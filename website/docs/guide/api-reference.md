# API 参考

本文档列出 cache-hub 所有公开模块的完整 API，包含方法签名、参数说明与使用示例。

---

## `cache-hub` — 核心模块

```typescript
import { MemoryCache } from 'cache-hub';
import type { CacheLike, CacheStats, MemoryCacheOptions } from 'cache-hub';
```

### `new MemoryCache(options?)`

创建一个基于 ES6 Map 的 LRU + TTL 内存缓存实例。

#### 构造参数 `MemoryCacheOptions`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxEntries` | `number` | `Infinity` | 最大条目数，超限后 LRU 淘汰最旧条目 |
| `maxMemory` | `number` | `Infinity` | 最大内存字节数（估算值），超限后 LRU 淘汰 |
| `ttl` | `number` | `0` | 默认 TTL（毫秒），`0` 表示不过期 |
| `cleanupInterval` | `number` | `0` | 周期清理间隔（毫秒），`0` 表示不开启 |
| `enableStats` | `boolean` | `false` | 是否开启命中率统计 |
| `enableTags` | `boolean` | `false` | 是否开启标签索引，支持 `invalidateByTag` |
| `enabled` | `boolean` | `true` | 全局开关，`false` 时 get 返回 undefined，set 不写入 |

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `get` | `(key: string) => V \| undefined` | 读取缓存，不存在或已过期返回 `undefined` |
| `set` | `(key: string, value: V, ttl?: number) => void` | 写入缓存，`ttl` 覆盖全局默认值 |
| `del` | `(key: string) => void` | 删除指定 key |
| `exists` | `(key: string) => boolean` | 判断 key 是否存在且未过期 |
| `has` | `(key: string) => boolean` | `exists` 的同步别名 |
| `clear` | `() => void` | 清空所有缓存 |
| `keys` | `() => string[]` | 返回所有有效（未过期）key 的列表 |
| `getMany` | `(keys: string[]) => Map<string, V>` | 批量读取，不存在的 key 不出现在结果 Map 中 |
| `setMany` | `(entries: Map<string, V>, ttl?: number) => void` | 批量写入 |
| `delMany` | `(keys: string[]) => void` | 批量删除 |
| `delPattern` | `(pattern: string) => void` | 按通配符模式删除，支持 `*`（`?` 和 `[` 被视为字面量）|
| `invalidateByTag` | `(tag: string) => void` | 按标签批量失效（需 `enableTags: true`）|
| `getStats` | `() => CacheStats` | 获取统计信息 |
| `destroy` | `() => void` | 清空缓存并停止周期清理定时器 |

---

### `CacheLike<V>` 接口

所有缓存实现（`MemoryCache`、`RedisCacheAdapter`、`MultiLevelCache`）均满足此接口，可互相替换。

```typescript
interface CacheLike<V = unknown> {
    get(key: string): V | undefined | Promise<V | undefined>;
    set(key: string, value: V, ttl?: number): void | Promise<void>;
    del(key: string): void | Promise<void>;
    exists(key: string): boolean | Promise<boolean>;
    has(key: string): boolean | Promise<boolean>;
    clear(): void | Promise<void>;
    keys(): string[] | Promise<string[]>;
    getMany(keys: string[]): Map<string, V> | Promise<Map<string, V>>;
    setMany(entries: Map<string, V>, ttl?: number): void | Promise<void>;
    delMany(keys: string[]): void | Promise<void>;
    delPattern(pattern: string): void | Promise<void>;
    getStats(): CacheStats;
    destroy(): void | Promise<void>;
}
```

---

### `CacheStats` 类型

```typescript
interface CacheStats {
    hits: number;          // 缓存命中次数
    misses: number;        // 缓存未命中次数
    sets: number;          // 写入次数
    deletes: number;       // 删除次数
    evictions: number;     // LRU 淘汰次数
    memoryUsage: number;   // 估算内存占用（字节）
    hitRate: number;       // 命中率（0~1），= hits / (hits + misses)
}
```

---

## `cache-hub/read-through` — 读穿缓存

```typescript
import { readThrough } from 'cache-hub/read-through';
```

### `readThrough(cache, ttl, key, fetcher)`

