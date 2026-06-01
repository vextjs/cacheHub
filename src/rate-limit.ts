/**
 * 限流专用可选原语。
 *
 * 该模块不改变 CacheLike 必需接口，用于未来 rate limiter adapter 以独立入口接入。
 */

import type {
    FixedWindowRateLimitResult,
    FixedWindowRateLimitStore,
    RedisFixedWindowRateLimitClient,
} from './types.js';

const SCAN_COUNT = 100;

const REDIS_INCREMENT_SCRIPT = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
return { current, ttl }
`;

const REDIS_DECREMENT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local ttl = redis.call('PTTL', KEYS[1])
local next = tonumber(current) - tonumber(ARGV[1])
if next < 0 then
  next = 0
end
redis.call('SET', KEYS[1], next)
if ttl > 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return next
`;

interface FixedWindowEntry {
    hits: number;
    resetAt: number;
}

function validateKey(key: string): void {
    if (typeof key !== 'string' || key === '') {
        throw new TypeError(
            `[cache-hub] rate-limit key 必须为非空字符串，收到: ${JSON.stringify(key)}`
        );
    }
}

function validatePrefix(prefix: string): void {
    if (typeof prefix !== 'string' || prefix === '') {
        throw new TypeError(
            `[cache-hub] rate-limit prefix 必须为非空字符串，收到: ${JSON.stringify(prefix)}`
        );
    }
}

function validatePositiveInteger(name: string, value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`[cache-hub] ${name} 必须为正数，收到: ${JSON.stringify(value)}`);
    }
    return Math.floor(value);
}

function toNumber(value: unknown): number {
    if (typeof value === 'bigint') {
        return Number(value);
    }
    return Number(value);
}

function escapeRedisGlobLiteral(value: string): string {
    return value.replace(/[\\*?[\]]/g, '\\$&');
}

function createResult(
    key: string,
    hits: number,
    limit: number,
    resetAt: number,
    now: number,
): FixedWindowRateLimitResult {
    return {
        key,
        hits,
        limit,
        remaining: Math.max(limit - hits, 0),
        resetTime: new Date(resetAt),
        retryAfterMs: Math.max(resetAt - now, 0),
    };
}

/**
 * 单进程内存固定窗口限流存储。
 */
export class MemoryFixedWindowRateLimitStore implements FixedWindowRateLimitStore {
    private readonly _store = new Map<string, FixedWindowEntry>();

    increment(
        key: string,
        windowMs: number,
        limit: number,
        delta = 1,
    ): FixedWindowRateLimitResult {
        validateKey(key);
        const normalizedWindowMs = validatePositiveInteger('windowMs', windowMs);
        const normalizedLimit = validatePositiveInteger('limit', limit);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const now = Date.now();

        let entry = this._store.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { hits: 0, resetAt: now + normalizedWindowMs };
            this._store.set(key, entry);
        }

        entry.hits += normalizedDelta;
        return createResult(key, entry.hits, normalizedLimit, entry.resetAt, now);
    }

    decrement(key: string, delta = 1): number {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const now = Date.now();
        const entry = this._store.get(key);

        if (!entry) {
            return 0;
        }
        if (entry.resetAt <= now) {
            this._store.delete(key);
            return 0;
        }

        entry.hits = Math.max(entry.hits - normalizedDelta, 0);
        return entry.hits;
    }

    reset(key: string): boolean {
        validateKey(key);
        return this._store.delete(key);
    }

    resetPrefix(prefix: string): number {
        validatePrefix(prefix);
        let count = 0;
        for (const key of this._store.keys()) {
            if (key.startsWith(prefix)) {
                this._store.delete(key);
                count++;
            }
        }
        return count;
    }
}

/**
 * Redis 固定窗口限流存储。
 */
export class RedisFixedWindowRateLimitStore implements FixedWindowRateLimitStore {
    private readonly _redis: RedisFixedWindowRateLimitClient;

    constructor(redisOrAdapter: RedisFixedWindowRateLimitClient | { getRedisInstance(): object }) {
        this._redis = 'getRedisInstance' in redisOrAdapter
            ? redisOrAdapter.getRedisInstance() as RedisFixedWindowRateLimitClient
            : redisOrAdapter;
    }

    async increment(
        key: string,
        windowMs: number,
        limit: number,
        delta = 1,
    ): Promise<FixedWindowRateLimitResult> {
        validateKey(key);
        const normalizedWindowMs = validatePositiveInteger('windowMs', windowMs);
        const normalizedLimit = validatePositiveInteger('limit', limit);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const now = Date.now();
        const response = await this._redis.eval(
            REDIS_INCREMENT_SCRIPT,
            1,
            key,
            normalizedDelta,
            normalizedWindowMs,
        ) as [unknown, unknown];
        const hits = toNumber(response[0]);
        const ttl = toNumber(response[1]);
        return createResult(key, hits, normalizedLimit, now + ttl, now);
    }

    async decrement(key: string, delta = 1): Promise<number> {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const response = await this._redis.eval(
            REDIS_DECREMENT_SCRIPT,
            1,
            key,
            normalizedDelta,
        );
        return toNumber(response);
    }

    async reset(key: string): Promise<boolean> {
        validateKey(key);
        const deleted = await this._redis.del(key);
        return deleted > 0;
    }

    async resetPrefix(prefix: string): Promise<number> {
        validatePrefix(prefix);
        let cursor = '0';
        let count = 0;

        do {
            const [nextCursor, keys] = await this._redis.scan(
                cursor,
                'MATCH',
                `${escapeRedisGlobLiteral(prefix)}*`,
                'COUNT',
                SCAN_COUNT,
            );
            cursor = nextCursor;

            if (keys.length > 0) {
                count += await this._redis.del(...keys);
            }
        } while (cursor !== '0');

        return count;
    }
}

export function createMemoryFixedWindowRateLimitStore(): MemoryFixedWindowRateLimitStore {
    return new MemoryFixedWindowRateLimitStore();
}

export function createRedisFixedWindowRateLimitStore(
    redisOrAdapter: RedisFixedWindowRateLimitClient | { getRedisInstance(): object },
): RedisFixedWindowRateLimitStore {
    return new RedisFixedWindowRateLimitStore(redisOrAdapter);
}
