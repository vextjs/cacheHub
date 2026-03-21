# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-03-22

首个正式发布版本。零运行时依赖的 Node.js 多层缓存库，统一工作区所有项目的缓存基础设施。

### Added（新增）

#### 核心类型与接口（`cache-hub`）
- 新增 `CacheLike` 接口：定义统一缓存契约，覆盖 `get / set / del / exists / has / clear / keys / getMany / setMany / delMany / delPattern / getStats / destroy` 共 13 个方法
- 新增 `CacheStats` 类型：统一统计信息结构（`hits / misses / sets / deletes / evictions / memoryUsage / hitRate`）
- 新增 `MemoryCacheOptions` 配置类型

#### MemoryCache（`cache-hub`）
- 基于 ES6 `Map` 实现的 O(1) LRU 淘汰引擎
- TTL 支持：惰性过期（`get` 时判断）+ 可选周期清理（`cleanupInterval`）
- 双重容量限制：`maxEntries`（条目数）+ `maxMemory`（字节估算）
- 批量操作：`getMany / setMany / delMany`
- 模式删除：`delPattern(pattern)`（`*` 通配符 → 正则）
- 统计信息：`hits / misses / evictions / hitRate` 等，可通过 `enableStats` 开关
- 标签索引：`enableTags=true` 时维护 `tagIndex`，支持 `invalidateByTag(tag)`
- `enabled` 开关：`false` 时 `get` 返回 `undefined`，`set` 不写入
- `destroy()`：清理周期定时器并清空缓存

#### stableStringify（`cache-hub/stringify`）
- `stableStringify(value, options?)`：对象键字母排序、`NaN` 固定输出 `"__NaN__"`、循环引用输出 `"[CIRCULAR]"`
- `RegExp` / `Date` 特殊处理，数组保序
- `customSerializer` 插件钩子：支持 BSON ObjectId 等自定义类型扩展

#### readThrough（`cache-hub/read-through`）
- `readThrough(cache, ttlMs, key, fetcher)`：缓存命中直返，未命中执行 fetcher 并写缓存
- 并发去重（in-flight map）：相同 key 的并发请求共享同一 Promise
- `ttl ≤ 0` 时直接执行 fetcher 不写缓存
- 内置溢出保护（INFLIGHT_MAX_SIZE = 10000，超限清理最旧 10%）
- 内置超时清理（INFLIGHT_TIMEOUT_MS = 300000ms，防止内存泄漏）
- `undefined` 不写缓存，`null` 视为有效空值

#### MultiLevelCache（`cache-hub/multi-level`）
- L1（本地）+ L2（远端）双层缓存，均接受 `CacheLike` 接口
- 写策略：`'both'`（同步双写）/ `'local-first-async-remote'`（本地优先异步写远端）
- 远端命中回填本地（`backfillOnRemoteHit`，默认开启，可关闭）
- 远端操作超时保护（`remoteTimeoutMs`，默认 50ms，超时降级不报错）
- 可选分布式失效广播回调（`publish?: (keys: string[]) => void`）

#### RedisCacheAdapter（`cache-hub/redis`）
- `createRedisCacheAdapter(urlOrInstance)`：将 ioredis 实例包装为 `CacheLike`
- 支持 URL 字符串初始化（自动创建 ioredis 连接）或传入已有实例
- `delPattern / keys` 使用 SCAN 游标迭代，禁止 `KEYS` 命令（防阻塞）
- `close()`：仅关闭自己创建的连接（外部传入的连接不关闭）
- 超长 key（> 512 字节）自动 SHA-256 压缩，`pattern` 超长时截断并 `console.warn`
- JSON 序列化存储，支持 `null` 作为有效缓存值

#### FunctionCache / withCache（`cache-hub/function-cache`）
- `withCache(fn, options)`：装饰器，自动缓存异步函数返回值
- 键生成：`namespace:fnName:stableStringify(args)`，超长键自动 SHA-256 压缩
- 并发去重：相同参数的并发调用共享同一 Promise
- 条件缓存：`condition(result)` 返回 `false` 时不写缓存
- `FunctionCache` 类：支持 `register / execute / invalidate / getStats`，适合多函数统一管理
- Per-function TTL / keyBuilder / condition 配置，可覆盖全局默认值

#### DistributedCacheInvalidator（`cache-hub/distributed`）
- `DistributedCacheInvalidator`：基于 Redis Pub/Sub 的跨实例缓存失效广播
- 自动过滤自身发出的消息（`instanceId` 隔离）
- 支持监听多个本地缓存实例（`watchedCaches`）
- 支持 `redisUrl` 字符串或已有 ioredis 连接两种初始化方式
- `invalidate(keys)` / `close()` 生命周期管理
- `getStats()` 返回发布/接收消息计数

### Build（构建）
- ESM + CJS 双格式产出（`dist/esm/` + `dist/cjs/` + `dist/types/`）
- 多入口按需导入：`cache-hub`、`cache-hub/redis`、`cache-hub/multi-level`、`cache-hub/function-cache`、`cache-hub/distributed`、`cache-hub/stringify`、`cache-hub/read-through`
- CJS 产物兼容性修补：`import.meta.url` → `__filename`（`scripts/build-cjs.mjs`）
- 零运行时依赖（`dependencies: {}`），ioredis 为可选 peerDependency（`>=5.0.0`）

### Tests（测试）
- 440 个单元测试，全部通过，全维度覆盖率 100%（Statements / Branches / Functions / Lines）
- 30 个集成测试（`test/integration/redis.integration.test.ts`），需本地 Redis 连接
- 支持 `npm test`（单元）、`npm run test:integration`（集成，需 Redis）
- 支持 `REDIS_URL` 环境变量自定义 Redis 地址，`SKIP_INTEGRATION=true` 跳过集成测试

---

## 格式说明

- **Added**：新功能
- **Changed**：现有功能的非破坏性变更
- **Fixed**：Bug 修复
- **Deprecated**：已弃用功能（将在未来版本移除）
- **Removed**：已移除功能（Major 版本）
- **Security**：安全修复