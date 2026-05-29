# 快速开始

本指南将带你在 5 分钟内完成 cache-hub 的安装与基本使用。

## 安装

```bash
npm install cache-hub
```

如需使用 Redis 适配器或分布式失效功能，还需安装 ioredis：

```bash
npm install ioredis
```

---

## 内存缓存（MemoryCache）

最基础的用法——开箱即用的 LRU + TTL 内存缓存：

```typescript
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({
    maxEntries: 1000,     // 最多缓存 1000 条，超限自动 LRU 淘汰
    defaultTtl: 60_000,   // 默认 TTL 60 秒（毫秒单位）
    enableStats: true,    // 开启命中率统计
});

// 写入
await cache.set('user:1', { name: 'Alice', age: 30 });

// 读取
const user = await cache.get('user:1');
// → { name: 'Alice', age: 30 }

// 判断是否存在
const exists = await cache.exists('user:1');
// → true

// 删除
await cache.del('user:1');

// 查看统计
const stats = cache.getStats();
console.log(stats.hitRate);   // 0~1 命中率
console.log(stats.hits);      // 命中次数
console.log(stats.misses);    // 未命中次数
```

### 批量操作

```typescript
// 批量写入
await cache.setMany({
    'user:1': { name: 'Alice' },
    'user:2': { name: 'Bob' },
}, 30_000); // 自定义 TTL

// 批量读取
const results = await cache.getMany(['user:1', 'user:2', 'user:3']);
// → { 'user:1': {...}, 'user:2': {...} }（不存在的 key 不出现在结果对象中）

// 模式删除（* 通配符）
await cache.delPattern('user:*');  // 删除所有以 user: 开头的缓存
```

### 标签失效

```typescript
const cache = new MemoryCache({
    enableTags: true,
});

// 写入时附加标签
await cache.set('product:1', data, 60_000, { tags: ['products', 'featured'] });
await cache.set('product:2', data, 60_000, { tags: ['products'] });

// 按标签批量失效
await cache.invalidateByTag('featured');  // 仅失效打了 featured 标签的条目
```

---

## 读穿缓存（readThrough）

缓存命中直接返回，未命中时调用 fetcher 并写入缓存。**相同 key 的并发请求共享同一个 Promise**，天然防止缓存击穿：

```typescript
import { MemoryCache } from 'cache-hub';
import { readThrough } from 'cache-hub/read-through';

const cache = new MemoryCache({ maxEntries: 500 });

async function getUser(userId: number) {
    return readThrough(
        cache,
        30_000,                        // TTL 30 秒
        `user:${userId}`,              // 缓存 key
        () => db.findUserById(userId)  // 未命中时执行
    );
}

// 即使同时发起 100 个 getUser(1)，也只会执行一次 db.findUserById(1)
const users = await Promise.all(Array.from({ length: 100 }, () => getUser(1)));
```

> **注意**：fetcher 返回 `null` 时会写入缓存（有效空值）；返回 `undefined` 时不写缓存。

---

## 函数装饰器（withCache）

用最少的代码为任意异步函数加上缓存：

```typescript
import { withCache } from 'cache-hub/function-cache';
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({ maxEntries: 200 });

// 原始函数
async function fetchWeather(city: string, date: string) {
    return externalApi.getWeather(city, date);
}

// 包装后的函数，行为完全一致，但结果会被缓存
const getCachedWeather = withCache(fetchWeather, {
    cache,
    ttl: 10 * 60_000,     // 缓存 10 分钟
    namespace: 'weather', // 键前缀（默认使用函数名）
    // 条件缓存：只缓存成功的结果
    condition: (result) => result !== null && result.status === 'ok',
});

const weather = await getCachedWeather('Beijing', '2026-03-22');
```

### FunctionCache 类（多函数统一管理）

