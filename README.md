# cache-hub

Zero-runtime-dependency caching and atomic state toolkit for Node.js services.

`cache-hub` provides an in-memory LRU + TTL cache, optional Redis integration,
read-through caching, function-level caching, distributed invalidation, stable
cache-key serialization, atomic state backends, and rate-limit state primitives
behind a small `CacheLike` contract.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](#testing)

Chinese documentation: [docs/README.zh-CN.md](./docs/README.zh-CN.md)

---

## Table of Contents

- [Why cache-hub](#why-cache-hub)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Module Reference](#module-reference)
- [Redis Defaults](#redis-defaults)
- [Testing](#testing)
- [Benchmarking](#benchmarking)
- [Build](#build)
- [Node.js Support](#nodejs-support)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why cache-hub

- **Zero runtime dependencies** - `dependencies` stays empty; Redis is an optional peer dependency.
- **Memory cache with LRU + TTL** - O(1) operations with entry-count and memory-size limits.
- **Multi-level cache** - L1 memory plus optional L2 remote cache, TTL-preserving backfill, timeout fallback, and configurable write policy.
- **Redis adapter** - wraps ioredis as `CacheLike`; uses SCAN instead of KEYS for production-safe pattern operations.
- **Read-through caching** - cache miss fetch, write-back, in-process de-duplication, and optional Redis lease de-duplication.
- **Function cache** - cache any async function with `withCache` or the `FunctionCache` registry.
- **Tag invalidation** - memory, Redis, multi-level, and distributed tag invalidation for grouped cache entries.
- **Distributed invalidation** - Redis Pub/Sub broadcasts pattern and tag invalidation across service instances.
- **Stable key serialization** - deterministic cache keys with sorted object keys, cycle handling, and special value sentinels.
- **Atomic state backends** - memory and Redis counter primitives for high-concurrency state updates.
- **Rate-limit primitives** - fixed-window, sliding-window, token-bucket, and leaky-bucket state stores for middleware authors.
- **Dual package format** - ESM and CommonJS builds with subpath exports.

---

## Installation

```bash
npm install cache-hub
```

Redis-backed features require ioredis:

```bash
npm install ioredis
```

`ioredis` is an optional peer dependency. Projects that only use memory caching
do not need to install it.

---

## Quick Start

### Memory Cache

```typescript
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({
    maxEntries: 1000,
    defaultTtl: 60_000,
    enableStats: true,
});

await cache.set('user:1', { name: 'Alice' });

const user = await cache.get<{ name: string }>('user:1');
console.log(user?.name); // Alice

const stats = cache.getStats();
console.log(stats.hitRate); // 0..1
```

### Read-through Cache

```typescript
import { MemoryCache } from 'cache-hub';
import { readThrough } from 'cache-hub/read-through';

const cache = new MemoryCache({ defaultTtl: 30_000 });

const user = await readThrough(cache, 30_000, 'user:1', async () => {
    return db.findUser(1);
});
```

`readThrough` returns cached values immediately on hit. On miss, it runs the
fetcher, writes non-`undefined` results back to cache, and shares one in-flight
promise for concurrent calls with the same key.

### Read-through with Redis Lease

Use `readThroughWithLease` when many Node.js processes may miss the same key at
the same time. One process acquires the Redis lease and runs the fetcher; other
processes wait briefly for the cache to be filled.

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';
import { createRedisLeaseStore } from 'cache-hub/lease';
import { readThroughWithLease } from 'cache-hub/read-through';

const cache = createRedisCacheAdapter('redis://localhost:6379');
const leaseStore = createRedisLeaseStore(cache);

const value = await readThroughWithLease({
    cache,
    ttlMs: 2_000,
    key: 'response:/users/1',
    leaseStore,
    leaseTtlMs: 1_000,
    waitForOwnerMs: 1_200,
    pollIntervalMs: 10,
    fetcher: async () => renderExpensiveResponse(),
});

await cache.close();
```

The default timeout behavior is `onLeaseTimeout: 'fetch'`, which favors
availability. Use `onLeaseTimeout: 'throw'` if duplicate origin fetches must be
rejected instead of allowed.

### Function Cache

```typescript
import { MemoryCache } from 'cache-hub';
import { withCache } from 'cache-hub/function-cache';

const cache = new MemoryCache({ maxEntries: 500 });

const getUser = withCache(
    async (userId: number) => db.findUser(userId),
    {
        cache,
        ttl: 60_000,
        namespace: 'users',
        condition: (result) => result !== null,
    },
);

const user = await getUser(1);
```

The default key builder uses `stableStringify`. Long keys are compressed with a
SHA-256 digest after the configured key length threshold.

### Multi-level Cache

```typescript
import { MemoryCache } from 'cache-hub';
import { MultiLevelCache } from 'cache-hub/multi-level';
import { createRedisCacheAdapter } from 'cache-hub/redis';

const local = new MemoryCache({ maxEntries: 500, defaultTtl: 30_000 });
const remote = createRedisCacheAdapter('redis://localhost:6379');

const cache = new MultiLevelCache({
    local,
    remote,
    remoteTimeoutMs: 50,
    backfillOnRemoteHit: true,
    writePolicy: 'both',
});

await cache.set('product:42', { name: 'Keyboard' }, 120_000);

const product = await cache.get<{ name: string }>('product:42');
console.log(product?.name); // Keyboard

await remote.close();
```

### Tags

Tags let you invalidate a group of cache entries without knowing every cache
key at call time.

```typescript
import { MemoryCache } from 'cache-hub';
import { createRedisCacheAdapter } from 'cache-hub/redis';

const memory = new MemoryCache({ enableTags: true });
await memory.set('user:1:profile', { name: 'Alice' }, 60_000, {
    tags: ['user:1', 'tenant:a'],
});
await memory.invalidateByTag('user:1');

const redis = createRedisCacheAdapter('redis://localhost:6379', {
    metaKeyPrefix: 'my-app:cache-meta',
    deleteCommand: 'unlink',
});
await redis.set('user:1:profile', { name: 'Alice' }, 60_000, {
    tags: ['user:1', 'tenant:a'],
});
const deleted = await redis.invalidateByTag('tenant:a');

await redis.close();
```

`set(key, value, ttl)` without tags clears any previous tag relationship for the
same key. This prevents an old tag from deleting a newer untagged value.

### Distributed Invalidation

```typescript
import { MemoryCache } from 'cache-hub';
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

const local = new MemoryCache({ maxEntries: 1000 });

const invalidator = new DistributedCacheInvalidator({
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    cache: local,
    channel: 'app:cache-invalidation',
});

await invalidator.invalidate('user:*');
await invalidator.invalidateTag('tenant:a');
await invalidator.close();
```

Calling `invalidate(pattern)` first invalidates the current instance and then
broadcasts the same pattern to other subscribers. `invalidateTag(tag)` does the
same for caches that support `invalidateByTag`.

### Fixed-window Rate-limit Store

```typescript
import { createMemoryFixedWindowRateLimitStore } from 'cache-hub/rate-limit';

const store = createMemoryFixedWindowRateLimitStore();

const result = store.increment('rl:user:42', 60_000, 100);

if (result.remaining === 0) {
    console.log(`Retry after ${result.retryAfterMs}ms`);
}
```

Redis-backed rate-limit state uses Lua scripts for atomic increment/decrement:

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';
import { createRedisFixedWindowRateLimitStore } from 'cache-hub/rate-limit';

const redisCache = createRedisCacheAdapter('redis://localhost:6379');
const store = createRedisFixedWindowRateLimitStore(redisCache);

await store.increment('rl:user:1', 60_000, 100);
await store.decrement('rl:user:1');
await store.resetPrefix('rl:user:');

await redisCache.close();
```

`cache-hub/rate-limit` is a low-level primitive for middleware authors. It does
not impose a specific HTTP framework adapter.

### Atomic State Backend

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';
import { createRedisAtomicStateBackend } from 'cache-hub/atomic';

const redisCache = createRedisCacheAdapter('redis://localhost:6379');
const atomic = createRedisAtomicStateBackend(redisCache);

const result = await atomic.incrementWithTtl('counter:tenant:42', 1, 60_000);

console.log(result.value, result.ttlMs);
await redisCache.close();
```

The Redis backend uses Lua scripts for atomic read-modify-write behavior. It is
safe to use as a storage primitive for high-concurrency counters where plain
`get -> set` would lose updates.

---

## Module Reference

### `cache-hub`

```typescript
import { MemoryCache } from 'cache-hub';
import type { CacheLike, CacheStats, MemoryCacheOptions } from 'cache-hub';
```

#### `new MemoryCache(options?)`

| Option | Type | Default | Description |
|---|---:|---:|---|
| `maxEntries` | `number` | `10000` | Maximum number of entries before LRU eviction. |
| `maxMemory` | `number` | `0` | Estimated max memory in bytes. `0` disables the memory limit. |
| `defaultTtl` | `number` | `0` | Default TTL in milliseconds. `0` means no expiration. |
| `cleanupInterval` | `number` | `0` | Periodic expired-entry cleanup interval in milliseconds. |
| `enableStats` | `boolean` | `true` | Enables hit/miss statistics. |
| `enableTags` | `boolean` | `false` | Enables tag indexes and `invalidateByTag`. |
| `enabled` | `boolean` | `true` | Disables cache reads/writes when set to `false`. |

`MemoryCache` also exposes `getRemainingTtl(key)` and
`getRemainingTtlMany(keys)`. A non-expiring existing key returns `null`; a
missing or expired key returns `undefined`.

#### `CacheLike`

Every cache implementation can be used through this interface:

```typescript
interface CacheLike {
    get<T = any>(key: string): T | undefined | Promise<T | undefined>;
    set(key: string, value: any, ttl?: number, options?: CacheSetOptions): void | Promise<void>;
    del(key: string): boolean | Promise<boolean>;
    exists(key: string): boolean | Promise<boolean>;
    has(key: string): boolean | Promise<boolean>;
    clear(): void | Promise<void>;
    keys(pattern?: string): string[] | Promise<string[]>;
    getMany(keys: string[]): Record<string, any> | Promise<Record<string, any>>;
    setMany(entries: Record<string, any>, ttl?: number): boolean | Promise<boolean>;
    delMany(keys: string[]): number | Promise<number>;
    delPattern(pattern: string): number | Promise<number>;
    getRemainingTtl?(key: string): number | null | undefined | Promise<number | null | undefined>;
    getRemainingTtlMany?(keys: string[]): Record<string, number | null> | Promise<Record<string, number | null>>;
    invalidateByTag?(tag: string): void | number | Promise<void | number>;
    getStats?(): CacheStats;
    resetStats?(): void;
    destroy?(): void;
    setLockManager?(lm: LockManager): void;
}
```

### `cache-hub/read-through`

```typescript
import { readThrough, readThroughWithLease } from 'cache-hub/read-through';

function readThrough<V>(
    cache: CacheLike,
    ttl: number,
    key: string,
    fetcher: () => Promise<V>,
): Promise<V>;
```

- `ttl <= 0` runs the fetcher without writing to cache.
- `null` is cached as a valid value.
- `undefined` is treated as a miss signal and is not cached.
- Same-key concurrent calls share one in-flight promise.
- `readThroughWithLease(options)` adds a `CacheLeaseStore` for cross-process
  de-duplication. It is useful for short TTL response cache entries that may be
  regenerated by many workers at once.

`readThroughWithLease` options:

| Option | Type | Default | Description |
|---|---|---|---|
| `cache` | `CacheLike` | required | Cache to read from and write to. |
| `key` | `string` | required | Cache key and lease resource key. |
| `ttlMs` | `number` | required | Cache TTL in milliseconds. `<= 0` bypasses cache and lease. |
| `fetcher` | `() => Promise<T>` | required | Origin function used on miss. |
| `leaseStore` | `CacheLeaseStore` | required | Lease store, usually created with `createRedisLeaseStore`. |
| `leaseTtlMs` | `number` | `min(ttlMs, 5000)`, at least `50` | Lease lifetime. Keep it longer than the normal fetch latency. |
| `waitForOwnerMs` | `number` | `leaseTtlMs + 25` | How long non-owner callers wait for cache fill. |
| `pollIntervalMs` | `number` | `10` | Cache polling interval while waiting. |
| `onLeaseTimeout` | `'fetch' \| 'throw'` | `'fetch'` | Fallback behavior when no owner fills the cache in time. |

### `cache-hub/multi-level`

```typescript
import { MultiLevelCache } from 'cache-hub/multi-level';

new MultiLevelCache(options);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `local` | `CacheLike` | required | L1 local cache. |
| `remote` | `CacheLike` | `undefined` | Optional L2 remote cache. |
| `writePolicy` | `'both' \| 'local-first-async-remote'` | `'both'` | Write-through or local-first async write policy. |
| `backfillOnRemoteHit` | `boolean` | `true` | Backfills L1 after L2 hit. Preserves remote TTL when supported. |
| `remoteTimeoutMs` | `number` | `50` | L2 get timeout in milliseconds. Timeout falls back to L1 miss behavior. |
| `publish` | `(msg) => void` | `undefined` | Optional callback for distributed invalidation messages. |
| `remoteInvalidationErrors` | `'ignore' \| 'throw'` | `'ignore'` | Controls whether remote `invalidateByTag` errors are swallowed or rethrown. |

### `cache-hub/redis`

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';

const adapter = createRedisCacheAdapter('redis://localhost:6379');
```

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `metaKeyPrefix` | `string` | `__cache-hub` | Prefix for Redis tag metadata keys. Use an app-specific prefix when several apps share a Redis database. |
| `scanCount` | `number` | `100` | SCAN / SSCAN count hint. Must be positive. |
| `deleteCommand` | `'del' \| 'unlink'` | `'del'` | Use `unlink` for asynchronous Redis memory reclamation on large values. |

The Redis adapter implements `CacheLike` and adds:

| Method | Description |
|---|---|
| `getRemainingTtl(key)` | Returns remaining TTL in milliseconds, `null` for non-expiring keys, and `undefined` for missing keys. |
| `getRemainingTtlMany(keys)` | Batch TTL lookup. |
| `invalidateByTag(tag)` | Deletes cache entries attached to a tag and returns the number of deleted business keys. |
| `close()` | Closes only the connection created by the adapter. Externally supplied ioredis instances are not closed. |
| `getRedisInstance()` | Returns the underlying ioredis instance for advanced use cases. |

Pattern operations use `SCAN` with `COUNT 100`; `KEYS` is not used.

### `cache-hub/lease`

```typescript
import { createRedisLeaseStore } from 'cache-hub/lease';

const leaseStore = createRedisLeaseStore(redisCacheOrIoredis, {
    leaseKeyPrefix: 'my-app:cache-lease',
    ownerId: 'api-worker-1',
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `leaseKeyPrefix` | `string` | `__cache-hub:lease` | Prefix for Redis lease keys. |
| `ownerId` | `string` | random UUID | Stable owner prefix included in lease tokens. |

The Redis lease store uses `SET key token NX PX ttlMs` to acquire a lease and Lua
scripts to release or renew only when the token still matches.

### `cache-hub/function-cache`

```typescript
import { FunctionCache, withCache } from 'cache-hub/function-cache';
```

```typescript
const cachedFn = withCache(asyncFn, {
    cache,
    ttl: 60_000,
    namespace: 'users',
    keyBuilder: (...args) => `custom:${args.join(':')}`,
    condition: (result) => result !== null,
});
```

`withCache(fn).invalidateAll()` only deletes keys that were actually written by
that wrapped function. It does not delete unrelated manual keys that happen to
share the same prefix.

### `cache-hub/distributed`

```typescript
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

const invalidator = new DistributedCacheInvalidator({
    cache,
    redisUrl: 'redis://localhost:6379',
});
```

| Option | Description |
|---|---|
| `cache` | Required cache instance that receives `delPattern(pattern)` and, for tag messages, `invalidateByTag(tag)` calls. |
| `redisUrl` | Redis URL. Defaults to `redis://localhost:6379` when neither `redisUrl` nor `redis` is provided. |
| `redis` | Existing ioredis instance used for publishing. |
| `channel` | Pub/Sub channel. Defaults to `cache-hub:invalidate`. |
| `instanceId` | Unique instance id used to filter self-sent messages. |

Methods:

| Method | Description |
|---|---|
| `invalidate(pattern)` | Invalidates the current instance with `delPattern(pattern)` and broadcasts a backward-compatible pattern message. |
| `invalidatePattern(pattern)` | Alias for `invalidate(pattern)`. |
| `invalidateTag(tag)` | Invalidates the current instance with `invalidateByTag(tag)` and broadcasts a tag message. |

### `cache-hub/atomic`

```typescript
import {
    createMemoryAtomicStateBackend,
    createRedisAtomicStateBackend,
} from 'cache-hub/atomic';
```

| API | Description |
|---|---|
| `MemoryAtomicStateBackend` | Synchronous in-memory atomic counter backend. |
| `RedisAtomicStateBackend` | Async Redis atomic counter backend backed by Lua scripts. |
| `incrementWithTtl(key, amount, ttlMs)` | Atomically increments a counter and assigns TTL on first write. |
| `decrement(key, amount?)` | Atomically decrements a counter while preserving TTL. |
| `reset(key)` | Deletes one atomic state key. |
| `resetPrefix(prefix)` | Deletes keys under a literal prefix with SCAN. |

### `cache-hub/rate-limit`

```typescript
import {
    createMemoryFixedWindowRateLimitStore,
    createMemoryRateLimitStateStore,
    createRedisFixedWindowRateLimitStore,
    createRedisRateLimitStateStore,
} from 'cache-hub/rate-limit';
```

| API | Description |
|---|---|
| `MemoryFixedWindowRateLimitStore` | Synchronous in-memory fixed-window counter. |
| `RedisFixedWindowRateLimitStore` | Async Redis fixed-window counter backed by Lua scripts. |
| `MemoryRateLimitStateStore` | In-memory sliding-window, token-bucket, and leaky-bucket state primitives. |
| `RedisRateLimitStateStore` | Redis Lua-backed sliding-window, token-bucket, and leaky-bucket state primitives. |
| `increment(key, windowMs, limit, amount?)` | Increments the current window and returns hits, remaining quota, reset time, and retry-after. |
| `decrement(key, amount?)` | Rolls back a counter, useful when downstream work fails after reservation. |
| `checkSlidingWindow(key, windowMs, limit, cost?)` | Reserves sliding-window state and returns an opaque rollback token when allowed. |
| `consumeTokenBucket(key, capacity, refillPerSecond, cost?)` | Atomically consumes token-bucket capacity and returns retry timing. |
| `consumeLeakyBucket(key, capacity, leakPerSecond, cost?)` | Atomically consumes leaky-bucket capacity and returns retry timing. |
| `reset(key)` | Deletes one rate-limit key. |
| `resetPrefix(prefix)` | Deletes keys under a literal prefix with SCAN. |

### `cache-hub/stringify`

```typescript
import { stableStringify } from 'cache-hub/stringify';

stableStringify({ b: 2, a: 1 }); // '{"a":1,"b":2}'
stableStringify(NaN); // '"__NaN__"'
```

`stableStringify` sorts object keys, handles cycles, supports custom
serializers, and keeps cache keys deterministic across processes.

---

## Redis Defaults

Redis-backed examples use:

```text
redis://localhost:6379
```

This URL means local Redis on port `6379` with no password. If your Redis
requires authentication, use the standard Redis URL form:

```text
redis://:password@host:6379
```

For tests, set `REDIS_URL` when you need a non-default endpoint:

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:integration
```

---

## Testing

```bash
# All Vitest tests; Redis integration tests run when Redis is reachable
npm test

# Coverage
npm run test:coverage

# Redis integration tests only
npm run test:integration

# Skip Redis integration tests explicitly
SKIP_INTEGRATION=true npm run test:integration
```

`npm test` runs the full Vitest suite. Redis integration cases execute when a
reachable Redis server is available; otherwise they log a skip message.
Integration tests require `ioredis` in the development environment. The package
keeps `ioredis` as an optional peer dependency for consumers and as a dev
dependency for real integration coverage.

Coverage target: statements, branches, functions, and lines all at 100%.

---

## Benchmarking

```bash
# Build first, then print benchmark tables
npm run benchmark

# Print JSON to stdout
npm run benchmark -- --json

# Write JSON to a file
npm run benchmark -- --json --output benchmark-results.json
```

The benchmark script focuses on direct library hot paths. Treat the numbers as
local performance signals, not as a replacement for production HTTP middleware
or real Redis network benchmarks.

---

## Build

```bash
# Type check only
npm run typecheck

# Build ESM, CommonJS, and declaration files
npm run build
```

Build output:

```text
dist/
├── esm/
├── cjs/
└── types/
```

The package exposes matching ESM, CJS, and type declaration paths for every
public subpath export.

---

## Node.js Support

| Node.js | Status |
|---|:---:|
| 18 LTS | Supported |
| 20 LTS | Supported |
| 22 LTS | Supported |

`cache-hub` requires Node.js `>=18.0.0`.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `redis-adapter requires ioredis` | Install `ioredis` in the consuming project: `npm install ioredis`. |
| Redis tests are skipped | Confirm Redis is running and `REDIS_URL` points to the reachable endpoint. |
| Redis auth fails | Use `redis://:password@host:6379` or pass an already configured ioredis instance. |
| Pattern deletes are slower than expected | `delPattern` and `keys` use SCAN for safety; this avoids blocking Redis like KEYS. |
| Cache misses after storing `undefined` | `undefined` is the miss signal. Use `null` or a sentinel object for cacheable empty results. |
| Tag invalidation does not remove Redis entries | Confirm entries were written with `set(key, value, ttl, { tags })` and that all instances use the same `metaKeyPrefix`. |
| Expired Redis keys still appear in tag metadata | This is expected; `invalidateByTag` cleans stale members lazily while scanning the tag. |
| Too many origin fetches after short TTL expiry | Use `readThroughWithLease` with a Redis lease store and set `leaseTtlMs` longer than normal fetch latency. |

---

## License

[MIT](./LICENSE)
