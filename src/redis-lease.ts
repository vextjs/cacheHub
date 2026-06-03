/**
 * Redis lease store
 * Provides a small distributed lease primitive for cross-process single-flight.
 */

import { createHash, randomUUID } from "crypto";
import type { CacheLease, CacheLeaseStore, RedisLeaseClient } from "./types.js";

const DEFAULT_LEASE_KEY_PREFIX = "__cache-hub:lease";
const MIN_LEASE_TTL_MS = 1;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export interface RedisLeaseStoreOptions {
  /** Redis key prefix used for lease records. */
  leaseKeyPrefix?: string;
  /** Stable owner id prefix included in each lease token. */
  ownerId?: string;
}

export interface RedisLeaseStore extends CacheLeaseStore {}

class RedisCacheLease implements CacheLease {
  constructor(
    public readonly key: string,
    public readonly token: string,
    public ttlMs: number,
    public expiresAt: number,
    private readonly _store: CacheLeaseStore,
  ) {}

  async release(): Promise<boolean> {
    return this._store.releaseLease(this.key, this.token);
  }

  async renew(ttlMs = this.ttlMs): Promise<boolean> {
    const renewed = await this._store.renewLease(this.key, this.token, ttlMs);
    if (renewed) {
      this.ttlMs = ttlMs;
      this.expiresAt = Date.now() + ttlMs;
    }
    return renewed;
  }
}

class RedisLeaseStoreImpl implements RedisLeaseStore {
  private readonly _redis: RedisLeaseClient;
  private readonly _leaseKeyPrefix: string;
  private readonly _ownerId: string;

  constructor(redisOrAdapter: RedisLeaseClient | { getRedisInstance(): object }, options: RedisLeaseStoreOptions = {}) {
    this._redis = this._resolveRedis(redisOrAdapter);
    this._leaseKeyPrefix = options.leaseKeyPrefix ?? DEFAULT_LEASE_KEY_PREFIX;
    this._ownerId = options.ownerId ?? randomUUID();
  }

  private _resolveRedis(redisOrAdapter: RedisLeaseClient | { getRedisInstance(): object }): RedisLeaseClient {
    if (
      redisOrAdapter &&
      typeof (redisOrAdapter as { getRedisInstance?: unknown }).getRedisInstance === "function"
    ) {
      return (redisOrAdapter as { getRedisInstance(): object }).getRedisInstance() as RedisLeaseClient;
    }
    return redisOrAdapter as RedisLeaseClient;
  }

  private _validateKey(key: string): void {
    if (typeof key !== "string" || key === "") {
      throw new TypeError(
        `[cache-hub] lease key 必须为非空字符串，收到: ${JSON.stringify(key)}`,
      );
    }
  }

  private _validateToken(token: string): void {
    if (typeof token !== "string" || token === "") {
      throw new TypeError(
        `[cache-hub] lease token 必须为非空字符串，收到: ${JSON.stringify(token)}`,
      );
    }
  }

  private _validateTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS) {
      throw new RangeError(
        `[cache-hub] lease ttlMs 必须为正数，收到: ${JSON.stringify(ttlMs)}`,
      );
    }
  }

  private _leaseKey(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return `${this._leaseKeyPrefix}:${hash}`;
  }

  private _newToken(): string {
    return `${this._ownerId}:${randomUUID()}`;
  }

  async acquireLease(key: string, ttlMs: number): Promise<CacheLease | undefined> {
    this._validateKey(key);
    this._validateTtl(ttlMs);

    const token = this._newToken();
    const ok = await this._redis.set(this._leaseKey(key), token, "NX", "PX", Math.floor(ttlMs));
    if (ok !== "OK") {
      return undefined;
    }

    const normalizedTtl = Math.floor(ttlMs);
    return new RedisCacheLease(
      key,
      token,
      normalizedTtl,
      Date.now() + normalizedTtl,
      this,
    );
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    this._validateKey(key);
    this._validateToken(token);
    const result = await this._redis.eval(RELEASE_SCRIPT, 1, this._leaseKey(key), token);
    return result === 1;
  }

  async renewLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    this._validateKey(key);
    this._validateToken(token);
    this._validateTtl(ttlMs);
    const normalizedTtl = Math.floor(ttlMs);
    const result = await this._redis.eval(
      RENEW_SCRIPT,
      1,
      this._leaseKey(key),
      token,
      normalizedTtl,
    );
    return result === 1;
  }
}

/**
 * Create a Redis-backed lease store.
 *
 * Accepts either an ioredis-like client or a cache-hub Redis adapter.
 */
export function createRedisLeaseStore(
  redisOrAdapter: RedisLeaseClient | { getRedisInstance(): object },
  options?: RedisLeaseStoreOptions,
): RedisLeaseStore {
  return new RedisLeaseStoreImpl(redisOrAdapter, options);
}
