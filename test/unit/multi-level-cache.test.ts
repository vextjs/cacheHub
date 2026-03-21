import { describe, it, expect, vi, beforeEach } from "vitest";
import { MultiLevelCache } from "../../src/multi-level-cache.js";
import { MemoryCache } from "../../src/memory-cache.js";
import type { CacheLike } from "../../src/types.js";

// ── 辅助工厂 ──

function makeLocal(
  opts?: ConstructorParameters<typeof MemoryCache>[0],
): MemoryCache {
  return new MemoryCache({ maxEntries: 100, enableStats: true, ...opts });
}

/** 创建一个可完全控制的 mock CacheLike 远端 */
function makeRemote(): CacheLike & {
  store: Record<string, any>;
  delay: number;
} {
  const store: Record<string, any> = {};
  let delay = 0;

  const wait = () =>
    delay > 0
      ? new Promise<void>((r) => setTimeout(r, delay))
      : Promise.resolve();

  return {
    store,
    get delay() {
      return delay;
    },
    set delay(v: number) {
      delay = v;
    },

    async get(key: string) {
      await wait();
      return store[key];
    },
    async set(key: string, value: any) {
      await wait();
      store[key] = value;
    },
    async del(key: string) {
      await wait();
      const existed = key in store;
      delete store[key];
      return existed;
    },
    async exists(key: string) {
      await wait();
      return key in store;
    },
    async has(key: string) {
      await wait();
      return key in store;
    },
    async clear() {
      await wait();
      for (const k of Object.keys(store)) {
        delete store[k];
      }
    },
    async getMany(keys: string[]) {
      await wait();
      const result: Record<string, any> = {};
      for (const k of keys) {
        if (k in store) result[k] = store[k];
      }
      return result;
    },
    async setMany(entries: Record<string, any>) {
      await wait();
      Object.assign(store, entries);
      return true;
    },
    async delMany(keys: string[]) {
      await wait();
      let count = 0;
      for (const k of keys) {
        if (k in store) {
          delete store[k];
          count++;
        }
      }
      return count;
    },
    async delPattern(pattern: string) {
      await wait();
      const escaped = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");
      const regex = new RegExp("^" + escaped + "$");
      let count = 0;
      for (const k of Object.keys(store)) {
        if (regex.test(k)) {
          delete store[k];
          count++;
        }
      }
      return count;
    },
    async keys(pattern?: string) {
      await wait();
      if (!pattern) return Object.keys(store);
      const escaped = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");
      const regex = new RegExp("^" + escaped + "$");
      return Object.keys(store).filter((k) => regex.test(k));
    },
  };
}

function makeCache(
  overrides?: Partial<ConstructorParameters<typeof MultiLevelCache>[0]>,
): {
  mlc: MultiLevelCache;
  local: MemoryCache;
  remote: ReturnType<typeof makeRemote>;
} {
  const local = makeLocal();
  const remote = makeRemote();
  const mlc = new MultiLevelCache({ local, remote, ...overrides });
  return { mlc, local, remote };
}

// ── 测试套件 ──

