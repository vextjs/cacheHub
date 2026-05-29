import { describe, it, expect, vi, beforeEach } from "vitest";
import { withCache, FunctionCache } from "../../src/function-cache.js";
import { MemoryCache } from "../../src/memory-cache.js";
import type { CacheLike } from "../../src/types.js";

// ── 辅助工厂 ──

function makeCache(
  opts?: ConstructorParameters<typeof MemoryCache>[0],
): MemoryCache {
  return new MemoryCache({ maxEntries: 200, enableStats: true, ...opts });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 创建带调用计数的异步函数
 */
function makeAsyncFn<T>(returnValue: T, delay = 0) {
  let calls = 0;
  const fn = async (..._args: any[]): Promise<T> => {
    calls++;
    if (delay > 0) {
      await sleep(delay);
    }
    return returnValue;
  };
  return { fn, getCalls: () => calls };
}

// ── withCache ──

describe("withCache", () => {
  // ────────────────────────────────────────────────────────
  // 基础缓存命中 / 未命中
  // ────────────────────────────────────────────────────────

  describe("基础缓存命中 / 未命中", () => {
    it("首次调用执行原函数并缓存结果", async () => {
      const { fn, getCalls } = makeAsyncFn("hello");
      const cached = withCache(fn, { ttl: 1000 });

      const result = await cached();
      expect(result).toBe("hello");
      expect(getCalls()).toBe(1);
    });

    it("第二次调用命中缓存，不再执行原函数", async () => {
      const { fn, getCalls } = makeAsyncFn("hello");
      const cached = withCache(fn, { ttl: 1000 });

      await cached();
      const result = await cached();
      expect(result).toBe("hello");
      expect(getCalls()).toBe(1);
    });

    it("不同参数组合使用不同缓存键", async () => {
      const fn = async (id: number) => `user:${id}`;
      const cached = withCache(fn, { ttl: 1000 });

      const r1 = await cached(1);
      const r2 = await cached(2);
      expect(r1).toBe("user:1");
      expect(r2).toBe("user:2");
    });

    it("相同参数命中缓存", async () => {
      let calls = 0;
      const fn = async (id: number) => {
        calls++;
        return `user:${id}`;
      };
      const cached = withCache(fn, { ttl: 1000 });

      await cached(42);
      await cached(42);
      expect(calls).toBe(1);
    });

    it("null 是有效缓存值，第二次不触发原函数", async () => {
      const fn = async () => null;
      let calls = 0;
      const counted = async () => {
        calls++;
        return fn();
      };
      const cached = withCache(counted, { ttl: 1000 });

      await cached();
      await cached();
      expect(calls).toBe(1);
    });

    it("false 是有效缓存值", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return false;
      };
      const cached = withCache(fn, { ttl: 1000 });

      await cached();
      const result = await cached();
      expect(result).toBe(false);
      expect(calls).toBe(1);
    });

    it("0 是有效缓存值", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return 0;
      };
      const cached = withCache(fn, { ttl: 1000 });
      await cached();
      const result = await cached();
      expect(result).toBe(0);
      expect(calls).toBe(1);
    });

    it("对象值正常缓存和返回", async () => {
      const obj = { id: 1, name: "Alice", roles: ["admin"] };
      const fn = async () => obj;
      const cached = withCache(fn, { ttl: 1000 });

      const r1 = await cached();
      const r2 = await cached();
      expect(r1).toEqual(obj);
      expect(r2).toEqual(obj);
    });
  });

  // ────────────────────────────────────────────────────────
  // 默认选项
  // ────────────────────────────────────────────────────────

  describe("默认选项", () => {
    it("不传 options 时使用默认 MemoryCache 和 ttl=60000", async () => {
      const fn = async () => "value";
      const cached = withCache(fn);
      expect(await cached()).toBe("value");
    });

    it("默认 namespace 为 fn", async () => {
      const cache = makeCache();
      const fn = async (x: number) => x * 2;
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(3);
      // 键应以 'fn:' 开头
      const keys = cache.keys();
      expect(Array.isArray(keys)).toBe(true);
      expect((keys as string[]).some((k) => k.startsWith("fn:"))).toBe(true);
    });

    it("自定义 namespace", async () => {
      const cache = makeCache();
      const fn = async (x: number) => x;
      const cached = withCache(fn, { cache, ttl: 1000, namespace: "myns" });

      await cached(1);
      const keys = cache.keys() as string[];
      expect(keys.some((k) => k.startsWith("myns:"))).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // TTL
  // ────────────────────────────────────────────────────────

  describe("TTL 过期", () => {
    it("TTL 过期后重新执行原函数", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        return `v${calls}`;
      };
      const cache = makeCache();
      const cached = withCache(fn, { cache, ttl: 20 });

      await cached();
      expect(calls).toBe(1);

      await sleep(50); // 等待过期

      const result = await cached();
      expect(calls).toBe(2);
      expect(result).toBe("v2");
    });
  });

  // ────────────────────────────────────────────────────────
  // keyBuilder 自定义键生成
  // ────────────────────────────────────────────────────────

  describe("keyBuilder", () => {
    it("使用自定义 keyBuilder 生成键", async () => {
      const cache = makeCache();
      let calls = 0;
      const fn = async (user: { id: number; name: string }) => {
        calls++;
        return user;
      };
      const cached = withCache(fn, {
        cache,
        ttl: 1000,
        keyBuilder: (user) => `user:${user.id}`,
      });

      await cached({ id: 1, name: "Alice" });
      await cached({ id: 1, name: "Bob" }); // 相同 id，命中缓存
      expect(calls).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // condition：条件缓存
  // ────────────────────────────────────────────────────────

  describe("condition", () => {
    it("condition 返回 false 时不写入缓存，下次仍执行原函数", async () => {
      let calls = 0;
      const fn = async (x: number) => {
        calls++;
        return x;
      };
      const cache = makeCache();
      // 仅缓存正数
      const cached = withCache(fn, {
        cache,
        ttl: 1000,
        condition: (result) => result > 0,
      });

      await cached(0); // condition=false，不缓存
      await cached(0); // 再次执行
      expect(calls).toBe(2);
    });

    it("condition 返回 true 时正常写入缓存", async () => {
      let calls = 0;
      const fn = async (x: number) => {
        calls++;
        return x;
      };
      const cache = makeCache();
      const cached = withCache(fn, {
        cache,
        ttl: 1000,
        condition: (result) => result > 0,
      });

      await cached(1); // condition=true，写入缓存
      await cached(1); // 命中
      expect(calls).toBe(1);
    });

    it("condition 为 null 结果返回 false 时不缓存空值", async () => {
      let calls = 0;
      const fn = async (): Promise<string | null> => {
        calls++;
        return null;
      };
      const cache = makeCache();
      const cached = withCache(fn, {
        cache,
        ttl: 1000,
        condition: (result) => result !== null,
      });

      await cached();
      await cached();
      expect(calls).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────
  // 并发去重（实例级 in-flight）
  // ────────────────────────────────────────────────────────

  describe("并发去重（in-flight）", () => {
    it("相同参数的并发请求只触发一次原函数", async () => {
      let calls = 0;
      const fn = async (id: number): Promise<string> => {
        calls++;
        await sleep(30);
        return `user:${id}`;
      };
      const cached = withCache(fn, { ttl: 1000 });

      const results = await Promise.all([
        cached(1),
        cached(1),
        cached(1),
        cached(1),
        cached(1),
      ]);

      expect(results).toEqual([
        "user:1",
        "user:1",
        "user:1",
        "user:1",
        "user:1",
      ]);
      expect(calls).toBe(1);
    });

    it("不同参数的并发请求各自执行原函数", async () => {
      let calls = 0;
      const fn = async (id: number): Promise<string> => {
        calls++;
        await sleep(10);
        return `user:${id}`;
      };
      const cached = withCache(fn, { ttl: 1000 });

      await Promise.all([cached(1), cached(2), cached(3)]);
      expect(calls).toBe(3);
    });

    it("in-flight 去重是实例级别的（不同 withCache 包装独立计数）", async () => {
      let callsA = 0;
      let callsB = 0;
      const fnA = async (): Promise<string> => {
        callsA++;
        await sleep(20);
        return "a";
      };
      const fnB = async (): Promise<string> => {
        callsB++;
        await sleep(20);
        return "b";
      };

      // 同一个 cache，但不同 withCache 实例
      const cache = makeCache();
      const cachedA = withCache(fnA, { cache, ttl: 1000, namespace: "a" });
      const cachedB = withCache(fnB, { cache, ttl: 1000, namespace: "b" });

      await Promise.all([cachedA(), cachedA(), cachedB(), cachedB()]);
      expect(callsA).toBe(1);
      expect(callsB).toBe(1);
    });

    it("in-flight Promise 失败后，下一次请求可重新执行", async () => {
      let attempt = 0;
      const fn = async (): Promise<string> => {
        attempt++;
        if (attempt === 1) {
          throw new Error("first attempt failed");
        }
        return "recovered";
      };
      const cached = withCache(fn, { ttl: 1000 });

      try {
        await cached();
      } catch {
        // 预期失败
      }

      const result = await cached();
      expect(result).toBe("recovered");
      expect(attempt).toBe(2);
    });

    it("并发 inflight Promise 失败时 catch 触发，第二个请求重新执行原函数", async () => {
      let callCount = 0;
      const fn = async (): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          await sleep(20); // 给第二个请求时间挂载到同一 inflight Promise
          throw new Error("transient failure");
        }
        return "recovered";
      };
      const cached = withCache(fn, { ttl: 1000 });

      const [r1, r2] = await Promise.allSettled([cached(), cached()]);
      expect(r1.status).toBe("rejected");
      expect(r2.status).toBe("fulfilled");
      if (r2.status === "fulfilled") {
        expect(r2.value).toBe("recovered");
      }
    });
  });

  // ────────────────────────────────────────────────────────
  // 错误处理
  // ────────────────────────────────────────────────────────

  describe("错误处理", () => {
    it("原函数抛出时 withCache 向上传播", async () => {
      const fn = async (): Promise<never> => {
        throw new Error("fn error");
      };
      const cached = withCache(fn, { ttl: 1000 });

      await expect(cached()).rejects.toThrow("fn error");
    });

    it("原函数抛出时不写入缓存，下次重新执行", async () => {
      let calls = 0;
      let shouldFail = true;
      const fn = async (): Promise<string> => {
        calls++;
        if (shouldFail) throw new Error("temp fail");
        return "ok";
      };
      const cached = withCache(fn, { ttl: 1000 });

      try {
        await cached();
      } catch {
        // 预期
      }
      shouldFail = false;
      const result = await cached();
      expect(result).toBe("ok");
      expect(calls).toBe(2);
    });

    it("cache.set 失败时静默忽略，仍然返回原函数结果", async () => {
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
      const fn = async () => "value";
      const cached = withCache(fn, { cache: badCache, ttl: 1000 });

      const result = await cached();
      expect(result).toBe("value");
    });
  });

  // ────────────────────────────────────────────────────────
  // invalidate / invalidateAll
  // ────────────────────────────────────────────────────────

  describe("invalidate", () => {
    it("invalidate(args) 使指定参数组合的缓存失效", async () => {
      let calls = 0;
      const fn = async (id: number) => {
        calls++;
        return `user:${id}`;
      };
      const cache = makeCache();
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(1);
      expect(calls).toBe(1);

      await cached.invalidate(1);
      await cached(1); // 重新执行
      expect(calls).toBe(2);
    });

    it("invalidate 仅使对应参数的缓存失效，不影响其他参数", async () => {
      let calls = 0;
      const fn = async (id: number) => {
        calls++;
        return `user:${id}`;
      };
      const cache = makeCache();
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(1);
      await cached(2);
      expect(calls).toBe(2);

      await cached.invalidate(1); // 仅失效 id=1

      await cached(1); // 重新执行
      await cached(2); // 仍命中缓存
      expect(calls).toBe(3);
    });
  });

  describe("invalidateAll", () => {
    it("invalidateAll() 使所有缓存条目失效", async () => {
      let calls = 0;
      const fn = async (id: number) => {
        calls++;
        return `user:${id}`;
      };
      const cache = makeCache();
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(1);
      await cached(2);
      await cached(3);
      expect(calls).toBe(3);

      await cached.invalidateAll();

      await cached(1);
      await cached(2);
      await cached(3);
      expect(calls).toBe(6);
    });

    it("默认键构造路径精确删除仍存在的已写入键，并清理淘汰历史键", async () => {
      const cache = makeCache({ maxEntries: 1 });
      const delPatternSpy = vi.spyOn(cache, "delPattern");
      const delSpy = vi.spyOn(cache, "del");
      const cached = withCache(async (id: number) => `v${id}`, {
        cache,
        ttl: 1000,
        namespace: "demo",
      });

      await cached(1);
      await cached(2);
      await cached(3);

      expect(cache.keys()).toHaveLength(1);

      await cached.invalidateAll();

      expect(delPatternSpy).not.toHaveBeenCalled();
      expect(delSpy).toHaveBeenCalledTimes(1);
      expect(cache.keys()).toEqual([]);
    });

    it("invalidateAll 不删除同前缀但非该包装函数写入的键", async () => {
      const cache = makeCache();
      cache.set("demo:anonymous:manual", "manual", 1000);
      const cached = withCache(async (id: number) => `v${id}`, {
        cache,
        ttl: 1000,
        namespace: "demo",
      });

      await cached(1);
      await cached.invalidateAll();

      expect(cache.get("demo:anonymous:manual")).toBe("manual");
      expect(cache.keys()).toEqual(["demo:anonymous:manual"]);
    });

    it("invalidateAll 后 knownKeys 清空，再次 invalidateAll 不报错", async () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000 });
      await cached();
      await cached.invalidateAll();
      await expect(cached.invalidateAll()).resolves.toBeUndefined();
    });

    it("invalidateAll: cache.del 抛出时静默忽略，继续处理其余键", async () => {
      const cache = makeCache();
      let calls = 0;
      const fn = async (id: number) => {
        calls++;
        return `v${id}`;
      };
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(1);
      await cached(2);

      // 让 del 抛出异常
      vi.spyOn(cache, "del").mockRejectedValue(new Error("del failed"));

      // 不应向外抛出
      await expect(cached.invalidateAll()).resolves.toBeUndefined();
    });

    it("invalidateAll 清理 knownKeys 时 exists 抛错仍保留并尝试删除", async () => {
      const cache = makeCache();
      const cached = withCache(async () => "v", { cache, ttl: 1000 });
      await cached();

      vi.spyOn(cache, "exists").mockImplementation(() => {
        throw new Error("exists failed");
      });
      const delSpy = vi.spyOn(cache, "del");

      await cached.invalidateAll();

      expect(delSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // stats 统计
  // ────────────────────────────────────────────────────────

  describe("stats", () => {
    it("初始 stats 全为 0", () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000 });
      const s = cached.stats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.errors).toBe(0);
      expect(s.hitRate).toBe(0);
    });

    it("miss 后 misses+1", async () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000 });
      await cached();
      expect(cached.stats().misses).toBe(1);
    });

    it("hit 后 hits+1", async () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000 });
      await cached();
      await cached();
      expect(cached.stats().hits).toBe(1);
      expect(cached.stats().misses).toBe(1);
    });

    it("hitRate = hits / (hits + misses)", async () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000 });
      await cached(); // miss
      await cached(); // hit
      await cached(); // hit
      const s = cached.stats();
      expect(s.hitRate).toBeCloseTo(2 / 3);
    });

    it("原函数抛出时 errors+1", async () => {
      const fn = async (): Promise<never> => {
        throw new Error("e");
      };
      const cached = withCache(fn, { ttl: 1000 });
      try {
        await cached();
      } catch {
        /* expected */
      }
      expect(cached.stats().errors).toBe(1);
    });

    it("enableStats=false 时 stats 始终为零", async () => {
      const fn = async () => "v";
      const cached = withCache(fn, { ttl: 1000, enableStats: false });
      await cached();
      await cached();
      expect(cached.stats().hits).toBe(0);
      expect(cached.stats().misses).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // A09：超长键 SHA-256 压缩
  // ────────────────────────────────────────────────────────

  describe("A09：超长键 SHA-256 压缩", () => {
    it("普通键（< 1024 字节）不使用 SHA-256", async () => {
      const cache = makeCache();
      const fn = async (x: number) => x;
      const cached = withCache(fn, { cache, ttl: 1000, namespace: "ns" });

      await cached(1);
      const keys = cache.keys() as string[];
      // 普通键不含 sha256 段
      expect(keys.some((k) => k.includes(":sha256:"))).toBe(false);
    });

    it("超长键（> 1024 字节）使用 SHA-256 压缩（A09）", async () => {
      const cache = makeCache();
      // 构造超长参数使键超过 1024 字节
      const longArg = "x".repeat(1100);
      const fn = async (arg: string) => arg.length;
      const cached = withCache(fn, { cache, ttl: 1000, namespace: "ns" });

      await cached(longArg);
      const keys = cache.keys() as string[];

      // 压缩后的键包含 sha256 段
      expect(keys.some((k) => k.includes(":sha256:"))).toBe(true);
      // 键长度不超过合理范围（namespace:fnName:sha256:<64位hex>）
      const sha256Key = keys.find((k) => k.includes(":sha256:"))!;
      expect(sha256Key.length).toBeLessThan(200);
    });

    it("超长键压缩后相同参数仍命中缓存", async () => {
      let calls = 0;
      const fn = async (arg: string) => {
        calls++;
        return arg.length;
      };
      const cache = makeCache();
      const longArg = "y".repeat(1100);
      const cached = withCache(fn, { cache, ttl: 1000 });

      await cached(longArg);
      await cached(longArg); // 应命中缓存
      expect(calls).toBe(1);
    });

    it("不同超长键产生不同 SHA-256（无碰撞）", async () => {
      const cache = makeCache();
      let calls = 0;
      const fn = async (arg: string) => {
        calls++;
        return arg;
      };
      const cached = withCache(fn, { cache, ttl: 1000 });

      const longArg1 = "a".repeat(1100);
      const longArg2 = "b".repeat(1100);

      await cached(longArg1);
      await cached(longArg2);
      // 两个不同参数各自执行
      expect(calls).toBe(2);
    });
  });
});

