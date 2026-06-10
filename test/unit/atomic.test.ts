import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    MemoryAtomicStateBackend,
    RedisAtomicStateBackend,
    createMemoryAtomicStateBackend,
    createRedisAtomicStateBackend,
} from '../../src/atomic.js';

function makeRedis() {
    return {
        eval: vi.fn(),
        del: vi.fn(),
        scan: vi.fn(),
    };
}

describe('atomic state backends', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    describe('MemoryAtomicStateBackend', () => {
        it('incrementWithTtl 在 TTL 窗口内累加并返回剩余 TTL', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const backend = createMemoryAtomicStateBackend();

            expect(backend.incrementWithTtl('atomic:k', 2, 1000)).toMatchObject({
                key: 'atomic:k',
                value: 2,
                ttlMs: 1000,
            });

            vi.setSystemTime(new Date('2026-06-01T00:00:00.250Z'));
            expect(backend.incrementWithTtl('atomic:k', 3, 1000)).toMatchObject({
                value: 5,
                ttlMs: 750,
            });
        });

        it('窗口过期后重新计数，decrement 对缺失或过期 key 返回 0', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const backend = new MemoryAtomicStateBackend();

            expect(backend.decrement('missing')).toBe(0);
            backend.incrementWithTtl('atomic:k', 4, 1000);
            expect(backend.decrement('atomic:k')).toBe(3);
            expect(backend.decrement('atomic:k', 10)).toBe(0);

            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));
            expect(backend.decrement('atomic:k')).toBe(0);
            expect(backend.incrementWithTtl('atomic:k', 1, 1000).value).toBe(1);
        });

        it('reset 与 resetPrefix 删除指定计数器', () => {
            const backend = new MemoryAtomicStateBackend();

            backend.incrementWithTtl('atomic:a', 1, 1000);
            backend.incrementWithTtl('atomic:b', 1, 1000);
            backend.incrementWithTtl('other:c', 1, 1000);

            expect(backend.reset('atomic:a')).toBe(true);
            expect(backend.reset('atomic:a')).toBe(false);
            expect(backend.resetPrefix('atomic:')).toBe(1);
            expect(backend.resetPrefix('missing:')).toBe(0);
        });

        it('cleanupExpired 回收高基数过期计数器', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const backend = new MemoryAtomicStateBackend();

            for (let i = 0; i < 1000; i++) {
                backend.incrementWithTtl(`atomic:${i}`, 1, 1000);
            }

            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));

            expect(backend.cleanupExpired()).toBe(1000);
            expect(backend.cleanupExpired()).toBe(0);
            expect(backend.incrementWithTtl('atomic:new', 1, 1000).value).toBe(1);
        });

        it('cleanupExpired 保留未过期计数器并刷新下次清理时间', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
            const backend = new MemoryAtomicStateBackend();

            backend.incrementWithTtl('expired', 1, 1000);
            backend.incrementWithTtl('live', 2, 5000);

            vi.setSystemTime(new Date('2026-06-01T00:00:01.001Z'));

            expect(backend.cleanupExpired()).toBe(1);
            expect(backend.decrement('live')).toBe(1);
        });

        it('校验非法参数', () => {
            const backend = new MemoryAtomicStateBackend();

            expect(() => backend.incrementWithTtl('', 1, 1000)).toThrow(TypeError);
            expect(() => backend.incrementWithTtl('k', 0, 1000)).toThrow(RangeError);
            expect(() => backend.incrementWithTtl('k', 1, Number.NaN)).toThrow(RangeError);
            expect(() => backend.decrement('k', -1)).toThrow(RangeError);
            expect(() => backend.reset('')).toThrow(TypeError);
            expect(() => backend.resetPrefix('')).toThrow(TypeError);
            expect(() => backend.resetPrefix(null as any)).toThrow(TypeError);
        });
    });

    describe('RedisAtomicStateBackend', () => {
        it('incrementWithTtl 使用 Lua 原子脚本并解析 bigint 响应', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue([3n, 900n]);
            const backend = new RedisAtomicStateBackend(redis);

            await expect(backend.incrementWithTtl('atomic:k', 3, 1000)).resolves.toEqual({
                key: 'atomic:k',
                value: 3,
                ttlMs: 900,
            });

            expect(redis.eval.mock.calls[0][0]).toContain('INCRBY');
            expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'atomic:k', 3, 1000]);
        });

        it('支持从 adapter 获取 Redis 实例', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue([1, 1000]);
            const backend = createRedisAtomicStateBackend({ getRedisInstance: () => redis });

            await expect(backend.incrementWithTtl('atomic:k', 1, 1000)).resolves.toMatchObject({
                value: 1,
            });
        });

        it('decrement 使用 Lua 脚本并返回剩余值', async () => {
            const redis = makeRedis();
            redis.eval.mockResolvedValue(4);
            const backend = new RedisAtomicStateBackend(redis);

            await expect(backend.decrement('atomic:k', 2)).resolves.toBe(4);
            expect(redis.eval.mock.calls[0][0]).toContain('tonumber(current)');
            expect(redis.eval.mock.calls[0].slice(1)).toEqual([1, 'atomic:k', 2]);
        });

        it('reset 与 resetPrefix 使用 Redis del/scan，且 prefix 按字面量转义', async () => {
            const redis = makeRedis();
            redis.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
            redis.scan
                .mockResolvedValueOnce(['7', ['atomic:a', 'atomic:b']])
                .mockResolvedValueOnce(['0', []]);
            const backend = new RedisAtomicStateBackend(redis);

            await expect(backend.reset('atomic:k')).resolves.toBe(true);
            await expect(backend.reset('atomic:k')).resolves.toBe(false);
            await expect(backend.resetPrefix('atomic:user?[1]')).resolves.toBe(2);

            expect(redis.scan).toHaveBeenNthCalledWith(
                1,
                '0',
                'MATCH',
                'atomic:user\\?\\[1\\]*',
                'COUNT',
                100,
            );
        });

        it('校验 Redis 路径非法参数', async () => {
            const redis = makeRedis();
            const backend = new RedisAtomicStateBackend(redis);

            await expect(backend.incrementWithTtl('', 1, 1000)).rejects.toThrow(TypeError);
            await expect(backend.incrementWithTtl('k', 1, 0)).rejects.toThrow(RangeError);
            await expect(backend.decrement('k', 0)).rejects.toThrow(RangeError);
            await expect(backend.reset('')).rejects.toThrow(TypeError);
            await expect(backend.resetPrefix('')).rejects.toThrow(TypeError);
        });
    });
});
