#!/usr/bin/env node

import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { setImmediate as waitImmediate, setTimeout as delay } from 'timers/promises';
import { MemoryCache } from '../dist/esm/memory-cache.js';
import { MultiLevelCache } from '../dist/esm/multi-level-cache.js';
import { readThrough, readThroughWithLease } from '../dist/esm/read-through.js';
import { withCache, FunctionCache } from '../dist/esm/function-cache.js';
import { DistributedCacheInvalidator } from '../dist/esm/distributed-invalidator.js';
import { stableStringify } from '../dist/esm/stable-stringify.js';
import {
    createMemoryAtomicStateBackend,
    createRedisAtomicStateBackend,
} from '../dist/esm/atomic.js';
import {
    createMemoryFixedWindowRateLimitStore,
    createMemoryRateLimitStateStore,
    createRedisFixedWindowRateLimitStore,
    createRedisRateLimitStateStore,
} from '../dist/esm/rate-limit.js';
import { createRedisCacheAdapter } from '../dist/esm/redis-adapter.js';
import { createRedisLeaseStore } from '../dist/esm/redis-lease.js';

const MB = 1024 * 1024;
const args = process.argv.slice(2);
const json = args.includes('--json');
const redisMode = readArg('--redis') ?? 'auto';
const outputPath = readArg('--output');
const baseIterations = Number(readArg('--iterations') ?? '4000');
const runId = `${Date.now()}-${process.pid}`;

const TIER_THRESHOLDS = {
    L1: 24 * MB,
    L2: 32 * MB,
    L3: 48 * MB,
};

if (typeof globalThis.gc !== 'function') {
    console.error('memory pressure probe requires node --expose-gc');
    process.exit(1);
}

function readArg(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) {
        return inline.slice(name.length + 1);
    }
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function formatBytes(bytes) {
    return `${(bytes / MB).toFixed(3)} MB`;
}

async function forceGc() {
    for (let i = 0; i < 4; i++) {
        globalThis.gc();
        await waitImmediate();
    }
}

function heapUsed() {
    return process.memoryUsage().heapUsed;
}

function assertResidualZero(label, count) {
    return {
        label,
        count,
        ok: count === 0,
    };
}

function createMemoryLeaseStore() {
    const leases = new Map();
    return {
        async acquireLease(key, ttlMs) {
            const now = Date.now();
            const existing = leases.get(key);
            if (existing && existing.expiresAt > now) {
                return undefined;
            }
            const token = `memory-pressure:${key}:${now}:${Math.random().toString(36).slice(2)}`;
            const lease = {
                key,
                token,
                ttlMs,
                expiresAt: now + ttlMs,
                async release() {
                    const current = leases.get(key);
                    if (current?.token !== token) {
                        return false;
                    }
                    leases.delete(key);
                    return true;
                },
                async renew(nextTtlMs = ttlMs) {
                    const current = leases.get(key);
                    if (current?.token !== token) {
                        return false;
                    }
                    lease.ttlMs = nextTtlMs;
                    lease.expiresAt = Date.now() + nextTtlMs;
                    leases.set(key, { token, expiresAt: lease.expiresAt });
                    return true;
                },
            };
            leases.set(key, { token, expiresAt: lease.expiresAt });
            return lease;
        },
        async releaseLease(key, token) {
            const current = leases.get(key);
            if (current?.token !== token) {
                return false;
            }
            leases.delete(key);
            return true;
        },
        async renewLease(key, token, ttlMs) {
            const current = leases.get(key);
            if (current?.token !== token) {
                return false;
            }
            leases.set(key, { token, expiresAt: Date.now() + ttlMs });
            return true;
        },
        residual() {
            return leases.size;
        },
    };
}

class FakeRedisConnection extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
        this.closed = false;
        this.subscriptions = new Set();
    }

    subscribe(channel, cb) {
        this.subscriptions.add(channel);
        cb?.(null, this.subscriptions.size);
        return Promise.resolve(this.subscriptions.size);
    }

    unsubscribe(channel) {
        this.subscriptions.delete(channel);
        return Promise.resolve(1);
    }

    publish(channel, payload) {
        this.emit('publish', channel, payload);
        return Promise.resolve(1);
    }

    quit() {
        this.closed = true;
        return Promise.resolve('OK');
    }
}