// ── FunctionCache ──

describe("FunctionCache", () => {
  // ────────────────────────────────────────────────────────
  // 构造函数
  // ────────────────────────────────────────────────────────

  describe("构造函数", () => {
    it("接受 CacheLike 实例", () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache);
      expect(fc.list()).toEqual([]);
    });

    it("接受 { getCache() } 形式（解耦框架）", () => {
      const cache = makeCache();
      const getter = { getCache: () => cache };
      const fc = new FunctionCache(getter);
      expect(fc.list()).toEqual([]);
    });

    it("接受全局选项（ttl / namespace）", () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 30000, namespace: "global" });
      expect(fc.list()).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────
  // register / execute
  // ────────────────────────────────────────────────────────

  describe("register / execute", () => {
    let cache: MemoryCache;
    let fc: FunctionCache;

    beforeEach(() => {
      cache = makeCache();
      fc = new FunctionCache(cache, { ttl: 1000 });
    });

    it("register 后可通过 execute 调用", async () => {
      fc.register("greet", async (name: string) => `Hello, ${name}!`);
      const result = await fc.execute("greet", "Alice");
      expect(result).toBe("Hello, Alice!");
    });

    it("execute 未注册的函数时抛出错误", async () => {
      await expect(fc.execute("nonexistent")).rejects.toThrow(
        '未注册的函数 "nonexistent"',
      );
    });

    it("execute 命中缓存后不再调用原函数", async () => {
      let calls = 0;
      fc.register("fn", async (x: number) => {
        calls++;
        return x * 2;
      });

      await fc.execute("fn", 5);
      await fc.execute("fn", 5);
      expect(calls).toBe(1);
    });

    it("不同参数使用不同缓存键", async () => {
      let calls = 0;
      fc.register("fn", async (x: number) => {
        calls++;
        return x * 2;
      });

      await fc.execute("fn", 1);
      await fc.execute("fn", 2);
      expect(calls).toBe(2);
    });

    it("register 选项的 ttl 覆盖全局 ttl", async () => {
      let calls = 0;
      fc.register(
        "fn",
        async () => {
          calls++;
          return "v";
        },
        { ttl: 20 },
      ); // 20ms 过期

      await fc.execute("fn");
      await sleep(50);
      await fc.execute("fn"); // 过期后重新执行
      expect(calls).toBe(2);
    });

    it("register 选项的 namespace 覆盖全局 namespace", async () => {
      fc.register("fn", async (x: number) => x, { namespace: "myns" });
      await fc.execute("fn", 1);

      const keys = cache.keys() as string[];
      expect(keys.some((k) => k.startsWith("myns:"))).toBe(true);
    });

    it("自定义 keyBuilder", async () => {
      let calls = 0;
      fc.register(
        "getUser",
        async (user: { id: number; extra: string }) => {
          calls++;
          return user.id;
        },
        {
          keyBuilder: (user: { id: number; extra: string }) =>
            `user:${user.id}`,
        },
      );

      // 不同 extra，但 id 相同 → 命中同一缓存
      await fc.execute("getUser", { id: 1, extra: "a" });
      await fc.execute("getUser", { id: 1, extra: "b" });
      expect(calls).toBe(1);
    });

    it("condition 返回 false 时不缓存", async () => {
      let calls = 0;
      fc.register(
        "fn",
        async (x: number) => {
          calls++;
          return x;
        },
        { condition: (r: number) => r > 0 },
      );

      await fc.execute("fn", 0);
      await fc.execute("fn", 0);
      expect(calls).toBe(2); // 不缓存，每次都执行
    });
  });

  // ────────────────────────────────────────────────────────
  // 并发去重（in-flight）
  // ────────────────────────────────────────────────────────

  describe("并发去重（in-flight）", () => {
    it("相同 name + 参数的并发请求只触发一次原函数", async () => {
      let calls = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });

      fc.register("fn", async (id: number): Promise<string> => {
        calls++;
        await sleep(30);
        return `item:${id}`;
      });

      const results = await Promise.all([
        fc.execute("fn", 1),
        fc.execute("fn", 1),
        fc.execute("fn", 1),
      ]);

      expect(results).toEqual(["item:1", "item:1", "item:1"]);
      expect(calls).toBe(1);
    });

    it("fn 抛出后下一次可重新执行", async () => {
      let attempt = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });

      fc.register("fn", async (): Promise<string> => {
        attempt++;
        if (attempt === 1) throw new Error("first fail");
        return "ok";
      });

      try {
        await fc.execute("fn");
      } catch {
        /* 预期 */
      }
      const result = await fc.execute("fn");
      expect(result).toBe("ok");
      expect(attempt).toBe(2);
    });

    it("并发 inflight Promise 失败时 catch 触发，第二个请求重新执行原函数", async () => {
      let callCount = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });

      fc.register("fn", async (): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          await sleep(20);
          throw new Error("transient failure");
        }
        return "recovered";
      });

      const [r1, r2] = await Promise.allSettled([
        fc.execute("fn"),
        fc.execute("fn"),
      ]);
      expect(r1.status).toBe("rejected");
      expect(r2.status).toBe("fulfilled");
      if (r2.status === "fulfilled") {
        expect((r2 as PromiseFulfilledResult<string>).value).toBe("recovered");
      }
    });

    it("execute: cache.set 抛出时静默忽略，仍返回原函数结果", async () => {
      const cache = makeCache();
      vi.spyOn(cache, "set").mockRejectedValue(new Error("cache.set failed"));
      const fc = new FunctionCache(cache, { ttl: 1000 });
      fc.register("fn", async () => "result-value");

      const result = await fc.execute("fn");
      expect(result).toBe("result-value");
    });
  });

  // ────────────────────────────────────────────────────────
  // invalidate / invalidatePattern
  // ────────────────────────────────────────────────────────

  describe("invalidate", () => {
    it("invalidate 使指定函数 + 参数的缓存失效", async () => {
      let calls = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });

      fc.register("fn", async (id: number) => {
        calls++;
        return id;
      });

      await fc.execute("fn", 1);
      await fc.invalidate("fn", 1);
      await fc.execute("fn", 1);
      expect(calls).toBe(2);
    });

    it("invalidate 未注册函数时不报错", async () => {
      const fc = new FunctionCache(makeCache());
      await expect(fc.invalidate("nonexistent", 1)).resolves.toBeUndefined();
    });

    it("invalidate 使用自定义 keyBuilder 生成 key 并删除对应缓存", async () => {
      let calls = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });

      fc.register(
        "getUser",
        async (user: { id: number; extra: string }) => {
          calls++;
          return user;
        },
        {
          keyBuilder: (user: { id: number; extra: string }) =>
            `user:${user.id}`,
        },
      );

      const arg = { id: 42, extra: "data" };
      await fc.execute("getUser", arg);
      expect(calls).toBe(1);

      // invalidate 应使用 keyBuilder 生成相同的 key，从而删除缓存
      await fc.invalidate("getUser", arg);

      await fc.execute("getUser", arg);
      expect(calls).toBe(2);
    });
  });

  describe("invalidatePattern", () => {
    it("委托给 cache.delPattern", async () => {
      const cache = makeCache();
      const delPatternSpy = vi.spyOn(cache, "delPattern");
      const fc = new FunctionCache(cache);

      await fc.invalidatePattern("user:*");
      expect(delPatternSpy).toHaveBeenCalledWith("user:*");
    });
  });

  // ────────────────────────────────────────────────────────
  // list
  // ────────────────────────────────────────────────────────

  describe("list", () => {
    it("空注册表时返回空数组", () => {
      const fc = new FunctionCache(makeCache());
      expect(fc.list()).toEqual([]);
    });

    it("返回所有已注册的函数名称", () => {
      const fc = new FunctionCache(makeCache());
      fc.register("fn1", async () => 1);
      fc.register("fn2", async () => 2);
      fc.register("fn3", async () => 3);
      expect(fc.list().sort()).toEqual(["fn1", "fn2", "fn3"]);
    });
  });

  // ────────────────────────────────────────────────────────
  // getStats
  // ────────────────────────────────────────────────────────

  describe("getStats", () => {
    let cache: MemoryCache;
    let fc: FunctionCache;

    beforeEach(() => {
      cache = makeCache();
      fc = new FunctionCache(cache, { ttl: 1000 });
      fc.register("fn", async (x: number) => x * 2);
    });

    it("初始 stats 全为 0", () => {
      const s = fc.getStats("fn") as {
        hits: number;
        misses: number;
        errors: number;
        hitRate: number;
      };
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.errors).toBe(0);
      expect(s.hitRate).toBe(0);
    });

    it("miss 后 misses+1", async () => {
      await fc.execute("fn", 1);
      const s = fc.getStats("fn") as {
        hits: number;
        misses: number;
        hitRate: number;
      };
      expect(s.misses).toBe(1);
      expect(s.hits).toBe(0);
    });

    it("hit 后 hits+1", async () => {
      await fc.execute("fn", 1);
      await fc.execute("fn", 1);
      const s = fc.getStats("fn") as {
        hits: number;
        misses: number;
        hitRate: number;
      };
      expect(s.hits).toBe(1);
      expect(s.misses).toBe(1);
    });

    it("hitRate 计算正确", async () => {
      await fc.execute("fn", 1); // miss
      await fc.execute("fn", 1); // hit
      await fc.execute("fn", 1); // hit
      const s = fc.getStats("fn") as { hitRate: number };
      expect(s.hitRate).toBeCloseTo(2 / 3);
    });

    it("fn 抛出时 errors+1", async () => {
      fc.register("errFn", async (): Promise<never> => {
        throw new Error("boom");
      });
      try {
        await fc.execute("errFn");
      } catch {
        /* 预期 */
      }
      const s = fc.getStats("errFn") as { errors: number };
      expect(s.errors).toBe(1);
    });

    it("未注册函数的 getStats 返回零值", () => {
      const s = fc.getStats("nonexistent") as { hits: number; misses: number };
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
    });

    it("不传 name 时返回全部函数统计", async () => {
      fc.register("fn2", async (x: number) => x);
      await fc.execute("fn", 1);
      await fc.execute("fn2", 2);

      const allStats = fc.getStats() as Record<string, { misses: number }>;
      expect(allStats["fn"].misses).toBe(1);
      expect(allStats["fn2"].misses).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // resetStats
  // ────────────────────────────────────────────────────────

  describe("resetStats", () => {
    it("重置指定函数的统计", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });
      fc.register("fn", async () => "v");

      await fc.execute("fn");
      await fc.execute("fn");
      fc.resetStats("fn");

      const s = fc.getStats("fn") as { hits: number; misses: number };
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
    });

    it("不传 name 时重置全部函数统计", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });
      fc.register("fn1", async () => "v1");
      fc.register("fn2", async () => "v2");

      await fc.execute("fn1");
      await fc.execute("fn2");
      fc.resetStats();

      const allStats = fc.getStats() as Record<string, { misses: number }>;
      expect(allStats["fn1"].misses).toBe(0);
      expect(allStats["fn2"].misses).toBe(0);
    });

    it("重置不存在函数时不报错", () => {
      const fc = new FunctionCache(makeCache());
      expect(() => fc.resetStats("nonexistent")).not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // clear
  // ────────────────────────────────────────────────────────

  describe("clear", () => {
    it("clear() 清空注册表，list() 返回空数组", () => {
      const fc = new FunctionCache(makeCache());
      fc.register("fn1", async () => 1);
      fc.register("fn2", async () => 2);
      fc.clear();
      expect(fc.list()).toEqual([]);
    });

    it("clear() 后 execute 已清除的函数时抛出错误", async () => {
      const fc = new FunctionCache(makeCache(), { ttl: 1000 });
      fc.register("fn", async () => "v");
      fc.clear();
      await expect(fc.execute("fn")).rejects.toThrow('未注册的函数 "fn"');
    });
  });

  // ────────────────────────────────────────────────────────
  // A09：超长键 SHA-256 压缩
  // ────────────────────────────────────────────────────────

  describe("A09：超长键 SHA-256 压缩", () => {
    it("超长参数产生 SHA-256 压缩键", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000, namespace: "test" });
      fc.register("fn", async (arg: string) => arg.length);

      const longArg = "z".repeat(1100);
      await fc.execute("fn", longArg);

      const keys = cache.keys() as string[];
      expect(keys.some((k) => k.includes(":sha256:"))).toBe(true);
    });

    it("相同超长参数命中缓存", async () => {
      let calls = 0;
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 1000 });
      fc.register("fn", async (arg: string) => {
        calls++;
        return arg.length;
      });

      const longArg = "w".repeat(1100);
      await fc.execute("fn", longArg);
      await fc.execute("fn", longArg);
      expect(calls).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // 端到端场景
  // ────────────────────────────────────────────────────────

  describe("端到端场景", () => {
    it("典型数据库查询缓存流程", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 5000, namespace: "db" });

      const dbCalls: number[] = [];
      fc.register("getUser", async (id: number) => {
        dbCalls.push(id);
        return { id, name: `User${id}` };
      });

      // 第一次查询（miss）
      const user1 = await fc.execute("getUser", 1);
      expect(user1).toEqual({ id: 1, name: "User1" });
      expect(dbCalls).toEqual([1]);

      // 第二次查询（hit）
      const user1again = await fc.execute("getUser", 1);
      expect(user1again).toEqual({ id: 1, name: "User1" });
      expect(dbCalls).toHaveLength(1);

      // 不同参数（miss）
      await fc.execute("getUser", 2);
      expect(dbCalls).toEqual([1, 2]);

      // 失效后重新查询
      await fc.invalidate("getUser", 1);
      await fc.execute("getUser", 1);
      expect(dbCalls).toEqual([1, 2, 1]);

      // 检查统计
      const stats = fc.getStats("getUser") as { hits: number; misses: number };
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(3);
    });

    it("{ getCache() } 形式接入 monSQLize 风格框架", async () => {
      const cache = makeCache();
      // 模拟 monSQLize 风格的 CacheManager
      const cacheManager = {
        getCache() {
          return cache;
        },
        someOtherMethod() {
          return "other";
        },
      };

      const fc = new FunctionCache(cacheManager, { ttl: 1000 });
      fc.register("fetchData", async (key: string) => `data:${key}`);

      const result = await fc.execute("fetchData", "abc");
      expect(result).toBe("data:abc");

      // 命中缓存
      let fetchCalled = 0;
      fc.register("countedFetch", async (key: string) => {
        fetchCalled++;
        return `data:${key}`;
      });
      await fc.execute("countedFetch", "xyz");
      await fc.execute("countedFetch", "xyz");
      expect(fetchCalled).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────
  // 分支覆盖补充（覆盖率 100%）
  // ────────────────────────────────────────────────────────

  describe("分支覆盖补充", () => {
    // Line 131: fn.name || 'anonymous'
    // 传入匿名函数时 fn.name 为 ''，取 'anonymous' 后备路径
    it("withCache 传入匿名函数：fn.name 为空时使用 anonymous 后备键", async () => {
      const cache = makeCache();
      // function expression 没有赋值给变量时 name === ''
      const cached = withCache(
        async function () {
          return "anon-result";
        },
        { cache, ttl: 1000 },
      );

      const result = await cached();
      expect(result).toBe("anon-result");

      const keys = cache.keys() as string[];
      // 键应包含 "anonymous" 段（因为 fn.name === ''）
      expect(keys.some((k) => k.includes("anonymous"))).toBe(true);
    });

    // Line 131: options 为 undefined 时 options?.keyBuilder 走短路分支
    it("withCache 不传 options 时使用默认配置（options=undefined）", async () => {
      // 不传任何 options，覆盖 options?.keyBuilder undefined 短路路径
      const cached = withCache(async function namedFn() {
        return 99;
      });
      const result = await cached();
      expect(result).toBe(99);
    });

    // Line 183/187: if (enableStats) 在 catch 块中——enableStats=false 时不计入 errors
    it("enableStats=false 时原函数抛出不计入 errors（覆盖 catch 块 else 分支）", async () => {
      const fn = async (): Promise<never> => {
        throw new Error("deliberate-error");
      };
      const cached = withCache(fn, { ttl: 1000, enableStats: false });
      await expect(cached()).rejects.toThrow("deliberate-error");
      // enableStats=false：stats 不追踪，errors 应为 0
      expect(cached.stats().errors).toBe(0);
    });

    // condition 返回 false 时跳过缓存写入
    it("withCache condition 返回 false 时不写入缓存，每次都穿透调用原函数", async () => {
      const cache = makeCache();
      let calls = 0;
      const fn = async (x: number) => {
        calls++;
        return x * 10;
      };
      // condition: 结果为 0 时不缓存
      const cached = withCache(fn, {
        cache,
        ttl: 1000,
        condition: (result) => result !== 0,
      });

      // 结果 0 → condition 返回 false → 不缓存
      await cached(0);
      await cached(0);
      expect(calls).toBe(2); // 未缓存，每次都调用原函数

      // 结果非 0 → condition 返回 true → 缓存
      await cached(5);
      await cached(5);
      expect(calls).toBe(3); // 第二次命中缓存
    });
  });

  describe("FunctionCache 分支覆盖补充", () => {
    // Line 333: entry.options?.ttl 分支——per-function ttl 覆盖全局 ttl
    it("execute 使用 per-function ttl（覆盖 entry.options?.ttl 非 undefined 分支）", async () => {
      const cache = makeCache();
      // 全局 ttl=5000，但 per-function ttl=1000
      const fc = new FunctionCache(cache, { ttl: 5000 });
      fc.register("fastFn", async (x: number) => x * 3, { ttl: 1000 });
      const result = await fc.execute("fastFn", 7);
      expect(result).toBe(21);
      // 确认结果已被缓存（使用 per-function ttl）
      const cached = await cache.get(cache.keys()[0]);
      expect(cached).toBe(21);
    });

    // Line 333: globalOptions.ttl 分支——per-function 无 ttl，使用 globalOptions.ttl
    it("execute 无 per-function ttl 时回退到 globalOptions.ttl", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache, { ttl: 2000 }); // 全局 ttl
      fc.register("globalTtlFn", async () => "global-ttl-result"); // 无 per-function ttl
      const result = await fc.execute("globalTtlFn");
      expect(result).toBe("global-ttl-result");
    });

    // Line 337-339: entry.options?.keyBuilder 分支
    it("execute 使用 per-function keyBuilder 构建键", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache);
      fc.register("keyedFn", async (id: number) => `item:${id}`, {
        keyBuilder: (...args) => `custom:${args[0]}`,
      });
      const result = await fc.execute("keyedFn", 42);
      expect(result).toBe("item:42");
      // 验证键使用了 keyBuilder
      const keys = cache.keys() as string[];
      expect(keys.some((k) => k.startsWith("custom:"))).toBe(true);
    });

    // Line 378-381: execute catch 块——原函数抛出时 entry.errors++ 且向外传播
    it("execute 原函数抛出时 errors 计入统计并向外传播", async () => {
      const cache = makeCache();
      const fc = new FunctionCache(cache);
      let callCount = 0;
      fc.register("throwingFn", async () => {
        callCount++;
        throw new Error("exec-error");
      });

      await expect(fc.execute("throwingFn")).rejects.toThrow("exec-error");
      const stats = fc.getStats("throwingFn") as {
        errors: number;
        misses: number;
      };
      expect(stats.errors).toBe(1);
      expect(stats.misses).toBe(1);
      expect(callCount).toBe(1);
    });

    // FunctionCache.invalidate：未注册函数名直接返回（不抛出）
    it("invalidate 未注册函数名时提前返回不抛出", async () => {
      const fc = new FunctionCache(new MemoryCache());
      await expect(fc.invalidate("nonExistent", 1, 2)).resolves.toBeUndefined();
    });
  });
});
