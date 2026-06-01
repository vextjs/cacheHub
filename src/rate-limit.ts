/**
 * 限流专用可选原语。
 *
 * 该模块不改变 CacheLike 必需接口，用于未来 rate limiter adapter 以独立入口接入。
 */

import type {
    FixedWindowRateLimitResult,
    FixedWindowRateLimitStore,
    LeakyBucketRateLimitResult,
    RateLimitStateStore,
    RedisFixedWindowRateLimitClient,
    RedisRateLimitStateClient,
    SlidingWindowRateLimitResult,
    TokenBucketRateLimitResult,
} from './types.js';
import { MemoryAtomicStateBackend, RedisAtomicStateBackend } from './atomic.js';
export type {
    FixedWindowRateLimitResult,
    FixedWindowRateLimitStore,
    LeakyBucketRateLimitResult,
    RateLimitStateStore,
    RedisFixedWindowRateLimitClient,
    RedisRateLimitStateClient,
    SlidingWindowRateLimitResult,
    TokenBucketRateLimitResult,
} from './types.js';

const SCAN_COUNT = 100;

const REDIS_SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local tokenPrefix = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfterMs = windowMs
if oldest[2] then
  retryAfterMs = math.max(0, tonumber(oldest[2]) + windowMs - now)
end

if count + cost > limit then
  redis.call('PEXPIRE', key, windowMs)
  return { 0, count, retryAfterMs, '' }
end

local members = {}
for i = 1, cost do
  local member = tokenPrefix .. ':' .. i
  redis.call('ZADD', key, now, member)
  members[i] = member
end

redis.call('PEXPIRE', key, windowMs)
count = redis.call('ZCARD', key)
oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
retryAfterMs = windowMs
if oldest[2] then
  retryAfterMs = math.max(0, tonumber(oldest[2]) + windowMs - now)
end

return { 1, count, retryAfterMs, table.concat(members, '|') }
`;

const REDIS_SLIDING_WINDOW_ROLLBACK_SCRIPT = `
local removed = 0
for token in string.gmatch(ARGV[1], '([^|]+)') do
  removed = removed + redis.call('ZREM', KEYS[1], token)
end
return removed
`;

const REDIS_TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerSecond = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(values[1]) or capacity
local updatedAt = tonumber(values[2]) or now
local elapsed = math.max(0, now - updatedAt)

tokens = math.min(capacity, tokens + elapsed * refillPerSecond / 1000)
local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retryAfterMs = math.ceil((cost - tokens) / refillPerSecond * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerSecond * 1000))
local resetAfterMs = math.ceil((capacity - tokens) / refillPerSecond * 1000)
return { allowed, tokens, retryAfterMs, resetAfterMs }
`;

const REDIS_TOKEN_BUCKET_ROLLBACK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local refillPerSecond = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'tokens')

if not values[1] then
  return 0
end

local tokens = math.min(capacity, tonumber(values[1]) + cost)
redis.call('HSET', key, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerSecond * 1000))
return 1
`;

const REDIS_LEAKY_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local leakPerSecond = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'level', 'updatedAt')
local level = tonumber(values[1]) or 0
local updatedAt = tonumber(values[2]) or now
local elapsed = math.max(0, now - updatedAt)

level = math.max(0, level - elapsed * leakPerSecond / 1000)
local allowed = 0
local retryAfterMs = 0

if level + cost <= capacity then
  allowed = 1
  level = level + cost
else
  retryAfterMs = math.ceil((level + cost - capacity) / leakPerSecond * 1000)
end

redis.call('HSET', key, 'level', level, 'updatedAt', now)
redis.call('PEXPIRE', key, math.ceil(capacity / leakPerSecond * 1000))
local resetAfterMs = math.ceil(level / leakPerSecond * 1000)
return { allowed, level, retryAfterMs, resetAfterMs }
`;

const REDIS_LEAKY_BUCKET_ROLLBACK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local leakPerSecond = tonumber(ARGV[4])
local values = redis.call('HMGET', key, 'level')

if not values[1] then
  return 0
end

