/**
 * 分布式缓存失效器
 * 基于 Redis Pub/Sub 实现跨实例的缓存失效通知
 *
 * 工作原理：
 * 1. 调用 invalidate(pattern) 时，先失效当前实例本地缓存，再通过 pub 连接广播失效消息
 * 2. 所有订阅同一频道的实例均会收到该消息
 * 3. instanceId 过滤：忽略自身发出的消息，避免本地重复失效
 * 4. 其他实例收到 pattern 消息后调用 cache.delPattern(pattern)
 * 5. 其他实例收到 tag 消息后调用 cache.invalidateByTag(tag)
 *
 * 提取自 monSQLize DistributedCacheInvalidator（重写为 TypeScript + CacheLike 接口）
 * 来源：技术方案 §9
 */

import { createRequire } from "module";
import { randomUUID } from "crypto";
import type { CacheLike } from "./types.js";

// ── 类型定义 ──

/**
 * 简单日志接口，全部方法可选以兼容各类 logger（console / pino / winston）
 */
export interface DistributedInvalidatorLogger {
  debug?(msg: string): void;
  info?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

/**
 * DistributedCacheInvalidator 构造选项
 */
export interface DistributedInvalidatorOptions {
  /**
   * 已创建的 ioredis 实例（用作 pub 连接）。
   * 传入时，失效器使用此实例发布消息；订阅连接独立创建（sub 独占连接，不可复用）。
   * 与 redisUrl 二选一，均未提供时默认连接 redis://localhost:6379。
   */
  redis?: object;

  /**
   * Redis 连接 URL（如 'redis://localhost:6379'）。
   * 提供时自动创建 pub + sub 两个独立连接。
   */
  redisUrl?: string;

  /** Pub/Sub 频道名称，默认 'cache-hub:invalidate' */
  channel?: string;

  /**
   * 当前实例 ID，用于过滤自身发送的消息，防止本地重复失效。
   * 默认自动生成（crypto.randomUUID()）。
   */
  instanceId?: string;

  /**
   * 目标缓存实例（必填）。
   * 收到失效消息时调用 cache.delPattern(pattern)。
   */
  cache: CacheLike;

  /** 可选日志记录器 */
  logger?: DistributedInvalidatorLogger;

  /**
   * @internal 仅用于单元测试 — 直接注入 pub/sub 连接，跳过 ioredis 动态加载。
   * 注入的连接默认不会在 close() 时被关闭（由调用方管理生命周期）。
   * `_shouldClosePub: true` 可覆盖默认行为，用于测试 pub.quit 关闭路径。
   */
  _connections?: { pub: any; sub: any; _shouldClosePub?: boolean };
}

/**
 * 失效器统计信息快照
 */
export interface InvalidatorStats {
  /** 通过本实例发出的失效消息数 */
  messagesSent: number;
  /** 从频道接收到的消息总数（含自身消息，instanceId 过滤前） */
  messagesReceived: number;
  /** 实际触发 delPattern 的次数（含本地主动失效与接收其他实例消息） */
  invalidationsTriggered: number;
  /** 实际触发 invalidateByTag 的次数（含本地主动失效与接收其他实例消息） */
  tagInvalidationsTriggered: number;
  /** 错误次数（发布 / 订阅 / 消息解析 / 失效处理） */
  errors: number;
  /** 当前实例 ID */
  instanceId: string;
  /** 订阅的 Pub/Sub 频道 */
  channel: string;
}

/** 内部消息格式（JSON 序列化后在 Pub/Sub 通道中传输） */
type InvalidationMessage =
  | {
      type: "invalidate" | "invalidate-pattern";
      pattern: string;
      instanceId: string;
      ts: number;
    }
  | {
      type: "invalidate-tag";
      tag: string;
      instanceId: string;
      ts: number;
    };

/** _buildConnections 返回结构 */
interface RedisConnections {
  pub: any;
  sub: any;
  /** true = pub 由本实例创建，close() 时需关闭 */
  shouldClosePub: boolean;
}

// ── 私有辅助函数 ──

/**
 * 生成唯一实例 ID（crypto.randomUUID，Node 16+ 内置）
 */
function _generateInstanceId(): string {
  return randomUUID();
}

/**
 * 动态加载 ioredis 并根据 options 初始化 pub / sub 连接。
 *
 * 设计决策：独立为模块级函数而非类私有方法，使构造函数可以直接将返回值赋给
 * readonly 字段（TypeScript 允许在构造函数体内赋值 readonly，但不允许在方法中赋值）。
 */
function _buildConnections(
  options: DistributedInvalidatorOptions,
): RedisConnections {
  let Redis: any;
  try {
    const _req = createRequire(import.meta.url);
    const mod = _req("ioredis");
    // ioredis v5 ESM 兼容：优先使用 .default 导出
    Redis = mod?.default ?? mod;
  } catch {
    throw new Error(
      "[cache-hub] DistributedCacheInvalidator requires ioredis. " +
        "Please install it: npm install ioredis",
    );
  }

  if (options.redis) {
    // 使用已有连接作为 pub（等价 A17：外部传入的连接不由我们关闭）
    // 订阅连接必须独立创建：subscribe 会独占该连接，无法复用 pub
    const existingOpts = (options.redis as any).options ?? {};
    const sub = new Redis({
      host: existingOpts.host ?? "localhost",
      port: existingOpts.port ?? 6379,
      ...(existingOpts.password !== undefined && {
        password: existingOpts.password,
      }),
      ...(existingOpts.db !== undefined && { db: existingOpts.db }),
    });
    return { pub: options.redis, sub, shouldClosePub: false };
  }

  const url = options.redisUrl ?? "redis://localhost:6379";
  return {
    pub: new Redis(url),
    sub: new Redis(url),
    shouldClosePub: true,
  };
}

// ── 主体实现 ──

/**
 * 基于 Redis Pub/Sub 的分布式缓存失效器。
 *
 * @example
 * ```typescript
 * const invalidator = new DistributedCacheInvalidator({
 *     redisUrl: 'redis://localhost:6379',
 *     cache: multiLevelCacheInstance,
 * });
 *
 * // 本地先失效，再广播给其他实例执行 cache.delPattern('user:*')
 * await invalidator.invalidate('user:*');
 *
 * // 关闭连接
 * await invalidator.close();
 * ```
 */
export class DistributedCacheInvalidator {
  private readonly _cache: CacheLike;
  private readonly _channel: string;
  private readonly _instanceId: string;
  private readonly _logger?: DistributedInvalidatorLogger;
  private readonly _shouldClosePub: boolean;
  private readonly _pub: any;
  private readonly _sub: any;
  private readonly _stats: {
    messagesSent: number;
    messagesReceived: number;
    invalidationsTriggered: number;
    tagInvalidationsTriggered: number;
    errors: number;
  };

