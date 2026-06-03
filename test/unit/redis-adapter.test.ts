import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRedisCacheAdapter } from "../../src/redis-adapter.js";
import type { RedisCacheAdapter } from "../../src/redis-adapter.js";

// ── vi.mock('module') ──
// 拦截 createRequire，为 URL 字符串构造路径提供假 ioredis 类。
// vi.mock 被 vitest 自动提升到 import 之前执行；
// _failIoredisLoad / _useDefaultExport 在测试用例运行时才被访问，不受 TDZ 影响。
let _failIoredisLoad = false;
let _useDefaultExport = false;

vi.mock("module", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("module");

  class FakeRedisClass {
    get = vi.fn<[string], Promise<null>>().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue("OK");
    del = vi.fn().mockResolvedValue(1);
    unlink = vi.fn().mockResolvedValue(1);
    exists = vi.fn().mockResolvedValue(0);
    pttl = vi.fn().mockResolvedValue(-2);
    flushdb = vi.fn().mockResolvedValue("OK");
    mget = vi.fn().mockResolvedValue([]);
    smembers = vi.fn().mockResolvedValue([]);
    sscan = vi.fn().mockResolvedValue(["0", []]);
    scan = vi.fn().mockResolvedValue(["0", []]);
    pipeline = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      unlink: vi.fn().mockReturnThis(),
      pttl: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      srem: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
    quit = vi.fn().mockResolvedValue("OK");
    on = vi.fn();
  }

  return {
    ...original,
    createRequire: (_url: string) => (id: string) => {
      if (id === "ioredis") {
        if (_failIoredisLoad) {
          throw new Error("Cannot find module 'ioredis'");
        }
        return _useDefaultExport ? { default: FakeRedisClass } : FakeRedisClass;
      }
      return original.createRequire(_url)(id);
    },
  };
});

// ── Mock Redis 工厂 ──

/**
 * 创建一个完整的 mock ioredis 实例（对象形式传入，绕过动态 require）。
 * 所有方法均为 vi.fn()，测试中按需 mock 返回值。
 */
function makeMockRedis() {
  const pipelineMock = {
    set: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    unlink: vi.fn().mockReturnThis(),
    pttl: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    srem: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(0),
    unlink: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(0),
    pttl: vi.fn().mockResolvedValue(-2),
    flushdb: vi.fn().mockResolvedValue("OK"),
    mget: vi.fn().mockResolvedValue([]),
    smembers: vi.fn().mockResolvedValue([]),
    sscan: vi.fn().mockResolvedValue(["0", []]),
    pipeline: vi.fn().mockReturnValue(pipelineMock),
    scan: vi.fn().mockResolvedValue(["0", []]),
    quit: vi.fn().mockResolvedValue("OK"),
    _pipeline: pipelineMock,
  };
}

type MockRedis = ReturnType<typeof makeMockRedis>;

function makeAdapter(redis?: MockRedis): {
  adapter: RedisCacheAdapter;
  redis: MockRedis;
} {
  const r = redis ?? makeMockRedis();
  const adapter = createRedisCacheAdapter(r as any);
  return { adapter, redis: r };
}

// ── 测试套件 ──

