#!/usr/bin/env node
/**
 * cache-hub micro benchmark.
 *
 * 运行方式：
 * - npm run benchmark
 * - npm run benchmark -- --json
 * - npm run benchmark -- --json --output benchmark-results.json
 */

import { writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { MemoryCache } from '../dist/esm/memory-cache.js';
import { MultiLevelCache } from '../dist/esm/multi-level-cache.js';
import { readThrough } from '../dist/esm/read-through.js';
import { withCache } from '../dist/esm/function-cache.js';
import { createRedisCacheAdapter } from '../dist/esm/redis-adapter.js';
import { createMemoryAtomicStateBackend } from '../dist/esm/atomic.js';
import {
    createMemoryFixedWindowRateLimitStore,
    createMemoryRateLimitStateStore,
} from '../dist/esm/rate-limit.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

function formatNumber(value) {
    return Math.round(value).toLocaleString('en-US');
}

async function bench(name, fn, options = {}) {
    const iterations = options.iterations ?? 100000;
    const warmup = Math.min(10000, iterations);

    for (let i = 0; i < warmup; i++) {
        await fn();
    }

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        await fn();
    }
    const durationMs = performance.now() - start;
    const hz = iterations / (durationMs / 1000);

    return {
        name,
        iterations,
        durationMs: Number(durationMs.toFixed(3)),
        hz: Math.round(hz),
    };
}

function createFakeRedis() {
    const store = new Map();
    return {
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
        async mget(...keys) {
            return keys.map((key) => store.get(key) ?? null);
        },
        pipeline() {
            const commands = [];
            return {
                set(key, value) {
                    commands.push(['set', key, value]);
                    return this;
                },
                del(key) {
                    commands.push(['del', key]);
                    return this;
                },
                pttl() {
                    commands.push(['pttl']);
                    return this;
                },
                async exec() {
                    for (const command of commands) {
                        if (command[0] === 'set') {
                            store.set(command[1], command[2]);
                        } else if (command[0] === 'del') {
                            store.delete(command[1]);
                        }
                    }
                    return commands.map(() => [null, 'OK']);
                },
            };
        },
        async scan() {
            return ['0', [...store.keys()]];
        },
        async pttl(key) {
            return store.has(key) ? -1 : -2;
        },
    };
}

const memory = new MemoryCache({ maxEntries: 50000, enableStats: false });
memory.set('hit', { id: 1 });
const batchEntries = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`batch:${index}`, index]),
);
memory.setMany(batchEntries);

const readThroughCache = new MemoryCache({ enableStats: false });
readThroughCache.set('read-through-hit', 'value', 60000);

const functionCache = new MemoryCache({ enableStats: false });
const cachedFn = withCache(async (id) => `user:${id}`, {
    cache: functionCache,
    ttl: 60000,
    namespace: 'bench',
});
await cachedFn(1);

const local = new MemoryCache({ enableStats: false });
const remote = new MemoryCache({ enableStats: false });
local.set('l1-hit', 'value');
const multiLevel = new MultiLevelCache({ local, remote });

const redisAdapter = createRedisCacheAdapter(createFakeRedis());
await redisAdapter.set('redis-hit', { id: 1 });

const rateLimitStore = createMemoryFixedWindowRateLimitStore();
const atomicBackend = createMemoryAtomicStateBackend();
const rateLimitStateStore = createMemoryRateLimitStateStore();

const results = [];
results.push(await bench('MemoryCache#get hit', () => memory.get('hit')));
results.push(await bench('MemoryCache#set existing', () => memory.set('hit', { id: 2 })));
results.push(await bench('MemoryCache#getMany 20 hits', () => memory.getMany(Object.keys(batchEntries))));
results.push(await bench('MemoryCache#setMany 20 existing', () => memory.setMany(batchEntries)));
results.push(await bench('readThrough cache hit', () => readThrough(readThroughCache, 60000, 'read-through-hit', async () => 'miss')));
results.push(await bench('withCache hit single key', () => cachedFn(1)));
results.push(await bench('MultiLevelCache L1 hit', () => multiLevel.get('l1-hit')));
results.push(await bench('MultiLevelCache L1 miss + remote miss', () => multiLevel.get('remote-miss')));
results.push(await bench('RedisAdapter(fake) get JSON parse', () => redisAdapter.get('redis-hit')));
results.push(await bench('RedisAdapter(fake) set JSON stringify', () => redisAdapter.set('redis-hit', { id: 2 })));
results.push(await bench('Atomic Memory incrementWithTtl', () => atomicBackend.incrementWithTtl('atomic:user:1', 1, 60000)));
results.push(await bench('RateLimit Memory fixed-window increment', () => rateLimitStore.increment('rl:user:1', 60000, 1000000)));
results.push(await bench(
    'RateLimit Memory sliding-window check',
    () => rateLimitStateStore.checkSlidingWindow('sw:user:1', 60000, 1000000),
    { iterations: 1000 },
));
results.push(await bench('RateLimit Memory token-bucket consume', () => rateLimitStateStore.consumeTokenBucket('tb:user:1', 1000000, 1000000)));

if (json) {
    const payload = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2);
    if (outputPath) {
        writeFileSync(outputPath, `${payload}\n`);
    }
    console.log(payload);
} else {
    console.log('\ncache-hub benchmark\n');
    for (const result of results) {
        console.log(`${result.name.padEnd(44)} ${formatNumber(result.hz).padStart(14)} ops/s`);
    }
}
