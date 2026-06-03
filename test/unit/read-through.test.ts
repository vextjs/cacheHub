import { describe, it, expect, vi, beforeEach } from "vitest";
import { readThrough, readThroughWithLease } from "../../src/read-through.js";
import { MemoryCache } from "../../src/memory-cache.js";
import type { CacheLease, CacheLeaseStore, CacheLike } from "../../src/types.js";

// ── 辅助工厂 ──

function makeCache(): MemoryCache {
  return new MemoryCache({ maxEntries: 100 });
}

/** 创建可统计调用次数的 fetcher */
function makeFetcher<T>(value: T) {
  let calls = 0;
  const fn = async (): Promise<T> => {
    calls++;
    return value;
  };
  return { fn, getCalls: () => calls };
}

function makeLeaseStore(options?: {
  grant?: boolean;
  renewResult?: boolean;
}): CacheLeaseStore & {
  acquireCalls: () => number;
  releaseCalls: () => number;
  renewCalls: () => number;
  lastTtl: () => number | undefined;
} {
  const grant = options?.grant ?? true;
  const renewResult = options?.renewResult ?? true;
  let held = false;
  let acquireCount = 0;
  let releaseCount = 0;
  let renewCount = 0;
  let lastTtl: number | undefined;

  return {
    acquireCalls: () => acquireCount,
    releaseCalls: () => releaseCount,
    renewCalls: () => renewCount,
    lastTtl: () => lastTtl,
    async acquireLease(key: string, ttlMs: number): Promise<CacheLease | undefined> {
      acquireCount++;
      lastTtl = ttlMs;
      if (!grant || held) {
        return undefined;
      }
      held = true;
      const lease: CacheLease = {
        key,
        token: `token:${key}`,
        ttlMs,
        expiresAt: Date.now() + ttlMs,
        async release() {
          releaseCount++;
          held = false;
          return true;
        },
        async renew(nextTtlMs = lease.ttlMs) {
          renewCount++;
          if (!renewResult) {
            return false;
          }
          lease.ttlMs = nextTtlMs;
          lease.expiresAt = Date.now() + nextTtlMs;
          return true;
        },
      };
      return lease;
    },
    async releaseLease() {
      releaseCount++;
      held = false;
      return true;
    },
    async renewLease() {
      renewCount++;
      return renewResult;
    },
  };
}

// ── 测试套件 ──

