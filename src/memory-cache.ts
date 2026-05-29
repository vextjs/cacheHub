/**
 * MemoryCache 核心引擎
 *
 * 基于 ES6 Map 插入顺序实现 LRU（delete + set 等价于"移到末尾"）。
 * TTL 采用惰性过期（get/exists 时检查）+ 可选周期清理（cleanupInterval）。
 * 支持标签索引（enableTags=true）用于按 tag 批量失效。
 * 零运行时依赖（NFR-01）。
 *
 * 来源：技术方案 §3
 */

import type {
  CacheLike,
  CacheRemainingTtl,
  CacheStats,
  LockManager,
  MemoryCacheOptions,
} from "./types.js";

// ── 内部类型 ──

/** 缓存条目内部结构 */
interface InternalEntry<V = any> {
  value: V;
  size: number; // 估算字节（仅 maxMemory > 0 时有意义）
  expireAt: number | null; // Date.now() + ttl；null 表示永不过期
  tags: string[]; // enableTags=true 时使用
}

/** set() 方法的扩展选项（不在 CacheLike 接口中，仅 MemoryCache 支持） */
export interface SetOptions {
  tags?: string[];
}

/** 内部统计计数器（仅追踪增量，不含计算字段） */
interface StatsCounters {
  hits: number;
  misses: number;
  evictions: number;
  sets: number;
  deletes: number;
}

// ── 常量 ──

const DEFAULT_MAX_ENTRIES = 10000;

// ── 类实现 ──

/**
 * LRU + TTL 内存缓存核心引擎，实现 CacheLike 接口。
 *
 * @example
 * ```typescript
 * const cache = new MemoryCache({ maxEntries: 500, defaultTtl: 60000 });
 * cache.set('user:1', { name: 'Alice' });
 * const user = cache.get('user:1'); // { name: 'Alice' }
 * cache.destroy();
 * ```
 */
export class MemoryCache implements CacheLike {
  private readonly _store: Map<string, InternalEntry>;
  private readonly _tagIndex: Map<string, Set<string>>;
  private readonly _options: Required<MemoryCacheOptions>;
  private _counters: StatsCounters;
  private _memoryUsage: number;
  /** A19：保存引用以便 destroy() 中 clearInterval，防止 Node.js 事件循环泄漏 */
  private _cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private _lockManager: LockManager | undefined;

