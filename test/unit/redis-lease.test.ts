import { describe, it, expect, vi } from "vitest";
import { createRedisLeaseStore } from "../../src/redis-lease.js";
import type { RedisLeaseClient } from "../../src/types.js";

function makeRedis() {
  const state = new Map<string, string>();
  const ttlByKey = new Map<string, number>();

  const redis: RedisLeaseClient & {
    state: Map<string, string>;
    ttlByKey: Map<string, number>;
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  } = {
    state,
    ttlByKey,
    set: vi.fn(async (key: string, value: string, nx: "NX", px: "PX", ttlMs: number) => {
      expect(nx).toBe("NX");
      expect(px).toBe("PX");
      if (state.has(key)) {
        return null;
      }
      state.set(key, value);
      ttlByKey.set(key, ttlMs);
      return "OK";
    }),
    eval: vi.fn(async (script: string, _keyCount: number, key: string, token: string, ttlMs?: number) => {
      if (state.get(key) !== token) {
        return 0;
      }
      if (script.includes("PEXPIRE")) {
        ttlByKey.set(key, Number(ttlMs));
        return 1;
      }
      state.delete(key);
      ttlByKey.delete(key);
      return 1;
    }),
  };

  return redis;
}

describe("RedisLeaseStore", () => {
  it("acquireLease 成功时写入 NX/PX，并返回可释放 lease", async () => {
    const redis = makeRedis();
    const store = createRedisLeaseStore(redis, { ownerId: "owner" });

    const lease = await store.acquireLease("cache:key", 1000);

    expect(lease).toBeDefined();
    expect(lease!.key).toBe("cache:key");
    expect(lease!.ttlMs).toBe(1000);
    expect(lease!.token.startsWith("owner:")).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("__cache-hub:lease:"),
      lease!.token,
      "NX",
      "PX",
      1000,
    );

    await expect(lease!.release()).resolves.toBe(true);
    expect(redis.state.size).toBe(0);
  });

  it("lease 已存在时 acquireLease 返回 undefined", async () => {
    const redis = makeRedis();
    const store = createRedisLeaseStore(redis);

    expect(await store.acquireLease("k", 500)).toBeDefined();
    expect(await store.acquireLease("k", 500)).toBeUndefined();
  });

  it("releaseLease 只释放匹配 token 的 lease", async () => {
    const redis = makeRedis();
    const store = createRedisLeaseStore(redis);
    const lease = await store.acquireLease("k", 500);

    expect(await store.releaseLease("k", "wrong-token")).toBe(false);
    expect(redis.state.size).toBe(1);
    expect(await store.releaseLease("k", lease!.token)).toBe(true);
    expect(redis.state.size).toBe(0);
  });

  it("renewLease 只续租匹配 token 的 lease，并更新 lease 快照", async () => {
    const redis = makeRedis();
    const store = createRedisLeaseStore(redis);
    const lease = await store.acquireLease("k", 500);
    const before = lease!.expiresAt;

    expect(await store.renewLease("k", "wrong-token", 1000)).toBe(false);
    expect(await lease!.renew(1500)).toBe(true);

    expect(lease!.ttlMs).toBe(1500);
    expect(lease!.expiresAt).toBeGreaterThanOrEqual(before);
    expect([...redis.ttlByKey.values()]).toEqual([1500]);
  });

  it("支持传入 Redis adapter，并通过 getRedisInstance 取底层客户端", async () => {
    const redis = makeRedis();
    const adapter = {
      getRedisInstance: () => redis,
    };
    const store = createRedisLeaseStore(adapter);

    expect(await store.acquireLease("k", 100)).toBeDefined();
    expect(redis.set).toHaveBeenCalledOnce();
  });

  it("非法参数抛出描述性错误", async () => {
    const store = createRedisLeaseStore(makeRedis());

    await expect(store.acquireLease("", 100)).rejects.toThrow(TypeError);
    await expect(store.acquireLease("k", 0)).rejects.toThrow(RangeError);
    await expect(store.releaseLease("k", "")).rejects.toThrow(TypeError);
    await expect(store.renewLease("k", "token", 0)).rejects.toThrow(RangeError);
  });
});
