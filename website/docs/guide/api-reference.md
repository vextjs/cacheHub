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
| `maxEntries` | `number` | `10000` | 最大条目数，超限后 LRU 淘汰最旧条目 |
| `maxMemory` | `number` | `0` | 最大内存字节数（估算值），超限后 LRU 淘汰；`0` 表示无内存限制 |
| `defaultTtl` | `number` | `0` | 默认 TTL（毫秒），`0` 表示不过期 |
| `cleanupInterval` | `number` | `0` | 周期清理间隔（毫秒），`0` 表示不开启 |
| `enableStats` | `boolean` | `true` | 是否开启命中率统计 |
| `enableTags` | `boolean` | `false` | 是否开启标签索引，支持 `invalidateByTag` |
| `enabled` | `boolean` | `true` | 全局开关，`false` 时 get 返回 undefined，set 不写入 |

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `get` | `(key: string) => V \| undefined` | 读取缓存，不存在或已过期返回 `undefined` |
| `set` | `(key: string, value: V, ttl?: number) => void` | 写入缓存，`ttl` 覆盖全局默认值 |
| `del` | `(key: string) => boolean` | 删除指定 key，返回 `true` 表示成功删除，`false` 表示 key 不存在 |
| `exists` | `(key: string) => boolean` | 判断 key 是否存在且未过期 |
| `has` | `(key: string) => boolean` | `exists` 的同步别名 |
| `clear` | `() => void` | 清空所有缓存 |
| `keys` | `(pattern?: string) => string[]` | 返回所有有效（未过期）key 的列表，支持通配符过滤 |
| `getMany` | `(keys: string[]) => Record<string, V>` | 批量读取，不存在的 key 不出现在结果对象中 |
| `setMany` | `(entries: Record<string, V>, ttl?: number) => boolean` | 批量写入，始终返回 `true` |
| `delMany` | `(keys: string[]) => number` | 批量删除，返回实际删除的条目数 |
| `delPattern` | `(pattern: string) => number` | 按通配符模式删除，返回删除条目数，支持 `*`（`?` 和 `[` 被视为字面量）|
| `invalidateByTag` | `(tag: string) => void` | 按标签批量失效（需 `enableTags: true`）|
| `getStats` | `() => CacheStats` | 获取统计信息 |
| `destroy` | `() => void` | 清空缓存并停止周期清理定时器 |

---

### `CacheLike` 接口

所有缓存实现（`MemoryCache`、`RedisCacheAdapter`、`MultiLevelCache`）均满足此接口，可互相替换。

```typescript
interface CacheLike {
    // ── 必填方法（11 个）──
    get<T = any>(key: string): T | undefined | Promise<T | undefined>;
    set(key: string, value: any, ttl?: number): void | Promise<void>;
    del(key: string): boolean | Promise<boolean>;
    exists(key: string): boolean | Promise<boolean>;
    has(key: string): boolean | Promise<boolean>;          // exists 的同步别名
    clear(): void | Promise<void>;
    keys(pattern?: string): string[] | Promise<string[]>;
    getMany(keys: string[]): Record<string, any> | Promise<Record<string, any>>;
    setMany(entries: Record<string, any>, ttl?: number): boolean | Promise<boolean>;
    delMany(keys: string[]): number | Promise<number>;
    delPattern(pattern: string): number | Promise<number>; // 支持 * 通配符
    // ── 可选扩展（5 个）──
    invalidateByTag?(tag: string): void | Promise<void>;
    getStats?(): CacheStats;
    resetStats?(): void;
    destroy?(): void;
    setLockManager?(lm: LockManager): void;
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
    entries: number;       // 当前存活条目数
    memoryUsage: number;   // 估算内存占用（字节）
    memoryUsageMB: number; // 估算内存占用（MB，保留 3 位小数）
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
    cache: CacheLike,
    ttl: number,
    key: string,
    fetcher: () => Promise<V>
): Promise<V>
```

#### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `cache` | `CacheLike` | 目标缓存实例 |
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
| `remote` | `CacheLike` | — | L2 远端缓存实例（可选，未传时单级运行）|
| `writePolicy` | `'both' \| 'local-first-async-remote'` | `'both'` | `'both'`：同步双写；`'local-first-async-remote'`：本地优先，异步写远端 |
| `backfillOnRemoteHit` | `boolean` | `true` | L2 命中时自动回填 L1 |
| `remoteTimeoutMs` | `number` | `50` | 远端操作超时（毫秒），超时后降级，不抛错 |
| `publish` | `(msg: { type: string; pattern: string; ts: number }) => void` | — | `delPattern` 时调用此回调广播失效事件（配合 `DistributedCacheInvalidator` 使用）|

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
| 超长 pattern | 超过 512 字符的 pattern 截断并打印 `console.warn`（key 无长度限制）|