```typescript
function readThrough<V>(
    cache: CacheLike<V>,
    ttl: number,
    key: string,
    fetcher: () => Promise<V>
): Promise<V>
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `cache` | `CacheLike<V>` | 目标缓存实例 |
| `ttl` | `number` | TTL（毫秒），`<= 0` 时直接执行 fetcher 不写缓存 |
| `key` | `string` | 缓存 key |
| `fetcher` | `() => Promise<V>` | 未命中时调用的数据加载函数 |

#### 行为说明

- **并发去重**：相同 key 的并发调用共享同一个 Promise，fetcher 只执行一次
- **null 语义**：fetcher 返回 `null` → 写入缓存（有效空值）；返回 `undefined` → 不写缓存
- **溢出保护**：内部 in-flight 表超过 10000 条时，自动清理最旧 10%
- **超时防漏**：in-flight 条目超过 300 秒未完成，自动清理（防内存泄漏）

---

## `cache-hub/multi-level` — 多级缓存

```typescript
import { MultiLevelCache } from 'cache-hub/multi-level';
```

### `new MultiLevelCache(options)`

#### 构造参数 `MultiLevelCacheOptions`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `local` | `CacheLike` | 必填 | L1 本地缓存实例 |
| `remote` | `CacheLike` | 必填 | L2 远端缓存实例 |
| `writePolicy` | `'both' \| 'local-first-async-remote'` | `'both'` | `'both'`：同步双写；`'local-first-async-remote'`：本地优先，异步写远端 |
| `backfillOnRemoteHit` | `boolean` | `true` | L2 命中时自动回填 L1 |
| `remoteTimeoutMs` | `number` | `50` | 远端操作超时（毫秒），超时后降级，不抛错 |
| `publish` | `(keys: string[]) => void` | — | 写入/删除后调用此回调广播失效事件（配合 `DistributedCacheInvalidator` 使用）|

#### 读取逻辑

```
get(key)
  ↓ 查 L1（本地）
  → 命中 → 返回
  → 未命中 → 查 L2（远端，含超时保护）
              → 命中 → 回填 L1（若 backfillOnRemoteHit=true）→ 返回
              → 未命中 → 返回 undefined
```

#### 实例方法

`MultiLevelCache` 实现完整的 `CacheLike` 接口，所有写操作（`set / del / clear / setMany / delMany / delPattern`）根据 `writePolicy` 同时操作 L1 和 L2。

---

## `cache-hub/redis` — Redis 适配器

```typescript
import { createRedisCacheAdapter } from 'cache-hub/redis';
```

> **前置条件**：需安装 `ioredis`（`npm install ioredis`）

### `createRedisCacheAdapter(urlOrInstance)`

```typescript
function createRedisCacheAdapter(
    urlOrInstance: string | Redis
): RedisCacheAdapter
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `urlOrInstance` | `string` | Redis URL（如 `'redis://localhost:6379'`），适配器自行创建连接并在 `close()` 时关闭 |
| `urlOrInstance` | `Redis` | 已有 ioredis 实例，`close()` 时**不会**关闭此连接 |

#### 实例方法

`RedisCacheAdapter` 实现完整的 `CacheLike` 接口，并额外提供：

| 方法 | 说明 |
|------|------|
| `close()` | 关闭适配器自己创建的连接（传入外部实例时不执行） |

#### 行为说明

| 特性 | 说明 |
|------|------|
| 序列化 | 值以 JSON 字符串存储，支持 `null` 作为有效值 |
| TTL | 通过 Redis `PEXPIRE` 实现毫秒精度过期 |
| `delPattern` / `keys` | 使用 SCAN 游标迭代，不使用 `KEYS`（防阻塞）|
| 超长 key | 超过 512 字节的 key 自动使用 SHA-256 哈希压缩 |
| 超长 pattern | 超过 512 字符的 pattern 截断并打印 `console.warn` |

---

## `cache-hub/function-cache` — 函数缓存

```typescript
import { withCache, FunctionCache } from 'cache-hub/function-cache';
```

### `withCache(fn, options)`

```typescript
function withCache<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    options: WithCacheOptions<A, R>
): (...args: A) => Promise<R>
```

#### `WithCacheOptions`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cache` | `CacheLike` | 必填 | 目标缓存实例 |
| `ttl` | `number` | `60000` | 缓存 TTL（毫秒）|
| `namespace` | `string` | 函数名 | 键前缀 |
| `keyBuilder` | `(...args: A) => string` | — | 自定义 key 生成函数，覆盖默认的 `stableStringify(args)` |
| `condition` | `(result: R) => boolean` | — | 返回 `false` 时不写缓存 |

#### 键生成规则

```
{namespace}:{fnName}:{stableStringify(args)}
```

若生成的 key 超过 512 字节，自动使用 SHA-256 哈希压缩：
```
{namespace}:{fnName}:sha256:{hash}
```

---

### `new FunctionCache(globalOptions)`

多函数统一缓存管理器。

