/**
 * 通用原子状态后端。
 *
 * 该模块不修改 CacheLike 契约，面向高并发状态读改写场景提供独立入口。
 */

import type {
    AtomicCounterResult,
    AtomicStateBackend,
    RedisAtomicStateClient,
} from './types.js';
export type {
    AtomicCounterResult,
    AtomicStateBackend,
    RedisAtomicStateClient,
} from './types.js';

const SCAN_COUNT = 100;

const REDIS_INCREMENT_WITH_TTL_SCRIPT = `
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

interface AtomicCounterEntry {
    value: number;
    expiresAt: number;
}

function validateKey(key: string): void {
    if (typeof key !== 'string' || key === '') {
        throw new TypeError(
            `[cache-hub] atomic key 必须为非空字符串，收到: ${JSON.stringify(key)}`
        );
    }
}

function validatePrefix(prefix: string): void {
    if (typeof prefix !== 'string' || prefix === '') {
        throw new TypeError(
            `[cache-hub] atomic prefix 必须为非空字符串，收到: ${JSON.stringify(prefix)}`
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

function createCounterResult(key: string, value: number, ttlMs: number | null): AtomicCounterResult {
    return { key, value, ttlMs };
}

/**
 * 单进程内存原子状态后端。
 */
export class MemoryAtomicStateBackend implements AtomicStateBackend {
    private readonly _counters = new Map<string, AtomicCounterEntry>();
    private _nextPruneAt = Number.POSITIVE_INFINITY;

    private _trackPruneAt(expiresAt: number): void {
        if (expiresAt < this._nextPruneAt) {
            this._nextPruneAt = expiresAt;
        }
    }

    private _refreshNextPruneAt(): void {
        let nextPruneAt = Number.POSITIVE_INFINITY;
        for (const entry of this._counters.values()) {
            nextPruneAt = Math.min(nextPruneAt, entry.expiresAt);
        }
        this._nextPruneAt = nextPruneAt;
    }

    private _cleanupExpiredIfDue(now: number): number {
        if (now < this._nextPruneAt) {
            return 0;
        }
        return this.cleanupExpired(now);
    }

    cleanupExpired(now = Date.now()): number {
        let count = 0;
        let nextPruneAt = Number.POSITIVE_INFINITY;

        for (const [key, entry] of this._counters) {
            if (entry.expiresAt <= now) {
                this._counters.delete(key);
                count++;
                continue;
            }
            nextPruneAt = Math.min(nextPruneAt, entry.expiresAt);
        }

        this._nextPruneAt = nextPruneAt;
        return count;
    }

    incrementWithTtl(key: string, delta: number, ttlMs: number): AtomicCounterResult {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const normalizedTtlMs = validatePositiveInteger('ttlMs', ttlMs);
        const now = Date.now();
        this._cleanupExpiredIfDue(now);
        let entry = this._counters.get(key);

        if (!entry || entry.expiresAt <= now) {
            entry = { value: 0, expiresAt: now + normalizedTtlMs };
            this._counters.set(key, entry);
            this._trackPruneAt(entry.expiresAt);
        }

        entry.value += normalizedDelta;
        return createCounterResult(key, entry.value, Math.max(entry.expiresAt - now, 0));
    }

    decrement(key: string, delta = 1): number {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const now = Date.now();
        this._cleanupExpiredIfDue(now);
        const entry = this._counters.get(key);

        if (!entry) {
            return 0;
        }

        entry.value = Math.max(entry.value - normalizedDelta, 0);
        return entry.value;
    }

    reset(key: string): boolean {
        validateKey(key);
        const entry = this._counters.get(key);
        const deleted = this._counters.delete(key);
        if (deleted && entry?.expiresAt === this._nextPruneAt) {
            this._refreshNextPruneAt();
        }
        return deleted;
    }

    resetPrefix(prefix: string): number {
        validatePrefix(prefix);
        let count = 0;

        for (const key of this._counters.keys()) {
            if (key.startsWith(prefix)) {
                this._counters.delete(key);
                count++;
            }
        }

        if (count > 0) {
            this._refreshNextPruneAt();
        }
        return count;
    }
}

/**
 * Redis 原子状态后端。
 */
export class RedisAtomicStateBackend implements AtomicStateBackend {
    private readonly _redis: RedisAtomicStateClient;

    constructor(redisOrAdapter: RedisAtomicStateClient | { getRedisInstance(): object }) {
        this._redis = 'getRedisInstance' in redisOrAdapter
            ? redisOrAdapter.getRedisInstance() as RedisAtomicStateClient
            : redisOrAdapter;
    }

    async incrementWithTtl(key: string, delta: number, ttlMs: number): Promise<AtomicCounterResult> {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        const normalizedTtlMs = validatePositiveInteger('ttlMs', ttlMs);
        const response = await this._redis.eval(
            REDIS_INCREMENT_WITH_TTL_SCRIPT,
            1,
            key,
            normalizedDelta,
            normalizedTtlMs,
        ) as [unknown, unknown];

        return createCounterResult(key, toNumber(response[0]), toNumber(response[1]));
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

export function createMemoryAtomicStateBackend(): MemoryAtomicStateBackend {
    return new MemoryAtomicStateBackend();
}

export function createRedisAtomicStateBackend(
    redisOrAdapter: RedisAtomicStateClient | { getRedisInstance(): object },
): RedisAtomicStateBackend {
    return new RedisAtomicStateBackend(redisOrAdapter);
}
