import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MemoryFixedWindowRateLimitStore,
    MemoryRateLimitStateStore,
    RedisFixedWindowRateLimitStore,
    RedisRateLimitStateStore,
    createMemoryFixedWindowRateLimitStore,
    createMemoryRateLimitStateStore,
    createRedisFixedWindowRateLimitStore,
    createRedisRateLimitStateStore,
} from '../../src/rate-limit.js';

function makeRedis() {
    return {
        eval: vi.fn(),
        del: vi.fn(),
        scan: vi.fn(),
    };
}

describe('rate-limit fixed-window primitives', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    describe('MemoryFixedWindowRateLimitStore', () => {
        it('increment 创建窗口并返回剩余额度与重置时间', () => {
            const store = new MemoryFixedWindowRateLimitStore();
            const result = store.increment('rl:user:1', 1000, 5);

            expect(result).toMatchObject({
                key: 'rl:user:1',
                hits: 1,
                limit: 5,
                remaining: 4,
            });
            expect(result.resetTime).toBeInstanceOf(Date);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it('increment 复用当前窗口并在超限时 remaining 保持 0', () => {
            const store = createMemoryFixedWindowRateLimitStore();

            store.increment('rl:user:1', 1000, 2);
            const result = store.increment('rl:user:1', 1000, 2, 2);

            expect(result.hits).toBe(3);
            expect(result.remaining).toBe(0);
        });

        it('窗口过期后重新计数', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryFixedWindowRateLimitStore();

            store.increment('rl:user:1', 1000, 5, 3);
            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));
            const result = store.increment('rl:user:1', 1000, 5);

            expect(result.hits).toBe(1);
            expect(result.remaining).toBe(4);
        });

        it('decrement 支持回滚并保持非负', () => {
            const store = new MemoryFixedWindowRateLimitStore();

            store.increment('rl:user:1', 1000, 5, 3);

            expect(store.decrement('rl:user:1')).toBe(2);
            expect(store.decrement('rl:user:1', 10)).toBe(0);
        });

        it('decrement 对不存在或已过期 key 返回 0', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryFixedWindowRateLimitStore();

            expect(store.decrement('missing')).toBe(0);
            store.increment('rl:user:1', 1000, 5);
            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));

            expect(store.decrement('rl:user:1')).toBe(0);
        });

        it('reset 与 resetPrefix 删除指定计数', () => {
            const store = new MemoryFixedWindowRateLimitStore();

            store.increment('rl:user:1', 1000, 5);
            store.increment('rl:user:2', 1000, 5);
            store.increment('other:user:1', 1000, 5);

            expect(store.reset('rl:user:1')).toBe(true);
            expect(store.reset('rl:user:1')).toBe(false);
            expect(store.resetPrefix('rl:')).toBe(1);
            expect(store.resetPrefix('none:')).toBe(0);
        });

        it('cleanupExpired 回收过期固定窗口计数', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryFixedWindowRateLimitStore();

            for (let i = 0; i < 1000; i++) {
                store.increment(`rl:user:${i}`, 1000, 10);
            }

            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));

            expect(store.cleanupExpired()).toBe(1000);
            expect(store.cleanupExpired()).toBe(0);
        });

        it('校验非法参数', () => {
            const store = new MemoryFixedWindowRateLimitStore();

            expect(() => store.increment('', 1000, 5)).toThrow(TypeError);
            expect(() => store.increment('k', 0, 5)).toThrow(RangeError);
            expect(() => store.increment('k', Infinity, 5)).toThrow(RangeError);
            expect(() => store.increment('k', 1000, 0)).toThrow(RangeError);
            expect(() => store.increment('k', 1000, 5, 0)).toThrow(RangeError);
            expect(() => store.resetPrefix('')).toThrow(TypeError);
            expect(() => store.resetPrefix(null as any)).toThrow(TypeError);
        });
    });

    describe('RedisFixedWindowRateLimitStore', () => {
        it('increment 使用 Lua 原子脚本并解析 number 响应', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue([2, 900]);
            const store = new RedisFixedWindowRateLimitStore(redis);

            const result = await store.increment('rl:user:1', 1000, 5, 2);

            expect(redis.eval.mock.calls[0][0]).toContain('INCRBY');
            expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'rl:user:1', 2, 1000]);
            expect(result.hits).toBe(2);
            expect(result.remaining).toBe(3);
        });

        it('increment 支持从 adapter 获取 Redis 实例并解析 bigint 响应', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue([3n, 800n]);
            const adapter = { getRedisInstance: () => redis };
            const store = createRedisFixedWindowRateLimitStore(adapter);

            const result = await store.increment('rl:user:1', 1000, 5);

            expect(result.hits).toBe(3);
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });

        it('decrement 使用 Lua 脚本并返回剩余 hits', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue(4);
            const store = new RedisFixedWindowRateLimitStore(redis);

            await expect(store.decrement('rl:user:1', 2)).resolves.toBe(4);
            expect(redis.eval.mock.calls[0][0]).toContain('tonumber(current)');
            expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'rl:user:1', 2]);
        });

        it('reset 返回 Redis 删除结果', async () => {
            const redis = makeRedis();
            const store = new RedisFixedWindowRateLimitStore(redis);

            redis.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

            await expect(store.reset('rl:user:1')).resolves.toBe(true);
            await expect(store.reset('rl:user:1')).resolves.toBe(false);
        });

        it('resetPrefix 使用 SCAN 分批删除，禁止 KEYS 风格全量扫描', async () => {
            const redis = makeRedis();
            redis.scan
                .mockResolvedValueOnce(['7', ['rl:a', 'rl:b']])
                .mockResolvedValueOnce(['0', []]);
            redis.del.mockResolvedValue(2);
            const store = new RedisFixedWindowRateLimitStore(redis);

            await expect(store.resetPrefix('rl:')).resolves.toBe(2);
            expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'rl:*', 'COUNT', 100);
            expect(redis.scan).toHaveBeenNthCalledWith(2, '7', 'MATCH', 'rl:*', 'COUNT', 100);
            expect(redis.del).toHaveBeenCalledWith('rl:a', 'rl:b');
        });

        it('resetPrefix 将 prefix 按字面量转义后再拼接通配符', async () => {
            const redis = makeRedis();
            redis.scan.mockResolvedValue(['0', []]);
            const store = new RedisFixedWindowRateLimitStore(redis);

            await store.resetPrefix('rl:user?[1]');

            expect(redis.scan).toHaveBeenCalledWith(
                '0',
                'MATCH',
                'rl:user\\?\\[1\\]*',
                'COUNT',
                100,
            );
        });

        it('校验 Redis 路径非法参数', async () => {
            const redis = makeRedis();
            const store = new RedisFixedWindowRateLimitStore(redis);

            await expect(store.increment('', 1000, 5)).rejects.toThrow(TypeError);
            await expect(store.increment('k', 1000, Number.NaN)).rejects.toThrow(RangeError);
            await expect(store.decrement('k', -1)).rejects.toThrow(RangeError);
            await expect(store.reset('')).rejects.toThrow(TypeError);
            await expect(store.resetPrefix('')).rejects.toThrow(TypeError);
        });
    });

    describe('MemoryRateLimitStateStore', () => {
        it('sliding-window 支持通过、拒绝、回滚与窗口过期', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = createMemoryRateLimitStateStore();

            const first = store.checkSlidingWindow('sw:user:1', 1000, 2);
            expect(first.allowed).toBe(true);
            expect(first.count).toBe(1);
            expect(first.rollbackToken).toBeDefined();

            expect(store.checkSlidingWindow('sw:user:1', 1000, 2).allowed).toBe(true);
            const blocked = store.checkSlidingWindow('sw:user:1', 1000, 2);
            expect(blocked.allowed).toBe(false);
            expect(blocked.retryAfterMs).toBe(1000);
            expect(store.rollbackSlidingWindow('sw:user:1', first.rollbackToken!)).toBe(true);
            expect(store.rollbackSlidingWindow('sw:user:1', first.rollbackToken!)).toBe(false);
            expect(store.rollbackSlidingWindow('missing', first.rollbackToken!)).toBe(false);

            const single = store.checkSlidingWindow('sw:single', 1000, 2);
            expect(store.rollbackSlidingWindow('sw:single', single.rollbackToken!)).toBe(true);
            expect(store.rollbackSlidingWindow('sw:single', single.rollbackToken!)).toBe(false);

            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));
            expect(store.checkSlidingWindow('sw:user:1', 1000, 2).count).toBe(1);
        });

        it('token-bucket 支持消耗、拒绝、补充与回滚', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryRateLimitStateStore();

            const allowed = store.consumeTokenBucket('tb:user:1', 3, 1, 3);
            expect(allowed.allowed).toBe(true);
            expect(allowed.tokens).toBe(0);
            expect(allowed.rollbackToken).toBe('tb:3:3:1');

            const blocked = store.consumeTokenBucket('tb:user:1', 3, 1);
            expect(blocked.allowed).toBe(false);
            expect(blocked.retryAfterMs).toBe(1000);
            expect(store.rollbackTokenBucket('tb:user:1', allowed.rollbackToken!)).toBe(true);
            expect(store.consumeTokenBucket('tb:user:1', 3, 1).allowed).toBe(true);

            vi.setSystemTime(new Date('2026-06-01T00:00:02.000Z'));
            expect(store.consumeTokenBucket('tb:user:1', 3, 1).tokens).toBe(2);
        });

        it('leaky-bucket 支持入水、拒绝、漏出与回滚', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryRateLimitStateStore();

            const allowed = store.consumeLeakyBucket('lb:user:1', 3, 1, 3);
            expect(allowed.allowed).toBe(true);
            expect(allowed.waterLevel).toBe(3);
            expect(allowed.rollbackToken).toBe('lb:3:3:1');

            const blocked = store.consumeLeakyBucket('lb:user:1', 3, 1);
            expect(blocked.allowed).toBe(false);
            expect(blocked.retryAfterMs).toBe(1000);
            expect(store.rollbackLeakyBucket('lb:user:1', allowed.rollbackToken!)).toBe(true);
            expect(store.consumeLeakyBucket('lb:user:1', 3, 1, 2).waterLevel).toBe(2);

            vi.setSystemTime(new Date('2026-06-01T00:00:01.000Z'));
            expect(store.consumeLeakyBucket('lb:user:1', 3, 1, 1).waterLevel).toBe(2);
        });

        it('reset 与 resetPrefix 覆盖所有状态集合', () => {
            const store = new MemoryRateLimitStateStore();

            store.checkSlidingWindow('rl:sw', 1000, 5);
            store.checkSlidingWindow('rl:sw2', 1000, 5);
            store.consumeTokenBucket('rl:tb', 3, 1);
            store.consumeLeakyBucket('rl:lb', 3, 1);
            store.checkSlidingWindow('other:sw', 1000, 5);

            expect(store.reset('rl:sw')).toBe(true);
            expect(store.reset('missing')).toBe(false);
            expect(store.resetPrefix('rl:')).toBe(3);
            expect(store.resetPrefix('none:')).toBe(0);
        });

        it('cleanupExpired 回收 sliding/token/leaky 高基数中性状态', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryRateLimitStateStore();

            for (let i = 0; i < 100; i++) {
                store.checkSlidingWindow(`sw:${i}`, 1000, 10);
                store.consumeTokenBucket(`tb:${i}`, 3, 1, 3);
                store.consumeLeakyBucket(`lb:${i}`, 3, 1, 3);
            }

            vi.setSystemTime(new Date('2026-06-01T00:00:03.001Z'));

            expect(store.cleanupExpired()).toBe(300);
            expect(store.cleanupExpired()).toBe(0);
            expect(store.rollbackTokenBucket('tb:1', 'tb:3:3:1')).toBe(false);
            expect(store.rollbackLeakyBucket('lb:1', 'lb:3:3:1')).toBe(false);
        });

        it('cleanupExpired 保留尚未自然补满或漏空的 bucket 状态', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const store = new MemoryRateLimitStateStore();

            store.checkSlidingWindow('sw:active', 5000, 10);
            store.consumeTokenBucket('tb:slow', 3, 1, 3);
            store.consumeLeakyBucket('lb:slow', 3, 1, 3);

            vi.setSystemTime(new Date('2026-06-01T00:00:01.000Z'));
            expect(store.cleanupExpired()).toBe(0);

            vi.setSystemTime(new Date('2026-06-01T00:00:03.001Z'));
            expect(store.cleanupExpired()).toBe(2);
        });

        it('校验状态原语非法参数与无状态回滚', () => {
            const store = new MemoryRateLimitStateStore();

            expect(() => store.checkSlidingWindow('', 1000, 5)).toThrow(TypeError);
            expect(() => store.checkSlidingWindow('k', 0, 5)).toThrow(RangeError);
            expect(() => store.consumeTokenBucket('k', 0, 1)).toThrow(RangeError);
            expect(() => store.consumeTokenBucket('k', 1, 0)).toThrow(RangeError);
            expect(() => store.consumeLeakyBucket('k', 1, 1, 0)).toThrow(RangeError);
            expect(() => store.rollbackTokenBucket('k', 'lb:1:1:1')).toThrow(TypeError);
            expect(store.rollbackTokenBucket('missing', 'tb:1:1:1')).toBe(false);
            expect(store.rollbackLeakyBucket('missing', 'lb:1:1:1')).toBe(false);
            expect(() => store.resetPrefix('')).toThrow(TypeError);
        });
    });

    describe('RedisRateLimitStateStore', () => {
        it('sliding-window 使用 Lua 原子脚本并解析允许响应', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue([1, 2, 900, 'sw:token:1']);
            const store = new RedisRateLimitStateStore(redis);

            const result = await store.checkSlidingWindow('sw:user:1', 1000, 5, 2);

            expect(redis.eval.mock.calls[0][0]).toContain('ZREMRANGEBYSCORE');
            expect(redis.eval.mock.calls[0].slice(1, 6)).toEqual([1, 'sw:user:1', expect.any(Number), 1000, 5]);
            expect(result).toMatchObject({
                allowed: true,
                count: 2,
                remaining: 3,
                rollbackToken: 'sw:token:1',
            });
        });

        it('sliding-window 解析拒绝响应并支持回滚', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValueOnce([0, 5n, 800n, '']).mockResolvedValueOnce(2);
            const store = createRedisRateLimitStateStore({ getRedisInstance: () => redis });

            const result = await store.checkSlidingWindow('sw:user:1', 1000, 5);

            expect(result.allowed).toBe(false);
            expect(result.retryAfterMs).toBe(800);
            await expect(store.rollbackSlidingWindow('sw:user:1', 'sw:a|sw:b')).resolves.toBe(true);
            expect(redis.eval.mock.calls[1][0]).toContain('ZREM');
        });

        it('token-bucket 使用 Lua 原子脚本并解析通过/拒绝与回滚', async () => {
            const redis = makeRedis();
            redis.eval
                .mockResolvedValueOnce([1, 2, 0, 1000])
                .mockResolvedValueOnce([0, 0.5, 500, 2500])
                .mockResolvedValueOnce(1);
            const store = new RedisRateLimitStateStore(redis);

            const allowed = await store.consumeTokenBucket('tb:user:1', 3, 1, 1);
            const blocked = await store.consumeTokenBucket('tb:user:1', 3, 1, 1);

            expect(redis.eval.mock.calls[0][0]).toContain('HMGET');
            expect(allowed).toMatchObject({ allowed: true, tokens: 2, rollbackToken: 'tb:1:3:1' });
            expect(blocked).toMatchObject({ allowed: false, tokens: 0.5, retryAfterMs: 500 });
            await expect(store.rollbackTokenBucket('tb:user:1', allowed.rollbackToken!)).resolves.toBe(true);
            expect(redis.eval.mock.calls[2][0]).toContain('tokens');
        });

        it('leaky-bucket 使用 Lua 原子脚本并解析通过/拒绝与回滚', async () => {
            const redis = makeRedis();
            redis.eval
                .mockResolvedValueOnce([1, 2, 0, 2000])
                .mockResolvedValueOnce([0, 3, 1000, 3000])
                .mockResolvedValueOnce(1);
            const store = new RedisRateLimitStateStore(redis);

            const allowed = await store.consumeLeakyBucket('lb:user:1', 3, 1, 2);
            const blocked = await store.consumeLeakyBucket('lb:user:1', 3, 1, 2);

            expect(allowed).toMatchObject({ allowed: true, waterLevel: 2, rollbackToken: 'lb:2:3:1' });
            expect(blocked).toMatchObject({ allowed: false, waterLevel: 3, retryAfterMs: 1000 });
            await expect(store.rollbackLeakyBucket('lb:user:1', allowed.rollbackToken!)).resolves.toBe(true);
            expect(redis.eval.mock.calls[2][0]).toContain('level');
        });

        it('resetPrefix 使用 SCAN 分批删除状态键', async () => {
            const redis = makeRedis();
            redis.scan
                .mockResolvedValueOnce(['7', ['rl:a', 'rl:b']])
                .mockResolvedValueOnce(['0', []]);
            redis.del.mockResolvedValue(2);
            const store = new RedisRateLimitStateStore(redis);

            await expect(store.resetPrefix('rl:?')).resolves.toBe(2);
            expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'rl:\\?*', 'COUNT', 100);
        });

        it('校验 Redis 状态路径非法参数与无效 rollback token', async () => {
            const redis = makeRedis();
            const store = new RedisRateLimitStateStore(redis);

            await expect(store.checkSlidingWindow('', 1000, 5)).rejects.toThrow(TypeError);
            await expect(store.checkSlidingWindow('k', 1000, 0)).rejects.toThrow(RangeError);
            await expect(store.rollbackSlidingWindow('k', '')).rejects.toThrow(TypeError);
            await expect(store.consumeTokenBucket('k', 1, Number.NaN)).rejects.toThrow(RangeError);
            await expect(store.rollbackTokenBucket('k', 'lb:1:1:1')).rejects.toThrow(TypeError);
            await expect(store.consumeLeakyBucket('k', 1, 1, -1)).rejects.toThrow(RangeError);
            await expect(store.reset('')).rejects.toThrow(TypeError);
            await expect(store.resetPrefix('')).rejects.toThrow(TypeError);
        });
    });
});
