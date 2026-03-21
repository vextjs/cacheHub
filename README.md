# cache-hub

零运行时依赖的 Node.js 多层缓存库。开箱即用的本地内存缓存（LRU + TTL）、可选 Redis 远端缓存、多级联动、函数装饰器与分布式失效广播——通过统一的 `CacheLike` 接口无侵入接入任何 Node.js 服务。

[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](#测试)

---

## 特性

- **零运行时依赖** — `dependencies` 永远为空，不会污染你的依赖树
- **LRU + TTL 内存缓存** — 基于 ES6 `Map` 实现 O(1) 淘汰，支持双重容量限制（条目数 + 内存字节）
- **多级缓存** — L1 本地 + L2 远端，自动回填、超时降级、写策略可配
- **Redis 适配器** — 将 ioredis 包装为 `CacheLike`，SCAN 替代 KEYS，无阻塞
- **函数装饰器** — `withCache` 一行代码缓存任意异步函数，并发去重 + 条件缓存
- **分布式失效** — Redis Pub/Sub 广播跨实例缓存清除
- **稳定序列化** — `stableStringify` 生成确定性缓存键，处理循环引用与特殊类型
- **CJS + ESM 双格式** — 支持 `require` 和 `import`，多入口按需导入

---

## 安装

```bash
npm install cache-hub
```

### 可选：Redis 功能

Redis 适配器和分布式失效需要 [ioredis](https://github.com/redis/ioredis)：

```bash
npm install ioredis
```

---

## 快速开始

### 内存缓存

```typescript
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({
    maxEntries: 1000,       // 最多 1000 条
    ttl: 60_000,            // 默认 TTL 60 秒
    enableStats: true,
});

await cache.set('user:1', { name: 'Alice' });
const user = await cache.get('user:1');  // { name: 'Alice' }

const stats = cache.getStats();
console.log(stats.hitRate);  // 0~1 命中率
```

### 读穿缓存

```typescript
import { MemoryCache } from 'cache-hub';
import { readThrough } from 'cache-hub/read-through';

const cache = new MemoryCache({ ttl: 30_000 });

// 缓存命中直返，未命中执行 fetcher 并写缓存
// 相同 key 的并发请求共享同一 Promise（并发去重）
const user = await readThrough(cache, 30_000, 'user:1', async () => {
    return db.findUser(1);
});
```

### 函数装饰器

```typescript
import { withCache } from 'cache-hub/function-cache';
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({ maxEntries: 500 });

const getUser = withCache(
    async (userId: number) => db.findUser(userId),
    {
        cache,
        ttl: 60_000,
        namespace: 'users',
        // 条件缓存：仅缓存非空结果
        condition: (result) => result !== null,
    }
);

// 参数相同的并发调用只执行一次 db.findUser
const user = await getUser(1);
```

### 多级缓存（L1 本地 + L2 Redis）

```typescript
import { MemoryCache } from 'cache-hub';
import { MultiLevelCache } from 'cache-hub/multi-level';
import { createRedisCacheAdapter } from 'cache-hub/redis';

const local = new MemoryCache({ maxEntries: 500, ttl: 30_000 });
const remote = createRedisCacheAdapter('redis://localhost:6379');

const cache = new MultiLevelCache({
    local,
    remote,
    remoteTimeoutMs: 50,          // 远端超时降级，不影响可用性
    backfillOnRemoteHit: true,    // L2 命中时自动回填 L1
    writePolicy: 'both',          // 同步双写
});

await cache.set('product:42', data, 120_000);
const product = await cache.get('product:42');  // 先查 L1，再查 L2

await remote.close();
```

### 分布式缓存失效

```typescript
import { MemoryCache } from 'cache-hub';
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

const local = new MemoryCache({ maxEntries: 1000 });

// 多个服务实例各自持有本地缓存，通过 Redis Pub/Sub 广播失效
const invalidator = new DistributedCacheInvalidator({
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    watchedCaches: [local],
    channel: 'app:cache-invalidation',
});

// 发布失效事件，其他实例收到后自动清除本地缓存
await invalidator.invalidate(['user:1', 'user:2']);

// 应用退出时关闭连接
await invalidator.close();
```

---

## 模块参考

cache-hub 采用多入口按需导入，避免捆绑不需要的模块。

### `cache-hub` — 核心

```typescript
import { MemoryCache } from 'cache-hub';
import type { CacheLike, CacheStats, MemoryCacheOptions } from 'cache-hub';
```

#### `new MemoryCache(options?)`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxEntries` | `number` | `Infinity` | 最大条目数，超限 LRU 淘汰 |
| `maxMemory` | `number` | `Infinity` | 最大内存（字节估算），超限 LRU 淘汰 |
| `ttl` | `number` | `0`（不过期）| 默认 TTL（毫秒） |
| `cleanupInterval` | `number` | `0`（不清理）| 周期清理间隔（毫秒） |
| `enableStats` | `boolean` | `false` | 开启命中率统计 |
| `enableTags` | `boolean` | `false` | 开启标签索引，支持 `invalidateByTag` |
| `enabled` | `boolean` | `true` | `false` 时禁用缓存 |

#### `CacheLike` 接口

所有缓存实现均满足此接口，可互相替换：

```typescript
interface CacheLike<V = unknown> {
    get(key: string): V | undefined | Promise<V | undefined>;
    set(key: string, value: V, ttl?: number): void | Promise<void>;
    del(key: string): void | Promise<void>;
    exists(key: string): boolean | Promise<boolean>;
    has(key: string): boolean | Promise<boolean>;         // exists 的同步别名
    clear(): void | Promise<void>;
    keys(): string[] | Promise<string[]>;
    getMany(keys: string[]): Map<string, V> | Promise<Map<string, V>>;
    setMany(entries: Map<string, V>, ttl?: number): void | Promise<void>;
    delMany(keys: string[]): void | Promise<void>;
    delPattern(pattern: string): void | Promise<void>;   // 支持 * 通配符
    getStats(): CacheStats;
    destroy(): void | Promise<void>;
}
```

---

### `cache-hub/read-through` — 读穿缓存

```typescript
import { readThrough } from 'cache-hub/read-through';

function readThrough<V>(
    cache: CacheLike<V>,
    ttl: number,
    key: string,
    fetcher: () => Promise<V>
): Promise<V>
```

- `ttl ≤ 0`：直接执行 fetcher，不写缓存
- `fetcher` 返回 `null`：写入缓存（有效空值）；返回 `undefined`：不写缓存
- 内置并发去重（同 key 共享 Promise）+ 超时防泄漏（300s）

---

### `cache-hub/multi-level` — 多级缓存

```typescript
import { MultiLevelCache } from 'cache-hub/multi-level';

new MultiLevelCache(options: MultiLevelCacheOptions)
```

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `local` | `CacheLike` | 必填 | L1 本地缓存 |
| `remote` | `CacheLike` | 必填 | L2 远端缓存 |
| `writePolicy` | `'both' \| 'local-first-async-remote'` | `'both'` | 写策略 |
| `backfillOnRemoteHit` | `boolean` | `true` | L2 命中时回填 L1 |
| `remoteTimeoutMs` | `number` | `50` | 远端超时（毫秒），超时降级不报错 |
| `publish` | `(keys: string[]) => void` | — | 分布式失效广播回调 |

---

### `cache-hub/redis` — Redis 适配器

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';

// 方式一：URL 字符串（自动创建连接）
const adapter = createRedisCacheAdapter('redis://localhost:6379');

// 方式二：已有 ioredis 实例（不会被 close() 关闭）
import Redis from 'ioredis';
const redis = new Redis();
const adapter = createRedisCacheAdapter(redis);

// 用完后关闭（仅关闭自己创建的连接）
await adapter.close();
```

> **需要安装 ioredis**：`npm install ioredis`

---

### `cache-hub/function-cache` — 函数缓存

```typescript
import { withCache, FunctionCache } from 'cache-hub/function-cache';
```

#### `withCache(fn, options)`

```typescript
const cachedFn = withCache(asyncFn, {
    cache,                          // CacheLike 实例
    ttl?: number,                   // 毫秒，默认 60000
    namespace?: string,             // 键前缀，默认函数名
    keyBuilder?: (...args) => string,  // 自定义键生成
    condition?: (result) => boolean,   // 返回 false 时不写缓存
});
```

#### `FunctionCache` 类

```typescript
const fc = new FunctionCache({ cache, ttl: 30_000 });

fc.register('getUser', async (id: number) => db.findUser(id));
fc.register('getProduct', async (id: number) => db.findProduct(id), { ttl: 10_000 });

const user = await fc.execute('getUser', [1]);
await fc.invalidate('getUser', [1]);  // 使指定参数的缓存失效

const stats = fc.getStats();  // { getUser: { hits, misses, ... } }
```

---

### `cache-hub/distributed` — 分布式失效

```typescript
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

new DistributedCacheInvalidator(options: DistributedInvalidatorOptions)
```

| 选项 | 类型 | 说明 |
|------|------|------|
| `redisUrl` | `string` | Redis URL，与 `redis` 二选一 |
| `redis` | `ioredis` | 已有 Redis 连接，与 `redisUrl` 二选一 |
| `watchedCaches` | `CacheLike[]` | 接收到失效消息时清除这些缓存 |
| `channel` | `string` | Pub/Sub 频道名，默认 `'cache-hub:invalidation'` |
| `instanceId` | `string` | 实例唯一 ID，用于过滤自身消息（默认随机生成） |

```typescript
// 发布失效事件
await invalidator.invalidate(['key1', 'key2']);

// 查看统计
const stats = invalidator.getStats();
// { published: 5, received: 12, selfFiltered: 5 }

// 关闭连接
await invalidator.close();
```

> **需要安装 ioredis**：`npm install ioredis`

---

### `cache-hub/stringify` — 稳定序列化

```typescript
import { stableStringify } from 'cache-hub/stringify';

// 键排序，确定性输出
stableStringify({ b: 2, a: 1 })          // '{"a":1,"b":2}'

// 特殊值处理
stableStringify(NaN)                      // '"__NaN__"'（避免与字符串 "NaN" 碰撞）
stableStringify({ a: { ref: undefined } }) // 循环引用输出 "[CIRCULAR]"

// 自定义序列化器（如 BSON ObjectId）
stableStringify(value, {
    customSerializer: (v) => {
        if (v instanceof ObjectId) return v.toHexString();
        return undefined;  // undefined 表示使用默认序列化
    }
});
```

---

## 测试

```bash
# 单元测试（440 个，无需外部依赖）
npm test

# 单元测试 + 覆盖率报告
npm run test:coverage

# 集成测试（30 个，需要本地 Redis）
npm run test:integration

# 指定 Redis 地址
REDIS_URL=redis://myhost:6380 npm run test:integration

# 跳过集成测试
SKIP_INTEGRATION=true npm run test:integration
```

覆盖率目标：**Statements / Branches / Functions / Lines 全部 100%**

---

## 构建

```bash
# 完整构建（ESM + CJS + 类型声明）
npm run build

# 仅类型检查
npm run typecheck
```

构建产物：
```
dist/
├── esm/      # ES Module 格式（.js）
├── cjs/      # CommonJS 格式（.js）
└── types/    # TypeScript 类型声明（.d.ts）
```

---

## Node.js 版本兼容性

| Node.js | 支持 |
|---------|:----:|
| 16 LTS  | ✅   |
| 18 LTS  | ✅   |
| 20 LTS  | ✅   |
| 22 LTS  | ✅   |

---

## License

[MIT](./LICENSE)