async function countRedisKeys(redis, pattern) {
    let cursor = '0';
    let count = 0;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        count += keys.length;
    } while (cursor !== '0');
    return count;
}

async function deleteRedisPattern(redis, pattern) {
    let cursor = '0';
    let count = 0;
    do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
            count += await redis.del(...keys);
        }
    } while (cursor !== '0');
    return count;
}

async function connectRedisIfAvailable() {
    if (redisMode === 'never') {
        return { redis: undefined, skipReason: 'disabled by --redis=never' };
    }

    try {
        const mod = await import('ioredis');
        const Redis = mod.default ?? mod;
        const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
            lazyConnect: true,
            connectTimeout: 500,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
        });
        await redis.connect();
        await redis.ping();
        return { redis, skipReason: undefined };
    } catch (error) {
        if (redisMode === 'required') {
            throw error;
        }
        return {
            redis: undefined,
            skipReason: `Redis unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

async function runScenario(config) {
    const iterations = config.iterations ?? baseIterations;
    const thresholdBytes = config.thresholdBytes ?? TIER_THRESHOLDS[config.tier];
    const methods = config.methods ?? [];

    await forceGc();
    const beforeBytes = heapUsed();
    const startedAt = performance.now();
    const context = await config.setup?.();

    try {
        for (let i = 0; i < iterations; i++) {
            await config.action(context, i);
        }

        await config.cleanup?.(context);
        await forceGc();
        const afterBytes = heapUsed();
        const deltaBytes = afterBytes - beforeBytes;
        const durationMs = performance.now() - startedAt;
        const residual = await config.residual?.(context) ?? [];
        const residuals = Array.isArray(residual) ? residual : [residual];
        const residualOk = residuals.every((item) => item.ok !== false);
        const ok = deltaBytes <= thresholdBytes && residualOk;

        return {
            name: config.name,
            tier: config.tier,
            status: ok ? 'pass' : 'fail',
            iterations,
            methods,
            methodCount: methods.length,
            beforeBytes,
            afterBytes,
            deltaBytes,
            thresholdBytes,
            durationMs: Number(durationMs.toFixed(3)),
            residuals,
        };
    } catch (error) {
        await config.cleanup?.(context).catch(() => undefined);
        return {
            name: config.name,
            tier: config.tier,
            status: 'fail',
            iterations,
            methods,
            methodCount: methods.length,
            beforeBytes,
            afterBytes: heapUsed(),
            deltaBytes: heapUsed() - beforeBytes,
            thresholdBytes,
            durationMs: Number((performance.now() - startedAt).toFixed(3)),
            residuals: [],
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        };
    }
}

function memoryCacheScenario() {
    const prefix = `memory-pressure:${runId}:memory`;
    let batch = {};
    let batchKeys = [];
    return {
        name: 'MemoryCache public methods',
        tier: 'L1',
        methods: [
            'get',
            'set',
            'del',
            'exists',
            'has',
            'clear',
            'getMany',
            'setMany',
            'delMany',
            'delPattern',
            'keys',
            'getRemainingTtl',
            'getRemainingTtlMany',
            'invalidateByTag',
            'getStats',
            'resetStats',
            'setLockManager',
            'destroy',
        ],
        setup() {
            const cache = new MemoryCache({
                maxEntries: 12000,
                enableTags: true,
                enableStats: true,
                cleanupInterval: 60_000,
            });
            cache.setLockManager({ isLocked: (key) => key.endsWith(':locked') });
            batchKeys = Array.from({ length: 16 }, (_, i) => `${prefix}:batch:${i}`);
            batch = Object.fromEntries(batchKeys.map((key, i) => [key, { i }]));
            return { cache };
        },
        action({ cache }, i) {
            const key = `${prefix}:key:${i % 800}`;
            cache.set(key, { i, value: `value-${i}` }, 1_000, { tags: [`tag:${i % 8}`] });
            cache.get(key);
            cache.exists(key);
            cache.has(key);
            cache.getRemainingTtl(key);
            if (i % 32 === 0) {
                cache.setMany(batch, 1_000);
                cache.getMany(batchKeys);
                cache.getRemainingTtlMany(batchKeys);
                cache.keys(`${prefix}:*`);
            }
            if (i % 127 === 0) {
                cache.invalidateByTag(`tag:${i % 8}`);
            }
            if (i % 251 === 0) {
                cache.del(`${prefix}:key:${(i + 17) % 800}`);
            }
            if (i % 503 === 0) {
                cache.delPattern(`${prefix}:missing:*`);
            }
            if (i % 997 === 0) {
                cache.delMany(batchKeys.slice(0, 4));
            }
            cache.set(`${prefix}:locked`, 'blocked');
            cache.getStats();
        },
        cleanup({ cache }) {
            cache.clear();
            cache.resetStats();
            cache.destroy();
        },
        residual({ cache }) {
            return [
                assertResidualZero('entries', cache.getStats().entries),
                assertResidualZero('matchingKeys', cache.keys(`${prefix}:*`).length),
            ];
        },
    };
}

function functionCacheScenario() {
    const prefix = `memory-pressure:${runId}:function`;
    return {
        name: 'FunctionCache and withCache public methods',
        tier: 'L1',
        methods: [
            'withCache.call',
            'withCache.invalidate',
            'withCache.invalidateAll',
            'withCache.stats',
            'FunctionCache.register',
            'FunctionCache.execute',
            'FunctionCache.invalidate',
            'FunctionCache.invalidatePattern',
            'FunctionCache.getStats',
            'FunctionCache.list',
            'FunctionCache.resetStats',
            'FunctionCache.clear',
        ],
        setup() {
            const cache = new MemoryCache({ maxEntries: 12000, enableStats: false });
            const wrapped = withCache(async (id) => ({ id, value: `wrapped:${id}` }), {
                cache,
                ttl: 1_000,
                namespace: `${prefix}:wrapped`,
            });
            const manager = new FunctionCache(cache, { ttl: 1_000, namespace: `${prefix}:manager` });
            manager.register('lookup', async (id) => ({ id, value: `lookup:${id}` }));
            manager.register('keyed', async (id) => ({ id }), {
                keyBuilder: (id) => `${prefix}:keyed:${id}`,
            });
            return { cache, wrapped, manager };
        },
        async action({ wrapped, manager }, i) {
            const id = i % 600;
            await wrapped(id);
            await manager.execute('lookup', id);
            await manager.execute('keyed', id);
            if (i % 97 === 0) {
                await wrapped.invalidate(id);
                await manager.invalidate('lookup', id);
            }
            if (i % 389 === 0) {
                await Promise.all([wrapped(id), wrapped(id), manager.execute('lookup', id)]);
                wrapped.stats();
                manager.getStats('lookup');
                manager.getStats();
                manager.list();
                manager.resetStats('lookup');
            }
        },
        async cleanup({ cache, wrapped, manager }) {
            await wrapped.invalidateAll();
            await manager.invalidatePattern(`${prefix}:*`);
            manager.resetStats();
            manager.clear();
            cache.clear();
            cache.destroy();
        },
        residual({ cache, manager }) {
            return [
                assertResidualZero('cacheKeys', cache.keys(`${prefix}:*`).length),
                assertResidualZero('registeredFunctions', manager.list().length),
            ];
        },
    };
}

function readThroughScenario() {
    const prefix = `memory-pressure:${runId}:read-through`;
    return {
        name: 'readThrough and readThroughWithLease public functions',
        tier: 'L2',
        methods: ['readThrough', 'readThroughWithLease'],
        setup() {
            return {
                cache: new MemoryCache({ maxEntries: 12000, enableStats: false }),
                leaseStore: createMemoryLeaseStore(),
                fetches: 0,
            };
        },
        async action(context, i) {
            const key = `${prefix}:key:${i % 700}`;
            const fetcher = async () => {
                context.fetches++;
                return { i };
            };
            await readThrough(context.cache, 1_000, key, fetcher);
            await readThrough(context.cache, 1_000, key, fetcher);
            if (i % 41 === 0) {
                await Promise.all([
                    readThrough(context.cache, 1_000, `${prefix}:same:${i}`, fetcher),
                    readThrough(context.cache, 1_000, `${prefix}:same:${i}`, fetcher),
                ]);
            }
            if (i % 73 === 0) {
                await readThroughWithLease({
                    cache: context.cache,
                    ttlMs: 1_000,
                    key: `${prefix}:lease:${i % 100}`,
                    fetcher,
                    leaseStore: context.leaseStore,
                    leaseTtlMs: 50,
                    waitForOwnerMs: 5,
                });
            }
            if (i % 211 === 0) {
                await readThrough(context.cache, 1_000, `${prefix}:undefined:${i}`, async () => undefined);
            }
            if (i % 503 === 0) {
                await readThrough(context.cache, 1_000, `${prefix}:reject:${i}`, async () => {
                    throw new Error('expected pressure rejection');
                }).catch(() => undefined);
            }
        },
        cleanup({ cache }) {
            cache.clear();
            cache.destroy();
        },
        residual({ cache, leaseStore }) {
            return [
                assertResidualZero('cacheKeys', cache.keys(`${prefix}:*`).length),
                assertResidualZero('leases', leaseStore.residual()),
            ];
        },
    };
}

function multiLevelScenario() {
    const prefix = `memory-pressure:${runId}:multi`;
    return {
        name: 'MultiLevelCache public methods',
        tier: 'L2',
        methods: [
            'get',
            'set',
            'del',
            'exists',
            'has',
            'clear',
            'getMany',
            'setMany',
            'delMany',
            'delPattern',
            'keys',
            'invalidateByTag',
            'getStats',
            'resetStats',
            'destroy',
        ],
        setup() {
            const local = new MemoryCache({ maxEntries: 12000, enableTags: true, enableStats: true });
            const remote = new MemoryCache({ maxEntries: 12000, enableTags: true, enableStats: false });
            const published = [];
            const cache = new MultiLevelCache({
                local,
                remote,
                publish: (message) => published.push(message),
            });
            return { cache, local, remote, published };
        },
        async action({ cache }, i) {
            const key = `${prefix}:key:${i % 800}`;
            await cache.set(key, { i }, 1_000, { tags: [`tag:${i % 6}`] });
            await cache.get(key);
            await cache.exists(key);
            await cache.has(key);
            if (i % 37 === 0) {
                const entries = Object.fromEntries(
                    Array.from({ length: 8 }, (_, n) => [`${prefix}:batch:${n}`, { n, i }]),
                );
                await cache.setMany(entries, 1_000);
                await cache.getMany(Object.keys(entries));
                await cache.keys(`${prefix}:*`);
            }
            if (i % 149 === 0) {
                await cache.del(`${prefix}:key:${(i + 3) % 800}`);
            }
            if (i % 307 === 0) {
                await cache.invalidateByTag(`tag:${i % 6}`);
            }
            if (i % 601 === 0) {
                await cache.delMany([`${prefix}:batch:0`, `${prefix}:batch:1`]);
                await cache.delPattern(`${prefix}:none:*`);
                cache.getStats();
                cache.resetStats();
            }
        },
        async cleanup({ cache, local, remote, published }) {
            await cache.clear();
            await remote.clear();
            cache.destroy();
            local.destroy();
            remote.destroy();
            published.length = 0;
        },
        residual({ local, remote, published }) {
            return [
                assertResidualZero('localEntries', local.getStats().entries),
                assertResidualZero('remoteEntries', remote.getStats().entries),
                assertResidualZero('publishedMessages', published.length),
            ];
        },
    };
}

function distributedScenario() {
    const prefix = `memory-pressure:${runId}:distributed`;
    const channel = `${prefix}:channel`;
    return {
        name: 'DistributedCacheInvalidator listener lifecycle',
        tier: 'L1',
        methods: ['invalidate', 'invalidatePattern', 'invalidateTag', 'getStats', 'close'],
        setup() {
            const cache = new MemoryCache({ maxEntries: 12000, enableTags: true, enableStats: false });
            const pub = new FakeRedisConnection('pub');
            const sub = new FakeRedisConnection('sub');
            const invalidator = new DistributedCacheInvalidator({
                cache,
                channel,
                instanceId: `${prefix}:self`,
                _connections: { pub, sub, _shouldClosePub: true },
            });
            return { cache, pub, sub, invalidator };
        },
        async action({ cache, sub, invalidator }, i) {
            const key = `${prefix}:key:${i % 500}`;
            cache.set(key, { i }, 1_000, { tags: [`tag:${i % 4}`] });
            if (i % 3 === 0) {
                await invalidator.invalidate(`${prefix}:missing:*`);
            }
            if (i % 11 === 0) {
                await invalidator.invalidatePattern(`${prefix}:other:*`);
            }
            if (i % 17 === 0) {
                await invalidator.invalidateTag(`tag:${i % 4}`);
            }
            if (i % 101 === 0) {
                sub.emit('message', channel, JSON.stringify({
                    type: 'invalidate',
                    pattern: `${prefix}:remote:*`,
                    instanceId: 'other',
                    ts: Date.now(),
                }));
                await waitImmediate();
                invalidator.getStats();
            }
        },
        async cleanup({ cache, invalidator }) {
            await invalidator.close();
            cache.clear();
            cache.destroy();
        },
        residual({ cache, pub, sub }) {
            return [
                assertResidualZero('cacheEntries', cache.getStats().entries),
                assertResidualZero('pubErrorListeners', pub.listenerCount('error')),
                assertResidualZero('subErrorListeners', sub.listenerCount('error')),
                assertResidualZero('subMessageListeners', sub.listenerCount('message')),
            ];
        },
    };
}

function redisAdapterSafeClearScenario() {
    const prefix = `memory-pressure:${runId}:redis-fake`;
    return {
        name: 'RedisCacheAdapter clear method on fake Redis',
        tier: 'L2',
        methods: ['RedisCacheAdapter.clear'],
        setup() {
            const store = new Map();
            const fakeRedis = {
                async get(key) {
                    return store.get(key) ?? null;
                },
                async set(key, value) {
                    store.set(key, value);
                    return 'OK';
                },
                async del(...keys) {
                    let count = 0;
                    for (const key of keys) {
                        if (store.delete(key)) {
                            count++;
                        }
                    }
                    return count;
                },
                async exists(key) {
                    return store.has(key) ? 1 : 0;
                },
                async flushdb() {
                    store.clear();
                    return 'OK';
                },
            };
            return {
                adapter: createRedisCacheAdapter(fakeRedis, { metaKeyPrefix: `${prefix}:meta` }),
                store,
            };
        },
        async action({ adapter }, i) {
            await adapter.set(`${prefix}:key:${i % 100}`, { i });
            if (i % 50 === 0) {
                await adapter.clear();
            }
        },
        async cleanup({ adapter }) {
            await adapter.clear();
            await adapter.close();
        },
        residual({ store }) {
            return [assertResidualZero('fakeRedisKeys', store.size)];
        },
    };
}

function atomicAndRateLimitScenario() {
    const prefix = `memory-pressure:${runId}:state`;
    return {
        name: 'Memory atomic and rate-limit state methods',
        tier: 'L1',
        methods: [
            'MemoryAtomicStateBackend.incrementWithTtl',
            'MemoryAtomicStateBackend.decrement',
            'MemoryAtomicStateBackend.reset',
            'MemoryAtomicStateBackend.resetPrefix',
            'MemoryAtomicStateBackend.cleanupExpired',
            'MemoryFixedWindowRateLimitStore.increment',
            'MemoryFixedWindowRateLimitStore.decrement',
            'MemoryFixedWindowRateLimitStore.reset',
            'MemoryFixedWindowRateLimitStore.resetPrefix',
            'MemoryFixedWindowRateLimitStore.cleanupExpired',
            'MemoryRateLimitStateStore.checkSlidingWindow',
            'MemoryRateLimitStateStore.rollbackSlidingWindow',
            'MemoryRateLimitStateStore.consumeTokenBucket',
            'MemoryRateLimitStateStore.rollbackTokenBucket',
            'MemoryRateLimitStateStore.consumeLeakyBucket',
            'MemoryRateLimitStateStore.rollbackLeakyBucket',
            'MemoryRateLimitStateStore.reset',
            'MemoryRateLimitStateStore.resetPrefix',
            'MemoryRateLimitStateStore.cleanupExpired',
        ],
        setup() {
            return {
                atomic: createMemoryAtomicStateBackend(),
                fixed: createMemoryFixedWindowRateLimitStore(),
                state: createMemoryRateLimitStateStore(),
            };
        },
        action({ atomic, fixed, state }, i) {
            const key = `${prefix}:key:${i % 900}`;
            atomic.incrementWithTtl(key, 1, 1_000);
            atomic.decrement(key);
            fixed.increment(`${prefix}:fixed:${i % 900}`, 1_000, 1_000);
            fixed.decrement(`${prefix}:fixed:${i % 900}`);
            const sliding = state.checkSlidingWindow(`${prefix}:sliding:${i % 500}`, 1_000, 1000);
            if (sliding.rollbackToken && i % 2 === 0) {
                state.rollbackSlidingWindow(`${prefix}:sliding:${i % 500}`, sliding.rollbackToken);
            }
            const token = state.consumeTokenBucket(`${prefix}:token:${i % 500}`, 1000, 1000);
            if (token.rollbackToken && i % 3 === 0) {
                state.rollbackTokenBucket(`${prefix}:token:${i % 500}`, token.rollbackToken);
            }
            const leaky = state.consumeLeakyBucket(`${prefix}:leaky:${i % 500}`, 1000, 1000);
            if (leaky.rollbackToken && i % 5 === 0) {
                state.rollbackLeakyBucket(`${prefix}:leaky:${i % 500}`, leaky.rollbackToken);
            }
            if (i % 251 === 0) {
                atomic.reset(key);
                fixed.reset(`${prefix}:fixed:${i % 900}`);
                state.reset(`${prefix}:sliding:${i % 500}`);
            }
        },
        cleanup({ atomic, fixed, state }) {
            atomic.resetPrefix(prefix);
            fixed.resetPrefix(prefix);
            state.resetPrefix(prefix);
            atomic.cleanupExpired(Date.now() + 10_000);
            fixed.cleanupExpired(Date.now() + 10_000);
            state.cleanupExpired(Date.now() + 10_000);
        },
        residual({ atomic, fixed, state }) {
            return [
                assertResidualZero('atomicResidual', atomic.resetPrefix(prefix)),
                assertResidualZero('fixedResidual', fixed.resetPrefix(prefix)),
                assertResidualZero('stateResidual', state.resetPrefix(prefix)),
            ];
        },
    };
}

function stableStringifyScenario() {
    const shared = { stable: true };
    shared.self = shared;
    return {
        name: 'stableStringify pressure paths',
        tier: 'L2',
        methods: ['stableStringify'],
        iterations: Math.max(baseIterations, 8000),
        setup() {
            return { observed: 0 };
        },
        action(context, i) {
            const value = {
                z: i,
                a: { n: Number.NaN, d: new Date(1_700_000_000_000 + i), r: /cache-hub/gi },
                b: [i % 7, `value-${i}`, { nested: true }],
            };
            context.observed += stableStringify(value).length;
            context.observed += stableStringify(shared, { circularValue: '[Circular]' }).length;
            context.observed += stableStringify({ custom: i }, {
                customSerializer: (item) => {
                    if (item && typeof item === 'object' && 'custom' in item) {
                        return `custom:${item.custom}`;
                    }
                    return undefined;
                },
            }).length;
        },
        residual(context) {
            return [assertResidualZero('retainedState', context.observed > 0 ? 0 : 1)];
        },
    };
}

function redisScenario(redis) {
    const prefix = `memory-pressure:${runId}:redis`;
    const tag = `${prefix}:tag`;
    return {
        name: 'Redis adapter, lease, atomic and rate-limit methods',
        tier: 'L3',
        iterations: Math.min(baseIterations, 900),
        methods: [
            'RedisCacheAdapter.get',
            'RedisCacheAdapter.set',
            'RedisCacheAdapter.del',
            'RedisCacheAdapter.exists',
            'RedisCacheAdapter.has',
            'RedisCacheAdapter.getMany',
            'RedisCacheAdapter.setMany',
            'RedisCacheAdapter.delMany',
            'RedisCacheAdapter.delPattern',
            'RedisCacheAdapter.keys',
            'RedisCacheAdapter.invalidateByTag',
            'RedisCacheAdapter.pruneTagMetadata',
            'RedisCacheAdapter.getRemainingTtl',
            'RedisCacheAdapter.getRemainingTtlMany',
            'RedisCacheAdapter.getStats',
            'RedisCacheAdapter.close',
            'RedisCacheAdapter.getRedisInstance',
            'RedisLeaseStore.acquireLease',
            'RedisLeaseStore.releaseLease',
            'RedisLeaseStore.renewLease',
            'RedisAtomicStateBackend.incrementWithTtl',
            'RedisAtomicStateBackend.decrement',
            'RedisAtomicStateBackend.reset',
            'RedisAtomicStateBackend.resetPrefix',
            'RedisFixedWindowRateLimitStore.increment',
            'RedisFixedWindowRateLimitStore.decrement',
            'RedisFixedWindowRateLimitStore.reset',
            'RedisFixedWindowRateLimitStore.resetPrefix',
            'RedisRateLimitStateStore.checkSlidingWindow',
            'RedisRateLimitStateStore.rollbackSlidingWindow',
            'RedisRateLimitStateStore.consumeTokenBucket',
            'RedisRateLimitStateStore.rollbackTokenBucket',
            'RedisRateLimitStateStore.consumeLeakyBucket',
            'RedisRateLimitStateStore.rollbackLeakyBucket',
            'RedisRateLimitStateStore.reset',
            'RedisRateLimitStateStore.resetPrefix',
        ],
        async setup() {
            await deleteRedisPattern(redis, `${prefix}*`);
            return {
                adapter: createRedisCacheAdapter(redis, {
                    metaKeyPrefix: `${prefix}:meta`,
                    scanCount: 50,
                }),
                leaseStore: createRedisLeaseStore(redis, {
                    leaseKeyPrefix: `${prefix}:lease`,
                    ownerId: 'memory-pressure',
                }),
                atomic: createRedisAtomicStateBackend(redis),
                fixed: createRedisFixedWindowRateLimitStore(redis),
                state: createRedisRateLimitStateStore(redis),
            };
        },
        async action({ adapter, leaseStore, atomic, fixed, state }, i) {
            const key = `${prefix}:cache:${i % 180}`;
            await adapter.set(key, { i }, 1_000, { tags: [`${tag}:${i % 5}`] });
            await adapter.get(key);
            await adapter.exists(key);
            await adapter.has(key);
            await adapter.getRemainingTtl(key);
            if (i % 17 === 0) {
                const entries = Object.fromEntries(
                    Array.from({ length: 4 }, (_, n) => [`${prefix}:batch:${n}`, { n, i }]),
                );
                await adapter.setMany(entries, 1_000);
                await adapter.getMany(Object.keys(entries));
                await adapter.getRemainingTtlMany(Object.keys(entries));
                await adapter.keys(`${prefix}:*`);
            }
            if (i % 47 === 0) {
                await adapter.invalidateByTag(`${tag}:${i % 5}`);
                await adapter.pruneTagMetadata?.(`${tag}:${i % 5}`);
            }
            if (i % 101 === 0) {
                await adapter.del(`${prefix}:cache:${(i + 13) % 180}`);
                await adapter.delMany([`${prefix}:batch:0`, `${prefix}:batch:1`]);
                await adapter.delPattern(`${prefix}:missing:*`);
                adapter.getStats();
                adapter.getRedisInstance();
            }
            const lease = await leaseStore.acquireLease(`${prefix}:lease-key:${i % 20}`, 1_000);
            if (lease) {
                await lease.renew(1_000);
                await leaseStore.renewLease(lease.key, lease.token, 1_000);
                await lease.release();
                await leaseStore.releaseLease(lease.key, lease.token);
            }
            const stateKey = `${prefix}:state:${i % 180}`;
            await atomic.incrementWithTtl(stateKey, 1, 1_000);
            await atomic.decrement(stateKey);
            await fixed.increment(`${prefix}:fixed:${i % 180}`, 1_000, 1000);
            await fixed.decrement(`${prefix}:fixed:${i % 180}`);
            const sliding = await state.checkSlidingWindow(`${prefix}:sliding:${i % 120}`, 1_000, 1000);
            if (sliding.rollbackToken && i % 2 === 0) {
                await state.rollbackSlidingWindow(`${prefix}:sliding:${i % 120}`, sliding.rollbackToken);
            }
            const bucket = await state.consumeTokenBucket(`${prefix}:token:${i % 120}`, 1000, 1000);
            if (bucket.rollbackToken && i % 3 === 0) {
                await state.rollbackTokenBucket(`${prefix}:token:${i % 120}`, bucket.rollbackToken);
            }
            const leaky = await state.consumeLeakyBucket(`${prefix}:leaky:${i % 120}`, 1000, 1000);
            if (leaky.rollbackToken && i % 5 === 0) {
                await state.rollbackLeakyBucket(`${prefix}:leaky:${i % 120}`, leaky.rollbackToken);
            }
        },
        async cleanup({ adapter, atomic, fixed, state }) {
            await atomic.resetPrefix(prefix);
            await fixed.resetPrefix(prefix);
            await state.resetPrefix(prefix);
            await adapter.delPattern(`${prefix}*`);
            await adapter.close();
            await deleteRedisPattern(redis, `${prefix}*`);
        },
        async residual() {
            return [assertResidualZero('redisKeys', await countRedisKeys(redis, `${prefix}*`))];
        },
    };
}

async function main() {
    const scenarios = [
        memoryCacheScenario(),
        functionCacheScenario(),
        readThroughScenario(),
        multiLevelScenario(),
        distributedScenario(),
        redisAdapterSafeClearScenario(),
        atomicAndRateLimitScenario(),
        stableStringifyScenario(),
    ];

    const { redis, skipReason } = await connectRedisIfAvailable();
    if (redis) {
        scenarios.push(redisScenario(redis));
    }

    const results = [];
    for (const scenario of scenarios) {
        results.push(await runScenario(scenario));
    }

    if (!redis) {
        results.push({
            name: 'Redis adapter, lease, atomic and rate-limit methods',
            tier: 'L3',
            status: 'skip',
            iterations: 0,
            methods: redisScenario({}).methods,
            methodCount: redisScenario({}).methods.length,
            skipReason,
        });
    }

    await redis?.quit().catch(() => undefined);

    const publicMethodCount = results.reduce((sum, result) => sum + (result.methodCount ?? 0), 0);
    const failed = results.filter((result) => result.status === 'fail');
    const payload = {
        generatedAt: new Date().toISOString(),
        runId,
        baseIterations,
        redis: redis ? 'executed' : 'skipped',
        publicMethodCount,
        status: failed.length === 0 ? 'pass' : 'fail',
        results,
    };

    if (outputPath) {
        writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    }

    if (json) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        console.log('\ncache-hub memory pressure probe\n');
        for (const result of results) {
            if (result.status === 'skip') {
                console.log(`SKIP ${result.name} (${result.skipReason})`);
                continue;
            }
            const residualSummary = result.residuals
                .map((item) => `${item.label}=${item.count}`)
                .join(', ');
            console.log(
                `${result.status.toUpperCase()} ${result.name} ` +
                `tier=${result.tier} iterations=${result.iterations} ` +
                `delta=${formatBytes(result.deltaBytes)} threshold=${formatBytes(result.thresholdBytes)} ` +
                `residual=[${residualSummary}] methods=${result.methodCount}`,
            );
            if (result.error) {
                console.log(result.error);
            }
        }
        console.log(`\nstatus=${payload.status} publicMethodReferences=${publicMethodCount} redis=${payload.redis}`);
    }

    if (failed.length > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