  constructor(options: DistributedInvalidatorOptions) {
    if (!options.cache) {
      throw new Error(
        "[cache-hub] DistributedCacheInvalidator requires a cache instance",
      );
    }

    this._cache = options.cache;
    this._channel = options.channel ?? "cache-hub:invalidate";
    this._instanceId = options.instanceId ?? _generateInstanceId();
    this._logger = options.logger;
    this._stats = {
      messagesSent: 0,
      messagesReceived: 0,
      invalidationsTriggered: 0,
      tagInvalidationsTriggered: 0,
      errors: 0,
    };

    if (options._connections) {
      // 测试注入路径：跳过 ioredis 动态加载，直接使用传入的 pub/sub
      // 默认由调用方管理生命周期；_shouldClosePub=true 时 close() 会关闭 pub（测试专用）
      this._pub = options._connections.pub;
      this._sub = options._connections.sub;
      this._shouldClosePub = options._connections._shouldClosePub ?? false;
    } else {
      // 生产路径：通过模块级函数动态加载 ioredis 并创建连接
      // 在构造函数体内赋值 readonly 字段，符合 TypeScript readonly 语义
      const conns = _buildConnections(options);
      this._pub = conns.pub;
      this._sub = conns.sub;
      this._shouldClosePub = conns.shouldClosePub;
    }

    this._setupSubscription();
  }

  /**
   * 注册 Redis error 事件处理器并订阅 Pub/Sub 频道。
   * @private
   */
  private _setupSubscription(): void {
    this._pub.on("error", (err: Error) => {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] pub error: ${err.message}`,
      );
    });

    this._sub.on("error", (err: Error) => {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] sub error: ${err.message}`,
      );
    });

    // 订阅目标频道
    this._sub.subscribe(this._channel, (err: Error | null) => {
      if (err) {
        this._stats.errors++;
        this._logger?.error?.(
          `[cache-hub/distributed] subscribe error: ${err.message}`,
        );
      } else {
        this._logger?.info?.(
          `[cache-hub/distributed] subscribed to channel: ${this._channel}`,
        );
      }
    });