describe("RedisCacheAdapter", () => {
  // ────────────────────────────────────────────────────────
  // get
  // ────────────────────────────────────────────────────────

  describe("get", () => {
    it("key 存在时反序列化并返回值", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(JSON.stringify({ id: 1, name: "Alice" }));

      const result = await adapter.get("user:1");
      expect(result).toEqual({ id: 1, name: "Alice" });
      expect(redis.get).toHaveBeenCalledWith("user:1");
    });

    it("key 不存在时返回 undefined（redis 返回 null）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(null);

      expect(await adapter.get("nonexistent")).toBeUndefined();
    });

    it("redis 返回 undefined 时也返回 undefined", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(undefined);

      expect(await adapter.get("k")).toBeUndefined();
    });

    it("存储的原始字符串（非 JSON）以原始值返回", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue("not-valid-json{");

      // 解析失败时以原始字符串返回，不抛出
      const result = await adapter.get("k");
      expect(result).toBe("not-valid-json{");
    });

    it("null 是有效缓存值", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(JSON.stringify(null));

      expect(await adapter.get("k")).toBeNull();
    });

    it("false 是有效缓存值", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(JSON.stringify(false));

      expect(await adapter.get("k")).toBe(false);
    });

    it("数字 0 是有效缓存值", async () => {
      const { adapter, redis } = makeAdapter();
      redis.get.mockResolvedValue(JSON.stringify(0));

      expect(await adapter.get("k")).toBe(0);
    });

    it("key 为空字符串时抛出 TypeError（A12）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.get("")).rejects.toThrow(TypeError);
    });

    it("key 为非 string 时抛出 TypeError（A12）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.get(123 as any)).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // set
  // ────────────────────────────────────────────────────────

  describe("set", () => {
    it("set 值时序列化为 JSON 并调用 redis.set", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.set("k", { id: 1 });

      expect(redis.set).toHaveBeenCalledWith("k", JSON.stringify({ id: 1 }));
    });

    it("set 带 TTL 时使用 PX 选项（毫秒精度）", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.set("k", "v", 5000);

      expect(redis.set).toHaveBeenCalledWith("k", '"v"', "PX", 5000);
    });

    it("TTL=0 时不带 PX 选项（不设过期）", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.set("k", "v", 0);

      expect(redis.set).toHaveBeenCalledWith("k", '"v"');
    });

    it("undefined TTL 时不带 PX 选项", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.set("k", "v");

      expect(redis.set).toHaveBeenCalledWith("k", '"v"');
    });

    it("set null 值", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.set("k", null);
      expect(redis.set).toHaveBeenCalledWith("k", "null");
    });

    it("key 为空字符串时抛出 TypeError（A12）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.set("", "v")).rejects.toThrow(TypeError);
    });

    it("set 带 tags 时写入 tag 索引和 key-tags 反向索引", async () => {
      const { adapter, redis } = makeAdapter();

      await adapter.set("k", "v", 1000, { tags: ["user", "tenant"] });

      expect(redis._pipeline.sadd).toHaveBeenCalledWith(
        expect.stringContaining(":tag:"),
        "k",
      );
      expect(redis._pipeline.sadd).toHaveBeenCalledWith(
        expect.stringContaining(":key-tags:"),
        "user",
        "tenant",
      );
      expect(redis._pipeline.exec).toHaveBeenCalledOnce();
    });

    it("set 去重 tags，并拒绝空 tag", async () => {
      const { adapter, redis } = makeAdapter();

      await adapter.set("k", "v", 1000, { tags: ["user", "user"] });
      expect(redis._pipeline.sadd).toHaveBeenCalledWith(
        expect.stringContaining(":key-tags:"),
        "user",
      );

      await expect(adapter.set("k", "v", 1000, { tags: [""] })).rejects.toThrow(
        TypeError,
      );
    });

    it("tags 不是数组时抛出 TypeError", async () => {
      const { adapter } = makeAdapter();
      await expect(
        adapter.set("k", "v", 1000, { tags: "bad" as any }),
      ).rejects.toThrow(TypeError);
    });

    it("无 tags 覆写会清理旧 tag 索引，避免 stale tag 误删新值", async () => {
      const { adapter, redis } = makeAdapter();
      redis.smembers.mockResolvedValueOnce(["old-tag"]);

      await adapter.set("k", "new-value");

      expect(redis._pipeline.srem).toHaveBeenCalledWith(
        expect.stringContaining(":tag:"),
        "k",
      );
      expect(redis._pipeline.del).toHaveBeenCalledWith(
        expect.stringContaining(":key-tags:"),
      );
    });

    it("底层客户端不支持 smembers 时仍能执行无 tag set", async () => {
      const redis = makeMockRedis();
      delete (redis as any).smembers;
      const adapter = createRedisCacheAdapter(redis as any);

      await adapter.set("k", "v");

      expect(redis.set).toHaveBeenCalledWith("k", '"v"');
    });
  });

  // ────────────────────────────────────────────────────────
  // del
  // ────────────────────────────────────────────────────────

  describe("del", () => {
    it("key 存在时返回 true", async () => {
      const { adapter, redis } = makeAdapter();
      redis.del.mockResolvedValue(1);

      expect(await adapter.del("k")).toBe(true);
      expect(redis.del).toHaveBeenCalledWith("k");
    });

    it("key 不存在时返回 false", async () => {
      const { adapter, redis } = makeAdapter();
      redis.del.mockResolvedValue(0);

      expect(await adapter.del("k")).toBe(false);
    });

    it("key 为空字符串时抛出 TypeError（A12）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.del("")).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // exists / has
  // ────────────────────────────────────────────────────────

  describe("exists / has", () => {
    it("key 存在时返回 true", async () => {
      const { adapter, redis } = makeAdapter();
      redis.exists.mockResolvedValue(1);

      expect(await adapter.exists("k")).toBe(true);
      expect(redis.exists).toHaveBeenCalledWith("k");
    });

    it("key 不存在时返回 false", async () => {
      const { adapter, redis } = makeAdapter();
      redis.exists.mockResolvedValue(0);

      expect(await adapter.exists("k")).toBe(false);
    });

    it("has 是 exists 的别名", async () => {
      const { adapter, redis } = makeAdapter();
      redis.exists.mockResolvedValue(1);

      expect(await adapter.has("k")).toBe(true);
    });

    it("key 为空字符串时抛出 TypeError（A12）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.exists("")).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // clear
  // ────────────────────────────────────────────────────────

  describe("clear", () => {
    it("调用 redis.flushdb()", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.clear();
      expect(redis.flushdb).toHaveBeenCalledOnce();
    });
  });

  // ────────────────────────────────────────────────────────
  // getMany（A16）
  // ────────────────────────────────────────────────────────

  describe("getMany（A16）", () => {
    it("空数组快速返回 {}", async () => {
      const { adapter, redis } = makeAdapter();
      const result = await adapter.getMany([]);
      expect(result).toEqual({});
      expect(redis.mget).not.toHaveBeenCalled();
    });

    it("批量获取多个键", async () => {
      const { adapter, redis } = makeAdapter();
      redis.mget.mockResolvedValue(['"v1"', '"v2"', null]);

      const result = await adapter.getMany(["k1", "k2", "k3"]);
      expect(result).toEqual({ k1: "v1", k2: "v2" });
      // k3 为 null，不出现在结果中
      expect(result["k3"]).toBeUndefined();
    });

    it("使用 spread 将 keys 数组传给 mget", async () => {
      const { adapter, redis } = makeAdapter();
      redis.mget.mockResolvedValue([null]);

      await adapter.getMany(["k1"]);
      expect(redis.mget).toHaveBeenCalledWith("k1");
    });

    it("对象值正确反序列化", async () => {
      const { adapter, redis } = makeAdapter();
      redis.mget.mockResolvedValue([JSON.stringify({ id: 42 })]);

      const result = await adapter.getMany(["user:42"]);
      expect(result["user:42"]).toEqual({ id: 42 });
    });

    it("无法解析的值以原始字符串存入结果", async () => {
      const { adapter, redis } = makeAdapter();
      redis.mget.mockResolvedValue(["not-json{"]);

      const result = await adapter.getMany(["k"]);
      expect(result["k"]).toBe("not-json{");
    });

    it("非法空 key 时抛出 TypeError（批量路径统一校验）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.getMany([""])).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // setMany（A16）
  // ────────────────────────────────────────────────────────

  describe("setMany（A16）", () => {
    it("空对象快速返回 true，不调用 pipeline", async () => {
      const { adapter, redis } = makeAdapter();
      const result = await adapter.setMany({});
      expect(result).toBe(true);
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it("通过 pipeline 批量写入", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.setMany({ k1: "v1", k2: "v2" });

      expect(redis.pipeline).toHaveBeenCalledOnce();
      expect(redis._pipeline.set).toHaveBeenCalledWith("k1", '"v1"');
      expect(redis._pipeline.set).toHaveBeenCalledWith("k2", '"v2"');
      expect(redis._pipeline.exec).toHaveBeenCalledOnce();
    });

    it("带 TTL 时使用 PX 选项", async () => {
      const { adapter, redis } = makeAdapter();
      await adapter.setMany({ k1: "v1" }, 3000);

      expect(redis._pipeline.set).toHaveBeenCalledWith(
        "k1",
        '"v1"',
        "PX",
        3000,
      );
    });

    it("返回值始终为 true", async () => {
      const { adapter } = makeAdapter();
      expect(await adapter.setMany({ k: "v" })).toBe(true);
    });

    it("非法空 key 时抛出 TypeError（批量路径统一校验）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.setMany({ "": "v" })).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // delMany（A16）
  // ────────────────────────────────────────────────────────

  describe("delMany（A16）", () => {
    it("空数组快速返回 0，不调用 redis.del", async () => {
      const { adapter, redis } = makeAdapter();
      const result = await adapter.delMany([]);
      expect(result).toBe(0);
      expect(redis.del).not.toHaveBeenCalled();
    });

    it("批量删除多个键，返回删除数量", async () => {
      const { adapter, redis } = makeAdapter();
      redis.del.mockResolvedValue(2);

      const result = await adapter.delMany(["k1", "k2", "k3"]);
      expect(result).toBe(2);
      expect(redis.del).toHaveBeenCalledWith("k1", "k2", "k3");
    });

    it("非法空 key 时抛出 TypeError（批量路径统一校验）", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.delMany([""])).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // delPattern（A08 / A10 / A11）
  // ────────────────────────────────────────────────────────

  describe("delPattern（A08 / A10 / A11）", () => {
    it("使用 SCAN 游标迭代，禁止 KEYS（A08）", async () => {
      const { adapter, redis } = makeAdapter();
      // 模拟单次 SCAN 返回 2 个键后 cursor='0' 结束
      redis.scan.mockResolvedValue(["0", ["user:1", "user:2"]]);

      const count = await adapter.delPattern("user:*");
      expect(count).toBe(2);
      expect(redis.scan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "user:*",
        "COUNT",
        100,
      );
      // 不应调用 redis.keys
      expect((redis as any).keys).toBeUndefined();
    });

    it("多批次 SCAN（cursor 非 0 继续迭代）", async () => {
      const { adapter, redis } = makeAdapter();
      // 第一批：cursor='42'，第二批：cursor='0' 结束
      redis.scan
        .mockResolvedValueOnce(["42", ["k:1", "k:2"]])
        .mockResolvedValueOnce(["0", ["k:3"]]);

      const count = await adapter.delPattern("k:*");
      expect(count).toBe(3);
      expect(redis.scan).toHaveBeenCalledTimes(2);
    });

    it("无匹配键时返回 0", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);

      const count = await adapter.delPattern("nonexistent:*");
      expect(count).toBe(0);
      // 空批次不调用 pipeline
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it("通过 pipeline 批量执行 DEL（减少 RTT）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", ["k:1", "k:2"]]);

      await adapter.delPattern("k:*");
      expect(redis.pipeline).toHaveBeenCalledOnce();
      expect(redis._pipeline.del).toHaveBeenCalledWith("k:1");
      expect(redis._pipeline.del).toHaveBeenCalledWith("k:2");
      expect(redis._pipeline.exec).toHaveBeenCalledOnce();
    });

    it("deleteCommand=unlink 时使用 UNLINK 删除匹配键", async () => {
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any, {
        deleteCommand: "unlink",
      });
      redis.scan.mockResolvedValue(["0", ["k:1", "k:2"]]);

      await adapter.delPattern("k:*");

      expect(redis._pipeline.unlink).toHaveBeenCalledWith("k:1");
      expect(redis._pipeline.unlink).toHaveBeenCalledWith("k:2");
      expect(redis._pipeline.del).not.toHaveBeenCalledWith("k:1");
    });

    it("deleteCommand=unlink 但 pipeline 不支持 unlink 时回退 DEL", async () => {
      const redis = makeMockRedis();
      delete (redis._pipeline as any).unlink;
      const adapter = createRedisCacheAdapter(redis as any, {
        deleteCommand: "unlink",
      });
      redis.scan.mockResolvedValue(["0", ["k:1"]]);

      await adapter.delPattern("k:*");

      expect(redis._pipeline.del).toHaveBeenCalledWith("k:1");
    });

    it("pattern 超过 512 字符时截断并打印 warn（A10）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const longPattern = "x".repeat(600) + ":*";
      await adapter.delPattern(longPattern);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("超过 512 字符"),
      );
      // SCAN MATCH 中的 pattern 应被截断
      const callArgs = redis.scan.mock.calls[0];
      const usedPattern = callArgs[2];
      expect(usedPattern.length).toBeLessThanOrEqual(512);

      warnSpy.mockRestore();
    });

    it("pattern 中的 ? 被转义为 \\?（A11：不支持 ? 通配符）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);

      await adapter.delPattern("user:?:data");
      const callArgs = redis.scan.mock.calls[0];
      expect(callArgs[2]).toBe("user:\\?:data");
    });

    it("pattern 中的 [ 被转义为 \\[（A11：不支持 [] 通配符）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);

      await adapter.delPattern("user:[0-9]:data");
      const callArgs = redis.scan.mock.calls[0];
      expect(callArgs[2]).toBe("user:\\[0-9]:data");
    });

    it("* 通配符保持不变（A11：支持 *）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);

      await adapter.delPattern("user:*:*");
      const callArgs = redis.scan.mock.calls[0];
      expect(callArgs[2]).toBe("user:*:*");
    });
  });

  // ────────────────────────────────────────────────────────
  // keys（A08 / A10 / A11）
  // ────────────────────────────────────────────────────────

  describe("keys（A08 / A10 / A11）", () => {
    it("不传 pattern 时使用 * 作为 MATCH 参数", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", ["a", "b", "c"]]);

      const result = await adapter.keys();
      expect(result).toEqual(["a", "b", "c"]);
      expect(redis.scan).toHaveBeenCalledWith("0", "MATCH", "*", "COUNT", 100);
    });

    it("传 pattern 时按 pattern 过滤", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", ["user:1", "user:2"]]);

      const result = await adapter.keys("user:*");
      expect(result).toEqual(["user:1", "user:2"]);
    });

    it("多批次 SCAN 合并全部键", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan
        .mockResolvedValueOnce(["10", ["k1", "k2"]])
        .mockResolvedValueOnce(["0", ["k3"]]);

      const result = await adapter.keys();
      expect(result).toEqual(["k1", "k2", "k3"]);
    });

    it("无匹配时返回空数组", async () => {
      const { adapter, redis } = makeAdapter();
      redis.scan.mockResolvedValue(["0", []]);
      expect(await adapter.keys("nonexistent:*")).toEqual([]);
    });

    it("自定义 scanCount 会传递给 SCAN", async () => {
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any, { scanCount: 7 });

      await adapter.keys("k:*");

      expect(redis.scan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "k:*",
        "COUNT",
        7,
      );
    });

    it("非法 scanCount 抛出 RangeError", () => {
      expect(() =>
        createRedisCacheAdapter(makeMockRedis() as any, { scanCount: 0 }),
      ).toThrow(RangeError);
    });
  });

  describe("getRemainingTtl", () => {
    it("存在过期时间时返回剩余 TTL（毫秒）", async () => {
      const { adapter, redis } = makeAdapter();
      redis.pttl.mockResolvedValue(1234);

      expect(await adapter.getRemainingTtl!("k")).toBe(1234);
      expect(redis.pttl).toHaveBeenCalledWith("k");
    });

    it("永不过期时返回 null", async () => {
      const { adapter, redis } = makeAdapter();
      redis.pttl.mockResolvedValue(-1);

      expect(await adapter.getRemainingTtl!("k")).toBeNull();
    });

    it("键不存在时返回 undefined", async () => {
      const { adapter, redis } = makeAdapter();
      redis.pttl.mockResolvedValue(-2);

      expect(await adapter.getRemainingTtl!("missing")).toBeUndefined();
    });

    it("Redis 返回 0 或负异常 TTL 时按不存在处理", async () => {
      const { adapter, redis } = makeAdapter();
      redis.pttl.mockResolvedValue(0);

      expect(await adapter.getRemainingTtl!("race-key")).toBeUndefined();
    });

    it("非法空 key 时抛出 TypeError", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.getRemainingTtl!("")).rejects.toThrow(TypeError);
    });

    it("批量 TTL 查询空输入快速返回空对象", async () => {
      const { adapter, redis } = makeAdapter();

      expect(await adapter.getRemainingTtlMany!([])).toEqual({});
      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it("批量 TTL 查询仅返回存在且可判定语义的键", async () => {
      const { adapter, redis } = makeAdapter();
      redis._pipeline.exec.mockResolvedValue([
        [null, 3000],
        [null, -1],
        [null, -2],
      ]);

      expect(await adapter.getRemainingTtlMany!(["k1", "k2", "k3"])).toEqual({
        k1: 3000,
        k2: null,
      });
      expect(redis._pipeline.pttl).toHaveBeenCalledWith("k1");
      expect(redis._pipeline.pttl).toHaveBeenCalledWith("k2");
      expect(redis._pipeline.pttl).toHaveBeenCalledWith("k3");
    });

    it("批量 TTL 查询会校验非法 key", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.getRemainingTtlMany!([""])).rejects.toThrow(
        TypeError,
      );
    });
  });

  describe("invalidateByTag", () => {
    it("按 tag 使用 SSCAN 找到 key，并删除存在的 key", async () => {
      const { adapter, redis } = makeAdapter();
      redis.sscan.mockResolvedValue(["0", ["k1", "k2"]]);
      redis.exists.mockResolvedValue(1);
      redis.del.mockResolvedValue(2);

      const count = await adapter.invalidateByTag("user");

      expect(count).toBe(2);
      expect(redis.sscan).toHaveBeenCalledWith(
        expect.stringContaining(":tag:"),
        "0",
        "COUNT",
        100,
      );
      expect(redis.del).toHaveBeenCalledWith("k1", "k2");
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(":tag:"));
    });

    it("invalidateByTag 会清理已过期 key 的反向索引", async () => {
      const { adapter, redis } = makeAdapter();
      redis.sscan.mockResolvedValue(["0", ["stale"]]);
      redis.exists.mockResolvedValue(0);
      redis.smembers.mockResolvedValueOnce(["user", "tenant"]);

      const count = await adapter.invalidateByTag("user");

      expect(count).toBe(0);
      expect(redis._pipeline.srem).toHaveBeenCalledWith(
        expect.stringContaining(":tag:"),
        "stale",
      );
      expect(
        redis._pipeline.srem.mock.calls.some(
          ([tagKey]) => tagKey === redis.sscan.mock.calls[0][0],
        ),
      ).toBe(false);
      expect(redis._pipeline.del).toHaveBeenCalledWith(
        expect.stringContaining(":key-tags:"),
      );
    });

    it("invalidateByTag 支持多批次 SSCAN", async () => {
      const { adapter, redis } = makeAdapter();
      redis.sscan
        .mockResolvedValueOnce(["7", ["k1"]])
        .mockResolvedValueOnce(["0", ["k2"]]);
      redis.exists.mockResolvedValue(1);
      redis.del.mockResolvedValue(1);

      expect(await adapter.invalidateByTag("user")).toBe(2);
      expect(redis.sscan).toHaveBeenCalledTimes(2);
    });

    it("空 tag 抛出 TypeError", async () => {
      const { adapter } = makeAdapter();
      await expect(adapter.invalidateByTag("")).rejects.toThrow(TypeError);
    });

    it("deleteCommand=unlink 时批量删除 tag 命中的 key 使用 UNLINK", async () => {
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any, {
        deleteCommand: "unlink",
      });
      redis.sscan.mockResolvedValue(["0", ["k1"]]);
      redis.exists.mockResolvedValue(1);
      redis.unlink.mockResolvedValue(1);

      expect(await adapter.invalidateByTag("user")).toBe(1);
      expect(redis.unlink).toHaveBeenCalledWith("k1");
    });

    it("内部 _deleteKeys 对空数组快速返回 0", async () => {
      const { adapter, redis } = makeAdapter();

      expect(await (adapter as any)._deleteKeys([])).toBe(0);
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────
  // getStats
  // ────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("返回零值统计（Redis 层不追踪命中率）", () => {
      const { adapter } = makeAdapter();
      const stats = adapter.getStats!();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // close（A17）
  // ────────────────────────────────────────────────────────

  describe("close（A17：生命周期管理）", () => {
    it("传入对象实例时 close() 不调用 redis.quit", async () => {
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any);

      await adapter.close();
      expect(redis.quit).not.toHaveBeenCalled();
    });

    it("传入 URL 字符串时 close() 调用 redis.quit（需 ioredis，跳过集成部分）", () => {
      // 此场景需要真实 ioredis，单元测试中通过行为覆盖上面的 shouldCloseOnDestroy 逻辑
      // 通过检查对象入参路径确认 shouldCloseOnDestroy=false 分支正常工作
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any);

      // 验证 getRedisInstance() 返回传入的 redis 对象
      expect(adapter.getRedisInstance()).toBe(redis);
    });
  });

  // ────────────────────────────────────────────────────────
  // getRedisInstance
  // ────────────────────────────────────────────────────────

  describe("getRedisInstance", () => {
    it("返回底层 ioredis 实例", () => {
      const redis = makeMockRedis();
      const adapter = createRedisCacheAdapter(redis as any);
      expect(adapter.getRedisInstance()).toBe(redis);
    });
  });

  // ────────────────────────────────────────────────────────
  // A12 参数校验覆盖（has / del 路径）
  // ────────────────────────────────────────────────────────

  describe("A12 参数校验", () => {
    it.each([
      ["get", (a: RedisCacheAdapter) => a.get(null as any)],
      ["set", (a: RedisCacheAdapter) => a.set(null as any, "v")],
      ["del", (a: RedisCacheAdapter) => a.del(null as any)],
      ["exists", (a: RedisCacheAdapter) => a.exists(null as any)],
      ["has", (a: RedisCacheAdapter) => a.has(null as any)],
    ])("%s(null) 抛出 TypeError", async (_, fn) => {
      const { adapter } = makeAdapter();
      await expect(fn(adapter)).rejects.toThrow(TypeError);
    });

    it.each([
      ["get", (a: RedisCacheAdapter) => a.get("")],
      ["set", (a: RedisCacheAdapter) => a.set("", "v")],
      ["del", (a: RedisCacheAdapter) => a.del("")],
      ["exists", (a: RedisCacheAdapter) => a.exists("")],
      ["has", (a: RedisCacheAdapter) => a.has("")],
    ])('%s("") 抛出 TypeError', async (_, fn) => {
      const { adapter } = makeAdapter();
      await expect(fn(adapter)).rejects.toThrow(TypeError);
    });
  });

  // ────────────────────────────────────────────────────────
  // 端到端场景（使用 mock redis）
  // ────────────────────────────────────────────────────────

  describe("端到端场景", () => {
    it("set → get → del 完整流程", async () => {
      const { adapter, redis } = makeAdapter();
      const data = { id: 1, roles: ["admin"] };

      // set
      await adapter.set("user:1", data, 60000);
      expect(redis.set).toHaveBeenCalledWith(
        "user:1",
        JSON.stringify(data),
        "PX",
        60000,
      );

      // get（模拟 redis 返回序列化数据）
      redis.get.mockResolvedValue(JSON.stringify(data));
      const result = await adapter.get("user:1");
      expect(result).toEqual(data);

      // del
      redis.del.mockResolvedValue(1);
      expect(await adapter.del("user:1")).toBe(true);

      // 再次 get 返回 undefined
      redis.get.mockResolvedValue(null);
      expect(await adapter.get("user:1")).toBeUndefined();
    });

    // ────────────────────────────────────────────────────────────────────────────
    // URL 字符串构造路径（loadIoredis + 自建连接）
    // 覆盖：loadIoredis() 函数体、constructor if (shouldCloseOnDestroy) 块、close() quit 路径
    // ────────────────────────────────────────────────────────────────────────────

    describe("RedisCacheAdapter — URL 字符串构造路径（vi.mock module）", () => {
      afterEach(() => {
        _failIoredisLoad = false;
        _useDefaultExport = false;
      });

      it("传入 URL 字符串时 loadIoredis 成功加载并创建假 Redis 实例", () => {
        // 覆盖 loadIoredis() try 块（lines 33-34）+ constructor if 块（lines 66-71）
        const adapter = createRedisCacheAdapter("redis://localhost:6379");
        expect(adapter).toBeDefined();
        expect(adapter.getRedisInstance()).toBeDefined();
      });

      it("传入 URL 字符串时 close() 调用 redis.quit()（shouldCloseOnDestroy=true，lines 286-287）", async () => {
        const adapter = createRedisCacheAdapter("redis://localhost:6379");
        const instance = adapter.getRedisInstance() as any;

        await adapter.close();

        // shouldCloseOnDestroy=true → close() 内执行了 this._redis.quit()
        expect(instance.quit).toHaveBeenCalledOnce();
      });

      it("ioredis 未安装时 loadIoredis 抛出描述性错误（lines 35-39）", () => {
        _failIoredisLoad = true;
        expect(() => createRedisCacheAdapter("redis://localhost:6379")).toThrow(
          "redis-adapter 需要安装 ioredis",
        );
      });

      it("ioredis 模块提供 .default 导出时使用 .default（ESM 兼容，line 70 左分支）", () => {
        // _useDefaultExport=true → 工厂返回 { default: FakeRedisClass }
        // 覆盖 `ioredis.default ?? ioredis` 中 ioredis.default 非 undefined 的分支
        _useDefaultExport = true;
        const adapter = createRedisCacheAdapter("redis://localhost:6379");
        expect(adapter).toBeDefined();
        expect(adapter.getRedisInstance()).toBeDefined();
      });

      it("传入 URL 字符串的适配器支持完整 CRUD 操作", async () => {
        const adapter = createRedisCacheAdapter("redis://localhost:6379");
        const instance = adapter.getRedisInstance() as any;

        instance.get.mockResolvedValue(JSON.stringify({ id: 42 }));
        const val = await adapter.get("test-key");
        expect(val).toEqual({ id: 42 });

        await adapter.set("test-key", { id: 99 }, 5000);
        expect(instance.set).toHaveBeenCalledWith(
          "test-key",
          JSON.stringify({ id: 99 }),
          "PX",
          5000,
        );
      });
    });

    it("delPattern 分批 SCAN 正确累计删除数量", async () => {
      const { adapter, redis } = makeAdapter();

      // 模拟三批 SCAN
      redis.scan
        .mockResolvedValueOnce(["cursor1", ["session:a", "session:b"]])
        .mockResolvedValueOnce([
          "cursor2",
          ["session:c", "session:d", "session:e"],
        ])
        .mockResolvedValueOnce(["0", ["session:f"]]);

      const count = await adapter.delPattern("session:*");
      expect(count).toBe(6);
      expect(redis.scan).toHaveBeenCalledTimes(3);
      // pipeline 应被调用 3 次（每批一次）
      expect(redis.pipeline).toHaveBeenCalledTimes(3);
    });

    it("setMany → getMany 批量读写（含 TTL）", async () => {
      const { adapter, redis } = makeAdapter();
      const entries = {
        "product:1": { name: "A" },
        "product:2": { name: "B" },
      };

      await adapter.setMany(entries, 30000);
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        "product:1",
        JSON.stringify({ name: "A" }),
        "PX",
        30000,
      );
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        "product:2",
        JSON.stringify({ name: "B" }),
        "PX",
        30000,
      );

      redis.mget.mockResolvedValue([
        JSON.stringify({ name: "A" }),
        JSON.stringify({ name: "B" }),
      ]);
      const result = await adapter.getMany(["product:1", "product:2"]);
      expect(result).toEqual(entries);
    });
  });
});
