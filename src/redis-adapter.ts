/**
 * Redis 适配器（Redis Adapter）
 * 将 ioredis 实例包装为 CacheLike 接口
 *
 * 关键约束：
 * - A08：delPattern / keys 使用 SCAN 游标迭代，禁止 KEYS 命令
 * - A10：pattern 超过 512 字符时截断并打印 console.warn
 * - A11：仅支持 * 通配符，? 和 [ 会被转义为字面量
 * - A12：key 为非 string 或空字符串时抛出 TypeError
 * - A13：ioredis 为 optional peer dep，使用 createRequire 动态加载
 * - A17：close() 仅关闭自己创建的连接（shouldCloseOnDestroy 标志）
 *
 * 来源：技术方案 §7
 */

import { createRequire } from 'module';

// ── 常量 ──

const SCAN_COUNT = 100;
const PATTERN_MAX_LENGTH = 512;

// ── 动态加载 ioredis（optional peer dep）──

const _require = createRequire(import.meta.url);

/**
 * 同步加载 ioredis，仅用于传入 URL 字符串时创建连接。
 * 若未安装 ioredis，抛出描述性错误。
 */
function loadIoredis(): any {
    try {
        return _require('ioredis');
    } catch {
        throw new Error(
            '[cache-hub] redis-adapter 需要安装 ioredis。' +
            '请执行：npm install ioredis'
        );
    }
}

// ── 接口扩展 ──

import type { CacheLike, CacheRemainingTtl, CacheStats } from './types.js';

/**
 * Redis 适配器扩展方法（close + getRedisInstance）
 */
export interface RedisCacheAdapter extends CacheLike {
    /** 关闭 Redis 连接（仅关闭自己创建的连接，A17） */
    close(): Promise<void>;
    /** 获取底层 ioredis 实例（用于高级操作） */
    getRedisInstance(): object;
}

// ── 内部实现类 ──

class RedisCacheAdapterImpl implements RedisCacheAdapter {
    private readonly _redis: any;
    /** A17：标记是否由 adapter 自建连接，仅自建时才在 close() 中关闭 */
    private readonly _shouldCloseOnDestroy: boolean;

    constructor(urlOrInstance: string | object) {
        this._shouldCloseOnDestroy = typeof urlOrInstance === 'string';

        if (this._shouldCloseOnDestroy) {
            // 传入 URL 字符串：动态加载 ioredis 并自建连接
            const ioredis = loadIoredis();
            // 兼容 ESM default export 与 CJS module.exports
            const RedisClass = ioredis.default ?? ioredis;
            this._redis = new RedisClass(urlOrInstance as string);
        } else {
            // 传入外部实例：直接使用，close() 不关闭
            this._redis = urlOrInstance;
        }
    }

    // ── 参数校验 ──

    private _validateKey(key: string): void {
        if (typeof key !== 'string' || key === '') {
            throw new TypeError(
                `[cache-hub] key 必须为非空字符串，收到: ${JSON.stringify(key)}`
            );
        }
    }

    private _validateKeys(keys: string[]): void {
        for (const key of keys) {
            this._validateKey(key);
        }
    }

    private _normalizeRemainingTtl(ttl: number): CacheRemainingTtl | undefined {
        if (ttl === -2) {
            return undefined;
        }
        if (ttl === -1) {
            return null;
        }
        if (ttl <= 0) {
            return undefined;
        }
        return ttl;
    }

