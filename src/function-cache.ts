/**
 * 函数缓存（Function Cache）
 * 提供 withCache 装饰器函数和 FunctionCache 管理类
 *
 * 关键约束：
 * - A09：键超过 1024 字节时使用 SHA-256 摘要压缩，禁止截断（截断导致键碰撞）
 * - A13：使用 Node.js 内置 crypto 模块（非运行时依赖）
 * - in-flight 去重：实例级（非模块级），避免相同参数的并发请求重复执行 fn
 *
 * 来源：技术方案 §8
 */

import { createHash } from "crypto";
import { MemoryCache } from "./memory-cache.js";
import { stableStringify } from "./stable-stringify.js";
import type { CacheLike } from "./types.js";

// ── 常量 ──

/** 键长度超过此阈值时使用 SHA-256 压缩（A09） */
const KEY_MAX_LENGTH = 1024;

// ── 辅助函数 ──

/**
 * 生成缓存键，超长时使用 SHA-256 压缩（A09）。
 *
 * @param namespace - 命名空间
 * @param fnName    - 函数名称
 * @param args      - 参数列表（序列化用）
 * @returns 缓存键字符串
 */
function buildCacheKey(
  namespace: string,
  fnName: string,
  args: unknown[],
): string {
  const raw = `${namespace}:${fnName}:${stableStringify(args)}`;
  if (raw.length > KEY_MAX_LENGTH) {
    // A09：超长键使用 SHA-256 摘要，保留前缀以便调试识别
    const hash = createHash("sha256").update(raw).digest("hex");
    return `${namespace}:${fnName}:sha256:${hash}`;
  }
  return raw;
}

// ── withCache 类型定义 ──

export interface WithCacheOptions<T extends (...args: any[]) => Promise<any>> {
  /** 缓存 TTL（毫秒），默认 60000 */
  ttl?: number;
  /** 目标缓存实例，默认新建 MemoryCache */
  cache?: CacheLike;
  /** 自定义键生成函数，默认使用 stableStringify */
  keyBuilder?: (...args: Parameters<T>) => string;
  /** 命名空间前缀，默认 'fn' */
  namespace?: string;
  /**
   * 缓存条件函数，返回 false 时跳过写入缓存。
   * 适用场景：空结果不缓存、错误状态不缓存等。
   */
  condition?: (result: Awaited<ReturnType<T>>) => boolean;
  /** 是否启用调用统计，默认 true */
  enableStats?: boolean;
}

export interface WithCacheStats {
  hits: number;
  misses: number;
  errors: number;
  hitRate: number;
}

export type WrappedFunction<T extends (...args: any[]) => Promise<any>> = T & {
  /** 使指定参数组合的缓存条目失效 */
  invalidate(...args: Parameters<T>): Promise<void>;
  /** 使该包装函数写入的全部缓存条目失效 */
  invalidateAll(): Promise<void>;
  /** 获取调用统计信息 */
  stats(): WithCacheStats;
};

// ── withCache ──

/**
 * 函数缓存装饰器：为异步函数添加缓存层，自动管理缓存键生成和并发去重。
 *
 * 特性：
 * - 缓存命中直接返回，不调用原函数
 * - 相同参数的并发请求共享同一 in-flight Promise（实例级）
 * - 超长键自动 SHA-256 压缩（A09）
 * - 附加 invalidate / invalidateAll / stats 方法
 *
 * @param fn      - 待缓存的异步函数
 * @param options - 缓存配置（ttl / cache / keyBuilder / namespace / condition）
 * @returns 具有 invalidate / invalidateAll / stats 方法的包装函数
 *
 * @example
 * ```typescript
 * const getUser = withCache(
 *     async (id: number) => fetchUserFromDB(id),
 *     { ttl: 60000, namespace: 'user' }
 * );
 * const user = await getUser(1);  // 首次：调用 fetchUserFromDB
 * const same = await getUser(1);  // 再次：命中缓存，不调用 fetchUserFromDB
 * await getUser.invalidate(1);    // 使 id=1 的缓存失效
 * ```
 */
