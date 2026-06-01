# cache-hub 中文文档

零运行时依赖的 Node.js 缓存与原子状态工具库。

`cache-hub` 提供内存 LRU + TTL 缓存、可选 Redis 集成、读穿缓存、函数级缓存、分布式失效、稳定缓存键序列化、原子状态后端，以及限流状态原语。所有核心能力都围绕轻量的 `CacheLike` 契约组织，便于在不同 Node.js 服务中复用。

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](#测试)

英文 README: [../README.md](../README.md)

---

## 目录导航

- [为什么选择 cache-hub](#为什么选择-cache-hub)
- [安装](#安装)
- [快速开始](#快速开始)
- [模块参考](#模块参考)
- [Redis 默认连接](#redis-默认连接)
- [测试](#测试)
- [性能基准](#性能基准)
- [构建](#构建)
- [Node.js 支持](#nodejs-支持)
- [常见问题排查](#常见问题排查)
- [许可证](#许可证)

---

## 为什么选择 cache-hub

- **零运行时依赖**：`dependencies` 保持为空；Redis 作为可选 peer dependency。
- **LRU + TTL 内存缓存**：基于 O(1) 路径实现，支持条目数和估算内存双重限制。
- **多级缓存**：L1 本地缓存加可选 L2 远端缓存，支持 TTL 保真回填、远端超时降级和可配置写策略。
- **Redis 适配器**：将 ioredis 包装为 `CacheLike`；模式操作使用 SCAN，不使用生产环境高风险的 KEYS。
- **读穿缓存**：未命中时执行 fetcher、写回缓存，并对同 key 并发请求做 in-flight 去重。
- **函数缓存**：通过 `withCache` 或 `FunctionCache` 缓存任意异步函数。
- **分布式失效**：通过 Redis Pub/Sub 在多个服务实例之间广播缓存失效。
- **稳定键序列化**：对象键排序、循环引用处理、特殊值哨兵，保证不同进程中的缓存键确定性。
- **原子状态后端**：提供内存与 Redis 计数器原语，适合高并发状态更新。
- **限流原语**：提供固定窗口、滑动窗口、token bucket、leaky bucket 状态存储，便于 HTTP middleware 作者接入。
- **双格式发布**：同时提供 ESM、CommonJS 和类型声明，多入口按需导入。

---

## 安装

```bash
npm install cache-hub
```

Redis 相关能力需要安装 ioredis：

```bash
npm install ioredis
```

`ioredis` 是可选 peer dependency。只使用内存缓存的项目不需要安装它。

---

## 快速开始

### 内存缓存

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

### 读穿缓存

```typescript
import { MemoryCache } from 'cache-hub';
import { readThrough } from 'cache-hub/read-through';

const cache = new MemoryCache({ defaultTtl: 30_000 });

const user = await readThrough(cache, 30_000, 'user:1', async () => {
    return db.findUser(1);
});
```

`readThrough` 命中缓存时直接返回；未命中时执行 fetcher，将非 `undefined` 结果写回缓存，并让同 key 并发调用共享同一个 Promise。

### 函数缓存

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

默认 keyBuilder 使用 `stableStringify`。超过阈值的长 key 会使用 SHA-256 摘要压缩。

### 多级缓存

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

### 分布式失效

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
await invalidator.close();
```

调用 `invalidate(pattern)` 时，当前实例会先失效本地缓存，再把同一个 pattern 广播给其他订阅实例。

### 固定窗口限流存储

```typescript
import { createMemoryFixedWindowRateLimitStore } from 'cache-hub/rate-limit';

const store = createMemoryFixedWindowRateLimitStore();

const result = store.increment('rl:user:42', 60_000, 100);

if (result.remaining === 0) {
    console.log(`Retry after ${result.retryAfterMs}ms`);
}
```

Redis 版本通过 Lua 脚本保证 increment/decrement 原子性：

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

`cache-hub/rate-limit` 是面向 middleware 作者的低层原语，不绑定具体 HTTP 框架。

### 原子状态后端

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';
import { createRedisAtomicStateBackend } from 'cache-hub/atomic';

const redisCache = createRedisCacheAdapter('redis://localhost:6379');
const atomic = createRedisAtomicStateBackend(redisCache);

const result = await atomic.incrementWithTtl('counter:tenant:42', 1, 60_000);

console.log(result.value, result.ttlMs);
await redisCache.close();
```

Redis 后端使用 Lua 脚本保证原子读改写。对于高并发计数器，这比普通 `get -> set` 更安全，不会因为并发覆盖导致计数丢失。

---

## 模块参考

### `cache-hub`

```typescript
import { MemoryCache } from 'cache-hub';
import type { CacheLike, CacheStats, MemoryCacheOptions } from 'cache-hub';
```

#### `new MemoryCache(options?)`

| 选项 | 类型 | 默认值 | 说明 |
|---|---:|---:|---|
| `maxEntries` | `number` | `10000` | 最大条目数，超限后按 LRU 淘汰。 |
| `maxMemory` | `number` | `0` | 估算最大内存字节数，`0` 表示不限制。 |
| `defaultTtl` | `number` | `0` | 默认 TTL，单位毫秒；`0` 表示不过期。 |
| `cleanupInterval` | `number` | `0` | 周期清理过期条目的间隔，单位毫秒。 |
| `enableStats` | `boolean` | `true` | 是否启用命中/未命中统计。 |
| `enableTags` | `boolean` | `false` | 是否启用标签索引与 `invalidateByTag`。 |
| `enabled` | `boolean` | `true` | 设置为 `false` 时禁用缓存读写。 |

`MemoryCache` 还提供 `getRemainingTtl(key)` 和 `getRemainingTtlMany(keys)`。不过期的已存在 key 返回 `null`；不存在或已过期 key 返回 `undefined`。

#### `CacheLike`

所有缓存实现都可通过这个接口互换：

```typescript
interface CacheLike {
    get<T = any>(key: string): T | undefined | Promise<T | undefined>;
    set(key: string, value: any, ttl?: number): void | Promise<void>;
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
    invalidateByTag?(tag: string): void | Promise<void>;
    getStats?(): CacheStats;
    resetStats?(): void;
    destroy?(): void;
    setLockManager?(lm: LockManager): void;
}
```

### `cache-hub/read-through`

```typescript
import { readThrough } from 'cache-hub/read-through';

function readThrough<V>(
    cache: CacheLike,
    ttl: number,
    key: string,
    fetcher: () => Promise<V>,
): Promise<V>;
```

- `ttl <= 0` 时直接执行 fetcher，不写缓存。
- `null` 是合法缓存值，会写入缓存。
- `undefined` 是未命中信号，不会写入缓存。
- 同 key 并发调用共享一个 in-flight Promise。

### `cache-hub/multi-level`

```typescript
import { MultiLevelCache } from 'cache-hub/multi-level';

new MultiLevelCache(options);
```

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `local` | `CacheLike` | 必填 | L1 本地缓存。 |
| `remote` | `CacheLike` | `undefined` | 可选 L2 远端缓存。 |
| `writePolicy` | `'both' \| 'local-first-async-remote'` | `'both'` | 写穿或本地优先异步远端写入。 |
| `backfillOnRemoteHit` | `boolean` | `true` | L2 命中后回填 L1；远端支持 TTL 查询时保留剩余 TTL。 |
| `remoteTimeoutMs` | `number` | `50` | L2 get 超时时间，超时后按 L1 未命中降级。 |
| `publish` | `(msg) => void` | `undefined` | 可选分布式失效消息回调。 |

### `cache-hub/redis`

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';

const adapter = createRedisCacheAdapter('redis://localhost:6379');
```

Redis adapter 实现 `CacheLike`，并额外提供：

| 方法 | 说明 |
|---|---|
| `getRemainingTtl(key)` | 返回剩余 TTL 毫秒数；不过期 key 返回 `null`，不存在 key 返回 `undefined`。 |
| `getRemainingTtlMany(keys)` | 批量查询 TTL。 |
| `close()` | 只关闭 adapter 自己创建的连接；外部传入的 ioredis 实例不会被关闭。 |
| `getRedisInstance()` | 返回底层 ioredis 实例，供高级场景使用。 |

模式操作使用 `SCAN COUNT 100`，不会使用 `KEYS`。

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

`withCache(fn).invalidateAll()` 只删除该包装函数实际写入过的 key，不会误删共享相同前缀的手工 key。

### `cache-hub/distributed`

```typescript
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

const invalidator = new DistributedCacheInvalidator({
    cache,
    redisUrl: 'redis://localhost:6379',
});
```

| 选项 | 说明 |
|---|---|
| `cache` | 必填，收到失效消息时调用该实例的 `delPattern(pattern)`。 |
| `redisUrl` | Redis URL；未传 `redisUrl` 或 `redis` 时默认 `redis://localhost:6379`。 |
| `redis` | 已有 ioredis 实例，用作发布连接。 |
| `channel` | Pub/Sub 频道，默认 `cache-hub:invalidate`。 |
| `instanceId` | 当前实例 ID，用于过滤自身消息。 |

### `cache-hub/atomic`

```typescript
import {
    createMemoryAtomicStateBackend,
    createRedisAtomicStateBackend,
} from 'cache-hub/atomic';
```

| API | 说明 |
|---|---|
| `MemoryAtomicStateBackend` | 同步内存原子计数后端。 |
| `RedisAtomicStateBackend` | 基于 Lua 脚本的异步 Redis 原子计数后端。 |
| `incrementWithTtl(key, amount, ttlMs)` | 原子递增计数器，并在首次写入时设置 TTL。 |
| `decrement(key, amount?)` | 原子递减计数器并保留 TTL。 |
| `reset(key)` | 删除单个原子状态 key。 |
| `resetPrefix(prefix)` | 使用 SCAN 删除字面量前缀下的 key。 |

### `cache-hub/rate-limit`

```typescript
import {
    createMemoryFixedWindowRateLimitStore,
    createMemoryRateLimitStateStore,
    createRedisFixedWindowRateLimitStore,
    createRedisRateLimitStateStore,
} from 'cache-hub/rate-limit';
```

| API | 说明 |
|---|---|
| `MemoryFixedWindowRateLimitStore` | 同步内存固定窗口计数器。 |
| `RedisFixedWindowRateLimitStore` | 基于 Lua 脚本的异步 Redis 固定窗口计数器。 |
| `MemoryRateLimitStateStore` | 内存滑动窗口、token bucket、leaky bucket 状态原语。 |
| `RedisRateLimitStateStore` | 基于 Redis Lua 的滑动窗口、token bucket、leaky bucket 状态原语。 |
| `increment(key, windowMs, limit, amount?)` | 增加当前窗口计数，并返回 hits、remaining、resetTime、retryAfter 等状态。 |
| `decrement(key, amount?)` | 回滚计数，适合下游处理失败后的补偿。 |
| `checkSlidingWindow(key, windowMs, limit, cost?)` | 预留滑动窗口状态，允许时返回不透明 rollback token。 |
| `consumeTokenBucket(key, capacity, refillPerSecond, cost?)` | 原子消耗 token bucket 容量，并返回重试时间。 |
| `consumeLeakyBucket(key, capacity, leakPerSecond, cost?)` | 原子消耗 leaky bucket 容量，并返回重试时间。 |
| `reset(key)` | 删除单个限流 key。 |
| `resetPrefix(prefix)` | 使用 SCAN 删除字面量前缀下的限流 key。 |

### `cache-hub/stringify`

```typescript
import { stableStringify } from 'cache-hub/stringify';

stableStringify({ b: 2, a: 1 }); // '{"a":1,"b":2}'
stableStringify(NaN); // '"__NaN__"'
```

`stableStringify` 会排序对象键、处理循环引用、支持自定义序列化器，并保证不同进程生成确定性的缓存键。

---

## Redis 默认连接

Redis 示例默认使用：

```text
redis://localhost:6379
```

该 URL 表示本机 `6379` 端口、无密码。如果 Redis 需要密码，请使用标准 Redis URL：

```text
redis://:password@host:6379
```

测试非默认地址时可设置 `REDIS_URL`：

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:integration
```

---

## 测试

```bash
# 全部 Vitest 测试；Redis 可连接时会执行集成测试
npm test

# 覆盖率
npm run test:coverage

# 仅 Redis 集成测试
npm run test:integration

# 显式跳过 Redis 集成测试
SKIP_INTEGRATION=true npm run test:integration
```

`npm test` 会运行完整 Vitest 测试套件。Redis 可连接时会执行集成测试；不可连接时会打印跳过信息。集成测试需要开发环境安装 `ioredis`。对使用者而言，`ioredis` 仍是可选 peer dependency；对本仓库而言，它作为 devDependency 用于真实集成覆盖。

覆盖率目标：Statements、Branches、Functions、Lines 均为 100%。

---

## 性能基准

```bash
# 先构建，再输出 benchmark 表格
npm run benchmark

# 输出 JSON 到 stdout
npm run benchmark -- --json

# 写入 JSON 文件
npm run benchmark -- --json --output benchmark-results.json
```

当前 benchmark 主要覆盖库内部热点路径。它适合作为本地性能信号，不应替代生产 HTTP middleware 或真实 Redis 网络链路压测。

---

## 构建

```bash
# 仅类型检查
npm run typecheck

# 构建 ESM、CommonJS 和类型声明
npm run build
```

构建产物：

```text
dist/
├── esm/
├── cjs/
└── types/
```

每个公开 subpath export 都提供匹配的 ESM、CJS 与类型声明路径。

---

## Node.js 支持

| Node.js | 状态 |
|---|:---:|
| 18 LTS | 支持 |
| 20 LTS | 支持 |
| 22 LTS | 支持 |

`cache-hub` 要求 Node.js `>=18.0.0`。

---

## 常见问题排查

| 现象 | 检查项 |
|---|---|
| 提示 `redis-adapter requires ioredis` | 在消费项目中安装 `ioredis`：`npm install ioredis`。 |
| Redis 测试被跳过 | 确认 Redis 正在运行，并且 `REDIS_URL` 指向可连接地址。 |
| Redis 鉴权失败 | 使用 `redis://:password@host:6379`，或传入已配置好的 ioredis 实例。 |
| 模式删除比预期慢 | `delPattern` 与 `keys` 为安全使用 SCAN，避免 KEYS 阻塞 Redis。 |
| 存入 `undefined` 后仍像未命中 | `undefined` 是未命中信号；需要缓存空结果时请使用 `null` 或哨兵对象。 |

---

## 许可证

[MIT](../LICENSE)