describe("MultiLevelCache", () => {
  // ────────────────────────────────────────────────────────
  // 构造选项与默认值
  // ────────────────────────────────────────────────────────

  describe("构造选项与默认值", () => {
    it("默认 writePolicy 为 both", async () => {
      const { mlc, local, remote } = makeCache();
      await mlc.set("k", "v");
      expect(local.get("k")).toBe("v");
      expect(remote.store["k"]).toBe("v");
    });

    it("默认 backfillOnRemoteHit 为 true", async () => {
      const { mlc, local, remote } = makeCache();
      remote.store["k"] = "from-remote";
      await mlc.get("k");
      expect(local.get("k")).toBe("from-remote");
    });

    it("默认 remoteTimeoutMs 为 50（不崩溃）", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      const mlc = new MultiLevelCache({ local, remote });
      remote.delay = 10; // 在 50ms 阈值内
      remote.store["k"] = "v";
      const result = await mlc.get("k");
      expect(result).toBe("v");
    });

    it("无 remote 时只操作 L1", async () => {
      const local = makeLocal();
      const mlc = new MultiLevelCache({ local });
      await mlc.set("k", "v");
      expect(local.get("k")).toBe("v");
    });
  });

  // ────────────────────────────────────────────────────────
  // get：L1 优先策略
  // ────────────────────────────────────────────────────────

  describe("get：L1 优先策略", () => {
    it("L1 命中：直接返回，不查 L2", async () => {
      const { mlc, local, remote } = makeCache();
      local.set("k", "l1-value");
      remote.store["k"] = "l2-value";

      const getSpy = vi.spyOn(remote, "get");
      const result = await mlc.get("k");

      expect(result).toBe("l1-value");
      expect(getSpy).not.toHaveBeenCalled();
    });

    it("L1 miss + L2 命中：返回 L2 值", async () => {
      const { mlc, remote } = makeCache();
      remote.store["k"] = "l2-value";
      const result = await mlc.get("k");
      expect(result).toBe("l2-value");
    });

    it("L1 miss + L2 miss：返回 undefined", async () => {
      const { mlc } = makeCache();
      const result = await mlc.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("无 remote 时 L1 miss 返回 undefined", async () => {
      const local = makeLocal();
      const mlc = new MultiLevelCache({ local });
      expect(await mlc.get("k")).toBeUndefined();
    });

    it("null 是有效缓存值（L1 命中）", async () => {
      const { mlc, local } = makeCache();
      local.set("k", null);
      expect(await mlc.get("k")).toBeNull();
    });

    it("null 是有效缓存值（L2 命中）", async () => {
      const { mlc, remote } = makeCache();
      remote.store["k"] = null;
      expect(await mlc.get("k")).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────
  // get：回填 L1（backfillOnRemoteHit）
  // ────────────────────────────────────────────────────────

  describe("get：回填 L1", () => {
    it("L2 命中时回填 L1（默认 backfillOnRemoteHit=true）", async () => {
      const { mlc, local, remote } = makeCache();
      remote.store["k"] = "v";

      await mlc.get("k");
      expect(local.get("k")).toBe("v");
    });

    it("backfillOnRemoteHit=false 时不回填 L1", async () => {
      const { mlc, local, remote } = makeCache({ backfillOnRemoteHit: false });
      remote.store["k"] = "v";

      await mlc.get("k");
      expect(local.get("k")).toBeUndefined();
    });

    it("回填 L1 失败时仍然返回 L2 的值（容错）", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      // 让 local.set 抛出异常
      vi.spyOn(local, "set").mockImplementation(() => {
        throw new Error("set failed");
      });
      const mlc = new MultiLevelCache({ local, remote });
      remote.store["k"] = "v";

      const result = await mlc.get("k");
      expect(result).toBe("v");
    });
  });

  // ────────────────────────────────────────────────────────
  // get：远端超时降级（remoteTimeoutMs）
  // ────────────────────────────────────────────────────────

  describe("get：远端超时降级", () => {
    it("L2 超时时降级为 miss，返回 undefined", async () => {
      const { mlc, remote } = makeCache({ remoteTimeoutMs: 20 });
      remote.store["k"] = "v";
      remote.delay = 100; // 超过 20ms 阈值

      const result = await mlc.get("k");
      expect(result).toBeUndefined();
    }, 500);

    it("L2 在阈值内响应时正常返回", async () => {
      const { mlc, remote } = makeCache({ remoteTimeoutMs: 200 });
      remote.store["k"] = "v";
      remote.delay = 10;

      const result = await mlc.get("k");
      expect(result).toBe("v");
    }, 500);

    it("L2 抛出异常时也降级为 miss", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "get").mockRejectedValue(new Error("redis down"));
      const mlc = new MultiLevelCache({ local, remote });

      expect(await mlc.get("k")).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────
  // set：writePolicy
  // ────────────────────────────────────────────────────────

  describe("set：writePolicy", () => {
    it("'both'：同步双写 L1 + L2", async () => {
      const { mlc, local, remote } = makeCache({ writePolicy: "both" });
      await mlc.set("k", "v");
      expect(local.get("k")).toBe("v");
      expect(remote.store["k"]).toBe("v");
    });

    it("'both'：L2.set() 失败时向调用方透传异常（A06）", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "set").mockRejectedValue(new Error("L2 set failed"));
      const mlc = new MultiLevelCache({ local, remote, writePolicy: "both" });

      await expect(mlc.set("k", "v")).rejects.toThrow("L2 set failed");
    });

    it("'local-first-async-remote'：先写 L1，L2 异步写入", async () => {
      const { mlc, local, remote } = makeCache({
        writePolicy: "local-first-async-remote",
      });
      await mlc.set("k", "v");
      // L1 立即可读
      expect(local.get("k")).toBe("v");
      // 等待 L2 异步写入
      await new Promise((r) => setTimeout(r, 20));
      expect(remote.store["k"]).toBe("v");
    });

    it("'local-first-async-remote'：L2 写入失败时不影响调用方", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "set").mockRejectedValue(
        new Error("L2 fire-and-forget fail"),
      );
      const mlc = new MultiLevelCache({
        local,
        remote,
        writePolicy: "local-first-async-remote",
      });

      // 不应抛出
      await expect(mlc.set("k", "v")).resolves.toBeUndefined();
      expect(local.get("k")).toBe("v");
    });

    it("无 remote 时 set 仅写 L1", async () => {
      const local = makeLocal();
      const mlc = new MultiLevelCache({ local });
      await mlc.set("k", "v");
      expect(local.get("k")).toBe("v");
    });

    it("set 传递 TTL", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      const setRemoteSpy = vi.spyOn(remote, "set");
      const setLocalSpy = vi.spyOn(local, "set");
      const mlc = new MultiLevelCache({ local, remote });

      await mlc.set("k", "v", 5000);
      expect(setLocalSpy).toHaveBeenCalledWith("k", "v", 5000);
      expect(setRemoteSpy).toHaveBeenCalledWith("k", "v", 5000);
    });
  });

  // ────────────────────────────────────────────────────────
  // del（A05）
  // ────────────────────────────────────────────────────────

  describe("del（A05）", () => {
    it("存在的键：删除 L1 和 L2，返回 true", async () => {
      const { mlc, local, remote } = makeCache();
      local.set("k", "v");
      remote.store["k"] = "v";

      const result = await mlc.del("k");
      expect(result).toBe(true);
      expect(local.get("k")).toBeUndefined();
      expect(remote.store["k"]).toBeUndefined();
    });

    it("不存在的键：返回 false", async () => {
      const { mlc } = makeCache();
      expect(await mlc.del("nonexistent")).toBe(false);
    });

    it("L2 del 失败时仍返回 L1 的结果（A05）", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "del").mockRejectedValue(new Error("L2 del failed"));
      const mlc = new MultiLevelCache({ local, remote });
      local.set("k", "v");

      // L2 失败不影响结果
      const result = await mlc.del("k");
      expect(result).toBe(true);
      // L1 已删除
      expect(local.get("k")).toBeUndefined();
    });

    it("L1 先删，L2 后删（即使 L2 失败也不跳过 L1 删除）", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      const delOrder: string[] = [];

      vi.spyOn(local, "del").mockImplementation((k) => {
        delOrder.push("L1");
        return true;
      });
      vi.spyOn(remote, "del").mockImplementation(async () => {
        delOrder.push("L2");
        throw new Error("L2 fail");
      });

      const mlc = new MultiLevelCache({ local, remote });
      await mlc.del("k");

      expect(delOrder).toEqual(["L1", "L2"]);
    });
  });

  // ────────────────────────────────────────────────────────
  // exists / has
  // ────────────────────────────────────────────────────────

  describe("exists / has", () => {
    it("L1 存在时直接返回 true，不查 L2", async () => {
      const { mlc, local, remote } = makeCache();
      local.set("k", "v");
      const existsSpy = vi.spyOn(remote, "exists");

      expect(await mlc.exists("k")).toBe(true);
      expect(existsSpy).not.toHaveBeenCalled();
    });

    it("L1 不存在 + L2 存在时返回 true", async () => {
      const { mlc, remote } = makeCache();
      remote.store["k"] = "v";
      expect(await mlc.exists("k")).toBe(true);
    });

    it("L1 和 L2 均不存在时返回 false", async () => {
      const { mlc } = makeCache();
      expect(await mlc.exists("nonexistent")).toBe(false);
    });

    it("L2 超时时降级为 false", async () => {
      const { mlc, remote } = makeCache({ remoteTimeoutMs: 20 });
      remote.store["k"] = "v";
      remote.delay = 100;
      expect(await mlc.exists("k")).toBe(false);
    }, 500);

    it("has 是 exists 的别名", async () => {
      const { mlc, local } = makeCache();
      local.set("k", "v");
      expect(await mlc.has("k")).toBe(true);
      expect(await mlc.has("nonexistent")).toBe(false);
    });

    it("无远端时 L1 miss 直接返回 false", async () => {
      const local = makeLocal();
      const mlc = new MultiLevelCache({ local });
      expect(await mlc.exists("no-such-key")).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────
  // clear（A07）
  // ────────────────────────────────────────────────────────

  describe("clear（A07：仅清 L1）", () => {
    it("clear() 清空 L1，不清 L2", async () => {
      const { mlc, local, remote } = makeCache();
      local.set("k1", "v1");
      local.set("k2", "v2");
      remote.store["k1"] = "r1";
      remote.store["k2"] = "r2";

      await mlc.clear();

      expect(local.get("k1")).toBeUndefined();
      expect(local.get("k2")).toBeUndefined();
      // L2 数据应保持不变
      expect(remote.store["k1"]).toBe("r1");
      expect(remote.store["k2"]).toBe("r2");
    });

    it("remote.clear 从未被调用（A07）", async () => {
      const { mlc, remote } = makeCache();
      const clearSpy = vi.spyOn(remote, "clear");
      await mlc.clear();
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────
  // 批量操作（A16：空输入默认值）
  // ────────────────────────────────────────────────────────

  describe("批量操作（A16）", () => {
    describe("getMany", () => {
      it("空数组快速返回 {}", async () => {
        const { mlc } = makeCache();
        expect(await mlc.getMany([])).toEqual({});
      });

      it("全命中 L1", async () => {
        const { mlc, local } = makeCache();
        local.set("k1", "v1");
        local.set("k2", "v2");
        const result = await mlc.getMany(["k1", "k2"]);
        expect(result).toEqual({ k1: "v1", k2: "v2" });
      });

      it("部分 L1 miss + L2 补充", async () => {
        const { mlc, local, remote } = makeCache();
        local.set("k1", "l1");
        remote.store["k2"] = "l2";

        const result = await mlc.getMany(["k1", "k2"]);
        expect(result).toEqual({ k1: "l1", k2: "l2" });
      });

      it("L2 命中后回填 L1", async () => {
        const { mlc, local, remote } = makeCache();
        remote.store["k2"] = "l2";

        await mlc.getMany(["k1", "k2"]);
        expect(local.get("k2")).toBe("l2");
      });

      it("L2 超时时仅返回 L1 结果", async () => {
        const { mlc, local, remote } = makeCache({ remoteTimeoutMs: 20 });
        local.set("k1", "v1");
        remote.store["k2"] = "v2";
        remote.delay = 100;

        const result = await mlc.getMany(["k1", "k2"]);
        expect(result).toEqual({ k1: "v1" });
      }, 500);

      it("L2 命中回填 L1 时 setMany 失败静默忽略，仍返回结果", async () => {
        const local = makeLocal();
        const remote = makeRemote();
        remote.store["k1"] = "v1";
        vi.spyOn(local, "setMany").mockRejectedValue(new Error("setMany fail"));
        const mlc = new MultiLevelCache({ local, remote });

        const result = await mlc.getMany(["k1"]);
        expect(result).toEqual({ k1: "v1" });
      });
    });

    describe("setMany", () => {
      it("空对象快速返回 true", async () => {
        const { mlc } = makeCache();
        expect(await mlc.setMany({})).toBe(true);
      });

      it("'both' 策略同步双写", async () => {
        const { mlc, local, remote } = makeCache({ writePolicy: "both" });
        await mlc.setMany({ k1: "v1", k2: "v2" });
        expect(local.get("k1")).toBe("v1");
        expect(remote.store["k1"]).toBe("v1");
      });

      it("'local-first-async-remote' 策略异步写 L2", async () => {
        const { mlc, local, remote } = makeCache({
          writePolicy: "local-first-async-remote",
        });
        await mlc.setMany({ k1: "v1" });
        expect(local.get("k1")).toBe("v1");
        await new Promise((r) => setTimeout(r, 20));
        expect(remote.store["k1"]).toBe("v1");
      });

      it("返回值始终为 true", async () => {
        const { mlc } = makeCache();
        expect(await mlc.setMany({ k: "v" })).toBe(true);
      });

      it("'both' 策略，无远端时仅写 L1", async () => {
        const local = makeLocal();
        const mlc = new MultiLevelCache({ local, writePolicy: "both" });
        await mlc.setMany({ k1: "v1", k2: "v2" });
        expect(local.get("k1")).toBe("v1");
        expect(local.get("k2")).toBe("v2");
      });
    });

    describe("delMany", () => {
      it("空数组快速返回 0", async () => {
        const { mlc } = makeCache();
        expect(await mlc.delMany([])).toBe(0);
      });

      it("删除多个键，返回 L1 删除计数", async () => {
        const { mlc, local, remote } = makeCache();
        local.set("k1", "v1");
        local.set("k2", "v2");
        remote.store["k1"] = "r1";
        remote.store["k2"] = "r2";

        const count = await mlc.delMany(["k1", "k2", "k3"]);
        // k3 不存在，L1 返回 2
        expect(count).toBe(2);
        expect(local.get("k1")).toBeUndefined();
        expect(remote.store["k1"]).toBeUndefined();
      });

      it("L2 失败时仍返回 L1 的计数", async () => {
        const local = makeLocal();
        const remote = makeRemote();
        vi.spyOn(remote, "delMany").mockRejectedValue(new Error("L2 fail"));
        const mlc = new MultiLevelCache({ local, remote });
        local.set("k", "v");

        const count = await mlc.delMany(["k"]);
        expect(count).toBe(1);
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // delPattern
  // ────────────────────────────────────────────────────────

  describe("delPattern", () => {
    it("删除匹配 pattern 的键，返回 L1 计数", async () => {
      const { mlc, local, remote } = makeCache();
      local.set("user:1", "u1");
      local.set("user:2", "u2");
      local.set("order:1", "o1");
      remote.store["user:1"] = "r1";
      remote.store["user:2"] = "r2";

      const count = await mlc.delPattern("user:*");
      expect(count).toBe(2);
      expect(local.get("user:1")).toBeUndefined();
      expect(local.get("user:2")).toBeUndefined();
      expect(local.get("order:1")).toBe("o1");
      // L2 也被删除
      expect(remote.store["user:1"]).toBeUndefined();
    });

    it("L2 delPattern 失败时静默忽略，返回 L1 计数", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "delPattern").mockRejectedValue(new Error("L2 fail"));
      const mlc = new MultiLevelCache({ local, remote });
      local.set("user:1", "v");

      const count = await mlc.delPattern("user:*");
      expect(count).toBe(1);
    });

    it("publish 回调在 delPattern 时触发", async () => {
      const publishFn = vi.fn();
      const { mlc } = makeCache({ publish: publishFn });
      await mlc.delPattern("user:*");

      expect(publishFn).toHaveBeenCalledOnce();
      const msg = publishFn.mock.calls[0][0];
      expect(msg.type).toBe("delPattern");
      expect(msg.pattern).toBe("user:*");
      expect(typeof msg.ts).toBe("number");
    });

    it("无 publish 时 delPattern 正常工作（不报错）", async () => {
      const { mlc } = makeCache(); // publish 未设置
      await expect(mlc.delPattern("user:*")).resolves.toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────
  // keys（仅 L1）
  // ────────────────────────────────────────────────────────

  describe("keys（仅 L1 本地键）", () => {
    it("不传 pattern 时返回全部 L1 键", async () => {
      const { mlc, local } = makeCache();
      local.set("a", 1);
      local.set("b", 2);
      const keys = await mlc.keys();
      expect(keys.sort()).toEqual(["a", "b"]);
    });

    it("remote 键不出现在结果中", async () => {
      const { mlc, remote } = makeCache();
      remote.store["remote-only"] = "v";
      const keys = await mlc.keys();
      expect(keys).not.toContain("remote-only");
    });

    it("传 pattern 时筛选 L1 键", async () => {
      const { mlc, local } = makeCache();
      local.set("user:1", "u1");
      local.set("user:2", "u2");
      local.set("order:1", "o1");
      const keys = await mlc.keys("user:*");
      expect(keys.sort()).toEqual(["user:1", "user:2"]);
    });
  });

  // ────────────────────────────────────────────────────────
  // getStats（委托 L1）
  // ────────────────────────────────────────────────────────

  describe("getStats（委托 L1）", () => {
    it("返回 L1 的统计数据", async () => {
      const { mlc, local } = makeCache();
      local.set("k", "v");
      local.get("k"); // hit

      const stats = mlc.getStats();
      expect(stats.hits).toBeGreaterThanOrEqual(1);
    });

    it("L1 不支持 getStats 时返回零值", async () => {
      const local = makeLocal({ enableStats: false });
      // 覆盖 getStats 为 undefined，模拟不支持场景
      const mockLocal = Object.assign(local, { getStats: undefined });
      const mlc = new MultiLevelCache({ local: mockLocal });

      const stats = mlc.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it("resetStats 委托 L1", () => {
      const { mlc, local } = makeCache();
      local.set("k", "v");
      local.get("k");
      mlc.resetStats();
      expect(mlc.getStats().hits).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // invalidateByTag
  // ────────────────────────────────────────────────────────

  describe("invalidateByTag", () => {
    it("委托 L1 的 invalidateByTag", () => {
      const local = makeLocal({ enableTags: true });
      const mlc = new MultiLevelCache({ local });
      local.set("k", "v", undefined, { tags: ["user"] } as any);

      mlc.invalidateByTag("user");
      expect(local.get("k")).toBeUndefined();
    });

    it("L1 不支持 invalidateByTag 时不抛异常", () => {
      const local = makeLocal();
      const mockLocal = Object.assign(local, { invalidateByTag: undefined });
      const mlc = new MultiLevelCache({ local: mockLocal });
      expect(() => mlc.invalidateByTag("tag")).not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // destroy
  // ────────────────────────────────────────────────────────

  describe("destroy", () => {
    it("调用 L1.destroy()（定时器清理）", () => {
      const local = makeLocal({ cleanupInterval: 1000 });
      const mlc = new MultiLevelCache({ local });
      const destroySpy = vi.spyOn(local, "destroy");
      mlc.destroy();
      expect(destroySpy).toHaveBeenCalledOnce();
    });

    it("不调用 remote 的 destroy（remote 生命周期由调用方管理）", () => {
      const local = makeLocal();
      const remote = makeRemote();
      // 给 remote 添加 destroy spy
      const destroyFn = vi.fn();
      (remote as any).destroy = destroyFn;
      const mlc = new MultiLevelCache({ local, remote });
      mlc.destroy();
      expect(destroyFn).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────
  // 端到端场景：典型使用流程
  // ────────────────────────────────────────────────────────

  describe("端到端场景", () => {
    it("L2 预热数据，第一次 get 从 L2 取并回填，第二次从 L1 取", async () => {
      const { mlc, local, remote } = makeCache();
      remote.store["user:42"] = { id: 42, name: "Alice" };

      // 第一次：L1 miss → L2 hit → 回填 L1
      const first = await mlc.get("user:42");
      expect(first).toEqual({ id: 42, name: "Alice" });
      expect(local.get("user:42")).toEqual({ id: 42, name: "Alice" });

      // 第二次：L1 hit（不查 L2）
      const getSpy = vi.spyOn(remote, "get");
      const second = await mlc.get("user:42");
      expect(second).toEqual({ id: 42, name: "Alice" });
      expect(getSpy).not.toHaveBeenCalled();
    });

    it("L2 降级场景：L2 不可用时仍可用 L1 数据", async () => {
      const local = makeLocal();
      const remote = makeRemote();
      vi.spyOn(remote, "get").mockRejectedValue(
        new Error("Connection refused"),
      );
      vi.spyOn(remote, "set").mockRejectedValue(
        new Error("Connection refused"),
      );
      const mlc = new MultiLevelCache({
        local,
        remote,
        writePolicy: "local-first-async-remote",
      });

      // 先写 L1
      await mlc.set("k", "v");
      expect(local.get("k")).toBe("v");

      // L2 down 时 get 仍能从 L1 读
      const result = await mlc.get("k");
      expect(result).toBe("v");
    });

    it("分布式失效：delPattern 触发 publish", async () => {
      const events: any[] = [];
      const { mlc, local } = makeCache({
        publish: (msg) => events.push(msg),
      });

      local.set("session:abc", "data");
      local.set("session:xyz", "data");

      await mlc.delPattern("session:*");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "delPattern",
        pattern: "session:*",
      });
    });
  });
});