---

## `cache-hub/function-cache` — 函数缓存

```typescript
import { withCache, FunctionCache } from 'cache-hub/function-cache';
```

### `withCache(fn, options)`

```typescript
function withCache<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    options?: WithCacheOptions<T>
): WrappedFunction<T>
```

#### `WithCacheOptions`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cache` | `CacheLike` | 新建 `MemoryCache` | 目标缓存实例 |
| `ttl` | `number` | `60000` | 缓存 TTL（毫秒）|
| `namespace` | `string` | `'fn'` | 键前缀 |
| `keyBuilder` | `(...args: Parameters<T>) => string` | — | 自定义 key 生成函数，覆盖默认的 `stableStringify(args)` |
| `condition` | `(result: Awaited<ReturnType<T>>) => boolean` | — | 返回 `false` 时不写缓存 |

#### 键生成规则

```
{namespace}:{fnName}:{stableStringify(args)}
```

若生成的 key 超过 1024 字节，自动使用 SHA-256 哈希压缩：
```
{namespace}:{fnName}:sha256:{hash}
```

#### `WrappedFunction` 附加方法

`withCache` 返回的函数除原有签名外，还附带以下方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `invalidate` | `(...args: Parameters<T>) => Promise<void>` | 使指定参数组合的缓存条目失效 |
| `invalidateAll` | `() => Promise<void>` | 使该包装函数写入的全部缓存条目失效 |
| `stats` | `() => WithCacheStats` | 获取调用统计（hits / misses / errors / hitRate）|

---

### `new FunctionCache(cache, options?)`

多函数统一缓存管理器。

```typescript
const fc = new FunctionCache(cache, {
    ttl?: number,       // 全局默认 TTL（毫秒），默认 60000
    namespace?: string, // 全局默认命名空间前缀，默认 'fn'
});
```

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `register` | `(name, fn, options?)` | 注册一个函数，`options` 可覆盖全局 `ttl` / `keyBuilder` / `condition` |
| `execute` | `(name, ...args)` | 执行已注册的函数（自动缓存，并发去重）|
| `invalidate` | `(name, ...args)` | 失效指定函数特定参数的缓存 |
| `invalidatePattern` | `(pattern) => Promise<number>` | 按通配符模式批量失效，返回删除条目数 |
| `list` | `() => string[]` | 返回所有已注册的函数名称 |
| `getStats` | `(name?) => FunctionCacheStats \| Record<string, FunctionCacheStats>` | 获取指定函数或全部函数的统计信息 |
| `resetStats` | `(name?)` | 重置统计计数器，不传 `name` 时重置全部 |
| `clear` | `()` | 清除全部已注册函数（不清除缓存数据）|

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
| `cache` | `CacheLike` | 必填 | 收到失效消息时，对该缓存实例执行 `delPattern` |
| `redisUrl` | `string` | `'redis://localhost:6379'` | Redis URL，与 `redis` 二选一，均未提供时使用默认地址 |
| `redis` | `Redis` | — | 已有 ioredis 实例，用作 pub 连接（sub 连接会额外创建）|
| `channel` | `string` | `'cache-hub:invalidate'` | Redis Pub/Sub 频道名 |
| `instanceId` | `string` | 随机 UUID | 实例唯一标识，用于过滤自身发出的消息 |

#### 实例方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `invalidate` | `(pattern: string) => Promise<void>` | 向频道广播失效事件，其他实例收到后执行 `delPattern(pattern)` |
| `getStats` | `() => InvalidatorStats` | 获取统计信息 |
| `close` | `() => Promise<void>` | 关闭 pub/sub 连接（外部传入的连接不关闭）|

#### `InvalidatorStats`

```typescript
interface InvalidatorStats {
    messagesSent: number;            // 本实例通过 publish 发出的失效消息数
    messagesReceived: number;        // 从频道接收到的消息总数（含所有实例）
    invalidationsTriggered: number;  // 实际触发 delPattern 的次数（过滤自身消息后）
    errors: number;                  // 错误次数（发布/订阅/消息解析/失效处理）
    instanceId: string;              // 当前实例 ID
    channel: string;                 // 订阅的频道名
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
| `undefined` | `'undefined'` | 避免与 `null` 的缓存键发生碰撞 |

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
import type { DistributedInvalidatorOptions, InvalidatorStats } from 'cache-hub/distributed';
import type { StableStringifyOptions } from 'cache-hub/stringify';
```
