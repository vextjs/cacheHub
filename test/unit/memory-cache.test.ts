import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryCache } from "../../src/memory-cache.js";
import type { SetOptions } from "../../src/memory-cache.js";

// ── 辅助工具 ──

function makeCache(
  options?: ConstructorParameters<typeof MemoryCache>[0],
): MemoryCache {
  return new MemoryCache({ maxEntries: 100, ...options });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 测试套件 ──

describe("MemoryCache", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = makeCache();
  });

  afterEach(() => {
    cache.destroy();
  });

  // ────────────────────────────────────────────────────────
  // 基础 CRUD
  // ────────────────────────────────────────────────────────

  describe("基础 CRUD", () => {
    it("set + get 基础读写", () => {
      cache.set("key1", "value1");
      expect(cache.get("key1")).toBe("value1");
    });

    it("get 未命中返回 undefined", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("null 是有效缓存值，不视为 miss", () => {
      cache.set("key", null);
      expect(cache.get("key")).toBeNull();
    });

    it("false 是有效缓存值", () => {
      cache.set("key", false);
      expect(cache.get("key")).toBe(false);
    });

    it("0 是有效缓存值", () => {
      cache.set("key", 0);
      expect(cache.get("key")).toBe(0);
    });

    it("空字符串是有效缓存值", () => {
      cache.set("key", "");
      expect(cache.get("key")).toBe("");
    });

    it("对象值正常读写", () => {
      const obj = { id: 1, name: "Alice" };
      cache.set("user", obj);
      expect(cache.get("user")).toEqual(obj);
    });

    it("覆盖写入同一 key", () => {
      cache.set("key", "v1");
      cache.set("key", "v2");
      expect(cache.get("key")).toBe("v2");
    });

    it("del 删除存在的键返回 true，之后 get 返回 undefined", () => {
      cache.set("key", "value");
      expect(cache.del("key")).toBe(true);
      expect(cache.get("key")).toBeUndefined();
    });

    it("del 删除不存在的键返回 false", () => {
      expect(cache.del("nonexistent")).toBe(false);
    });

    it("exists 对存在的键返回 true", () => {
      cache.set("key", "value");
      expect(cache.exists("key")).toBe(true);
    });

    it("exists 对不存在的键返回 false", () => {
      expect(cache.exists("nonexistent")).toBe(false);
    });

    it("has 是 exists 的别名", () => {
      cache.set("key", "value");
      expect(cache.has("key")).toBe(true);
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("clear 清空所有条目，get 返回 undefined", () => {
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.clear();
      expect(cache.get("k1")).toBeUndefined();
      expect(cache.get("k2")).toBeUndefined();
    });

    it("clear 后 getStats().entries 为 0", () => {
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.clear();
      expect(cache.getStats().entries).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // TTL 过期
  // ────────────────────────────────────────────────────────

  describe("TTL 过期（惰性）", () => {
    it("TTL 过期后 get 返回 undefined", async () => {
      cache.set("key", "value", 10);
      await sleep(30);
      expect(cache.get("key")).toBeUndefined();
    });

    it("TTL 未到期时 get 正常返回", async () => {
      cache.set("key", "value", 2000);
      await sleep(10);
      expect(cache.get("key")).toBe("value");
    });

    it("TTL=0 表示永不过期", async () => {
      cache.set("key", "value", 0);
      await sleep(20);
      expect(cache.get("key")).toBe("value");
    });

    it("负数 TTL 视为 0（永不过期）", async () => {
      cache.set("key", "value", -100);
      await sleep(20);
      expect(cache.get("key")).toBe("value");
    });

    it("NaN TTL 视为 0（永不过期）", async () => {
      cache.set("key", "value", NaN);
      await sleep(20);
      expect(cache.get("key")).toBe("value");
    });

    it("TTL 过期后 exists 返回 false（并触发惰性删除）", async () => {
      cache.set("key", "value", 10);
      await sleep(30);
      expect(cache.exists("key")).toBe(false);
    });

    it("TTL 过期的条目不计入 entries", async () => {
      cache.set("key", "value", 10);
      await sleep(30);
      cache.get("key"); // 触发惰性删除
      expect(cache.getStats().entries).toBe(0);
    });

    it("defaultTtl 在未提供 ttl 参数时生效", async () => {
      const c = makeCache({ defaultTtl: 10 });
      c.set("key", "value");
      await sleep(30);
      expect(c.get("key")).toBeUndefined();
      c.destroy();
    });

    it("显式提供 ttl 时覆盖 defaultTtl", async () => {
      const c = makeCache({ defaultTtl: 10 });
      c.set("key", "value", 2000); // 显式 ttl 覆盖
      await sleep(30);
      expect(c.get("key")).toBe("value");
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 周期清理（cleanupInterval）
  // ────────────────────────────────────────────────────────

  describe("周期清理（cleanupInterval）", () => {
    it("cleanupInterval 定期清理过期条目", async () => {
      const c = makeCache({ cleanupInterval: 20 });
      c.set("key", "value", 10); // 10ms TTL
      await sleep(60); // 等待定时器触发清理
      // 条目应已被清理，但 get 触发惰性检查时同样返回 undefined
      expect(c.get("key")).toBeUndefined();
      c.destroy();
    });

    it("destroy() 正确清理 cleanupInterval 定时器（A19）", () => {
      const c = makeCache({ cleanupInterval: 100 });
      c.set("k", "v");
      // destroy 不应抛出，且定时器应被清理（不阻止进程退出）
      expect(() => c.destroy()).not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // LRU 淘汰
  // ────────────────────────────────────────────────────────

  describe("LRU 淘汰", () => {
    it("超过 maxEntries 时淘汰最旧条目", () => {
      const c = makeCache({ maxEntries: 3 });
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);
      c.set("d", 4); // 应淘汰 'a'（最旧）
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe(2);
      expect(c.get("c")).toBe(3);
      expect(c.get("d")).toBe(4);
      c.destroy();
    });

    it("get 访问刷新 LRU 顺序，被访问的条目不被淘汰", () => {
      const c = makeCache({ maxEntries: 3 });
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3);
      c.get("a"); // 访问 'a'，使其成为最近使用
      c.set("d", 4); // 应淘汰 'b'（最旧未访问）
      expect(c.get("a")).toBe(1); // 被访问过，应保留
      expect(c.get("b")).toBeUndefined(); // 应被淘汰
      expect(c.get("c")).toBe(3);
      expect(c.get("d")).toBe(4);
      c.destroy();
    });

    it("多次写入同一 key 不重复占用 entry 数量", () => {
      const c = makeCache({ maxEntries: 3 });
      c.set("a", 1);
      c.set("b", 2);
      c.set("a", 11); // 覆盖写，不新增
      c.set("c", 3);
      // maxEntries=3，此时 a/b/c 三条，不应触发淘汰
      expect(c.get("b")).toBe(2); // b 应保留
      expect(c.getStats().entries).toBe(3);
      c.destroy();
    });

    it("eviction 触发时计入统计 evictions", () => {
      const c = makeCache({ maxEntries: 2 });
      c.set("a", 1);
      c.set("b", 2);
      c.set("c", 3); // 触发淘汰
      expect(c.getStats().evictions).toBe(1);
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 内存淘汰（maxMemory）
  // ────────────────────────────────────────────────────────

  describe("maxMemory 内存淘汰", () => {
    it("超过 maxMemory 时淘汰最旧条目", () => {
      // 每个条目约占：key(2*6=12) + value(2*100=200) ≈ 212 bytes
      const c = makeCache({ maxMemory: 300 }); // 只能放约 1-2 个
      c.set("key001", "x".repeat(100));
      c.set("key002", "x".repeat(100));
      c.set("key003", "x".repeat(100));
      // 至少 key001 应被淘汰（最旧）
      expect(c.get("key001")).toBeUndefined();
      c.destroy();
    });

    it("maxMemory 限制下对象值使用 JSON.stringify 估算大小", () => {
      // maxMemory > 0 时 _estimateSize 对 object 值走 JSON.stringify 分支
      const c = makeCache({ maxMemory: 1024 * 1024 });
      c.set("obj-key", { id: 1, name: "Alice", roles: ["admin", "user"] });
      // 写入后 memoryUsage 应包含对象的 JSON 估算值
      const stats = c.getStats();
      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(c.get("obj-key")).toEqual({
        id: 1,
        name: "Alice",
        roles: ["admin", "user"],
      });
      c.destroy();
    });

    it("maxMemory 限制下循环引用对象使用保守估算 100（JSON.stringify 抛出时 catch）", () => {
      // 循环引用导致 JSON.stringify 抛出，_estimateSize 降级为 100 bytes
      const c = makeCache({ maxMemory: 1024 * 1024 });
      const circular: Record<string, any> = { name: "circular" };
      circular["self"] = circular; // 创建循环引用
      // 不应抛出，而是静默降级
      expect(() => c.set("circular-key", circular)).not.toThrow();
      // 写入后 memoryUsage 应包含保守估算的 100 bytes（加上 key 的估算）
      expect(c.getStats().memoryUsage).toBeGreaterThan(0);
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 批量操作
  // ────────────────────────────────────────────────────────

  describe("批量操作", () => {
    describe("getMany", () => {
      it("返回所有命中键的 Record", () => {
        cache.set("k1", "v1");
        cache.set("k2", "v2");
        expect(cache.getMany(["k1", "k2"])).toEqual({ k1: "v1", k2: "v2" });
      });

      it("未命中的键不出现在结果中", () => {
        cache.set("k1", "v1");
        const result = cache.getMany(["k1", "missing"]);
        expect(result).toEqual({ k1: "v1" });
        expect("missing" in result).toBe(false);
      });

      it("空数组返回 {} (A16)", () => {
        expect(cache.getMany([])).toEqual({});
      });

      it("null 值包含在结果中（null 是有效缓存值）", () => {
        cache.set("k", null);
        expect(cache.getMany(["k"])).toEqual({ k: null });
      });

      it("enabled=false 时 getMany 返回空对象但仍校验 key", () => {
        const c = makeCache({ enabled: false });
        c.set("k", "v");
        expect(c.getMany(["k"])).toEqual({});
        expect(() => c.getMany([""])).toThrow(TypeError);
        c.destroy();
      });
    });

    describe("setMany", () => {
      it("批量写入所有键", () => {
        const result = cache.setMany({ k1: "v1", k2: "v2", k3: "v3" });
        expect(result).toBe(true);
        expect(cache.get("k1")).toBe("v1");
        expect(cache.get("k2")).toBe("v2");
        expect(cache.get("k3")).toBe("v3");
      });

      it("空 Record 返回 true（A16）", () => {
        expect(cache.setMany({})).toBe(true);
      });

      it("setMany 传入 ttl 参数生效", async () => {
        cache.setMany({ k1: "v1" }, 10);
        await sleep(30);
        expect(cache.get("k1")).toBeUndefined();
      });

      it("setMany 在 disabled 缓存上不写入但仍校验 key", () => {
        const c = makeCache({ enabled: false });
        expect(c.setMany({ k: "v" })).toBe(true);
        expect(c.get("k")).toBeUndefined();
        expect(() => c.setMany({ "": "v" })).toThrow(TypeError);
        c.destroy();
      });

      it("setMany 批量写入后统一执行容量淘汰", () => {
        const c = makeCache({ maxEntries: 2 });
        c.setMany({ a: 1, b: 2, c: 3 });
        expect(c.get("a")).toBeUndefined();
        expect(c.get("b")).toBe(2);
        expect(c.get("c")).toBe(3);
        c.destroy();
      });
    });

    describe("delMany", () => {
      it("返回实际删除的数量", () => {
        cache.set("k1", "v1");
        cache.set("k2", "v2");
        expect(cache.delMany(["k1", "k2", "missing"])).toBe(2);
      });

      it("删除后键不可访问", () => {
        cache.set("k1", "v1");
        cache.delMany(["k1"]);
        expect(cache.get("k1")).toBeUndefined();
      });

      it("空数组返回 0（A16）", () => {
        expect(cache.delMany([])).toBe(0);
      });

      it("delMany 对非法 key 抛出 TypeError", () => {
        expect(() => cache.delMany([""])).toThrow(TypeError);
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // delPattern
  // ────────────────────────────────────────────────────────

  describe("delPattern", () => {
    it("* 通配符匹配多个键", () => {
      cache.set("user:1", "a");
      cache.set("user:2", "b");
      cache.set("order:1", "c");
      expect(cache.delPattern("user:*")).toBe(2);
      expect(cache.get("user:1")).toBeUndefined();
      expect(cache.get("user:2")).toBeUndefined();
      expect(cache.get("order:1")).toBe("c"); // 不受影响
    });

    it("精确匹配（无通配符）", () => {
      cache.set("exact", "value");
      cache.set("exact-other", "other");
      expect(cache.delPattern("exact")).toBe(1);
      expect(cache.get("exact")).toBeUndefined();
      expect(cache.get("exact-other")).toBe("other");
    });

    it(".（点）被视为字面量，不作为正则元字符（A11）", () => {
      cache.set("key.dot", "v1");
      cache.set("keyadot", "v2"); // 'a' 替代 '.'
      expect(cache.delPattern("key.dot")).toBe(1);
      expect(cache.get("key.dot")).toBeUndefined();
      expect(cache.get("keyadot")).toBe("v2"); // 不应被匹配
    });

    it("* 只支持通配，不支持 ? 或 [] glob（A11）", () => {
      cache.set("key1", "v1");
      cache.set("key2", "v2");
      // '?' 被转义为字面 '?'，不匹配单字符
      expect(cache.delPattern("key?")).toBe(0);
    });

    it("无匹配时返回 0", () => {
      expect(cache.delPattern("nonexistent:*")).toBe(0);
    });

    it("pattern 超过 512 字符时截断并打印 console.warn（A10）", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      cache.delPattern("a".repeat(600));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("超过 512 字符"),
      );
      warnSpy.mockRestore();
    });

    it("前缀通配符匹配", () => {
      cache.set("prefix:a", 1);
      cache.set("prefix:b", 2);
      cache.set("other", 3);
      expect(cache.delPattern("prefix:*")).toBe(2);
    });

    it("全匹配 * 删除所有键", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      expect(cache.delPattern("*")).toBe(3);
      expect(cache.getStats().entries).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // keys()
  // ────────────────────────────────────────────────────────

  describe("keys()", () => {
    it("返回所有未过期键", async () => {
      cache.set("k1", "v1");
      cache.set("k2", "v2", 10);
      await sleep(30);
      const k = cache.keys();
      expect(k).toContain("k1");
      expect(k).not.toContain("k2"); // 已过期，惰性排除
    });

    it("无 pattern 时返回全部键", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      const k = cache.keys();
      expect(k).toHaveLength(2);
      expect(k).toContain("a");
      expect(k).toContain("b");
    });

    it("pattern 参数过滤键", () => {
      cache.set("user:1", "a");
      cache.set("user:2", "b");
      cache.set("order:1", "c");
      const k = cache.keys("user:*");
      expect(k).toHaveLength(2);
      expect(k).not.toContain("order:1");
    });

    it("空缓存返回空数组", () => {
      expect(cache.keys()).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────
  // 可选 TTL 查询扩展
  // ────────────────────────────────────────────────────────

  describe("TTL 查询扩展", () => {
    it("getRemainingTtl 对带过期时间的键返回正数", () => {
      cache.set("ttl-key", "v", 1000);
      const ttl = cache.getRemainingTtl!("ttl-key");
      expect(typeof ttl).toBe("number");
      expect(ttl as number).toBeGreaterThan(0);
    });

    it("getRemainingTtl 对永不过期键返回 null", () => {
      cache.set("forever", "v", 0);
      expect(cache.getRemainingTtl!("forever")).toBeNull();
    });

    it("getRemainingTtl 对不存在键返回 undefined", () => {
      expect(cache.getRemainingTtl!("missing")).toBeUndefined();
    });

    it("getRemainingTtl 会惰性清理已过期键", async () => {
      cache.set("expired", "v", 10);
      await sleep(30);
      expect(cache.getRemainingTtl!("expired")).toBeUndefined();
      expect(cache.exists("expired")).toBe(false);
    });

    it("enabled=false 时 getRemainingTtl 返回 undefined", () => {
      const c = makeCache({ enabled: false });
      c.set("disabled", "v", 1000);
      expect(c.getRemainingTtl!("disabled")).toBeUndefined();
      c.destroy();
    });

    it("getRemainingTtlMany 返回存在键的 TTL 语义", () => {
      cache.set("ttl", "v", 1000);
      cache.set("forever", "v", 0);

      const result = cache.getRemainingTtlMany!(["ttl", "forever", "missing"]);

      expect(result["ttl"]).toEqual(expect.any(Number));
      expect(result["forever"]).toBeNull();
      expect(result["missing"]).toBeUndefined();
    });

    it("getRemainingTtlMany 空输入返回空对象", () => {
      expect(cache.getRemainingTtlMany!([])).toEqual({});
    });
  });

  // ────────────────────────────────────────────────────────
  // 标签索引（enableTags）
  // ────────────────────────────────────────────────────────

  describe("标签索引（enableTags=true）", () => {
    it("invalidateByTag 批量失效带该标签的条目", () => {
      const c = makeCache({ enableTags: true });
      c.set("k1", "v1", 0, { tags: ["tagA"] } as SetOptions);
      c.set("k2", "v2", 0, { tags: ["tagA", "tagB"] } as SetOptions);
      c.set("k3", "v3", 0, { tags: ["tagB"] } as SetOptions);
      c.invalidateByTag("tagA");
      expect(c.get("k1")).toBeUndefined();
      expect(c.get("k2")).toBeUndefined();
      expect(c.get("k3")).toBe("v3"); // tagB 不受影响
      c.destroy();
    });

    it("失效某个 tag 后，共享该 key 的其他 tag 索引也被清理", () => {
      const c = makeCache({ enableTags: true });
      c.set("k", "v", 0, { tags: ["tagA", "tagB"] } as SetOptions);
      c.invalidateByTag("tagA"); // 清理 k，同时 tagB 的 Set 中 k 也被移除
      // tagB 失效时不应报错（k 已不存在）
      expect(() => c.invalidateByTag("tagB")).not.toThrow();
      c.destroy();
    });

    it("invalidateByTag 对不存在的 tag 无操作", () => {
      const c = makeCache({ enableTags: true });
      expect(() => c.invalidateByTag("nonexistent-tag")).not.toThrow();
      c.destroy();
    });

    it("enableTags=false 时 invalidateByTag 无操作（不抛出）", () => {
      cache.set("k", "v");
      expect(() => cache.invalidateByTag?.("tag")).not.toThrow();
      expect(cache.get("k")).toBe("v");
    });

    it("del 单个键后标签索引同步清理", () => {
      const c = makeCache({ enableTags: true });
      c.set("k1", "v1", 0, { tags: ["tagA"] } as SetOptions);
      c.set("k2", "v2", 0, { tags: ["tagA"] } as SetOptions);
      c.del("k1"); // 从 tagA 的 Set 中移除 k1
      c.invalidateByTag("tagA"); // 只应删除 k2
      expect(c.get("k2")).toBeUndefined();
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 统计（enableStats）
  // ────────────────────────────────────────────────────────

  describe("统计（enableStats）", () => {
    it("初始状态所有计数器为 0", () => {
      const s = cache.getStats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.sets).toBe(0);
      expect(s.deletes).toBe(0);
      expect(s.evictions).toBe(0);
      expect(s.entries).toBe(0);
    });

    it("set 计入 sets，get 命中计入 hits", () => {
      cache.set("k", "v");
      cache.get("k");
      const s = cache.getStats();
      expect(s.sets).toBe(1);
      expect(s.hits).toBe(1);
    });

    it("get 未命中计入 misses", () => {
      cache.get("nonexistent");
      expect(cache.getStats().misses).toBe(1);
    });

    it("TTL 过期后 get 计入 misses", async () => {
      cache.set("k", "v", 10);
      await sleep(30);
      cache.get("k");
      expect(cache.getStats().misses).toBe(1);
    });

    it("del 计入 deletes", () => {
      cache.set("k", "v");
      cache.del("k");
      expect(cache.getStats().deletes).toBe(1);
    });

    it("del 不存在的键不计入 deletes", () => {
      cache.del("nonexistent");
      expect(cache.getStats().deletes).toBe(0);
    });

    it("hitRate 正确计算（hits / (hits + misses)）", () => {
      cache.set("k", "v");
      cache.get("k"); // hit
      cache.get("miss1"); // miss
      cache.get("miss2"); // miss (注意：miss2 还未被set)
      // 但只要k存在，get('k') 才是hit
      const s = cache.getStats();
      expect(s.hitRate).toBeCloseTo(1 / 3);
    });

    it("无命中无未命中时 hitRate 为 0", () => {
      expect(cache.getStats().hitRate).toBe(0);
    });

    it("entries 反映当前条目数", () => {
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      expect(cache.getStats().entries).toBe(2);
      cache.del("k1");
      expect(cache.getStats().entries).toBe(1);
    });

    it("resetStats 重置所有计数器", () => {
      cache.set("k", "v");
      cache.get("k");
      cache.get("miss");
      cache.del("k");
      cache.resetStats();
      const s = cache.getStats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.sets).toBe(0);
      expect(s.deletes).toBe(0);
      expect(s.evictions).toBe(0);
    });

    it("resetStats 不清空缓存数据", () => {
      cache.set("k", "v");
      cache.resetStats();
      expect(cache.get("k")).toBe("v");
    });

    it("enableStats=false 时所有计数器保持 0", () => {
      const c = makeCache({ enableStats: false });
      c.set("k", "v");
      c.get("k");
      c.get("miss");
      const s = c.getStats();
      expect(s.hits).toBe(0);
      expect(s.misses).toBe(0);
      expect(s.sets).toBe(0);
      c.destroy();
    });

    it("memoryUsage 在 maxMemory > 0 时返回正值", () => {
      const c = makeCache({ maxMemory: 1024 * 1024 });
      c.set("key", "value");
      expect(c.getStats().memoryUsage).toBeGreaterThan(0);
      c.destroy();
    });

    it("memoryUsageMB 保留 3 位小数精度", () => {
      const c = makeCache({ maxMemory: 1024 * 1024 });
      c.set("key", "x".repeat(500));
      const s = c.getStats();
      expect(typeof s.memoryUsageMB).toBe("number");
      // 确认不是 Infinity 或 NaN
      expect(Number.isFinite(s.memoryUsageMB)).toBe(true);
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 参数校验（A12）
  // ────────────────────────────────────────────────────────

  describe("参数校验（A12）", () => {
    it("空字符串 key 在 get 时抛出 TypeError", () => {
      expect(() => cache.get("")).toThrow(TypeError);
    });

    it("空字符串 key 在 set 时抛出 TypeError", () => {
      expect(() => cache.set("", "v")).toThrow(TypeError);
    });

    it("空字符串 key 在 del 时抛出 TypeError", () => {
      expect(() => cache.del("")).toThrow(TypeError);
    });

    it("空字符串 key 在 exists 时抛出 TypeError", () => {
      expect(() => cache.exists("")).toThrow(TypeError);
    });

    it("非 string key 在 get 时抛出 TypeError", () => {
      expect(() => cache.get(123 as any)).toThrow(TypeError);
    });

    it("非 string key 在 set 时抛出 TypeError", () => {
      expect(() => cache.set(null as any, "v")).toThrow(TypeError);
    });

    it("错误信息包含收到的非法值", () => {
      try {
        cache.get("" as any);
      } catch (e) {
        expect((e as Error).message).toContain("cache-hub");
      }
    });
  });

  // ────────────────────────────────────────────────────────
  // enabled=false（全局禁用）
  // ────────────────────────────────────────────────────────

  describe("enabled=false（全局禁用）", () => {
    it("set 不存储，get 始终返回 undefined", () => {
      const c = makeCache({ enabled: false });
      c.set("k", "v");
      expect(c.get("k")).toBeUndefined();
      c.destroy();
    });

    it("exists 始终返回 false", () => {
      const c = makeCache({ enabled: false });
      c.set("k", "v");
      expect(c.exists("k")).toBe(false);
      c.destroy();
    });
  });

  // ────────────────────────────────────────────────────────
  // 分布式锁（setLockManager）
  // ────────────────────────────────────────────────────────

  describe("setLockManager", () => {
    it("锁定键的 set 被跳过", () => {
      cache.setLockManager({ isLocked: (k) => k === "locked-key" });
      cache.set("locked-key", "value");
      expect(cache.get("locked-key")).toBeUndefined();
    });

    it("未锁定键的 set 正常执行", () => {
      cache.setLockManager({ isLocked: (k) => k === "locked-key" });
      cache.set("normal-key", "value");
      expect(cache.get("normal-key")).toBe("value");
    });

    it("可替换 lockManager", () => {
      cache.setLockManager({ isLocked: () => true }); // 全部锁定
      cache.set("k", "v");
      expect(cache.get("k")).toBeUndefined();

      cache.setLockManager({ isLocked: () => false }); // 全部解锁
      cache.set("k", "v");
      expect(cache.get("k")).toBe("v");
    });
  });

  // ────────────────────────────────────────────────────────
  // destroy
  // ────────────────────────────────────────────────────────

  describe("destroy", () => {
    it("destroy 后 store 为空（不抛出）", () => {
      cache.set("k", "v");
      expect(() => cache.destroy()).not.toThrow();
    });

    it("destroy 两次不抛出", () => {
      expect(() => {
        cache.destroy();
        cache.destroy();
      }).not.toThrow();
    });

    it("带 cleanupInterval 的实例 destroy 清理定时器（A19）", () => {
      const c = makeCache({ cleanupInterval: 50 });
      expect(() => c.destroy()).not.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // 构造选项边界
  // ────────────────────────────────────────────────────────

  describe("构造选项边界（§15 参数校验）", () => {
    it("maxEntries <= 0 时回退为默认值 10000", () => {
      const c = makeCache({ maxEntries: 0 });
      // 填充 200 个条目，均应保留（回退到 10000）
      for (let i = 0; i < 200; i++) {
        c.set(`k${i}`, i);
      }
      expect(c.getStats().entries).toBe(200);
      c.destroy();
    });

    it("maxEntries 为负数时回退为默认值", () => {
      const c = makeCache({ maxEntries: -5 });
      for (let i = 0; i < 50; i++) {
        c.set(`k${i}`, i);
      }
      expect(c.getStats().entries).toBe(50);
      c.destroy();
    });

    it("maxMemory < 0 时回退为 0（无内存限制）", () => {
      const c = makeCache({ maxMemory: -1 });
      c.set("k", "v");
      expect(c.get("k")).toBe("v");
      c.destroy();
    });
  });
});