```typescript
const fc = new FunctionCache({
    cache: CacheLike,   // 必填，所有注册函数共享
    ttl?: number,       // 全局默认 TTL（毫秒），默认 60000
    namespace?: string, // 全局默认命名空间前缀
});
```

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `register` | `(name, fn, options?)` | 注册一个函数，`options` 可覆盖全局 `ttl` / `keyBuilder` / `condition` |
| `execute` | `(name, args)` | 执行已注册的函数（自动缓存，并发去重）|
| `invalidate` | `(name, args?)` | 失效指定函数的缓存；不传 `args` 时失效该函数所有缓存 |
| `getStats` | `()` | 返回各函数的统计信息 `Record<string, CacheStats>` |

---

## `cache-hub/distributed` — 分布式失效

```typescript
import { DistributedCacheInvalidator } from 'cache-hub/distributed';
```

> **前置条件**：需安装 `ioredis`（`npm install ioredis`）

### `new DistributedCacheInvalidator(options)`

#### 构造参数 `DistributedInvalidatorOptions`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `redisUrl` | `string` | — | Redis URL，与 `redis` 二选一（自动创建 pub + sub 两个连接）|
| `redis` | `Redis` | — | 已有 ioredis 实例，用作 pub 连接（sub 连接会额外创建）|
| `watchedCaches` | `CacheLike[]` | `[]` | 收到失效消息时，对这些缓存实例执行 `del` |
| `channel` | `string` | `'cache-hub:invalidation'` | Redis Pub/Sub 频道名 |
| `instanceId` | `string` | 随机 UUID | 实例唯一标识，用于过滤自身发出的消息 |

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `invalidate` | `(keys: string[]) => Promise<void>` | 向频道发布失效事件，其他实例收到后清除对应 key |
| `getStats` | `() => InvalidatorStats` | 获取统计信息 |
| `close` | `() => Promise<void>` | 关闭 pub/sub 连接（外部传入的连接不关闭）|

#### `InvalidatorStats`

```typescript
interface InvalidatorStats {
    published: number;     // 本实例发布的失效消息数
    received: number;      // 收到的失效消息总数（含所有实例）
    selfFiltered: number;  // 自身发出被过滤掉的消息数
}
```

---

## `cache-hub/stringify` — 稳定序列化

```typescript
import { stableStringify } from 'cache-hub/stringify';
```

### `stableStringify(value, options?)`

```typescript
function stableStringify(
    value: unknown,
    options?: StableStringifyOptions
): string
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `value` | `unknown` | 待序列化的任意值 |
| `options.customSerializer` | `(value: unknown) => string \| undefined` | 自定义序列化器，返回 `undefined` 时使用默认逻辑 |

#### 特殊值处理规则

| 输入 | 输出 | 说明 |
|------|------|------|
| 普通对象 `{ b: 2, a: 1 }` | `'{"a":1,"b":2}'` | 键按字母顺序排序 |
| `NaN` | `'"__NaN__"'` | 避免与字符串 `"NaN"` 产生键碰撞 |
| 循环引用 | `'"[CIRCULAR]"'` | 安全处理循环引用，不抛错 |
| `Date` | `'"2026-03-22T..."'` | ISO 8601 格式 |
| `RegExp` | `'"/pattern/flags"'` | 保留完整正则表达式 |
| 数组 | 保序 | 数组元素顺序不变 |
| `undefined` | `'null'` | JSON 标准行为 |

#### 示例

```typescript
import { stableStringify } from 'cache-hub/stringify';

// 键排序
stableStringify({ z: 3, a: 1, m: 2 });
// → '{"a":1,"m":2,"z":3}'

// NaN 安全
stableStringify(NaN);       // → '"__NaN__"'
stableStringify('NaN');     // → '"NaN"'  ← 与 NaN 不同，无碰撞

// 循环引用
const obj: Record<string, unknown> = { a: 1 };
obj.self = obj;
stableStringify(obj);       // → '{"a":1,"self":"[CIRCULAR]"}'

// 自定义序列化器（如 MongoDB ObjectId）
import { ObjectId } from 'mongodb';
stableStringify(new ObjectId('507f1f77bcf86cd799439011'), {
    customSerializer: (v) => v instanceof ObjectId ? v.toHexString() : undefined,
});
// → '"507f1f77bcf86cd799439011"'
```

---

## 环境变量

集成测试与运行时支持以下环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接地址（集成测试与 DistributedCacheInvalidator 使用）|
| `SKIP_INTEGRATION` | — | 设为 `true` 时跳过集成测试 |

---

## TypeScript 类型导出

所有公开类型均从对应入口导出：

```typescript
// 核心类型
import type {
    CacheLike,
    CacheStats,
    MemoryCacheOptions,
} from 'cache-hub';

// 各模块配置类型
import type { MultiLevelCacheOptions } from 'cache-hub/multi-level';
import type { WithCacheOptions } from 'cache-hub/function-cache';
import type { DistributedInvalidatorOptions } from 'cache-hub/distributed';
import type { StableStringifyOptions } from 'cache-hub/stringify';
```
