import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MemoryFixedWindowRateLimitStore,
    RedisFixedWindowRateLimitStore,
    createMemoryFixedWindowRateLimitStore,
    createRedisFixedWindowRateLimitStore,
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
});