```typescript
import { FunctionCache } from 'cache-hub/function-cache';
import { MemoryCache } from 'cache-hub';

const cache = new MemoryCache({ maxEntries: 1000 });
const fc = new FunctionCache(cache, { ttl: 60_000 });

// 注册函数
fc.register('getUser', async (id: number) => db.findUser(id));
fc.register('getProduct', async (id: number) => db.findProduct(id), {
    ttl: 10_000,  // 覆盖全局 TTL
});

// 执行（自动缓存）
const user = await fc.execute('getUser', 1);

// 精确失效某个参数对应的缓存
await fc.invalidate('getUser', 1);

// 查看各函数的统计
const stats = fc.getStats();
// → { getUser: { hits: 10, misses: 2, ... }, getProduct: { ... } }
```

---

## 多级缓存（MultiLevelCache）

L1 本地内存 + L2 远端 Redis，两级联动：

```typescript
import { MemoryCache } from 'cache-hub';
import { MultiLevelCache } from 'cache-hub/multi-level';
import { createRedisCacheAdapter } from 'cache-hub/redis';

const local = new MemoryCache({
    maxEntries: 500,
    defaultTtl: 30_000,   // L1 缓存 30 秒
});

const remote = createRedisCacheAdapter(
    process.env.REDIS_URL ?? 'redis://localhost:6379'
);

const cache = new MultiLevelCache({
    local,
    remote,
    remoteTimeoutMs: 50,          // 远端超时 50ms，超时后降级到仅本地
    backfillOnRemoteHit: true,    // L2 命中时回填 L1；可查询 TTL 时保留远端剩余 TTL
    writePolicy: 'both',          // 同步双写 L1 + L2
});

// 写入（同时写 L1 和 L2）
await cache.set('session:abc', sessionData, 120_000);

// 读取（先查 L1，L1 未命中查 L2，L2 命中时回填 L1）
const session = await cache.get('session:abc');

// 程序退出时关闭远端连接
await remote.close();
```

当远端实现支持 `getRemainingTtl/getRemainingTtlMany` 时，回填 L1 会保留 L2 的剩余 TTL；普通 `CacheLike` 远端不支持 TTL 查询时仍会回填，并使用 L1 的默认 TTL 策略。

---

## 分布式缓存失效（DistributedCacheInvalidator）

当多个服务实例各自持有本地缓存时，通过 Redis Pub/Sub 广播失效事件，确保所有实例的本地缓存保持一致：

```typescript
import { MemoryCache } from 'cache-hub';
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

// 每个服务实例
const local = new MemoryCache({ maxEntries: 1000 });

const invalidator = new DistributedCacheInvalidator({
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    cache: local,                         // 收到失效消息时操作的缓存实例
    channel: 'myapp:cache-invalidation',  // 自定义频道名
});

// 某实例更新数据后，先失效当前实例，再广播给其他实例（支持通配符 *）
await invalidator.invalidate('user:*');

// 查看统计
const stats = invalidator.getStats();
console.log(stats.messagesSent);            // 本实例发布的失效消息数
console.log(stats.messagesReceived);        // 收到的消息总数（含所有实例）
console.log(stats.invalidationsTriggered);  // 实际触发 delPattern 的次数

// 程序退出时关闭
await invalidator.close();
```

---

## 与 MultiLevelCache 联动

将多级缓存与分布式失效结合，实现完整的多实例缓存方案：

```typescript
import { MemoryCache } from 'cache-hub';
import { MultiLevelCache } from 'cache-hub/multi-level';
import { createRedisCacheAdapter } from 'cache-hub/redis';
import { DistributedCacheInvalidator } from 'cache-hub/distributed';

const local = new MemoryCache({ maxEntries: 500, defaultTtl: 30_000 });
const remote = createRedisCacheAdapter(process.env.REDIS_URL!);

const invalidator = new DistributedCacheInvalidator({
    redisUrl: process.env.REDIS_URL!,
    cache: local,
});

const cache = new MultiLevelCache({
    local,
    remote,
    // delPattern 时广播失效，确保其他实例的 L1 缓存被清除
    publish: (msg) => invalidator.invalidate(msg.pattern),
});

// 写入时：L1 + L2 双写，并广播失效给其他实例
await cache.set('config:theme', newTheme);

// 清理
await invalidator.close();
await remote.close();
```

---

## 下一步

- 查看 [API 参考](/guide/api-reference) 了解所有配置项和方法
- 查看 [README](https://github.com/vextjs/cacheHub#readme) 了解完整选项说明