    // 注册消息处理器
    this._sub.on("message", (channel: string, raw: string) => {
      if (channel !== this._channel) {
        return;
      }

      this._stats.messagesReceived++;

      let msg: InvalidationMessage;
      try {
        msg = JSON.parse(raw) as InvalidationMessage;
      } catch {
        this._stats.errors++;
        this._logger?.error?.(
          "[cache-hub/distributed] message parse error: invalid JSON",
        );
        return;
      }

      // 忽略自身发送的消息（instanceId 过滤，避免本地重复失效）
      if (msg.instanceId === this._instanceId) {
        return;
      }

      if (
        (msg.type === "invalidate" || msg.type === "invalidate-pattern") &&
        "pattern" in msg &&
        typeof msg.pattern === "string" &&
        msg.pattern.length > 0
      ) {
        // 异步处理，不阻塞 Redis 消息循环；错误在 _invalidateLocal 内捕获
        void this._invalidatePatternLocal(msg.pattern);
        return;
      }

      if (
        msg.type === "invalidate-tag" &&
        "tag" in msg &&
        typeof msg.tag === "string" &&
        msg.tag.length > 0
      ) {
        void this._invalidateTagLocal(msg.tag);
      }
    });
  }

  /**
   * 执行本地缓存失效：调用 cache.delPattern(pattern)。
   * delPattern 返回 number | Promise<number>，统一 await。
   * @private
   */
  private async _invalidatePatternLocal(
    pattern: string,
    rethrowErrors = false,
  ): Promise<void> {
    try {
      await this._cache.delPattern(pattern);
      this._stats.invalidationsTriggered++;
      this._logger?.debug?.(
        `[cache-hub/distributed] invalidated pattern: ${pattern}`,
      );
    } catch (err: unknown) {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] invalidation error: ${(err as Error).message}`,
      );
      if (rethrowErrors) {
        throw err;
      }
    }
  }

  private async _invalidateTagLocal(
    tag: string,
    rethrowErrors = false,
  ): Promise<void> {
    try {
      if (!this._cache.invalidateByTag) {
        this._stats.errors++;
        this._logger?.warn?.(
          `[cache-hub/distributed] cache does not support invalidateByTag: ${tag}`,
        );
        return;
      }
      await this._cache.invalidateByTag(tag);
      this._stats.tagInvalidationsTriggered++;
      this._logger?.debug?.(
        `[cache-hub/distributed] invalidated tag: ${tag}`,
      );
    } catch (err: unknown) {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] tag invalidation error: ${(err as Error).message}`,
      );
      if (rethrowErrors) {
        throw err;
      }
    }
  }

  /**
   * 广播缓存失效消息。
   *
   * 当前实例会先执行本地失效，再广播给同频道内的其他实例。
   * 订阅回环中的自身消息仍会被 instanceId 过滤，避免重复失效。
   *
   * @param pattern - 缓存键模式（支持通配符 *；空字符串不发送）
   * @throws 发布失败时抛出 ioredis 错误
   */
  async invalidate(pattern: string): Promise<void> {
    if (!pattern) {
      return;
    }

    await this._invalidatePatternLocal(pattern, true);

    const msg: InvalidationMessage = {
      type: "invalidate",
      pattern,
      instanceId: this._instanceId,
      ts: Date.now(),
    };

    try {
      await this._pub.publish(this._channel, JSON.stringify(msg));
      this._stats.messagesSent++;
      this._logger?.debug?.(
        `[cache-hub/distributed] published invalidation: ${pattern}`,
      );
    } catch (err: unknown) {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] publish error: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * 语义化 pattern 失效别名。保留 invalidate(pattern) 兼容旧调用。
   */
  async invalidatePattern(pattern: string): Promise<void> {
    await this.invalidate(pattern);
  }

  /**
   * 按 tag 广播缓存失效消息。
   */
  async invalidateTag(tag: string): Promise<void> {
    if (!tag) {
      return;
    }

    await this._invalidateTagLocal(tag, true);

    const msg: InvalidationMessage = {
      type: "invalidate-tag",
      tag,
      instanceId: this._instanceId,
      ts: Date.now(),
    };

    try {
      await this._pub.publish(this._channel, JSON.stringify(msg));
      this._stats.messagesSent++;
      this._logger?.debug?.(
        `[cache-hub/distributed] published tag invalidation: ${tag}`,
      );
    } catch (err: unknown) {
      this._stats.errors++;
      this._logger?.error?.(
        `[cache-hub/distributed] publish error: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * 获取当前统计信息快照（每次调用返回独立副本）。
   */
  getStats(): InvalidatorStats {
    return {
      ...this._stats,
      instanceId: this._instanceId,
      channel: this._channel,
    };
  }

  /**
   * 关闭连接并取消订阅。
   *
   * - sub 连接始终关闭（由本实例创建）
   * - pub 连接仅在由本实例创建时关闭（外部传入的 redis 不关闭）
   *
   * 关闭过程中的错误会记录日志但不向外抛出。
   */
  async close(): Promise<void> {
    // 取消订阅
    try {
      await this._sub.unsubscribe(this._channel);
    } catch (err: unknown) {
      this._logger?.error?.(
        `[cache-hub/distributed] unsubscribe error: ${(err as Error).message}`,
      );
    }

    // 关闭 sub 连接（始终自行创建）
    try {
      await this._sub.quit();
    } catch (err: unknown) {
      this._logger?.error?.(
        `[cache-hub/distributed] sub quit error: ${(err as Error).message}`,
      );
    }

    // 关闭 pub 连接（仅自建时关闭）
    if (this._shouldClosePub) {
      try {
        await this._pub.quit();
      } catch (err: unknown) {
        this._logger?.error?.(
          `[cache-hub/distributed] pub quit error: ${(err as Error).message}`,
        );
      }
    }

    this._logger?.info?.("[cache-hub/distributed] closed");
  }
}