local level = math.max(0, tonumber(values[1]) - cost)
redis.call('HSET', key, 'level', level, 'updatedAt', now)
redis.call('PEXPIRE', key, math.ceil(capacity / leakPerSecond * 1000))
return 1
`;

interface SlidingWindowEntry {
    timestamp: number;
    token: string;
}

interface TokenBucketEntry {
    tokens: number;
    updatedAt: number;
}

interface LeakyBucketEntry {
    level: number;
    updatedAt: number;
}

interface ParsedBucketToken {
    cost: number;
    capacity: number;
    ratePerSecond: number;
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

function validatePositiveNumber(name: string, value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`[cache-hub] ${name} 必须为正数，收到: ${JSON.stringify(value)}`);
    }
    return value;
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

function createOpaqueToken(prefix: string): string {
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function createBucketRollbackToken(prefix: string, cost: number, capacity: number, ratePerSecond: number): string {
    return `${prefix}:${cost}:${capacity}:${ratePerSecond}`;
}

function parseBucketRollbackToken(prefix: string, rollbackToken: string): ParsedBucketToken {
    const [actualPrefix, cost, capacity, ratePerSecond] = rollbackToken.split(':');

    if (actualPrefix !== prefix) {
        throw new TypeError(`[cache-hub] rollbackToken 无效，预期 ${prefix} token`);
    }

    return {
        cost: validatePositiveNumber('rollbackToken.cost', Number(cost)),
        capacity: validatePositiveNumber('rollbackToken.capacity', Number(capacity)),
        ratePerSecond: validatePositiveNumber('rollbackToken.ratePerSecond', Number(ratePerSecond)),
    };
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

function createSlidingWindowResult(
    key: string,
    count: number,
    limit: number,
    retryAfterMs: number,
    now: number,
    rollbackToken?: string,
): SlidingWindowRateLimitResult {
    return {
        key,
        count,
        limit,
        allowed: rollbackToken !== undefined,
        remaining: Math.max(limit - count, 0),
        resetTime: new Date(now + retryAfterMs),
        retryAfterMs,
        ...(rollbackToken === undefined ? {} : { rollbackToken }),
    };
}

function createTokenBucketResult(
    key: string,
    tokens: number,
    capacity: number,
    retryAfterMs: number,
    resetAfterMs: number,
    now: number,
    rollbackToken?: string,
): TokenBucketRateLimitResult {
    return {
        key,
        allowed: rollbackToken !== undefined,
        tokens,
        capacity,
        remaining: Math.floor(tokens),
        resetTime: new Date(now + resetAfterMs),
        retryAfterMs,
        ...(rollbackToken === undefined ? {} : { rollbackToken }),
    };
}

function createLeakyBucketResult(
    key: string,
    waterLevel: number,
    capacity: number,
    retryAfterMs: number,
    resetAfterMs: number,
    now: number,
    rollbackToken?: string,
): LeakyBucketRateLimitResult {
    return {
        key,
        allowed: rollbackToken !== undefined,
        waterLevel,
        capacity,
        remaining: Math.max(Math.floor(capacity - waterLevel), 0),
        resetTime: new Date(now + resetAfterMs),
        retryAfterMs,
        ...(rollbackToken === undefined ? {} : { rollbackToken }),
    };
}

/**
 * 单进程内存固定窗口限流存储。
 */
export class MemoryFixedWindowRateLimitStore implements FixedWindowRateLimitStore {
    private readonly _atomic = new MemoryAtomicStateBackend();

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
        const result = this._atomic.incrementWithTtl(key, normalizedDelta, normalizedWindowMs);
        return createResult(key, result.value, normalizedLimit, now + (result.ttlMs as number), now);
    }

    decrement(key: string, delta = 1): number {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        return this._atomic.decrement(key, normalizedDelta);
    }

    reset(key: string): boolean {
        validateKey(key);
        return this._atomic.reset(key);
    }

    resetPrefix(prefix: string): number {
        validatePrefix(prefix);
        return this._atomic.resetPrefix(prefix);
    }
}

/**
 * Redis 固定窗口限流存储。
 */
export class RedisFixedWindowRateLimitStore implements FixedWindowRateLimitStore {
    private readonly _atomic: RedisAtomicStateBackend;

    constructor(redisOrAdapter: RedisFixedWindowRateLimitClient | { getRedisInstance(): object }) {
        this._atomic = new RedisAtomicStateBackend(redisOrAdapter);
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
        const result = await this._atomic.incrementWithTtl(key, normalizedDelta, normalizedWindowMs);
        return createResult(key, result.value, normalizedLimit, now + (result.ttlMs as number), now);
    }

    async decrement(key: string, delta = 1): Promise<number> {
        validateKey(key);
        const normalizedDelta = validatePositiveInteger('delta', delta);
        return this._atomic.decrement(key, normalizedDelta);
    }

    async reset(key: string): Promise<boolean> {
        validateKey(key);
        return this._atomic.reset(key);
    }

    async resetPrefix(prefix: string): Promise<number> {
        validatePrefix(prefix);
        return this._atomic.resetPrefix(prefix);
    }
}

/**
 * 单进程限流状态原语。
 */
export class MemoryRateLimitStateStore implements RateLimitStateStore {
    private readonly _atomic = new MemoryAtomicStateBackend();
    private readonly _slidingWindows = new Map<string, SlidingWindowEntry[]>();
    private readonly _tokenBuckets = new Map<string, TokenBucketEntry>();
    private readonly _leakyBuckets = new Map<string, LeakyBucketEntry>();

    checkSlidingWindow(key: string, windowMs: number, limit: number, cost = 1): SlidingWindowRateLimitResult {
        validateKey(key);
        const normalizedWindowMs = validatePositiveInteger('windowMs', windowMs);
        const normalizedLimit = validatePositiveInteger('limit', limit);
        const normalizedCost = validatePositiveInteger('cost', cost);
        const now = Date.now();
        const threshold = now - normalizedWindowMs;
        const entries = (this._slidingWindows.get(key) ?? []).filter((entry) => entry.timestamp > threshold);
        const count = entries.length;
        const retryAfterMs = entries.length === 0
            ? normalizedWindowMs
            : Math.max(entries[0].timestamp + normalizedWindowMs - now, 0);

        if (count + normalizedCost > normalizedLimit) {
            this._slidingWindows.set(key, entries);
            return createSlidingWindowResult(key, count, normalizedLimit, retryAfterMs, now);
        }

        const rollbackToken = createOpaqueToken('sw');
        for (let i = 0; i < normalizedCost; i++) {
            entries.push({ timestamp: now, token: `${rollbackToken}:${i}` });
        }
        this._slidingWindows.set(key, entries);

        return createSlidingWindowResult(
            key,
            entries.length,
            normalizedLimit,
            Math.max(entries[0].timestamp + normalizedWindowMs - now, 0),
            now,
            entries.slice(-normalizedCost).map((entry) => entry.token).join('|'),
        );
    }

    rollbackSlidingWindow(key: string, rollbackToken: string): boolean {
        validateKey(key);
        validateKey(rollbackToken);
        const tokens = new Set(rollbackToken.split('|'));
        const entries = this._slidingWindows.get(key);

        if (!entries) {
            return false;
        }

        const next = entries.filter((entry) => !tokens.has(entry.token));
        this._slidingWindows.set(key, next);
        return next.length !== entries.length;
    }

    consumeTokenBucket(
        key: string,
        capacity: number,
        refillPerSecond: number,
        cost = 1,
    ): TokenBucketRateLimitResult {
        validateKey(key);
        const normalizedCapacity = validatePositiveNumber('capacity', capacity);
        const normalizedRefillPerSecond = validatePositiveNumber('refillPerSecond', refillPerSecond);
        const normalizedCost = validatePositiveNumber('cost', cost);
        const now = Date.now();
        const entry = this._tokenBuckets.get(key) ?? { tokens: normalizedCapacity, updatedAt: now };
        const elapsedMs = Math.max(now - entry.updatedAt, 0);
        const tokens = Math.min(
            normalizedCapacity,
            entry.tokens + elapsedMs * normalizedRefillPerSecond / 1000,
        );

        if (tokens < normalizedCost) {
            const retryAfterMs = Math.ceil((normalizedCost - tokens) / normalizedRefillPerSecond * 1000);
            this._tokenBuckets.set(key, { tokens, updatedAt: now });
            return createTokenBucketResult(
                key,
                tokens,
                normalizedCapacity,
                retryAfterMs,
                Math.ceil((normalizedCapacity - tokens) / normalizedRefillPerSecond * 1000),
                now,
            );
        }

        const nextTokens = tokens - normalizedCost;
        this._tokenBuckets.set(key, { tokens: nextTokens, updatedAt: now });
        return createTokenBucketResult(
            key,
            nextTokens,
            normalizedCapacity,
            0,
            Math.ceil((normalizedCapacity - nextTokens) / normalizedRefillPerSecond * 1000),
            now,
            createBucketRollbackToken('tb', normalizedCost, normalizedCapacity, normalizedRefillPerSecond),
        );
    }

    rollbackTokenBucket(key: string, rollbackToken: string): boolean {
        validateKey(key);
        const { cost, capacity } = parseBucketRollbackToken('tb', rollbackToken);
        const entry = this._tokenBuckets.get(key);

        if (!entry) {
            return false;
        }

        entry.tokens = Math.min(entry.tokens + cost, capacity);
        entry.updatedAt = Date.now();
        return true;
    }

    consumeLeakyBucket(
        key: string,
        capacity: number,
        leakPerSecond: number,
        cost = 1,
    ): LeakyBucketRateLimitResult {
        validateKey(key);
        const normalizedCapacity = validatePositiveNumber('capacity', capacity);
        const normalizedLeakPerSecond = validatePositiveNumber('leakPerSecond', leakPerSecond);
        const normalizedCost = validatePositiveNumber('cost', cost);
        const now = Date.now();
        const entry = this._leakyBuckets.get(key) ?? { level: 0, updatedAt: now };
        const elapsedMs = Math.max(now - entry.updatedAt, 0);
        const level = Math.max(0, entry.level - elapsedMs * normalizedLeakPerSecond / 1000);

        if (level + normalizedCost > normalizedCapacity) {
            const retryAfterMs = Math.ceil((level + normalizedCost - normalizedCapacity) / normalizedLeakPerSecond * 1000);
            this._leakyBuckets.set(key, { level, updatedAt: now });
            return createLeakyBucketResult(
                key,
                level,
                normalizedCapacity,
                retryAfterMs,
                Math.ceil(level / normalizedLeakPerSecond * 1000),
                now,
            );
        }

        const nextLevel = level + normalizedCost;
        this._leakyBuckets.set(key, { level: nextLevel, updatedAt: now });
        return createLeakyBucketResult(
            key,
            nextLevel,
            normalizedCapacity,
            0,
            Math.ceil(nextLevel / normalizedLeakPerSecond * 1000),
            now,
            createBucketRollbackToken('lb', normalizedCost, normalizedCapacity, normalizedLeakPerSecond),
        );
    }

    rollbackLeakyBucket(key: string, rollbackToken: string): boolean {
        validateKey(key);
        const { cost } = parseBucketRollbackToken('lb', rollbackToken);
        const entry = this._leakyBuckets.get(key);

        if (!entry) {
            return false;
        }

        entry.level = Math.max(entry.level - cost, 0);
        entry.updatedAt = Date.now();
        return true;
    }

    reset(key: string): boolean {
        validateKey(key);
        const atomicDeleted = this._atomic.reset(key);
        const slidingDeleted = this._slidingWindows.delete(key);
        const tokenDeleted = this._tokenBuckets.delete(key);
        const leakyDeleted = this._leakyBuckets.delete(key);
        return atomicDeleted || slidingDeleted || tokenDeleted || leakyDeleted;
    }

    resetPrefix(prefix: string): number {
        validatePrefix(prefix);
        const keys = new Set<string>();

        for (const key of this._slidingWindows.keys()) {
            if (key.startsWith(prefix)) {
                keys.add(key);
            }
        }
        for (const key of this._tokenBuckets.keys()) {
            if (key.startsWith(prefix)) {
                keys.add(key);
            }
        }
        for (const key of this._leakyBuckets.keys()) {
            if (key.startsWith(prefix)) {
                keys.add(key);
            }
        }

        const atomicCount = this._atomic.resetPrefix(prefix);
        for (const key of keys) {
            this._slidingWindows.delete(key);
            this._tokenBuckets.delete(key);
            this._leakyBuckets.delete(key);
        }

        return atomicCount + keys.size;
    }
}

/**
 * Redis 限流状态原语。
 */
export class RedisRateLimitStateStore implements RateLimitStateStore {
    private readonly _redis: RedisRateLimitStateClient;
    private readonly _atomic: RedisAtomicStateBackend;

    constructor(redisOrAdapter: RedisRateLimitStateClient | { getRedisInstance(): object }) {
        this._redis = 'getRedisInstance' in redisOrAdapter
            ? redisOrAdapter.getRedisInstance() as RedisRateLimitStateClient
            : redisOrAdapter;
        this._atomic = new RedisAtomicStateBackend(redisOrAdapter);
    }

    async checkSlidingWindow(
        key: string,
        windowMs: number,
        limit: number,
        cost = 1,
    ): Promise<SlidingWindowRateLimitResult> {
        validateKey(key);
        const normalizedWindowMs = validatePositiveInteger('windowMs', windowMs);
        const normalizedLimit = validatePositiveInteger('limit', limit);
        const normalizedCost = validatePositiveInteger('cost', cost);
        const now = Date.now();
        const tokenPrefix = createOpaqueToken('sw');
        const response = await this._redis.eval(
            REDIS_SLIDING_WINDOW_SCRIPT,
            1,
            key,
            now,
            normalizedWindowMs,
            normalizedLimit,
            normalizedCost,
            tokenPrefix,
        ) as [unknown, unknown, unknown, unknown];
        const allowed = toNumber(response[0]) === 1;
        const count = toNumber(response[1]);
        const retryAfterMs = toNumber(response[2]);
        const rollbackToken = typeof response[3] === 'string' && response[3] !== ''
            ? response[3]
            : undefined;

        return createSlidingWindowResult(
            key,
            count,
            normalizedLimit,
            retryAfterMs,
            now,
            allowed ? rollbackToken : undefined,
        );
    }

    async rollbackSlidingWindow(key: string, rollbackToken: string): Promise<boolean> {
        validateKey(key);
        validateKey(rollbackToken);
        const removed = await this._redis.eval(
            REDIS_SLIDING_WINDOW_ROLLBACK_SCRIPT,
            1,
            key,
            rollbackToken,
        );
        return toNumber(removed) > 0;
    }

    async consumeTokenBucket(
        key: string,
        capacity: number,
        refillPerSecond: number,
        cost = 1,
    ): Promise<TokenBucketRateLimitResult> {
        validateKey(key);
        const normalizedCapacity = validatePositiveNumber('capacity', capacity);
        const normalizedRefillPerSecond = validatePositiveNumber('refillPerSecond', refillPerSecond);
        const normalizedCost = validatePositiveNumber('cost', cost);
        const now = Date.now();
        const response = await this._redis.eval(
            REDIS_TOKEN_BUCKET_SCRIPT,
            1,
            key,
            now,
            normalizedCapacity,
            normalizedRefillPerSecond,
            normalizedCost,
        ) as [unknown, unknown, unknown, unknown];
        const allowed = toNumber(response[0]) === 1;
        const tokens = toNumber(response[1]);
        const retryAfterMs = toNumber(response[2]);
        const resetAfterMs = toNumber(response[3]);

        return createTokenBucketResult(
            key,
            tokens,
            normalizedCapacity,
            retryAfterMs,
            resetAfterMs,
            now,
            allowed
                ? createBucketRollbackToken('tb', normalizedCost, normalizedCapacity, normalizedRefillPerSecond)
                : undefined,
        );
    }

    async rollbackTokenBucket(key: string, rollbackToken: string): Promise<boolean> {
        validateKey(key);
        const { cost, capacity, ratePerSecond } = parseBucketRollbackToken('tb', rollbackToken);
        const rolledBack = await this._redis.eval(
            REDIS_TOKEN_BUCKET_ROLLBACK_SCRIPT,
            1,
            key,
            Date.now(),
            cost,
            capacity,
            ratePerSecond,
        );
        return toNumber(rolledBack) > 0;
    }

    async consumeLeakyBucket(
        key: string,
        capacity: number,
        leakPerSecond: number,
        cost = 1,
    ): Promise<LeakyBucketRateLimitResult> {
        validateKey(key);
        const normalizedCapacity = validatePositiveNumber('capacity', capacity);
        const normalizedLeakPerSecond = validatePositiveNumber('leakPerSecond', leakPerSecond);
        const normalizedCost = validatePositiveNumber('cost', cost);
        const now = Date.now();
        const response = await this._redis.eval(
            REDIS_LEAKY_BUCKET_SCRIPT,
            1,
            key,
            now,
            normalizedCapacity,
            normalizedLeakPerSecond,
            normalizedCost,
        ) as [unknown, unknown, unknown, unknown];
        const allowed = toNumber(response[0]) === 1;
        const level = toNumber(response[1]);
        const retryAfterMs = toNumber(response[2]);
        const resetAfterMs = toNumber(response[3]);

        return createLeakyBucketResult(
            key,
            level,
            normalizedCapacity,
            retryAfterMs,
            resetAfterMs,
            now,
            allowed
                ? createBucketRollbackToken('lb', normalizedCost, normalizedCapacity, normalizedLeakPerSecond)
                : undefined,
        );
    }

    async rollbackLeakyBucket(key: string, rollbackToken: string): Promise<boolean> {
        validateKey(key);
        const { cost, capacity, ratePerSecond } = parseBucketRollbackToken('lb', rollbackToken);
        const rolledBack = await this._redis.eval(
            REDIS_LEAKY_BUCKET_ROLLBACK_SCRIPT,
            1,
            key,
            Date.now(),
            cost,
            capacity,
            ratePerSecond,
        );
        return toNumber(rolledBack) > 0;
    }

    async reset(key: string): Promise<boolean> {
        validateKey(key);
        return this._atomic.reset(key);
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

export function createMemoryRateLimitStateStore(): MemoryRateLimitStateStore {
    return new MemoryRateLimitStateStore();
}

export function createRedisRateLimitStateStore(
    redisOrAdapter: RedisRateLimitStateClient | { getRedisInstance(): object },
): RedisRateLimitStateStore {
    return new RedisRateLimitStateStore(redisOrAdapter);
}
