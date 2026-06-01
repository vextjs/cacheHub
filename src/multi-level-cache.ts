/**
 * 多级缓存（Multi-Level Cache）
 * L1 本地（MemoryCache）+ L2 远端（任意 CacheLike 实现，可选）
 *
 * 关键约束：
 * - A05：del() 先删 L1（必成功），再删 L2（容错），返回 L1 结果
 * - A06：'both' 策略 set() 中 L2 失败向调用方透传；remoteTimeoutMs 仅用于 get() 路径
 * - A07：clear() 仅清 L1，不清 L2 远端
 * - A16：批量操作空输入必须快速返回规定默认值
 *
 * 来源：技术方案 §6
 */

import type { CacheLike, CacheRemainingTtl, CacheStats } from "./types.js";

// ── 类型定义 ──

export interface MultiLevelCacheOptions {
  /** L1 本地缓存（必填） */
  local: CacheLike;
  /** L2 远端缓存（可选，通常为 Redis 适配器） */
  remote?: CacheLike;
  /**
   * 写入策略（默认 'both'）：
   * - 'both'：同步等待 L1 + L2 双写完成后返回
   * - 'local-first-async-remote'：先同步写 L1，再异步写 L2（fire-and-forget）
   */
  writePolicy?: "both" | "local-first-async-remote";
  /** L2 命中后是否回填 L1；TTL 不可查询时使用 L1 默认 TTL（默认 true） */
  backfillOnRemoteHit?: boolean;
  /** 远端 get() 操作超时（毫秒），超时则降级为 miss（默认 50） */
  remoteTimeoutMs?: number;
  /** 分布式失效发布函数（可选，delPattern 时调用） */
  publish?: (msg: { type: string; pattern: string; ts: number }) => void;
}

function normalizeBackfillTtl(ttl: CacheRemainingTtl): number {
  return ttl === null ? 0 : ttl;
}

const UNKNOWN_BACKFILL_TTL = Symbol("unknown-backfill-ttl");
type ResolvedBackfillTtl = number | typeof UNKNOWN_BACKFILL_TTL;

// ── 辅助函数 ──

/**
 * 包装远端操作超时，并在操作完成后清理 timer，避免成功请求遗留短期定时器。
 */