export function withCache<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: WithCacheOptions<T>,
): WrappedFunction<T> {
  const ttl = options?.ttl ?? 60000;
  const cache = options?.cache ?? new MemoryCache();
  const namespace = options?.namespace ?? "fn";
  const condition = options?.condition;
  const enableStats = options?.enableStats !== false;

  // 实例级 in-flight 去重表（不同于 readThrough 的模块级表）
  const inflight = new Map<string, Promise<any>>();

  // 该包装函数曾写入的键集合（用于 invalidateAll）
  const knownKeys = new Set<string>();

  // 统计计数器
  let hits = 0;
  let misses = 0;
  let errors = 0;

  // 构建键的辅助函数（捕获 options 闭包）
  function resolveKey(args: Parameters<T>): string {
    if (options?.keyBuilder) {
      return options.keyBuilder(...args);
    }
    const fnName = fn.name || "anonymous";
    return buildCacheKey(namespace, fnName, args as unknown[]);
  }

  // 包装函数主体
  const wrapped = async function (
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> {
    const key = resolveKey(args);

    // 缓存命中：直接返回
    const cached = await cache.get<Awaited<ReturnType<T>>>(key);
    if (cached !== undefined) {
      if (enableStats) {
        hits++;
      }
      return cached;
    }

    if (enableStats) {
      misses++;
    }

    // 并发去重：已有相同 key 的 in-flight Promise，复用
    if (inflight.has(key)) {
      try {
        return await (inflight.get(key) as Promise<Awaited<ReturnType<T>>>);
      } catch {
        // 复用的 Promise 失败时，回退到重新执行 fn
      }
    }

    // 构造新的 in-flight Promise
    const p = (async (): Promise<Awaited<ReturnType<T>>> => {
      const result = await fn(...args);

      // condition 检查：返回 false 时跳过缓存写入
      if (!condition || condition(result)) {
        try {
          await cache.set(key, result, ttl);
          knownKeys.add(key);
        } catch {
          // 缓存写入失败静默忽略：不影响调用方获取数据
        }
      }

      return result;
    })();

    inflight.set(key, p);

    try {
      return await p;
    } catch (e) {
      if (enableStats) {
        errors++;
      }
      throw e;
    } /* v8 ignore next */ finally {
      inflight.delete(key);
    }
  } as T;

  // ── 附加方法 ──

  const enhanced = Object.assign(wrapped, {
    async invalidate(...args: Parameters<T>): Promise<void> {
      const key = resolveKey(args);
      await cache.del(key);
      knownKeys.delete(key);
    },

    async invalidateAll(): Promise<void> {
      // 按记录顺序逐个删除
      for (const key of knownKeys) {
        try {
          await cache.del(key);
        } catch {
          // 删除失败静默忽略
        }
      }
      knownKeys.clear();
    },

    stats(): WithCacheStats {
      const total = hits + misses;
      return {
        hits,
        misses,
        errors,
        hitRate: total > 0 ? hits / total : 0,
      };
    },
  });

  return enhanced as WrappedFunction<T>;
}

// ── FunctionCache 类型定义 ──

interface RegisteredEntry {
  fn: Function;
  options?: {
    ttl?: number;
    keyBuilder?: (...args: any[]) => string;
    namespace?: string;
    condition?: (result: any) => boolean;
  };
  /** 实例级 in-flight 去重表 */
  inflight: Map<string, Promise<any>>;
  hits: number;
  misses: number;
  errors: number;
}

export interface FunctionCacheOptions {
  /** 全局默认 TTL（毫秒），默认 60000 */
  ttl?: number;
  /** 全局默认命名空间前缀，默认 'fn' */
  namespace?: string;
}

export interface FunctionCacheStats {
  hits: number;
  misses: number;
  errors: number;
  hitRate: number;
}

// ── FunctionCache ──

/**
 * 函数缓存管理器：集中注册和管理多个函数的缓存。
 *
 * 与 withCache 的区别：
 * - FunctionCache 通过 name 字符串注册和调用函数，适合动态注册场景
 * - 构造函数接受 CacheLike 或 { getCache(): CacheLike } 对象，解耦框架依赖
 *
 * @example
 * ```typescript
 * const fc = new FunctionCache(new MemoryCache(), { ttl: 60000 });
 * fc.register('getUser', async (id: number) => fetchUser(id));
 * const user = await fc.execute('getUser', 42);
 * fc.getStats('getUser'); // { hits: 0, misses: 1, errors: 0, hitRate: 0 }
 * ```
 */
export class FunctionCache {
  private readonly _cache: CacheLike;
  private readonly _globalOptions: FunctionCacheOptions;
  private readonly _registry = new Map<string, RegisteredEntry>();

  constructor(
    cacheOrGetter: CacheLike | { getCache(): CacheLike },
    options?: FunctionCacheOptions,
  ) {
    // 兼容 { getCache() } 形式（解耦框架，如 monSQLize）
    if (
      "getCache" in cacheOrGetter &&
      typeof (cacheOrGetter as any).getCache === "function"
    ) {
      this._cache = (cacheOrGetter as { getCache(): CacheLike }).getCache();
    } else {
      this._cache = cacheOrGetter as CacheLike;
    }
    this._globalOptions = options ?? {};
  }

  /**
   * 注册一个函数，赋予名称和缓存配置。
   *
   * @param name    - 函数唯一标识名称
   * @param fn      - 目标函数（同步或异步）
   * @param options - 每函数缓存配置，覆盖全局默认值
   */
  register(
    name: string,
    fn: Function,
    options?: {
      ttl?: number;
      keyBuilder?: (...args: any[]) => string;
      namespace?: string;
      condition?: (result: any) => boolean;
    },
  ): void {
    this._registry.set(name, {
      fn,
      options,
      inflight: new Map(),
      hits: 0,
      misses: 0,
      errors: 0,
    });
  }

  /**
   * 执行已注册的函数，命中缓存时直接返回，否则调用函数并缓存结果。
   *
   * @param name - 已注册的函数名称
   * @param args - 传递给函数的参数
   */
  async execute(name: string, ...args: any[]): Promise<any> {
    const entry = this._registry.get(name);
    if (!entry) {
      throw new Error(`[cache-hub] FunctionCache: 未注册的函数 "${name}"`);
    }

    const ns =
      entry.options?.namespace ?? this._globalOptions.namespace ?? "fn";
    const ttl = entry.options?.ttl ?? this._globalOptions.ttl ?? 60000;
    const condition = entry.options?.condition;

    // 构建缓存键
    const key = entry.options?.keyBuilder
      ? entry.options.keyBuilder(...args)
      : buildCacheKey(ns, name, args);

    // 缓存命中
    const cached = await this._cache.get(key);
    if (cached !== undefined) {
      entry.hits++;
      return cached;
    }

    entry.misses++;

    // 并发去重
    if (entry.inflight.has(key)) {
      try {
        return await entry.inflight.get(key);
      } catch {
        // 复用 Promise 失败，重新执行
      }
    }

    // 构造新的 in-flight Promise
    const p = (async (): Promise<any> => {
      const result = await entry.fn(...args);

      if (!condition || condition(result)) {
        try {
          await this._cache.set(key, result, ttl);
        } catch {
          // 写入失败静默忽略
        }
      }

      return result;
    })();

    entry.inflight.set(key, p);

    try {
      return await p;
    } catch (e) {
      entry.errors++;
      throw e;
    } /* v8 ignore next */ finally {
      entry.inflight.delete(key);
    }
  }

  /**
   * 使指定函数 + 参数组合的缓存条目失效。
   *
   * @param name - 已注册的函数名称
   * @param args - 缓存键对应的参数
   */
  async invalidate(name: string, ...args: any[]): Promise<void> {
    const entry = this._registry.get(name);
    if (!entry) {
      return;
    }

    const ns =
      entry.options?.namespace ?? this._globalOptions.namespace ?? "fn";
    const key = entry.options?.keyBuilder
      ? entry.options.keyBuilder(...args)
      : buildCacheKey(ns, name, args);

    await this._cache.del(key);
  }

  /**
   * 使匹配 pattern 的全部缓存键失效（委托给底层 cache.delPattern）。
   *
   * @param pattern - 删除模式（仅支持 * 通配符，A11）
   * @returns 删除的键数量
   */
  async invalidatePattern(pattern: string): Promise<number> {
    return this._cache.delPattern(pattern);
  }

  /**
   * 获取函数调用统计信息。
   *
   * @param name - 函数名称，省略时返回所有已注册函数的统计
   * @returns 统计对象或统计对象字典
   */
  getStats(
    name?: string,
  ): FunctionCacheStats | Record<string, FunctionCacheStats> {
    if (name !== undefined) {
      const entry = this._registry.get(name);
      if (!entry) {
        return { hits: 0, misses: 0, errors: 0, hitRate: 0 };
      }
      return this._calcStats(entry);
    }

    // 全部统计
    const all: Record<string, FunctionCacheStats> = {};
    for (const [fnName, entry] of this._registry) {
      all[fnName] = this._calcStats(entry);
    }
    return all;
  }

  /**
   * 获取已注册的全部函数名称列表。
   */
  list(): string[] {
    return [...this._registry.keys()];
  }

  /**
   * 重置统计计数器。
   *
   * @param name - 函数名称，省略时重置全部
   */
  resetStats(name?: string): void {
    if (name !== undefined) {
      const entry = this._registry.get(name);
      if (entry) {
        entry.hits = 0;
        entry.misses = 0;
        entry.errors = 0;
      }
      return;
    }
    for (const entry of this._registry.values()) {
      entry.hits = 0;
      entry.misses = 0;
      entry.errors = 0;
    }
  }

  /**
   * 清除全部已注册函数（不清除缓存数据，仅清除注册表）。
   * 如需同时清缓存，请先调用 cache.clear()。
   */
  clear(): void {
    this._registry.clear();
  }

  // ── 私有辅助 ──

  private _calcStats(entry: RegisteredEntry): FunctionCacheStats {
    const total = entry.hits + entry.misses;
    return {
      hits: entry.hits,
      misses: entry.misses,
      errors: entry.errors,
      hitRate: total > 0 ? entry.hits / total : 0,
    };
  }
}
