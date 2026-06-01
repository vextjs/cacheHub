/**
 * cache-hub 主入口
 * 仅做 re-export，禁止在此文件中写任何逻辑
 *
 * 来源：技术方案 §11
 */

// 核心类型
export type {
  CacheLike,
  CacheRemainingTtl,
  CacheStats,
  MemoryCacheOptions,
  LockManager,
  AtomicCounterResult,
  AtomicStateBackend,
  RedisAtomicStateClient,
} from "./types.js";

// 核心实现
export { MemoryCache } from "./memory-cache.js";
export type { SetOptions } from "./memory-cache.js";

// 工具函数
export { stableStringify } from "./stable-stringify.js";
export type { StableStringifyOptions } from "./stable-stringify.js";

// 读穿缓存
export { readThrough } from "./read-through.js";

// 多级缓存
export { MultiLevelCache } from "./multi-level-cache.js";
export type { MultiLevelCacheOptions } from "./multi-level-cache.js";

// Redis 适配器
export { createRedisCacheAdapter } from "./redis-adapter.js";
export type { RedisCacheAdapter } from "./redis-adapter.js";

// 函数缓存
export { withCache, FunctionCache } from "./function-cache.js";
export type {
  WithCacheOptions,
  WithCacheStats,
  WrappedFunction,
  FunctionCacheOptions,
  FunctionCacheStats,
} from "./function-cache.js";

// 分布式缓存失效器
export { DistributedCacheInvalidator } from "./distributed-invalidator.js";
export type {
  DistributedInvalidatorOptions,
  DistributedInvalidatorLogger,
  InvalidatorStats,
} from "./distributed-invalidator.js";

// 可选限流原语
export {
  MemoryFixedWindowRateLimitStore,
  MemoryRateLimitStateStore,
  RedisFixedWindowRateLimitStore,
  RedisRateLimitStateStore,
  createMemoryFixedWindowRateLimitStore,
  createMemoryRateLimitStateStore,
  createRedisFixedWindowRateLimitStore,
  createRedisRateLimitStateStore,
} from "./rate-limit.js";
export type {
  FixedWindowRateLimitResult,
  FixedWindowRateLimitStore,
  SlidingWindowRateLimitResult,
  TokenBucketRateLimitResult,
  LeakyBucketRateLimitResult,
  RateLimitStateStore,
  RedisFixedWindowRateLimitClient,
  RedisRateLimitStateClient,
} from "./types.js";

// 原子状态后端
export {
  MemoryAtomicStateBackend,
  RedisAtomicStateBackend,
  createMemoryAtomicStateBackend,
  createRedisAtomicStateBackend,
} from "./atomic.js";