async function withRemoteTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[cache-hub] remote timeout after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race<T>([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ── 主类 ──

/**
 * 多级缓存：L1（本地）+ L2（远端）两级联动
 *
 * get 策略：L1 优先 → L1 miss 时查 L2（含 remoteTimeoutMs 降级）→ L2 命中可回填 L1
 * set 策略：由 writePolicy 决定（'both' 双写 / 'local-first-async-remote' 异步写远端）
 * del  策略：L1 必删，L2 容错（A05）
 * clear 策略：仅清 L1（A07）
 * keys/getStats：仅 L1
 */
export class MultiLevelCache implements CacheLike {
  private readonly _local: CacheLike;
  private readonly _remote: CacheLike | undefined;
  private readonly _writePolicy: "both" | "local-first-async-remote";
  private readonly _backfillOnRemoteHit: boolean;
  private readonly _remoteTimeoutMs: number;
  private readonly _publish:
    | ((msg: { type: string; pattern: string; ts: number }) => void)
    | undefined;

  constructor(options: MultiLevelCacheOptions) {
    this._local = options.local;
    this._remote = options.remote;
    this._writePolicy = options.writePolicy ?? "both";
    this._backfillOnRemoteHit = options.backfillOnRemoteHit ?? true;
    this._remoteTimeoutMs = options.remoteTimeoutMs ?? 50;
    this._publish = options.publish;
  }

  private async _resolveBackfillTtl(
    key: string,
  ): Promise<ResolvedBackfillTtl | undefined> {
    if (!this._remote?.getRemainingTtl) {
      return UNKNOWN_BACKFILL_TTL;
    }

    try {
      const ttl = await this._remote.getRemainingTtl(key);
      if (ttl === undefined) {
        return undefined;
      }
      return normalizeBackfillTtl(ttl);
    } catch {
      return UNKNOWN_BACKFILL_TTL;
    }
  }

  private async _resolveBackfillTtls(
    keys: string[],
  ): Promise<Record<string, ResolvedBackfillTtl>> {
    if (!this._remote || keys.length === 0) {
      return {};
    }

    if (this._remote.getRemainingTtlMany) {
      try {
        const batchTtls = await this._remote.getRemainingTtlMany(keys);
        const normalized: Record<string, ResolvedBackfillTtl> = {};
        for (const [key, ttl] of Object.entries(batchTtls)) {
          normalized[key] = normalizeBackfillTtl(ttl);
        }
        return normalized;
      } catch {
        // 回退到逐键查询
      }
    }

    if (!this._remote.getRemainingTtl) {
      return Object.fromEntries(
        keys.map((key) => [key, UNKNOWN_BACKFILL_TTL]),
      );
    }

    const result: Record<string, ResolvedBackfillTtl> = {};
    for (const key of keys) {
      const ttl = await this._resolveBackfillTtl(key);
      if (ttl !== undefined) {
        result[key] = ttl;
      }
    }
    return result;
  }

  private async _setLocalBackfill(
    key: string,
    value: any,
    ttl: ResolvedBackfillTtl,
  ): Promise<void> {
    if (ttl === UNKNOWN_BACKFILL_TTL) {
      await this._local.set(key, value);
      return;
    }
    await this._local.set(key, value, ttl);
  }

  // ── get ──

  async get<T = any>(key: string): Promise<T | undefined> {
    // L1 命中：直接返回，不查 L2
    const l1Value = await this._local.get<T>(key);
    if (l1Value !== undefined) {
      return l1Value;
    }

    // 无远端：L1 miss 即为最终 miss
    if (!this._remote) {
      return undefined;
    }

    // L2 查询（含 remoteTimeoutMs 超时降级，A06：remoteTimeoutMs 仅用于 get 路径）
    let l2Value: T | undefined;
    try {
      l2Value = await withRemoteTimeout(
        Promise.resolve(this._remote.get<T>(key)),
        this._remoteTimeoutMs,
      );
    } catch {
      // 超时或远端异常：降级为 miss，不影响调用方
      return undefined;
    }

    if (l2Value === undefined) {
      return undefined;
    }

    // 回填 L1（backfillOnRemoteHit=true 时）
    if (this._backfillOnRemoteHit) {
      try {
        const ttl = await this._resolveBackfillTtl(key);
        if (ttl !== undefined) {
          await this._setLocalBackfill(key, l2Value, ttl);
        }
      } catch {
        // 回填失败静默忽略：不影响本次返回值
      }
    }

    return l2Value;
  }

  // ── set ──

  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (this._writePolicy === "both") {
      // A06：'both' 策略使用 Promise.all，L2.set() 失败向调用方透传
      // 注意：remoteTimeoutMs 不包装 set() 路径，L2.set() 超时由 ioredis 内置控制
      if (this._remote) {
        await Promise.all([
          this._local.set(key, value, ttl),
          this._remote.set(key, value, ttl),
        ]);
      } else {
        await this._local.set(key, value, ttl);
      }
    } else {
      // 'local-first-async-remote'：先同步写 L1，再异步 fire-and-forget 写 L2
      await this._local.set(key, value, ttl);
      if (this._remote) {
        // fire-and-forget：L2 失败静默忽略，不等待
        void Promise.resolve(this._remote.set(key, value, ttl)).catch(() => {});
      }
    }
  }

  // ── del ──

  async del(key: string): Promise<boolean> {
    // A05：先删 L1（必须完成），再尝试删 L2（容错）
    // 无论 L2 是否失败，均返回 L1 del 的结果
    const l1Result = await this._local.del(key);
    if (this._remote) {
      try {
        await this._remote.del(key);
      } catch {
        // 静默忽略 L2 失败，不影响 L1 结果
      }
    }
    return l1Result;
  }

  // ── exists / has ──

  async exists(key: string): Promise<boolean> {
    // L1 命中直接返回 true
    const l1Exists = await this._local.exists(key);
    if (l1Exists) {
      return true;
    }

    // 查 L2（含超时降级）
    if (!this._remote) {
      return false;
    }
    try {
      return await withRemoteTimeout(
        Promise.resolve(this._remote.exists(key)),
        this._remoteTimeoutMs,
      );
    } catch {
      return false;
    }
  }

  async has(key: string): Promise<boolean> {
    return this.exists(key);
  }

  // ── clear（A07：仅清 L1，不清 L2 远端）──

  async clear(): Promise<void> {
    // 设计决策：clear() 仅清 L1 本地缓存。
    // 远端 Redis 通常是多实例共享存储，FLUSHDB 会影响所有服务实例。
    // 需要清远端时，调用方应通过 DistributedCacheInvalidator 或直接操作 Redis 客户端。
    await this._local.clear();
  }

  // ── 批量操作 ──

  async getMany(keys: string[]): Promise<Record<string, any>> {
    // A16：空输入快速返回
    if (keys.length === 0) {
      return {};
    }

    // 先查 L1
    const l1Result = await this._local.getMany(keys);
    const missingKeys = keys.filter((k) => l1Result[k] === undefined);

    // L1 全命中 或 无远端：直接返回
    if (missingKeys.length === 0 || !this._remote) {
      return l1Result;
    }

    // L2 补充 miss 的键（含超时降级）
    let l2Result: Record<string, any> = {};
    try {
      l2Result = await withRemoteTimeout(
        Promise.resolve(this._remote.getMany(missingKeys)),
        this._remoteTimeoutMs,
      );
    } catch {
      // L2 超时或失败：仅返回 L1 结果
      return l1Result;
    }

    // 回填 L1（仅 L2 有值的键）
    if (this._backfillOnRemoteHit) {
      const toBackfill: Record<string, any> = {};
      for (const k of missingKeys) {
        if (l2Result[k] !== undefined) {
          toBackfill[k] = l2Result[k];
        }
      }
      if (Object.keys(toBackfill).length > 0) {
        try {
          const backfillTtls = await this._resolveBackfillTtls(
            Object.keys(toBackfill),
          );
          for (const key of Object.keys(toBackfill)) {
            const ttl = backfillTtls[key];
            if (ttl !== undefined) {
              await this._setLocalBackfill(key, toBackfill[key], ttl);
            }
          }
        } catch {
          // 回填失败静默忽略
        }
      }
    }

    return { ...l1Result, ...l2Result };
  }

  async setMany(entries: Record<string, any>, ttl?: number): Promise<boolean> {
    // A16：空输入快速返回
    if (Object.keys(entries).length === 0) {
      return true;
    }

    if (this._writePolicy === "both") {
      if (this._remote) {
        // A06 同款：双写失败透传
        await Promise.all([
          this._local.setMany(entries, ttl),
          this._remote.setMany(entries, ttl),
        ]);
      } else {
        await this._local.setMany(entries, ttl);
      }
    } else {
      await this._local.setMany(entries, ttl);
      if (this._remote) {
        void Promise.resolve(this._remote.setMany(entries, ttl)).catch(
          () => {},
        );
      }
    }
    return true;
  }

  async delMany(keys: string[]): Promise<number> {
    // A16：空输入快速返回
    if (keys.length === 0) {
      return 0;
    }

    // A05 同款：L1 必删，L2 容错，返回 L1 计数
    const l1Count = await this._local.delMany(keys);
    if (this._remote) {
      try {
        await this._remote.delMany(keys);
      } catch {
        // 静默忽略
      }
    }
    return l1Count;
  }

  // ── delPattern ──

  async delPattern(pattern: string): Promise<number> {
    // L1 删除（必须）
    const l1Count = await this._local.delPattern(pattern);

    // L2 删除（容错）
    if (this._remote) {
      try {
        await this._remote.delPattern(pattern);
      } catch {
        // 静默忽略
      }
    }

    // 发布分布式失效消息（供其他实例监听）
    if (this._publish) {
      this._publish({ type: "delPattern", pattern, ts: Date.now() });
    }

    return l1Count;
  }

  // ── keys（仅 L1 本地键）──

  async keys(pattern?: string): Promise<string[]> {
    // 设计决策：keys() 仅返回 L1 本地键，不合并 L2 远端键
    return this._local.keys(pattern);
  }

  // ── invalidateByTag ──

  invalidateByTag(tag: string): void | Promise<void> {
    if (this._local.invalidateByTag) {
      return this._local.invalidateByTag(tag);
    }
  }

  // ── getStats（委托 L1）──

  getStats(): CacheStats {
    if (this._local.getStats) {
      return this._local.getStats();
    }
    // L1 不支持 stats 时返回零值
    return {
      hits: 0,
      misses: 0,
      hitRate: 0,
      entries: 0,
      evictions: 0,
      sets: 0,
      deletes: 0,
      memoryUsage: 0,
      memoryUsageMB: 0,
    };
  }

  resetStats(): void {
    if (this._local.resetStats) {
      this._local.resetStats();
    }
  }

  // ── destroy ──

  destroy(): void {
    if (this._local.destroy) {
      this._local.destroy();
    }
    // 设计决策：不销毁 remote，remote 的生命周期由调用方管理
  }
}