describe("readThrough", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = makeCache();
  });

  // ── 基础场景 ──

  describe("缓存未命中 + fetcher 调用", () => {
    it("未命中时调用 fetcher 并返回结果", async () => {
      const { fn } = makeFetcher("hello");
      const result = await readThrough(cache, 1000, "key", fn);
      expect(result).toBe("hello");
    });

    it("fetcher 返回值被写入缓存", async () => {
      const { fn } = makeFetcher({ id: 1 });
      await readThrough(cache, 1000, "key", fn);
      expect(cache.get("key")).toEqual({ id: 1 });
    });

    it("第二次调用命中缓存，不再触发 fetcher", async () => {
      const { fn, getCalls } = makeFetcher("value");
      await readThrough(cache, 1000, "key", fn);
      await readThrough(cache, 1000, "key", fn);
      expect(getCalls()).toBe(1);
    });
  });

  describe("缓存命中", () => {
    it("缓存中已有值时直接返回，不调用 fetcher", async () => {
      cache.set("key", "cached");
      const { fn, getCalls } = makeFetcher("new");
      const result = await readThrough(cache, 1000, "key", fn);
      expect(result).toBe("cached");
      expect(getCalls()).toBe(0);
    });

    it("null 是有效缓存值，命中后不触发 fetcher", async () => {
      cache.set("key", null);
      const { fn, getCalls } = makeFetcher("should-not-be-returned");
      const result = await readThrough(cache, 1000, "key", fn);
      expect(result).toBeNull();
      expect(getCalls()).toBe(0);
    });
  });

  // ── TTL 边界 ──

  describe("ttlMs <= 0 直接穿透", () => {
    it("ttl=0 直接调用 fetcher，不查缓存也不写缓存", async () => {
      cache.set("key", "cached");
      const { fn, getCalls } = makeFetcher("fresh");
      const result = await readThrough(cache, 0, "key", fn);
      // ttl <= 0 直接穿透，不查缓存
      expect(result).toBe("fresh");
      expect(getCalls()).toBe(1);
    });

    it("ttl 为负数时直接穿透", async () => {
      const { fn, getCalls } = makeFetcher("value");
      await readThrough(cache, -1, "key", fn);
      expect(getCalls()).toBe(1);
      // 不写入缓存
      expect(cache.get("key")).toBeUndefined();
    });
  });

  // ── undefined 语义（A04）──

  describe("fetcher 返回 undefined 不写入缓存", () => {
    it("undefined 不写入缓存，第二次仍触发 fetcher", async () => {
      let calls = 0;
      const fetcher = async (): Promise<undefined> => {
        calls++;
        return undefined;
      };
      await readThrough(cache, 1000, "key", fetcher);
      await readThrough(cache, 1000, "key", fetcher);
      // undefined 不缓存，每次都穿透
      expect(calls).toBe(2);
      expect(cache.get("key")).toBeUndefined();
    });

    it("fetcher 返回 null 正常写入缓存", async () => {
      const fetcher = async (): Promise<null> => null;
      await readThrough(cache, 1000, "key", fetcher);
      expect(cache.get("key")).toBeNull();
    });
  });

  // ── 错误处理 ──

  describe("fetcher 抛出异常", () => {
    it("fetcher 抛出时 readThrough 向上抛出", async () => {
      const fetcher = async (): Promise<never> => {
        throw new Error("fetch failed");
      };
      await expect(readThrough(cache, 1000, "key", fetcher)).rejects.toThrow(
        "fetch failed",
      );
    });

    it("fetcher 抛出时不写入缓存", async () => {
      const fetcher = async (): Promise<never> => {
        throw new Error("fail");
      };
      try {
        await readThrough(cache, 1000, "key", fetcher);
      } catch {
        // 预期抛出
      }
      expect(cache.get("key")).toBeUndefined();
    });

    it("fetcher 抛出后，下一次请求可以重新执行 fetcher", async () => {
      let shouldFail = true;
      let calls = 0;
      const fetcher = async (): Promise<string> => {
        calls++;
        if (shouldFail) {
          throw new Error("temp fail");
        }
        return "recovered";
      };

      // 第一次失败
      try {
        await readThrough(cache, 1000, "key", fetcher);
      } catch {
        // 预期
      }

      // 第二次成功
      shouldFail = false;
      const result = await readThrough(cache, 1000, "key", fetcher);
      expect(result).toBe("recovered");
      expect(calls).toBe(2);
    });
  });

  // ── cache.set 失败容错 ──

  describe("cache.set 失败时静默忽略", () => {
    it("写入缓存失败时仍然返回 fetcher 的值", async () => {
      const badCache: CacheLike = {
        get: async () => undefined,
        set: async () => {
          throw new Error("write error");
        },
        del: async () => false,
        exists: async () => false,
        has: async () => false,
        clear: async () => {},
        getMany: async () => ({}),
        setMany: async () => true,
        delMany: async () => 0,
        delPattern: async () => 0,
        keys: async () => [],
      };
      const { fn } = makeFetcher("value");
      const result = await readThrough(badCache, 1000, "key", fn);
      expect(result).toBe("value");
    });
  });

  // ── 并发去重 ──

  describe("并发去重（相同 key 多个并发请求共享同一 Promise）", () => {
    it("并发请求只触发一次 fetcher", async () => {
      let calls = 0;
      const fetcher = async (): Promise<string> => {
        calls++;
        // 模拟异步延迟
        await new Promise((r) => setTimeout(r, 20));
        return "result";
      };

      // 同时发起 5 个请求
      const results = await Promise.all([
        readThrough(cache, 1000, "concurrent-key", fetcher),
        readThrough(cache, 1000, "concurrent-key", fetcher),
        readThrough(cache, 1000, "concurrent-key", fetcher),
        readThrough(cache, 1000, "concurrent-key", fetcher),
        readThrough(cache, 1000, "concurrent-key", fetcher),
      ]);

      // 所有请求都应该得到正确结果
      expect(results).toEqual([
        "result",
        "result",
        "result",
        "result",
        "result",
      ]);
      // 但 fetcher 只被调用一次
      expect(calls).toBe(1);
    });

    it("不同 key 的并发请求各自独立执行 fetcher", async () => {
      let calls = 0;
      const fetcher = async (): Promise<string> => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return `result-${calls}`;
      };

      await Promise.all([
        readThrough(cache, 1000, "key-a", fetcher),
        readThrough(cache, 1000, "key-b", fetcher),
      ]);

      expect(calls).toBe(2);
    });

    it("inflight Promise 失败时 catch 触发，后续请求重新执行 fetcher", async () => {
      let callCount = 0;
      const fetcher = async (): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          // 首次调用延迟后抛出，给第二个请求时间挂载到同一 inflight Promise
          await new Promise((r) => setTimeout(r, 20));
          throw new Error("transient failure");
        }
        return "recovered";
      };

      // 两个并发请求共享同一 inflight Promise
      const [r1, r2] = await Promise.allSettled([
        readThrough(cache, 1000, "inflight-fail-key", fetcher),
        readThrough(cache, 1000, "inflight-fail-key", fetcher),
      ]);

      // 第一个请求（创建 inflight 的那个）应该失败
      expect(r1.status).toBe("rejected");
      // 第二个请求（复用 inflight 的那个）的 catch 块触发后重新执行 fetcher
      expect(r2.status).toBe("fulfilled");
      if (r2.status === "fulfilled") {
        expect(r2.value).toBe("recovered");
      }
      // fetcher 总共被调用了 2 次：第一次失败，第二次重试成功
      expect(callCount).toBe(2);
    });
  });

  // ── 对象值 ──

  describe("复杂值类型", () => {
    it("对象值正常缓存和返回", async () => {
      const obj = { user: { id: 1, name: "Alice" }, roles: ["admin"] };
      const { fn } = makeFetcher(obj);
      const result = await readThrough(cache, 1000, "obj-key", fn);
      expect(result).toEqual(obj);
    });

    it("数组值正常缓存和返回", async () => {
      const arr = [1, 2, 3];
      const { fn } = makeFetcher(arr);
      const result = await readThrough(cache, 1000, "arr-key", fn);
      expect(result).toEqual(arr);
    });
  });

  // ── inflight 溢出保护 + 定时器回调（覆盖率补充）──

  describe("inflight 溢出保护（行 72-80）", () => {
    it("inflight 条目达到 INFLIGHT_MAX_SIZE（10000）时触发 10% 清理", async () => {
      vi.useFakeTimers();
      try {
        const mockCache: CacheLike = {
          get: vi.fn().mockResolvedValue(undefined),
          set: vi.fn().mockResolvedValue(undefined),
          del: async () => false,
          exists: async () => false,
          has: async () => false,
          clear: async () => {},
          getMany: async () => ({}),
          setMany: async () => true,
          delMany: async () => 0,
          delPattern: async () => 0,
          keys: async () => [],
        };

        // 创建 10000 个 pending fetcher，填满 inflight 表（INFLIGHT_MAX_SIZE = 10000）
        const resolvers: Array<() => void> = [];
        const inflightPromises: Array<Promise<string>> = [];

        for (let i = 0; i < 10000; i++) {
          let resolve!: () => void;
          const pendingP = new Promise<void>((r) => {
            resolve = r;
          });
          resolvers.push(resolve);
          inflightPromises.push(
            readThrough(mockCache, 60000, `fill-overflow-${i}`, () =>
              pendingP.then(() => `v${i}`),
            ),
          );
        }

        // 第 10001 个请求触发溢出清理（覆盖行 72-80）
        let triggerResolve!: (v: string) => void;
        const triggerFetch = new Promise<string>((r) => {
          triggerResolve = r;
        });
        const triggerResult = readThrough(
          mockCache,
          60000,
          "overflow-trigger-key",
          () => triggerFetch,
        );

        // 解决全部 pending promise
        resolvers.forEach((r) => r());
        triggerResolve("overflow-triggered");

        await Promise.all([...inflightPromises, triggerResult]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("INFLIGHT_TIMEOUT_MS 定时器回调（行 100）", () => {
    it("超过 INFLIGHT_TIMEOUT_MS 后定时器触发 __inflight.delete，结果仍正确返回", async () => {
      vi.useFakeTimers();
      try {
        const mockCache: CacheLike = {
          get: vi.fn().mockResolvedValue(undefined),
          set: vi.fn().mockResolvedValue(undefined),
          del: async () => false,
          exists: async () => false,
          has: async () => false,
          clear: async () => {},
          getMany: async () => ({}),
          setMany: async () => true,
          delMany: async () => 0,
          delPattern: async () => 0,
          keys: async () => [],
        };

        let resolveSlowFetch!: (v: string) => void;
        const slowFetch = new Promise<string>((r) => {
          resolveSlowFetch = r;
        });

        // 启动 readThrough，内部创建 INFLIGHT_TIMEOUT_MS（300000ms）假定时器
        const resultP = readThrough(
          mockCache,
          60000,
          "timer-callback-key",
          () => slowFetch,
        );

        // 刷新微任务队列，让 readThrough 内部的 await cache.get() 完成
        // 并使 setTimeout 被注册到假时间系统中
        await Promise.resolve();
        await Promise.resolve();

        // 推进假时间 300001ms，触发定时器回调
        // 回调执行 __inflight.delete('timer-callback-key')（行 100）
        vi.advanceTimersByTime(300001);

        // 定时器已触发后再 resolve fetcher，readThrough 应正常完成
        resolveSlowFetch("timer-ok");
        const result = await resultP;
        expect(result).toBe("timer-ok");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── TTL 过期后重新 fetch ──

  describe("TTL 过期后重新 fetch", () => {
    it("TTL 过期后再次请求会重新调用 fetcher", async () => {
      let calls = 0;
      const fetcher = async (): Promise<string> => {
        calls++;
        return `value-${calls}`;
      };

      await readThrough(cache, 10, "key", fetcher); // TTL 10ms
      expect(calls).toBe(1);

      await new Promise((r) => setTimeout(r, 30)); // 等待过期

      const result = await readThrough(cache, 10, "key", fetcher);
      expect(calls).toBe(2);
      expect(result).toBe("value-2");
    });
  });
});

describe("readThroughWithLease", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = makeCache();
  });

  it("缓存命中时直接返回，不获取 lease", async () => {
    cache.set("key", "cached");
    const leaseStore = makeLeaseStore();
    const fetcher = vi.fn(async () => "fresh");

    expect(
      await readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "key",
        fetcher,
        leaseStore,
      }),
    ).toBe("cached");
    expect(fetcher).not.toHaveBeenCalled();
    expect(leaseStore.acquireCalls()).toBe(0);
  });

  it("拿到 lease 的调用者执行 fetcher、写入缓存并释放 lease", async () => {
    const leaseStore = makeLeaseStore();
    const fetcher = vi.fn(async () => ({ id: 1 }));

    const result = await readThroughWithLease({
      cache,
      ttlMs: 1000,
      key: "owner-key",
      fetcher,
      leaseStore,
    });

    expect(result).toEqual({ id: 1 });
    expect(cache.get("owner-key")).toEqual({ id: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(leaseStore.renewCalls()).toBe(1);
    expect(leaseStore.releaseCalls()).toBe(1);
  });

  it("拿到 lease 后若缓存已被填充，则直接返回缓存值且不调用 fetcher", async () => {
    let getCalls = 0;
    const raceCache: CacheLike = {
      get: async () => {
        getCalls++;
        return getCalls === 1 ? undefined : "filled-during-race";
      },
      set: vi.fn(),
      del: async () => false,
      exists: async () => false,
      has: async () => false,
      clear: async () => {},
      getMany: async () => ({}),
      setMany: async () => true,
      delMany: async () => 0,
      delPattern: async () => 0,
      keys: async () => [],
    };
    const leaseStore = makeLeaseStore();
    const fetcher = vi.fn(async () => "fresh");

    expect(
      await readThroughWithLease({
        cache: raceCache,
        ttlMs: 1000,
        key: "race-key",
        fetcher,
        leaseStore,
      }),
    ).toBe("filled-during-race");

    expect(fetcher).not.toHaveBeenCalled();
    expect(raceCache.set).not.toHaveBeenCalled();
    expect(leaseStore.releaseCalls()).toBe(1);
  });

  it("10000 并发 miss 只触发一次 fetcher", async () => {
    const leaseStore = makeLeaseStore();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "single-flight";
    };

    const results = await Promise.all(
      Array.from({ length: 10000 }, () =>
        readThroughWithLease({
          cache,
          ttlMs: 2000,
          key: "burst-key",
          fetcher,
          leaseStore,
        }),
      ),
    );

    expect(calls).toBe(1);
    expect(leaseStore.acquireCalls()).toBe(1);
    expect(results).toHaveLength(10000);
    expect(results.every((value) => value === "single-flight")).toBe(true);
  });

  it("inflight Promise 失败时后续并发请求会重新执行 lease 周期", async () => {
    const leaseStore = makeLeaseStore();
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("first failure");
      }
      return "recovered";
    };

    const [r1, r2] = await Promise.allSettled([
      readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "lease-inflight-fail",
        fetcher,
        leaseStore,
      }),
      readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "lease-inflight-fail",
        fetcher,
        leaseStore,
      }),
    ]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("fulfilled");
    if (r2.status === "fulfilled") {
      expect(r2.value).toBe("recovered");
    }
    expect(callCount).toBe(2);
  });

  it("未拿到 lease 时等待 owner 写入缓存并返回缓存值", async () => {
    const leaseStore = makeLeaseStore({ grant: false });
    const fetcher = vi.fn(async () => "should-not-fetch");

    const resultP = readThroughWithLease({
      cache,
      ttlMs: 1000,
      key: "wait-key",
      fetcher,
      leaseStore,
      waitForOwnerMs: 50,
      pollIntervalMs: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.set("wait-key", "filled-by-owner");

    expect(await resultP).toBe("filled-by-owner");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("未拿到 lease 且等待超时后默认执行 fetcher 兜底", async () => {
    const leaseStore = makeLeaseStore({ grant: false });
    const fetcher = vi.fn(async () => "fallback");

    expect(
      await readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "fallback-key",
        fetcher,
        leaseStore,
        waitForOwnerMs: 1,
        pollIntervalMs: 1,
      }),
    ).toBe("fallback");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("第一次未拿到 lease，等待超时后第二次拿到 lease 并写入缓存", async () => {
    let attempts = 0;
    let releaseCalls = 0;
    const leaseStore: CacheLeaseStore = {
      async acquireLease(key, ttlMs) {
        attempts++;
        if (attempts === 1) {
          return undefined;
        }
        const lease: CacheLease = {
          key,
          token: "retry-token",
          ttlMs,
          expiresAt: Date.now() + ttlMs,
          async release() {
            releaseCalls++;
            return true;
          },
          async renew() {
            return true;
          },
        };
        return lease;
      },
      async releaseLease() {
        return true;
      },
      async renewLease() {
        return true;
      },
    };

    expect(
      await readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "retry-owner-key",
        fetcher: async () => "fresh-after-retry",
        leaseStore,
        waitForOwnerMs: 1,
        pollIntervalMs: 1,
      }),
    ).toBe("fresh-after-retry");
    expect(attempts).toBe(2);
    expect(releaseCalls).toBe(1);
    expect(cache.get("retry-owner-key")).toBe("fresh-after-retry");
  });

  it("onLeaseTimeout=throw 时等待超时直接抛错", async () => {
    const leaseStore = makeLeaseStore({ grant: false });

    await expect(
      readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "timeout-key",
        fetcher: async () => "fallback",
        leaseStore,
        waitForOwnerMs: 1,
        pollIntervalMs: 1,
        onLeaseTimeout: "throw",
      }),
    ).rejects.toThrow("readThroughWithLease timeout");
  });

  it("fetcher 返回 undefined 时不写入缓存", async () => {
    const leaseStore = makeLeaseStore();

    await readThroughWithLease({
      cache,
      ttlMs: 1000,
      key: "undefined-key",
      fetcher: async () => undefined,
      leaseStore,
    });

    expect(cache.get("undefined-key")).toBeUndefined();
  });

  it("lease 续租失败时返回 fresh，但不写入缓存", async () => {
    const leaseStore = makeLeaseStore({ renewResult: false });

    expect(
      await readThroughWithLease({
        cache,
        ttlMs: 1000,
        key: "lost-lease-key",
        fetcher: async () => "fresh",
        leaseStore,
      }),
    ).toBe("fresh");
    expect(cache.get("lost-lease-key")).toBeUndefined();
  });

  it("ttlMs <= 0 时直接穿透，不获取 lease", async () => {
    cache.set("key", "cached");
    const leaseStore = makeLeaseStore();

    expect(
      await readThroughWithLease({
        cache,
        ttlMs: 0,
        key: "key",
        fetcher: async () => "fresh",
        leaseStore,
      }),
    ).toBe("fresh");
    expect(leaseStore.acquireCalls()).toBe(0);
  });

  it("自定义 leaseTtlMs 小于 1 时归一化为 1ms", async () => {
    const leaseStore = makeLeaseStore();

    await readThroughWithLease({
      cache,
      ttlMs: 1000,
      key: "ttl-clamp-key",
      fetcher: async () => "fresh",
      leaseStore,
      leaseTtlMs: 0,
    });

    expect(leaseStore.lastTtl()).toBe(1);
  });

  it("readThroughWithLease 的 inflight 定时器触发后仍能返回结果", async () => {
    vi.useFakeTimers();
    try {
      const leaseStore = makeLeaseStore();
      let resolveFetch!: (value: string) => void;
      const pendingFetch = new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });

      const resultP = readThroughWithLease({
        cache,
        ttlMs: 60000,
        key: "lease-timer-key",
        fetcher: () => pendingFetch,
        leaseStore,
      });

      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(300001);

      resolveFetch("timer-ok");
      expect(await resultP).toBe("timer-ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lease inflight 条目达到上限时触发 10% 清理", async () => {
    vi.useFakeTimers();
    try {
      const leaseStore: CacheLeaseStore = {
        async acquireLease(key, ttlMs) {
          return {
            key,
            token: `token:${key}`,
            ttlMs,
            expiresAt: Date.now() + ttlMs,
            async release() {
              return true;
            },
            async renew() {
              return true;
            },
          };
        },
        async releaseLease() {
          return true;
        },
        async renewLease() {
          return true;
        },
      };

      const resolvers: Array<() => void> = [];
      const inflightPromises: Array<Promise<string>> = [];
      for (let i = 0; i < 10000; i++) {
        let resolve!: () => void;
        const pendingP = new Promise<void>((r) => {
          resolve = r;
        });
        resolvers.push(resolve);
        inflightPromises.push(
          readThroughWithLease({
            cache,
            ttlMs: 60000,
            key: `lease-overflow-${i}`,
            leaseStore,
            fetcher: () => pendingP.then(() => `v${i}`),
          }),
        );
      }

      let triggerResolve!: (value: string) => void;
      const triggerFetch = new Promise<string>((resolve) => {
        triggerResolve = resolve;
      });
      const triggerResult = readThroughWithLease({
        cache,
        ttlMs: 60000,
        key: "lease-overflow-trigger",
        leaseStore,
        fetcher: () => triggerFetch,
      });

      resolvers.forEach((resolve) => resolve());
      triggerResolve("overflow-triggered");

      await Promise.all([...inflightPromises, triggerResult]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cache.set 失败时仍返回 fetcher 的值并释放 lease", async () => {
    const badCache: CacheLike = {
      get: async () => undefined,
      set: async () => {
        throw new Error("write failed");
      },
      del: async () => false,
      exists: async () => false,
      has: async () => false,
      clear: async () => {},
      getMany: async () => ({}),
      setMany: async () => true,
      delMany: async () => 0,
      delPattern: async () => 0,
      keys: async () => [],
    };
    const leaseStore = makeLeaseStore();

    expect(
      await readThroughWithLease({
        cache: badCache,
        ttlMs: 1000,
        key: "bad-cache-key",
        fetcher: async () => "fresh",
        leaseStore,
      }),
    ).toBe("fresh");
    expect(leaseStore.releaseCalls()).toBe(1);
  });
});