    /**
     * 将用户 pattern 转换为 Redis SCAN MATCH 兼容的 pattern。
     * - A10：超长截断
     * - A11：仅支持 *，转义 ? 和 [
     */
    private _toRedisPattern(pattern: string): string {
        // A10：超长截断
        let safe = pattern;
        if (safe.length > PATTERN_MAX_LENGTH) {
            console.warn('[cache-hub] delPattern: pattern 超过 512 字符，已截断');
            safe = safe.slice(0, PATTERN_MAX_LENGTH);
        }
        // A11：转义 Redis MATCH 中的 ? 和 [（不支持这两种通配符）
        return safe
            .replace(/\?/g, '\\?')
            .replace(/\[/g, '\\[');
    }

    // ── 核心 CRUD ──

    async get<T = any>(key: string): Promise<T | undefined> {
        this._validateKey(key);
        const raw = await this._redis.get(key);
        if (raw === null || raw === undefined) {
            return undefined;
        }
        try {
            return JSON.parse(raw) as T;
        } catch {
            // 解析失败（非 JSON 存储的旧数据）：以原始字符串返回
            return raw as unknown as T;
        }
    }

    async set(key: string, value: any, ttl?: number): Promise<void> {
        this._validateKey(key);
        const serialized = JSON.stringify(value);
        if (ttl !== undefined && ttl > 0) {
            // 使用 PX 选项（毫秒精度，对应 psetex 语义）
            await this._redis.set(key, serialized, 'PX', ttl);
        } else {
            await this._redis.set(key, serialized);
        }
    }

    async del(key: string): Promise<boolean> {
        this._validateKey(key);
        const result: number = await this._redis.del(key);
        return result > 0;
    }

    async exists(key: string): Promise<boolean> {
        this._validateKey(key);
        const result: number = await this._redis.exists(key);
        return result > 0;
    }

    async has(key: string): Promise<boolean> {
        return this.exists(key);
    }

    async clear(): Promise<void> {
        await this._redis.flushdb();
    }

    // ── 批量操作 ──

    async getMany(keys: string[]): Promise<Record<string, any>> {
        // A16：空输入快速返回
        if (keys.length === 0) {
            return {};
        }
        this._validateKeys(keys);

        const values: (string | null)[] = await this._redis.mget(...keys);
        const result: Record<string, any> = {};
        for (let i = 0; i < keys.length; i++) {
            const raw = values[i];
            if (raw !== null && raw !== undefined) {
                try {
                    result[keys[i]] = JSON.parse(raw);
                } catch {
                    result[keys[i]] = raw;
                }
            }
        }
        return result;
    }

    async setMany(entries: Record<string, any>, ttl?: number): Promise<boolean> {
        const keys = Object.keys(entries);
        // A16：空输入快速返回
        if (keys.length === 0) {
            return true;
        }
        this._validateKeys(keys);

        const pipeline = this._redis.pipeline();
        for (const key of keys) {
            const serialized = JSON.stringify(entries[key]);
            if (ttl !== undefined && ttl > 0) {
                pipeline.set(key, serialized, 'PX', ttl);
            } else {
                pipeline.set(key, serialized);
            }
        }
        await pipeline.exec();
        return true;
    }

    async delMany(keys: string[]): Promise<number> {
        // A16：空输入快速返回
        if (keys.length === 0) {
            return 0;
        }
        this._validateKeys(keys);
        const result: number = await this._redis.del(...keys);
        return result;
    }

    // ── 模式与键操作（A08：使用 SCAN，禁止 KEYS）──

    async delPattern(pattern: string): Promise<number> {
        const redisPattern = this._toRedisPattern(pattern);
        let cursor = '0';
        let count = 0;

        do {
            const [nextCursor, matchedKeys]: [string, string[]] = await this._redis.scan(
                cursor,
                'MATCH',
                redisPattern,
                'COUNT',
                SCAN_COUNT
            );
            cursor = nextCursor;

            if (matchedKeys.length > 0) {
                // 批量删除当前批次（pipeline 减少 RTT）
                const pipeline = this._redis.pipeline();
                for (const k of matchedKeys) {
                    pipeline.del(k);
                }
                await pipeline.exec();
                count += matchedKeys.length;
            }
        } while (cursor !== '0');

        return count;
    }

    async keys(pattern?: string): Promise<string[]> {
        const rawPattern = pattern ?? '*';
        const redisPattern = this._toRedisPattern(rawPattern);
        let cursor = '0';
        const result: string[] = [];

        do {
            const [nextCursor, matchedKeys]: [string, string[]] = await this._redis.scan(
                cursor,
                'MATCH',
                redisPattern,
                'COUNT',
                SCAN_COUNT
            );
            cursor = nextCursor;
            result.push(...matchedKeys);
        } while (cursor !== '0');

        return result;
    }

    async getRemainingTtl(key: string): Promise<CacheRemainingTtl | undefined> {
        this._validateKey(key);
        const ttl: number = await this._redis.pttl(key);
        return this._normalizeRemainingTtl(ttl);
    }

    async getRemainingTtlMany(
        keys: string[],
    ): Promise<Record<string, CacheRemainingTtl>> {
        if (keys.length === 0) {
            return {};
        }
        this._validateKeys(keys);

        const pipeline = this._redis.pipeline();
        for (const key of keys) {
            pipeline.pttl(key);
        }

        const responses: Array<[Error | null, number]> = await pipeline.exec();
        const result: Record<string, CacheRemainingTtl> = {};
        for (let i = 0; i < keys.length; i++) {
            const ttl = this._normalizeRemainingTtl(responses[i]?.[1] as number);
            if (ttl !== undefined) {
                result[keys[i]] = ttl;
            }
        }
        return result;
    }

    // ── 可选扩展 ──

    /**
     * getStats 在 Redis 层不追踪命中率等统计信息（无状态适配器）。
     * 若需要 stats，请在 MultiLevelCache 中访问 L1 的 getStats()。
     */
    getStats(): CacheStats {
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

    // ── 生命周期 ──

    /**
     * 关闭 Redis 连接。
     * A17：仅关闭由 adapter 自建的连接（传入 URL 字符串时），
     * 外部传入的 ioredis 实例由调用方负责关闭。
     */
    async close(): Promise<void> {
        if (this._shouldCloseOnDestroy) {
            await this._redis.quit();
        }
        // 外传实例：不操作，调用方负责管理连接生命周期
    }

    /**
     * 获取底层 ioredis 实例，用于执行适配器未封装的高级命令。
     */
    getRedisInstance(): object {
        return this._redis;
    }
}

// ── 工厂函数（公开 API）──

/**
 * 创建 Redis 缓存适配器，将 ioredis 连接包装为 CacheLike 接口。
 *
 * @param urlOrInstance - Redis 连接 URL（字符串）或已有的 ioredis 实例（对象）
 *   - 传入字符串：adapter 自建连接，close() 会调用 redis.quit()
 *   - 传入对象：使用外部连接，close() 不操作（A17）
 * @returns CacheLike 实现 + close() + getRedisInstance() 扩展
 *
 * @example
 * ```typescript
 * // 传入 URL（adapter 自建连接）
 * const cache = createRedisCacheAdapter('redis://localhost:6379');
 * await cache.set('key', { id: 1 }, 60000);
 * await cache.close(); // 关闭连接
 *
 * // 传入已有实例（外部管理生命周期）
 * import Redis from 'ioredis';
 * const redis = new Redis('redis://localhost:6379');
 * const cache = createRedisCacheAdapter(redis);
 * await cache.close(); // 不操作 redis 实例
 * redis.quit();        // 调用方负责关闭
 * ```
 */
export function createRedisCacheAdapter(
    urlOrInstance: string | object
): RedisCacheAdapter {
    return new RedisCacheAdapterImpl(urlOrInstance);
}
