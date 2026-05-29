/**
 * cache-hub 核心类型定义
 * 所有公开接口类型均在此集中管理
 */

/**
 * cache-hub 统一缓存接口
 *
 * 约束：
 * - 返回 T | Promise<T>，兼容同步内存实现与异步远端实现
 * - 11 必需方法覆盖 monSQLize isValidCache 的 10 方法全集 + has
 * - exists 为主方法，has 为别名（schema-dsl 使用）
 * - 未命中返回 undefined（null 为有效缓存值，不视为 miss）
 * - TTL 统一使用毫秒
 */
export type CacheRemainingTtl = number | null;

export interface CacheLike {
    // ── 核心 CRUD（6 方法）──
    get<T = any>(key: string): T | undefined | Promise<T | undefined>;
    set(key: string, value: any, ttl?: number): void | Promise<void>;
    del(key: string): boolean | Promise<boolean>;
    exists(key: string): boolean | Promise<boolean>;
    has(key: string): boolean | Promise<boolean>;        // exists 别名（schema-dsl 使用）
    clear(): void | Promise<void>;                       // 兼容 Redis FLUSHDB（异步）

    // ── 批量操作（3 方法）──
    getMany(keys: string[]): Record<string, any> | Promise<Record<string, any>>;
    /**
     * 批量写入。始终返回 true。
     * boolean 类型保留以供未来批量操作部分失败场景使用。
     */
    setMany(entries: Record<string, any>, ttl?: number): boolean | Promise<boolean>;
    delMany(keys: string[]): number | Promise<number>;

    // ── 模式与键操作（2 方法）──
    delPattern(pattern: string): number | Promise<number>;
    keys(pattern?: string): string[] | Promise<string[]>; // 兼容 Redis SCAN（异步）

    // ── 可选扩展 ──
    /**
     * 获取单个键的剩余 TTL（毫秒）。
     * - `number`：剩余 TTL（> 0）
     * - `null`：存在但永不过期
     * - `undefined`：键不存在，或当前实现不支持 TTL 查询
     */
    getRemainingTtl?(key: string): CacheRemainingTtl | undefined | Promise<CacheRemainingTtl | undefined>;
    /**
     * 批量获取剩余 TTL。返回对象仅包含存在且可确定 TTL 语义的键：
     * - 值为 `number`：剩余 TTL（毫秒）
     * - 值为 `null`：存在且永不过期
     */
    getRemainingTtlMany?(keys: string[]): Record<string, CacheRemainingTtl> | Promise<Record<string, CacheRemainingTtl>>;
    invalidateByTag?(tag: string): void | Promise<void>;
    getStats?(): CacheStats;
    resetStats?(): void;
    destroy?(): void;
    setLockManager?(lm: LockManager): void;
}

/**
 * 缓存统计信息
 */
export interface CacheStats {
    hits: number;
    misses: number;
    hitRate: number;        // 0-1 比率（非百分比字符串）
    entries: number;        // 当前条目数
    evictions: number;
    sets: number;
    deletes: number;
    memoryUsage: number;    // 估算字节
    memoryUsageMB: number;  // 保留 3 位小数（= Math.round(memoryUsage / 1024 / 1024 * 1000) / 1000）
}

/**
 * MemoryCache 构造选项
 */
export interface MemoryCacheOptions {
    maxEntries?: number;        // 最大条目数，默认 10000
    maxMemory?: number;         // 最大内存（字节），0=无限制，默认 0
    defaultTtl?: number;        // 默认 TTL（毫秒），0=永不过期，默认 0
    enableStats?: boolean;      // 是否启用统计，默认 true
    enableTags?: boolean;       // 是否启用标签索引，默认 false
    cleanupInterval?: number;   // 周期清理间隔（毫秒），0=仅惰性清理，默认 0
    enabled?: boolean;          // 是否启用缓存，false=所有读写均跳过，默认 true
}

/**
 * 锁管理器接口（monSQLize 分布式锁集成）
 */
export interface LockManager {
    isLocked(key: string): boolean;
}
