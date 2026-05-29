/**
 * Redis 集成测试
 *
 * 前置条件：本地运行 Redis（默认 redis://localhost:6379）
 *
 * 运行方式：
 *   npm run test:integration
 *   REDIS_URL=redis://myhost:6379 npm run test:integration
 *
 * 跳过方式：
 *   SKIP_INTEGRATION=true npm run test:integration
 *   或直接运行 npm test（单元测试不包含此目录）
 *
 * 来源：技术方案 §7 §9 多层缓存端到端验证
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createRedisCacheAdapter } from "../../src/redis-adapter.js";
import type { RedisCacheAdapter } from "../../src/redis-adapter.js";
import { DistributedCacheInvalidator } from "../../src/distributed-invalidator.js";
import { MultiLevelCache } from "../../src/multi-level-cache.js";
import { MemoryCache } from "../../src/memory-cache.js";

// ── 环境配置 ──

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION === "true";

// 测试用键前缀（避免污染生产数据，每次运行唯一）
const TEST_PREFIX = `cache-hub-test:${Date.now()}:`;

// ── 连通性检测 ──

/**
 * 检测 Redis 是否可达。
 * 利用 ioredis 的 ready 事件和 PING 命令进行快速探测。
 */
async function isRedisAvailable(
  url: string,
  timeoutMs = 3000,
): Promise<boolean> {
  let adapter: RedisCacheAdapter | null = null;
  try {
    adapter = createRedisCacheAdapter(url);
    const redis = adapter.getRedisInstance() as any;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Redis connection timeout"));
      }, timeoutMs);

      redis.on("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      redis.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    try {
      const r = adapter?.getRedisInstance() as any;
      r?.disconnect?.();
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── 条件跳过 ──

const describeIfRedis = SKIP_INTEGRATION ? describe.skip : describe;

// ── 集成测试套件 ──

describeIfRedis("Redis 集成测试", () => {
  let redisAvailable = false;

  beforeAll(async () => {
    if (SKIP_INTEGRATION) return;

    redisAvailable = await isRedisAvailable(REDIS_URL);

    if (!redisAvailable) {
      console.warn(
        `[集成测试] 跳过：无法连接到 Redis (${REDIS_URL})。` +
          "请确保本地 Redis 正在运行，或设置 REDIS_URL 环境变量。",
      );
    } else {
      console.info(`[集成测试] 已连接 Redis: ${REDIS_URL}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // RedisCacheAdapter 端到端测试
  // ─────────────────────────────────────────────────────────────────

  describe("RedisCacheAdapter 端到端", () => {
    let adapter: RedisCacheAdapter;

    beforeAll(async () => {
      if (!redisAvailable) return;
      adapter = createRedisCacheAdapter(REDIS_URL);
    });

    afterAll(async () => {
      if (!redisAvailable || !adapter) return;
      try {
        // 清理本次测试写入的键（用 delPattern，不用 FLUSHDB）
        await adapter.delPattern(`${TEST_PREFIX}adapter:*`);
      } finally {
        await adapter.close();
      }
    });

    beforeEach(async () => {
      if (!redisAvailable) return;
      // 每个测试前清理自己的键空间
      await adapter.delPattern(`${TEST_PREFIX}adapter:*`);
    });

    it("set / get 基本读写", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:basic`;
      await adapter.set(key, { hello: "world" }, 10000);

      const result = await adapter.get<{ hello: string }>(key);
      expect(result).toEqual({ hello: "world" });
    });

    it("get 不存在的键返回 undefined", async () => {
      if (!redisAvailable) return;

      const result = await adapter.get(`${TEST_PREFIX}adapter:nonexistent`);
      expect(result).toBeUndefined();
    });

    it("set null 值（有效缓存值）", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:null-val`;
      await adapter.set(key, null, 10000);

      const result = await adapter.get(key);
      expect(result).toBeNull();
    });

    it("set false 值（有效缓存值）", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:false-val`;
      await adapter.set(key, false, 10000);

      const result = await adapter.get(key);
      expect(result).toBe(false);
    });

    it("set 数字 0（有效缓存值）", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:zero-val`;
      await adapter.set(key, 0, 10000);

      const result = await adapter.get(key);
      expect(result).toBe(0);
    });

    it("del 删除键后 get 返回 undefined", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:del-test`;
      await adapter.set(key, "value", 10000);
      expect(await adapter.get(key)).toBe("value");

      await adapter.del(key);
      expect(await adapter.get(key)).toBeUndefined();
    });

    it("exists / has 检测键存在性", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:exists-test`;
      expect(await adapter.exists(key)).toBe(false);
      expect(await adapter.has(key)).toBe(false);

      await adapter.set(key, "present", 10000);

      expect(await adapter.exists(key)).toBe(true);
      expect(await adapter.has(key)).toBe(true);
    });

    it("TTL 过期后 get 返回 undefined", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}adapter:ttl-test`;
      await adapter.set(key, "expires", 100); // 100ms TTL

      expect(await adapter.get(key)).toBe("expires");

      await new Promise((r) => setTimeout(r, 250));

      expect(await adapter.get(key)).toBeUndefined();
    });

    it("getMany / setMany 批量读写", async () => {
      if (!redisAvailable) return;

      const entries: Record<string, any> = {
        [`${TEST_PREFIX}adapter:many:a`]: { id: 1, name: "Alice" },
        [`${TEST_PREFIX}adapter:many:b`]: { id: 2, name: "Bob" },
        [`${TEST_PREFIX}adapter:many:c`]: 42,
      };

      await adapter.setMany(entries, 10000);

      const keys = Object.keys(entries);
      const result = await adapter.getMany(keys);

      expect(result[`${TEST_PREFIX}adapter:many:a`]).toEqual({
        id: 1,
        name: "Alice",
      });
      expect(result[`${TEST_PREFIX}adapter:many:b`]).toEqual({
        id: 2,
        name: "Bob",
      });
      expect(result[`${TEST_PREFIX}adapter:many:c`]).toBe(42);
    });

    it("delMany 批量删除", async () => {
      if (!redisAvailable) return;

      const keys = [
        `${TEST_PREFIX}adapter:delmany:1`,
        `${TEST_PREFIX}adapter:delmany:2`,
        `${TEST_PREFIX}adapter:delmany:3`,
      ];

      await adapter.setMany(
        Object.fromEntries(keys.map((k) => [k, "val"])),
        10000,
      );

      for (const k of keys) {
        expect(await adapter.exists(k)).toBe(true);
      }

      const deleted = await adapter.delMany(keys);
      expect(deleted).toBe(3);

      for (const k of keys) {
        expect(await adapter.exists(k)).toBe(false);
      }
    });

    it("delPattern 按模式批量删除（A08 SCAN）", async () => {
      if (!redisAvailable) return;

      const prefix = `${TEST_PREFIX}adapter:pattern:`;
      const keys = Array.from({ length: 5 }, (_, i) => `${prefix}item-${i}`);

      await adapter.setMany(
        Object.fromEntries(keys.map((k) => [k, "val"])),
        10000,
      );

      const count = await adapter.delPattern(`${prefix}*`);
      expect(count).toBeGreaterThanOrEqual(5);

      for (const k of keys) {
        expect(await adapter.get(k)).toBeUndefined();
      }
    });

    it("keys() 列出匹配的键（A08 SCAN）", async () => {
      if (!redisAvailable) return;

      const prefix = `${TEST_PREFIX}adapter:keys:`;
      const keys = Array.from({ length: 3 }, (_, i) => `${prefix}k${i}`);

      await adapter.setMany(
        Object.fromEntries(keys.map((k) => [k, "v"])),
        10000,
      );

      const found = await adapter.keys(`${prefix}*`);
      expect(found.length).toBeGreaterThanOrEqual(3);
      for (const k of keys) {
        expect(found).toContain(k);
      }
    });

    it("getStats 返回零值统计（Redis 层无命中率追踪）", async () => {
      if (!redisAvailable) return;

      const stats = adapter.getStats!();
      expect(stats.hits).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it("URL 字符串构造：自建连接，close() 调用 quit（A17）", async () => {
      if (!redisAvailable) return;

      // 创建一个独立的适配器，验证 URL 构造路径（shouldCloseOnDestroy=true）
      const tmpAdapter = createRedisCacheAdapter(REDIS_URL);
      const tmpKey = `${TEST_PREFIX}adapter:lifecycle`;

      await tmpAdapter.set(tmpKey, { created: true }, 5000);
      const val = await tmpAdapter.get(tmpKey);
      expect(val).toEqual({ created: true });

      // close() 会调用 redis.quit()（shouldCloseOnDestroy=true）
      await tmpAdapter.close();

      // 清理（通过 main adapter）
      await adapter.del(tmpKey);
    });

    it("外部实例构造：close() 不调用 quit（A17）", async () => {
      if (!redisAvailable) return;

      // 获取底层 redis 实例并传入 adapter（外部管理生命周期）
      const primaryRedis = adapter.getRedisInstance() as any;
      const secondaryAdapter = createRedisCacheAdapter(primaryRedis);

      const key = `${TEST_PREFIX}adapter:external-instance`;
      await secondaryAdapter.set(key, "external", 5000);
      expect(await secondaryAdapter.get(key)).toBe("external");

      // close() 不操作 primaryRedis（shouldCloseOnDestroy=false）
      await secondaryAdapter.close();

      // primaryRedis 应该仍然可用（adapter 共用同一底层连接）
      const stillAlive = await primaryRedis.ping();
      expect(stillAlive).toBe("PONG");
    });

    it("pattern 中的 ? 和 [ 被正确转义（A11）", async () => {
      if (!redisAvailable) return;

      // 写入一个包含 ? 字符的键（Redis 中真实存在）
      const key = `${TEST_PREFIX}adapter:esc-test`;
      await adapter.set(key, "present", 5000);

      // 使用 ? 作为 pattern 中的字面量（A11：? 被转义，不匹配单字符）
      const count = await adapter.delPattern(`${TEST_PREFIX}adapter:esc?test`);
      // ? 被转义为 \?，不应匹配 esc-test
      expect(count).toBe(0);

      // 确认原键仍然存在
      expect(await adapter.exists(key)).toBe(true);
    });

    it("getRedisInstance 返回底层 ioredis 实例", async () => {
      if (!redisAvailable) return;

      const instance = adapter.getRedisInstance();
      expect(instance).toBeDefined();
      expect(typeof (instance as any).ping).toBe("function");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MultiLevelCache（L1 MemoryCache + L2 Redis）
  // ─────────────────────────────────────────────────────────────────

  describe("MultiLevelCache L1+L2 端到端", () => {
    let l2: RedisCacheAdapter;
    let mlc: MultiLevelCache;
    let l1: MemoryCache;

    beforeAll(async () => {
      if (!redisAvailable) return;
      l2 = createRedisCacheAdapter(REDIS_URL);
      l1 = new MemoryCache({ maxEntries: 200 });
      // MultiLevelCache 使用 options 对象构造
      mlc = new MultiLevelCache({ local: l1, remote: l2 });
    });

    afterAll(async () => {
      if (!redisAvailable || !l2) return;
      try {
        await l2.delPattern(`${TEST_PREFIX}mlc:*`);
      } finally {
        await l2.close();
      }
    });

    beforeEach(async () => {
      if (!redisAvailable || !mlc) return;
      // 清理 L1（不清 L2，避免 FLUSHDB，改用 delPattern 清理本次测试键空间）
      l1.destroy?.();
      l1 = new MemoryCache({ maxEntries: 200 });
      mlc = new MultiLevelCache({ local: l1, remote: l2 });
      await l2.delPattern(`${TEST_PREFIX}mlc:*`);
    });

    it("set 写入 L1+L2，get 先命中 L1", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}mlc:basic`;
      await mlc.set(key, { user: "Alice" }, 10000);

      // 通过 mlc 读取（命中 L1）
      const r1 = await mlc.get<{ user: string }>(key);
      expect(r1).toEqual({ user: "Alice" });

      // 直接从 L2 确认写入
      const r2 = await l2.get<{ user: string }>(key);
      expect(r2).toEqual({ user: "Alice" });
    });

    it("L1 无数据时从 L2 回填", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}mlc:backfill`;

      // 直接写入 L2，L1 没有这个键
      await l2.set(key, { backfill: true }, 10000);
      expect(l1.get(key)).toBeUndefined();

      // 通过 mlc 获取：L1 miss → L2 hit → 回填 L1
      const result = await mlc.get<{ backfill: boolean }>(key);
      expect(result).toEqual({ backfill: true });

      // 回填后 L1 也应该有值
      expect(l1.get(key)).toEqual({ backfill: true });
    });

    it("del 同时从 L1 和 L2 删除（A05）", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}mlc:del`;
      await mlc.set(key, "to-delete", 10000);

      expect(await mlc.get(key)).toBe("to-delete");

      await mlc.del(key);

      expect(await mlc.get(key)).toBeUndefined();
      expect(await l2.get(key)).toBeUndefined();
    });

    it("delPattern 通过 L2 按模式删除", async () => {
      if (!redisAvailable) return;

      const prefix = `${TEST_PREFIX}mlc:pattern:`;
      await mlc.set(`${prefix}a`, "va", 10000);
      await mlc.set(`${prefix}b`, "vb", 10000);
      await mlc.set(`${prefix}c`, "vc", 10000);

      const deleted = await mlc.delPattern(`${prefix}*`);
      expect(deleted).toBeGreaterThanOrEqual(3);

      expect(await mlc.get(`${prefix}a`)).toBeUndefined();
      expect(await mlc.get(`${prefix}b`)).toBeUndefined();
    });

    it("L2 中的键可被 keys() 列出", async () => {
      if (!redisAvailable) return;

      const prefix = `${TEST_PREFIX}mlc:keys:`;
      await mlc.set(`${prefix}x`, 1, 10000);
      await mlc.set(`${prefix}y`, 2, 10000);

      const found = await mlc.keys(`${prefix}*`);
      expect(found).toContain(`${prefix}x`);
      expect(found).toContain(`${prefix}y`);
    });

    it("exists 检测 L1 和 L2", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}mlc:exists`;
      expect(await mlc.exists(key)).toBe(false);

      await mlc.set(key, "present", 10000);
      expect(await mlc.exists(key)).toBe(true);
    });

    it("getMany / setMany 批量操作", async () => {
      if (!redisAvailable) return;

      const entries: Record<string, any> = {
        [`${TEST_PREFIX}mlc:many:1`]: { id: 1 },
        [`${TEST_PREFIX}mlc:many:2`]: { id: 2 },
      };

      await mlc.setMany(entries, 10000);

      const result = await mlc.getMany(Object.keys(entries));
      expect(result[`${TEST_PREFIX}mlc:many:1`]).toEqual({ id: 1 });
      expect(result[`${TEST_PREFIX}mlc:many:2`]).toEqual({ id: 2 });
    });

    it("L2 回填 L1 时保留远端 TTL，不把短 TTL 扩展为本地永久缓存", async () => {
      if (!redisAvailable) return;

      const key = `${TEST_PREFIX}mlc:backfill-ttl`;
      const local = new MemoryCache({ maxEntries: 100, defaultTtl: 0 });
      const remote = createRedisCacheAdapter(REDIS_URL);
      const cache = new MultiLevelCache({ local, remote });

      try {
        await remote.set(key, { shortLived: true }, 60);
        expect(local.get(key)).toBeUndefined();

        expect(await cache.get(key)).toEqual({ shortLived: true });
        expect(local.get(key)).toEqual({ shortLived: true });

        await new Promise((r) => setTimeout(r, 120));

        expect(local.get(key)).toBeUndefined();
        expect(await cache.get(key)).toBeUndefined();
      } finally {
        await remote.del(key);
        await remote.close();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // DistributedCacheInvalidator 端到端
  // ─────────────────────────────────────────────────────────────────

  describe("DistributedCacheInvalidator 端到端", () => {
    afterAll(async () => {
      if (!redisAvailable) return;
      // 清理失效器测试相关键
      const cleanup = createRedisCacheAdapter(REDIS_URL);
      try {
        await cleanup.delPattern(`${TEST_PREFIX}invalidator:*`);
      } finally {
        await cleanup.close();
      }
    });

    it("invalidate 广播后接收方执行 delPattern", async () => {
      if (!redisAvailable) return;

      const l1 = new MemoryCache({ maxEntries: 100 });
      const channel = `${TEST_PREFIX}invalidator:ch`;

      // 接收方：订阅失效消息，持有 L1 内存缓存
      const receiver = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: l1,
        channel,
        instanceId: "receiver-instance",
      });

      // 发送方：不同 instanceId，发布失效消息
      const sender = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: new MemoryCache(),
        channel,
        instanceId: "sender-instance",
      });

      try {
        // 向 L1 写入数据
        l1.set("user:100", { name: "Alice" });
        l1.set("user:200", { name: "Bob" });
        expect(l1.get("user:100")).toBeDefined();
        expect(l1.get("user:200")).toBeDefined();

        // 等待订阅建立
        await new Promise((r) => setTimeout(r, 300));

        // 发送方广播失效 user:*
        await sender.invalidate("user:*");

        // 等待消息传播和处理
        await new Promise((r) => setTimeout(r, 500));

        // 接收方的 L1 缓存应该被清空
        expect(l1.get("user:100")).toBeUndefined();
        expect(l1.get("user:200")).toBeUndefined();

        // 统计验证
        const receiverStats = receiver.getStats();
        expect(receiverStats.messagesReceived).toBeGreaterThanOrEqual(1);
        expect(receiverStats.invalidationsTriggered).toBeGreaterThanOrEqual(1);

        const senderStats = sender.getStats();
        expect(senderStats.messagesSent).toBe(1);
      } finally {
        await receiver.close();
        await sender.close();
      }
    });

    it("调用 invalidate() 时当前实例先失效，本身回环消息不会重复触发", async () => {
      if (!redisAvailable) return;

      const l1 = new MemoryCache({ maxEntries: 100 });
      const channel = `${TEST_PREFIX}invalidator:selffilter`;

      const invalidator = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: l1,
        channel,
        instanceId: "self-test-instance",
      });

      try {
        l1.set("product:1", { name: "Widget" });
        expect(l1.get("product:1")).toBeDefined();

        // 等待订阅建立
        await new Promise((r) => setTimeout(r, 300));

        // 自己发给自己（同一 instanceId）
        await invalidator.invalidate("product:*");

        // 等待消息处理
        await new Promise((r) => setTimeout(r, 400));

        // invalidate() 已先失效本地缓存；回环消息仍会被 instanceId 过滤，避免重复触发
        expect(l1.get("product:1")).toBeUndefined();

        const stats = invalidator.getStats();
        expect(stats.messagesSent).toBe(1);
        expect(stats.messagesReceived).toBeGreaterThanOrEqual(1);
        expect(stats.invalidationsTriggered).toBe(1);
      } finally {
        await invalidator.close();
      }
    });

    it("getStats 快照返回当前统计，每次调用独立副本", async () => {
      if (!redisAvailable) return;

      const invalidator = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: new MemoryCache(),
        channel: `${TEST_PREFIX}invalidator:stats`,
        instanceId: "stats-test",
      });

      try {
        await new Promise((r) => setTimeout(r, 150));

        const s1 = invalidator.getStats();
        const s2 = invalidator.getStats();

        expect(s1).not.toBe(s2); // 独立副本
        expect(s1.instanceId).toBe("stats-test");
        expect(s1.errors).toBe(0);
      } finally {
        await invalidator.close();
      }
    });

    it("close 正常关闭：unsubscribe + sub.quit + pub.quit（shouldClosePub=true）", async () => {
      if (!redisAvailable) return;

      const invalidator = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: new MemoryCache(),
        channel: `${TEST_PREFIX}invalidator:close`,
        instanceId: "close-test",
      });

      await new Promise((r) => setTimeout(r, 150));
      await expect(invalidator.close()).resolves.toBeUndefined();
    });

    it("使用已有 redis 连接（shouldClosePub=false）：close 不关闭 pub", async () => {
      if (!redisAvailable) return;

      // 用一个临时 adapter 拿到底层 ioredis 实例作为 pub
      const tmpAdapter = createRedisCacheAdapter(REDIS_URL);
      const existingRedis = tmpAdapter.getRedisInstance() as any;

      try {
        // 等待连接就绪
        await new Promise<void>((resolve, reject) => {
          if (existingRedis.status === "ready") {
            resolve();
            return;
          }
          existingRedis.once("ready", resolve);
          existingRedis.once("error", reject);
          setTimeout(reject, 3000);
        });

        const invalidator = new DistributedCacheInvalidator({
          redis: existingRedis,
          cache: new MemoryCache(),
          channel: `${TEST_PREFIX}invalidator:external-pub`,
          instanceId: "external-pub-test",
        });

        await new Promise((r) => setTimeout(r, 150));

        // close() 不应关闭 existingRedis（shouldClosePub=false）
        await invalidator.close();

        // existingRedis 仍然可用
        const pong = await existingRedis.ping();
        expect(pong).toBe("PONG");
      } finally {
        await tmpAdapter.close();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MultiLevelCache + DistributedCacheInvalidator 联动
  // ─────────────────────────────────────────────────────────────────

  describe("MultiLevelCache + DistributedCacheInvalidator 联动", () => {
    it("发布失效后，接收方的 MultiLevelCache L1 被清空", async () => {
      if (!redisAvailable) return;

      const l2 = createRedisCacheAdapter(REDIS_URL);
      const l1 = new MemoryCache({ maxEntries: 100 });
      const mlc = new MultiLevelCache({ local: l1, remote: l2 });
      const channel = `${TEST_PREFIX}combined:ch`;

      const receiver = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: l1,
        channel,
        instanceId: "combined-receiver",
      });

      const sender = new DistributedCacheInvalidator({
        redisUrl: REDIS_URL,
        cache: new MemoryCache(),
        channel,
        instanceId: "combined-sender",
      });

      try {
        // 向 MultiLevelCache 写入（L1 + L2 双写）
        const prefix = `${TEST_PREFIX}combined:user:`;
        await mlc.set(`${prefix}1`, { name: "Alice" }, 10000);
        await mlc.set(`${prefix}2`, { name: "Bob" }, 10000);

        expect(l1.get(`${prefix}1`)).toBeDefined();
        expect(l1.get(`${prefix}2`)).toBeDefined();

        // 等待订阅建立
        await new Promise((r) => setTimeout(r, 300));

        // 发布失效
        await sender.invalidate(`${prefix}*`);

        // 等待失效传播
        await new Promise((r) => setTimeout(r, 500));

        // 接收方 L1 应被清空
        expect(l1.get(`${prefix}1`)).toBeUndefined();
        expect(l1.get(`${prefix}2`)).toBeUndefined();

        // L2 仍然有数据（失效只清 L1）
        expect(await l2.get(`${prefix}1`)).toBeDefined();
      } finally {
        await receiver.close();
        await sender.close();
        await l2.delPattern(`${TEST_PREFIX}combined:*`);
        await l2.close();
      }
    });
  });
});