  constructor(options: MemoryCacheOptions = {}) {
    // 参数校验与默认值（越界时回退默认值，见技术方案 §15）
    this._options = {
      maxEntries:
        typeof options.maxEntries === "number" && options.maxEntries > 0
          ? Math.floor(options.maxEntries)
          : DEFAULT_MAX_ENTRIES,
      maxMemory:
        typeof options.maxMemory === "number" && options.maxMemory >= 0
          ? options.maxMemory
          : 0,
      defaultTtl:
        typeof options.defaultTtl === "number" && options.defaultTtl >= 0
          ? options.defaultTtl
          : 0,
      enableStats: options.enableStats !== false,
      enableTags: options.enableTags === true,
      cleanupInterval:
        typeof options.cleanupInterval === "number" &&
        options.cleanupInterval > 0
          ? options.cleanupInterval
          : 0,
      enabled: options.enabled !== false,
    };

    this._store = new Map();
    this._tagIndex = new Map();
    this._memoryUsage = 0;
    this._counters = { hits: 0, misses: 0, evictions: 0, sets: 0, deletes: 0 };

    // 周期清理定时器（A19：必须保存引用）
    if (this._options.cleanupInterval > 0) {
      this._cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this._store.entries()) {
          if (entry.expireAt !== null && entry.expireAt <= now) {
            // TTL 过期不计入 deletes / evictions（见 _deleteInternal 注释）
            this._deleteInternal(key);
          }
        }
      }, this._options.cleanupInterval);
      // 不阻止进程退出（A19 建议）
      this._cleanupTimer.unref();
    }
  }

  // ── 核心 CRUD ──

  get<T = any>(key: string): T | undefined {
    this._validateKey(key);
    if (!this._options.enabled) {
      return undefined;
    }

    const entry = this._store.get(key) as InternalEntry<T> | undefined;
    if (!entry) {
      this._recordMiss();
      return undefined;
    }

    // 惰性 TTL 过期检查
    if (entry.expireAt !== null && Date.now() >= entry.expireAt) {
      this._deleteInternal(key);
      this._recordMiss();
      return undefined;
    }

    // LRU 刷新：delete + set 将条目移到 Map 末尾（最近使用）
    this._store.delete(key);
    this._store.set(key, entry);

    this._recordHit();
    return entry.value;
  }

  /**
   * 写入缓存条目。
   *
   * @param key     - 缓存键（非空字符串）
   * @param value   - 缓存值（null 为有效值，不视为 miss）
   * @param ttl     - TTL（毫秒），未提供时使用 defaultTtl，< 0 或 NaN 视为 0
   * @param options - 扩展选项（tags 仅在 enableTags=true 时生效）
   */
  set(key: string, value: any, ttl?: number, options?: SetOptions): void {
    this._validateKey(key);
    if (!this._options.enabled) {
      return;
    }

    // 分布式锁守卫：锁定键跳过写入（技术方案 §3.2）
    if (this._lockManager?.isLocked(key)) {
      return;
    }

    // 删除旧条目（回退内存计数 + 标签索引）
    if (this._store.has(key)) {
      this._deleteInternal(key);
    }

    // 解析 TTL（< 0 或 NaN 视为 0 = 永不过期，见 §15）
    let resolvedTtl = ttl !== undefined ? ttl : this._options.defaultTtl;
    if (
      typeof resolvedTtl !== "number" ||
      Number.isNaN(resolvedTtl) ||
      resolvedTtl < 0
    ) {
      resolvedTtl = 0;
    }

    // 内存估算（仅 maxMemory > 0 时调用，避免不必要的 JSON.stringify）
    const size =
      this._options.maxMemory > 0 ? this._estimateSize(key, value) : 0;

    const entry: InternalEntry = {
      value,
      size,
      expireAt: resolvedTtl > 0 ? Date.now() + resolvedTtl : null,
      tags:
        this._options.enableTags && options?.tags && options.tags.length > 0
          ? options.tags
          : [],
    };

    this._store.set(key, entry);
    this._memoryUsage += size;

    // 标签索引注册
    if (this._options.enableTags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        let tagSet = this._tagIndex.get(tag);
        if (!tagSet) {
          tagSet = new Set<string>();
          this._tagIndex.set(tag, tagSet);
        }
        tagSet.add(key);
      }
    }

    this._recordSet();
    this._enforceLimits();
  }

  del(key: string): boolean {
    this._validateKey(key);
    if (this._deleteInternal(key)) {
      this._recordDelete();
      return true;
    }
    return false;
  }

  exists(key: string): boolean {
    this._validateKey(key);
    if (!this._options.enabled) {
      return false;
    }
    const entry = this._store.get(key);
    if (!entry) {
      return false;
    }
    // 惰性 TTL 检查
    if (entry.expireAt !== null && Date.now() >= entry.expireAt) {
      this._deleteInternal(key);
      return false;
    }
    return true;
  }

  /** exists 的同步别名（schema-dsl 使用） */
  has(key: string): boolean {
    return this.exists(key);
  }

  clear(): void {
    this._store.clear();
    this._tagIndex.clear();
    this._memoryUsage = 0;
    // 设计决策：clear() 不重置统计计数器（与 resetStats() 职责分离）
  }

  // ── 批量操作 ──

  getMany(keys: string[]): Record<string, any> {
    if (keys.length === 0) {
      return {}; // A16：空输入返回空对象
    }
    const result: Record<string, any> = {};
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  setMany(entries: Record<string, any>, ttl?: number): boolean {
    if (Object.keys(entries).length === 0) {
      return true; // A16：空输入视为成功
    }
    for (const [key, value] of Object.entries(entries)) {
      this.set(key, value, ttl);
    }
    return true;
  }

  delMany(keys: string[]): number {
    if (keys.length === 0) {
      return 0; // A16：空输入返回 0
    }
    let count = 0;
    for (const key of keys) {
      if (this.del(key)) {
        count++;
      }
    }
    return count;
  }

  // ── 模式与键操作 ──

  delPattern(pattern: string): number {
    // A10：pattern 长度上限 512 字符
    if (pattern.length > 512) {
      console.warn("[cache-hub] delPattern: pattern 超过 512 字符，已截断");
      pattern = pattern.slice(0, 512);
    }
    const regex = this._patternToRegex(pattern);
    // 先收集匹配键，再删除（避免迭代中修改 Map）
    const toDelete: string[] = [];
    for (const key of this._store.keys()) {
      if (regex.test(key)) {
        toDelete.push(key);
      }
    }
    let count = 0;
    for (const key of toDelete) {
      if (this._deleteInternal(key)) {
        count++;
      }
    }
    return count;
  }

  keys(pattern?: string): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [key, entry] of this._store.entries()) {
      // 跳过已过期条目（惰性检查，不触发删除）
      if (entry.expireAt !== null && entry.expireAt <= now) {
        continue;
      }
      result.push(key);
    }
    if (!pattern) {
      return result;
    }
    const regex = this._patternToRegex(pattern);
    return result.filter((k) => regex.test(k));
  }

  // ── 可选扩展 ──

  getRemainingTtl(key: string): CacheRemainingTtl | undefined {
    this._validateKey(key);
    if (!this._options.enabled) {
      return undefined;
    }

    const entry = this._store.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expireAt !== null) {
      const remaining = entry.expireAt - Date.now();
      if (remaining <= 0) {
        this._deleteInternal(key);
        return undefined;
      }
      return remaining;
    }

    return null;
  }

  getRemainingTtlMany(keys: string[]): Record<string, CacheRemainingTtl> {
    if (keys.length === 0) {
      return {};
    }

    const result: Record<string, CacheRemainingTtl> = {};
    for (const key of keys) {
      const ttl = this.getRemainingTtl(key);
      if (ttl !== undefined) {
        result[key] = ttl;
      }
    }
    return result;
  }

  invalidateByTag(tag: string): void {
    if (!this._options.enableTags) {
      return;
    }
    const keys = this._tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      return;
    }
    // 复制 Set，避免 _deleteInternal 在迭代中修改 Set（技术方案 §3.5）
    const keysCopy = [...keys];
    for (const key of keysCopy) {
      // _deleteInternal 会从所有 tag 的 Set 中移除该 key
      this._deleteInternal(key);
    }
    // 确保 tag 条目被清除（_deleteInternal 可能已部分清理，此处兜底）
    this._tagIndex.delete(tag);
  }

  getStats(): CacheStats {
    const total = this._counters.hits + this._counters.misses;
    return {
      hits: this._counters.hits,
      misses: this._counters.misses,
      hitRate: total > 0 ? this._counters.hits / total : 0,
      entries: this._store.size,
      evictions: this._counters.evictions,
      sets: this._counters.sets,
      deletes: this._counters.deletes,
      memoryUsage: this._memoryUsage,
      memoryUsageMB:
        Math.round((this._memoryUsage / 1024 / 1024) * 1000) / 1000,
    };
  }

  resetStats(): void {
    this._counters = { hits: 0, misses: 0, evictions: 0, sets: 0, deletes: 0 };
  }

  setLockManager(lm: LockManager): void {
    this._lockManager = lm;
  }

  /**
   * 销毁实例：清理定时器 + 清空数据。
   * A19：必须 clearInterval 防止 Node.js 事件循环泄漏。
   * destroy() 调用后不应再使用该实例（行为未定义）。
   */
  destroy(): void {
    if (this._cleanupTimer !== undefined) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = undefined;
    }
    this._store.clear();
    this._tagIndex.clear();
  }

  // ── 私有方法 ──

  /**
   * 运行时校验 key 参数（A12）。
   * TypeScript 已在编译期保证 string 类型；此处防御 JavaScript 调用方传入非法值。
   */
  private _validateKey(key: string): void {
    if (typeof key !== "string" || key === "") {
      throw new TypeError(
        `[cache-hub] key 必须为非空字符串，收到: ${JSON.stringify(key)}`,
      );
    }
  }

  /**
   * 内部删除实现（不更新统计计数器）。
   * 调用方负责决定是否调用 _recordDelete() / _recordEviction()：
   * - del()            → _deleteInternal() + _recordDelete()
   * - _enforceLimits() → _deleteInternal() + _recordEviction()
   * - cleanupInterval  → _deleteInternal()（过期不计入 deletes/evictions）
   * - invalidateByTag  → _deleteInternal()（批量失效不计入 deletes）
   */
  private _deleteInternal(key: string): boolean {
    const entry = this._store.get(key);
    if (!entry) {
      return false;
    }

    // 回退内存计数
    this._memoryUsage -= entry.size;

    // 清理标签索引（从每个 tag 的 Set 中移除此 key）
    if (this._options.enableTags && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        const tagKeys = this._tagIndex.get(tag);
        if (tagKeys) {
          tagKeys.delete(key);
          // 防止空 Set 积累（技术方案 §3.5）
          if (tagKeys.size === 0) {
            this._tagIndex.delete(tag);
          }
        }
      }
    }

    this._store.delete(key);
    return true;
  }

  /**
   * 双重淘汰：先按条目数，再按内存大小。
   * LRU 策略：删除 Map 中最先插入（最旧未使用）的条目。
   */
  private _enforceLimits(): void {
    // 按条目数淘汰（超过 maxEntries）
    while (this._store.size > this._options.maxEntries) {
      const oldest = this._store.keys().next().value as string | undefined;
      /* v8 ignore next 3 */
      if (oldest === undefined) {
        break;
      }
      this._deleteInternal(oldest);
      this._recordEviction();
    }

    // 按内存淘汰（超过 maxMemory，仅 maxMemory > 0 时）
    if (this._options.maxMemory > 0) {
      while (this._memoryUsage > this._options.maxMemory) {
        const oldest = this._store.keys().next().value as string | undefined;
        /* v8 ignore next 3 */
        if (oldest === undefined) {
          break;
        }
        this._deleteInternal(oldest);
        this._recordEviction();
      }
    }
  }

  /**
   * 内存大小估算（仅 maxMemory > 0 时调用，避免不必要的 JSON.stringify 开销）。
   *
   * 已知限制（技术方案 §3.7）：
   * 1. key.length * 2 对 4 字节 Unicode（emoji/surrogate pairs）估算偏小
   * 2. tags 数组大小不计入估算
   */
  private _estimateSize(key: string, value: any): number {
    const keySize = key.length * 2; // UTF-16 估算
    let valueSize = 8; // 基础开销
    if (typeof value === "string") {
      valueSize = value.length * 2;
    } else if (typeof value === "object" && value !== null) {
      try {
        valueSize = JSON.stringify(value).length * 2;
      } catch {
        valueSize = 100; // 无法序列化时使用保守估算
      }
    }
    return keySize + valueSize;
  }

  /**
   * 将 * 通配符模式转为正则表达式（A10/A11/§16 ReDoS 防护）。
   *
   * 转换步骤：
   * 1. 转义所有正则元字符（包括 * 本身，变为 \*）
   * 2. 将 \* 替换为 .* （恢复通配符语义）
   *
   * 仅支持 * 通配符（A11），不支持 ?/[] 等 glob 语法。
   */
  private _patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // 先转义所有元字符
      .replace(/\\\*/g, ".*"); // 再将 \* 还原为 .*
    return new RegExp("^" + escaped + "$");
  }

  // ── 统计辅助（enableStats 守卫，修复 monSQLize bug R01）──

  private _recordHit(): void {
    if (this._options.enableStats) {
      this._counters.hits++;
    }
  }

  private _recordMiss(): void {
    if (this._options.enableStats) {
      this._counters.misses++;
    }
  }

  private _recordSet(): void {
    if (this._options.enableStats) {
      this._counters.sets++;
    }
  }

  private _recordDelete(): void {
    if (this._options.enableStats) {
      this._counters.deletes++;
    }
  }

  private _recordEviction(): void {
    if (this._options.enableStats) {
      this._counters.evictions++;
    }
  }
}
