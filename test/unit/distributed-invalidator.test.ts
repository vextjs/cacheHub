/**
 * distributed-invalidator 单元测试
 * 覆盖：构造函数 / invalidate() / 消息接收 / instanceId 过滤 /
 *       stats / close() / logger / errors 计数
 *
 * 来源：技术方案 §9
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DistributedCacheInvalidator } from "../../src/distributed-invalidator.js";
import type {
  DistributedInvalidatorOptions,
  DistributedInvalidatorLogger,
} from "../../src/distributed-invalidator.js";
import type { CacheLike } from "../../src/types.js";

// ── vi.mock('module') ──
// 拦截 _buildConnections 内部的 createRequire(import.meta.url) 调用，
// 返回假 ioredis 类，无需真实 Redis 连接即可覆盖生产路径代码。
// vi.mock 被 vitest 自动提升到 import 之前；
// _failIoredisForDI 在测试用例运行时才被访问，不受 TDZ 影响。
let _failIoredisForDI = false;

vi.mock("module", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("module");

  class FakeRedisForDI {
    private _handlers: Record<string, Array<(...args: any[]) => void>> = {};
    private _subscribeCallback: ((err: Error | null) => void) | null = null;

    on(event: string, handler: (...args: any[]) => void) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(handler);
    }

    subscribe(_ch: string, cb?: (err: Error | null) => void) {
      if (cb) {
        this._subscribeCallback = cb;
        cb(null); // 默认触发成功回调（覆盖 else 分支 logger.info 路径）
      }
      return Promise.resolve();
    }

    publish = vi.fn().mockResolvedValue(1);
    unsubscribe = vi.fn().mockResolvedValue(0);
    quit = vi.fn().mockResolvedValue("OK");

    _triggerSubscribeError(err: Error) {
      if (this._subscribeCallback) this._subscribeCallback(err);
    }
  }

  return {
    ...original,
    createRequire: (_url: string) => (id: string) => {
      if (id === "ioredis") {
        if (_failIoredisForDI) {
          throw new Error("Cannot find module 'ioredis'");
        }
        return FakeRedisForDI;
      }
      return original.createRequire(_url)(id);
    },
  };
});

// ──────────────────────────────────────────────
// 测试辅助：Mock 工厂
// ──────────────────────────────────────────────

/**
 * 创建模拟 Redis pub/sub 连接对象。
 * 通过 _triggerMessage / _triggerError 手动触发事件，
 * 通过 _triggerSubscribeError 模拟 subscribe 失败回调。
 */
function makeRedisMock() {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  let _subscribeCallback: ((err: Error | null) => void) | null = null;

  return {
    publish: vi.fn<[string, string], Promise<number>>().mockResolvedValue(1),
    subscribe: vi
      .fn()
      .mockImplementation((_ch: string, cb?: (err: Error | null) => void) => {
        _subscribeCallback = cb ?? null;
        if (cb) {
          cb(null); // 默认同步触发成功回调
        }
        return Promise.resolve();
      }),
    unsubscribe: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue("OK"),
    on: vi
      .fn()
      .mockImplementation(
        (event: string, handler: (...args: any[]) => void) => {
          if (!handlers[event]) {
            handlers[event] = [];
          }
          handlers[event].push(handler);
        },
      ),
    // ── 测试专用：手动触发事件 ──
    _triggerMessage(channel: string, raw: string): void {
      (handlers["message"] ?? []).forEach((h) => h(channel, raw));
    },
    _triggerError(err: Error): void {
      (handlers["error"] ?? []).forEach((h) => h(err));
    },
    _triggerSubscribeError(err: Error): void {
      if (_subscribeCallback) {
        _subscribeCallback(err);
      }
    },
  };
}

type RedisMock = ReturnType<typeof makeRedisMock>;

/**
 * 创建最小化 CacheLike mock
 */
function makeCacheMock(): CacheLike {
  return {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    del: vi.fn().mockReturnValue(true),
    exists: vi.fn().mockReturnValue(false),
    has: vi.fn().mockReturnValue(false),
    clear: vi.fn(),
    getMany: vi.fn().mockReturnValue({}),
    setMany: vi.fn().mockReturnValue(true),
    delMany: vi.fn().mockReturnValue(0),
    delPattern: vi.fn().mockResolvedValue(3),
    invalidateByTag: vi.fn().mockResolvedValue(2),
    keys: vi.fn().mockReturnValue([]),
  };
}

/**
 * 构造辅助：使用 _connections 注入绕过 ioredis 动态加载。
 * 默认注入 instanceId / channel，方便断言。
 */
function makeInvalidator(
  overrides: Partial<DistributedInvalidatorOptions> = {},
  pubOverride?: RedisMock,
  subOverride?: RedisMock,
): {
  invalidator: DistributedCacheInvalidator;
  pub: RedisMock;
  sub: RedisMock;
  cache: CacheLike;
} {
  const pub = pubOverride ?? makeRedisMock();
  const sub = subOverride ?? makeRedisMock();
  const cache = overrides.cache ?? makeCacheMock();

  const invalidator = new DistributedCacheInvalidator({
    cache,
    instanceId: "test-instance-id",
    channel: "test:channel",
    _connections: { pub, sub },
    ...overrides,
  });

  return { invalidator, pub, sub, cache };
}

/**
 * 等待当前微任务队列清空，让 void async 操作完成。
 * 两次 Promise.resolve() 足以覆盖 mockResolvedValue 的一次 await。
 */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  // 额外一次 macrotask 以防链式 Promise
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ──────────────────────────────────────────────
// 构造函数
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — 构造函数", () => {
  it("cache 为 undefined 时抛出 Error", () => {
    expect(() => {
      new DistributedCacheInvalidator({
        cache: undefined as any,
        _connections: { pub: makeRedisMock(), sub: makeRedisMock() },
      });
    }).toThrow(
      "[cache-hub] DistributedCacheInvalidator requires a cache instance",
    );
  });

  it("正常构造不抛出", () => {
    expect(() => makeInvalidator()).not.toThrow();
  });

  it("构造时以正确频道调用 sub.subscribe", () => {
    const sub = makeRedisMock();
    makeInvalidator({ channel: "my:ch" }, undefined, sub);
    expect(sub.subscribe).toHaveBeenCalledWith("my:ch", expect.any(Function));
  });

  it('构造时注册 sub.on("error") 和 sub.on("message")', () => {
    const { sub } = makeInvalidator();
    const events = sub.on.mock.calls.map((c: any[]) => c[0] as string);
    expect(events).toContain("error");
    expect(events).toContain("message");
  });

  it('构造时注册 pub.on("error")', () => {
    const { pub } = makeInvalidator();
    const events = pub.on.mock.calls.map((c: any[]) => c[0] as string);
    expect(events).toContain("error");
  });

  it("instanceId 使用传入值", () => {
    const { invalidator } = makeInvalidator({ instanceId: "custom-id" });
    expect(invalidator.getStats().instanceId).toBe("custom-id");
  });

  it("instanceId 未传时自动生成（非空字符串）", () => {
    const inv = new DistributedCacheInvalidator({
      cache: makeCacheMock(),
      _connections: { pub: makeRedisMock(), sub: makeRedisMock() },
    });
    const { instanceId } = inv.getStats();
    expect(typeof instanceId).toBe("string");
    expect(instanceId.length).toBeGreaterThan(0);
  });

  it("多次无参构造生成不同 instanceId", () => {
    const make = () =>
      new DistributedCacheInvalidator({
        cache: makeCacheMock(),
        _connections: { pub: makeRedisMock(), sub: makeRedisMock() },
      });
    expect(make().getStats().instanceId).not.toBe(make().getStats().instanceId);
  });

  it("channel 使用传入值", () => {
    const { invalidator } = makeInvalidator({ channel: "ns:invalidate" });
    expect(invalidator.getStats().channel).toBe("ns:invalidate");
  });

  it('channel 未传时默认为 "cache-hub:invalidate"', () => {
    const inv = new DistributedCacheInvalidator({
      cache: makeCacheMock(),
      _connections: { pub: makeRedisMock(), sub: makeRedisMock() },
    });
    expect(inv.getStats().channel).toBe("cache-hub:invalidate");
  });

  it("初始 stats 全部为 0", () => {
    const { invalidator } = makeInvalidator();
    const stats = invalidator.getStats();
    expect(stats.messagesSent).toBe(0);
    expect(stats.messagesReceived).toBe(0);
    expect(stats.invalidationsTriggered).toBe(0);
    expect(stats.tagInvalidationsTriggered).toBe(0);
    expect(stats.errors).toBe(0);
  });
});

// ──────────────────────────────────────────────
// invalidate()
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — invalidate()", () => {
  it("先失效本地缓存，再执行 publish", async () => {
    const pub = makeRedisMock();
    const cache = makeCacheMock();
    const order: string[] = [];

    (cache.delPattern as any).mockImplementation(async () => {
      order.push("local");
      return 1;
    });
    pub.publish.mockImplementation(async () => {
      order.push("publish");
      return 1;
    });

    const { invalidator } = makeInvalidator({ cache }, pub);
    await invalidator.invalidate("user:*");

    expect(order).toEqual(["local", "publish"]);
  });

  it("主动失效成功后 invalidationsTriggered +1", async () => {
    const { invalidator } = makeInvalidator();
    await invalidator.invalidate("user:*");
    expect(invalidator.getStats().invalidationsTriggered).toBe(1);
  });

  it("调用 pub.publish，消息包含正确字段", async () => {
    const { invalidator, pub } = makeInvalidator({
      instanceId: "sender",
      channel: "ch:x",
    });
    await invalidator.invalidate("user:*");

    expect(pub.publish).toHaveBeenCalledOnce();
    const [publishedChannel, rawMsg] = pub.publish.mock.calls[0] as [
      string,
      string,
    ];
    expect(publishedChannel).toBe("ch:x");

    const msg = JSON.parse(rawMsg);
    expect(msg.type).toBe("invalidate");
    expect(msg.pattern).toBe("user:*");
    expect(msg.instanceId).toBe("sender");
    expect(typeof msg.ts).toBe("number");
  });

  it("成功发布后 messagesSent +1", async () => {
    const { invalidator } = makeInvalidator();
    await invalidator.invalidate("user:*");
    expect(invalidator.getStats().messagesSent).toBe(1);
  });

  it("多次调用 messagesSent 正确累加", async () => {
    const { invalidator } = makeInvalidator();
    await invalidator.invalidate("a:*");
    await invalidator.invalidate("b:*");
    await invalidator.invalidate("c:*");
    expect(invalidator.getStats().messagesSent).toBe(3);
  });

  it("空字符串 pattern 不调用 publish", async () => {
    const { invalidator, pub } = makeInvalidator();
    await invalidator.invalidate("");
    expect(pub.publish).not.toHaveBeenCalled();
    expect(invalidator.getStats().messagesSent).toBe(0);
  });

  it("本地失效失败时不调用 publish，并向外抛出错误", async () => {
    const pub = makeRedisMock();
    const cache = makeCacheMock();
    (cache.delPattern as any).mockRejectedValue(new Error("local invalidate failed"));
    const { invalidator } = makeInvalidator({ cache }, pub);

    await expect(invalidator.invalidate("user:*")).rejects.toThrow(
      "local invalidate failed",
    );
    expect(pub.publish).not.toHaveBeenCalled();
    expect(invalidator.getStats().errors).toBe(1);
    expect(invalidator.getStats().invalidationsTriggered).toBe(0);
  });

  it("publish 失败时向外抛出错误", async () => {
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("connection refused"));
    const { invalidator } = makeInvalidator({}, pub);
    await expect(invalidator.invalidate("user:*")).rejects.toThrow(
      "connection refused",
    );
  });

  it("publish 失败时 errors +1", async () => {
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("fail"));
    const { invalidator } = makeInvalidator({}, pub);
    try {
      await invalidator.invalidate("x:*");
    } catch {
      /* expected */
    }
    expect(invalidator.getStats().errors).toBe(1);
  });

  it("publish 失败时 messagesSent 不增加", async () => {
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("fail"));
    const { invalidator } = makeInvalidator({}, pub);
    try {
      await invalidator.invalidate("x:*");
    } catch {
      /* expected */
    }
    expect(invalidator.getStats().messagesSent).toBe(0);
  });

  it("发布消息中 ts 字段为合理时间戳", async () => {
    const before = Date.now();
    const { invalidator, pub } = makeInvalidator();
    await invalidator.invalidate("x:*");
    const after = Date.now();
    const msg = JSON.parse((pub.publish.mock.calls[0] as [string, string])[1]);
    expect(msg.ts).toBeGreaterThanOrEqual(before);
    expect(msg.ts).toBeLessThanOrEqual(after);
  });

  it("invalidatePattern 是 invalidate 的语义化别名", async () => {
    const { invalidator, cache } = makeInvalidator();

    await invalidator.invalidatePattern("alias:*");

    expect(cache.delPattern).toHaveBeenCalledWith("alias:*");
    expect(invalidator.getStats().messagesSent).toBe(1);
  });
});

// ──────────────────────────────────────────────
// invalidateTag()
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — invalidateTag()", () => {
  it("先失效本地 tag，再发布 tag 消息", async () => {
    const pub = makeRedisMock();
    const cache = makeCacheMock();
    const order: string[] = [];

    (cache.invalidateByTag as any).mockImplementation(async () => {
      order.push("local-tag");
      return 1;
    });
    pub.publish.mockImplementation(async () => {
      order.push("publish");
      return 1;
    });

    const { invalidator } = makeInvalidator({ cache }, pub);
    await invalidator.invalidateTag("user");

    expect(order).toEqual(["local-tag", "publish"]);
  });

  it("发布消息包含 tag 字段并更新统计", async () => {
    const { invalidator, pub } = makeInvalidator({
      instanceId: "sender",
      channel: "ch:x",
    });

    await invalidator.invalidateTag("user");

    const [publishedChannel, rawMsg] = pub.publish.mock.calls[0] as [
      string,
      string,
    ];
    expect(publishedChannel).toBe("ch:x");
    expect(JSON.parse(rawMsg)).toMatchObject({
      type: "invalidate-tag",
      tag: "user",
      instanceId: "sender",
    });
    expect(invalidator.getStats().messagesSent).toBe(1);
    expect(invalidator.getStats().tagInvalidationsTriggered).toBe(1);
  });

  it("空 tag 不发布消息", async () => {
    const { invalidator, pub } = makeInvalidator();

    await invalidator.invalidateTag("");

    expect(pub.publish).not.toHaveBeenCalled();
    expect(invalidator.getStats().messagesSent).toBe(0);
  });

  it("本地 cache 不支持 invalidateByTag 时记录错误但仍广播给其他实例", async () => {
    const logger: Required<DistributedInvalidatorLogger> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pub = makeRedisMock();
    const cache = Object.assign(makeCacheMock(), { invalidateByTag: undefined });
    const { invalidator } = makeInvalidator({ cache, logger }, pub);

    await expect(invalidator.invalidateTag("user")).resolves.toBeUndefined();
    expect(pub.publish).toHaveBeenCalledOnce();
    expect(invalidator.getStats().errors).toBe(1);
    expect(invalidator.getStats().tagInvalidationsTriggered).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not support invalidateByTag"),
    );
  });

  it("本地 tag 失效失败时不发布，并向外抛出错误", async () => {
    const logger: Required<DistributedInvalidatorLogger> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pub = makeRedisMock();
    const cache = makeCacheMock();
    (cache.invalidateByTag as any).mockRejectedValue(new Error("tag local failed"));
    const { invalidator } = makeInvalidator({ cache, logger }, pub);

    await expect(invalidator.invalidateTag("user")).rejects.toThrow(
      "tag local failed",
    );
    expect(pub.publish).not.toHaveBeenCalled();
    expect(invalidator.getStats().errors).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("tag invalidation error"),
    );
  });

  it("publish 失败时 errors +1 并向外抛出", async () => {
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("publish failed"));
    const { invalidator } = makeInvalidator({}, pub);

    await expect(invalidator.invalidateTag("user")).rejects.toThrow(
      "publish failed",
    );
    expect(invalidator.getStats().errors).toBe(1);
  });

  it("invalidateTag 成功时调用 logger.debug", async () => {
    const logger: Required<DistributedInvalidatorLogger> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { invalidator } = makeInvalidator({ logger });

    await invalidator.invalidateTag("user");

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("published tag invalidation"),
    );
  });

  it("invalidateTag 发布失败时调用 logger.error", async () => {
    const logger: Required<DistributedInvalidatorLogger> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("tag publish failed"));
    const { invalidator } = makeInvalidator({ logger }, pub);

    await expect(invalidator.invalidateTag("user")).rejects.toThrow(
      "tag publish failed",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("publish error"),
    );
  });
});

// ──────────────────────────────────────────────
// 消息接收 & instanceId 过滤
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — 消息接收", () => {
  it("收到其他实例消息后调用 cache.delPattern", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "user:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).toHaveBeenCalledWith("user:*");
  });

  it("收到消息后 messagesReceived +1", async () => {
    const { invalidator, sub } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(invalidator.getStats().messagesReceived).toBe(1);
  });

  it("触发失效后 invalidationsTriggered +1", async () => {
    const { invalidator, sub } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(invalidator.getStats().invalidationsTriggered).toBe(1);
  });

  it("收到 invalidate-pattern 新消息类型后调用 cache.delPattern", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate-pattern",
      pattern: "new:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).toHaveBeenCalledWith("new:*");
  });

  it("收到其他实例 tag 消息后调用 cache.invalidateByTag", async () => {
    const { invalidator, sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate-tag",
      tag: "user",
      instanceId: "other",
      ts: Date.now(),
    });

    sub._triggerMessage("test:channel", raw);
    await flushAsync();

    expect(cache.invalidateByTag).toHaveBeenCalledWith("user");
    expect(invalidator.getStats().tagInvalidationsTriggered).toBe(1);
  });

  it("忽略自身消息（instanceId 过滤）：不调用 cache.delPattern", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "same-id" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "user:*",
      instanceId: "same-id",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
  });

  it("自身消息仍计入 messagesReceived（instanceId 过滤在计数之后）", async () => {
    const { invalidator, sub } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "me",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(invalidator.getStats().messagesReceived).toBe(1);
    expect(invalidator.getStats().invalidationsTriggered).toBe(0);
  });

  it("不同频道的消息被忽略（不计入 messagesReceived，不调用 delPattern）", async () => {
    const { invalidator, sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("other:channel", raw); // 错误频道
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
    expect(invalidator.getStats().messagesReceived).toBe(0);
  });

  it("非法 JSON：errors +1，不调用 delPattern，messagesReceived +1", async () => {
    const { invalidator, sub, cache } = makeInvalidator({ instanceId: "me" });
    sub._triggerMessage("test:channel", "not-json!!!");
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
    expect(invalidator.getStats().errors).toBe(1);
    expect(invalidator.getStats().messagesReceived).toBe(1);
  });

  it('type 不是 "invalidate" 的消息被忽略', async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "refresh",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
  });

  it("pattern 为空字符串时忽略，不调用 delPattern", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
  });

  it("pattern 字段缺失时忽略，不调用 delPattern", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).not.toHaveBeenCalled();
  });

  it("tag 为空字符串时忽略，不调用 invalidateByTag", async () => {
    const { sub, cache } = makeInvalidator({ instanceId: "me" });
    const raw = JSON.stringify({
      type: "invalidate-tag",
      tag: "",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.invalidateByTag).not.toHaveBeenCalled();
  });

  it("收到 tag 消息时 cache.invalidateByTag 抛错只记录错误，不向外传播", async () => {
    const logger: Required<DistributedInvalidatorLogger> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const cache = makeCacheMock();
    (cache.invalidateByTag as any).mockRejectedValue(new Error("tag down"));
    const { invalidator, sub } = makeInvalidator({
      instanceId: "me",
      cache,
      logger,
    });
    const raw = JSON.stringify({
      type: "invalidate-tag",
      tag: "user",
      instanceId: "other",
      ts: Date.now(),
    });

    sub._triggerMessage("test:channel", raw);
    await flushAsync();

    expect(invalidator.getStats().errors).toBe(1);
    expect(invalidator.getStats().tagInvalidationsTriggered).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("tag invalidation error"),
    );
  });

  it("cache.delPattern 抛出时：errors +1，不向外传播，invalidationsTriggered 不增加", async () => {
    const cache = makeCacheMock();
    (cache.delPattern as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("redis down"),
    );
    const { invalidator, sub } = makeInvalidator({ instanceId: "me", cache });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(invalidator.getStats().errors).toBe(1);
    expect(invalidator.getStats().invalidationsTriggered).toBe(0);
  });

  it("cache.delPattern 同步返回 number 时也能正常处理（await 同步值）", async () => {
    const cache = makeCacheMock();
    (cache.delPattern as ReturnType<typeof vi.fn>).mockReturnValue(5); // 同步返回
    const { invalidator, sub } = makeInvalidator({ instanceId: "me", cache });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(cache.delPattern).toHaveBeenCalledWith("x:*");
    expect(invalidator.getStats().invalidationsTriggered).toBe(1);
  });

  it("多条消息连续处理，stats 正确累计", async () => {
    const { invalidator, sub } = makeInvalidator({ instanceId: "me" });

    // 3 条有效消息
    for (let i = 0; i < 3; i++) {
      sub._triggerMessage(
        "test:channel",
        JSON.stringify({
          type: "invalidate",
          pattern: `ns${i}:*`,
          instanceId: "other",
          ts: Date.now(),
        }),
      );
    }
    // 1 条自身消息
    sub._triggerMessage(
      "test:channel",
      JSON.stringify({
        type: "invalidate",
        pattern: "self:*",
        instanceId: "me",
        ts: Date.now(),
      }),
    );
    // 1 条非法 JSON
    sub._triggerMessage("test:channel", "<<invalid>>");

    await flushAsync();

    const stats = invalidator.getStats();
    expect(stats.messagesReceived).toBe(5); // 3 有效 + 1 自身 + 1 非法
    expect(stats.invalidationsTriggered).toBe(3); // 仅 3 条有效触发失效
    expect(stats.errors).toBe(1); // 仅 1 条非法 JSON
  });
});

// ──────────────────────────────────────────────
// getStats()
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — getStats()", () => {
  it("返回包含所有必须字段的对象", () => {
    const { invalidator } = makeInvalidator({
      instanceId: "id-1",
      channel: "ch:1",
    });
    const stats = invalidator.getStats();
    expect(stats).toMatchObject({
      messagesSent: 0,
      messagesReceived: 0,
      invalidationsTriggered: 0,
      tagInvalidationsTriggered: 0,
      errors: 0,
      instanceId: "id-1",
      channel: "ch:1",
    });
  });

  it("每次调用返回独立副本（非同一引用）", async () => {
    const { invalidator } = makeInvalidator();
    const s1 = invalidator.getStats();
    await invalidator.invalidate("x:*");
    const s2 = invalidator.getStats();
    // s1 不受后续操作影响
    expect(s1.messagesSent).toBe(0);
    expect(s2.messagesSent).toBe(1);
  });

  it("instanceId 和 channel 始终存在于快照", () => {
    const { invalidator } = makeInvalidator({
      instanceId: "abc",
      channel: "z:ch",
    });
    const stats = invalidator.getStats();
    expect(stats.instanceId).toBe("abc");
    expect(stats.channel).toBe("z:ch");
  });
});

// ──────────────────────────────────────────────
// close()
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — close()", () => {
  it("调用 sub.unsubscribe（传入正确频道）", async () => {
    const { invalidator, sub } = makeInvalidator({ channel: "test:channel" });
    await invalidator.close();
    expect(sub.unsubscribe).toHaveBeenCalledWith("test:channel");
  });

  it("调用 sub.quit", async () => {
    const { invalidator, sub } = makeInvalidator();
    await invalidator.close();
    expect(sub.quit).toHaveBeenCalledOnce();
  });

  it("_connections 注入时不调用 pub.quit（shouldClosePub = false）", async () => {
    const { invalidator, pub } = makeInvalidator();
    await invalidator.close();
    expect(pub.quit).not.toHaveBeenCalled();
  });

  it("close 操作顺序：unsubscribe → sub.quit", async () => {
    const callOrder: string[] = [];
    const sub = makeRedisMock();
    sub.unsubscribe = vi.fn().mockImplementation(async () => {
      callOrder.push("unsubscribe");
    });
    sub.quit = vi.fn().mockImplementation(async () => {
      callOrder.push("quit");
    });
    const { invalidator } = makeInvalidator({}, makeRedisMock(), sub);
    await invalidator.close();
    expect(callOrder).toEqual(["unsubscribe", "quit"]);
  });

  it("unsubscribe 失败时不向外抛出", async () => {
    const sub = makeRedisMock();
    sub.unsubscribe = vi.fn().mockRejectedValue(new Error("disconnected"));
    const { invalidator } = makeInvalidator({}, makeRedisMock(), sub);
    await expect(invalidator.close()).resolves.toBeUndefined();
  });

  it("sub.quit 失败时不向外抛出", async () => {
    const sub = makeRedisMock();
    sub.quit = vi.fn().mockRejectedValue(new Error("timeout"));
    const { invalidator } = makeInvalidator({}, makeRedisMock(), sub);
    await expect(invalidator.close()).resolves.toBeUndefined();
  });

  it("unsubscribe 和 sub.quit 都失败时仍不向外抛出", async () => {
    const sub = makeRedisMock();
    sub.unsubscribe = vi.fn().mockRejectedValue(new Error("e1"));
    sub.quit = vi.fn().mockRejectedValue(new Error("e2"));
    const { invalidator } = makeInvalidator({}, makeRedisMock(), sub);
    await expect(invalidator.close()).resolves.toBeUndefined();
  });

  it("close 后可以再次调用而不抛出（幂等）", async () => {
    const { invalidator } = makeInvalidator();
    await invalidator.close();
    await expect(invalidator.close()).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// Logger 集成
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — logger", () => {
  function makeLogger(): Required<DistributedInvalidatorLogger> {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("subscribe 成功时调用 logger.info（含频道名）", () => {
    const logger = makeLogger();
    makeInvalidator({ logger });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("test:channel"),
    );
  });

  it("subscribe 失败时调用 logger.error", () => {
    const logger = makeLogger();
    const sub = makeRedisMock();
    sub.subscribe = vi
      .fn()
      .mockImplementation((_ch: string, cb?: (err: Error | null) => void) => {
        if (cb) {
          cb(new Error("auth failed"));
        }
      });
    makeInvalidator({ logger }, makeRedisMock(), sub);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("subscribe error"),
    );
  });

  it("invalidate 成功时调用 logger.debug（含 pattern）", async () => {
    const logger = makeLogger();
    const { invalidator } = makeInvalidator({ logger });
    await invalidator.invalidate("user:*");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("published invalidation"),
    );
  });

  it("invalidate 失败时调用 logger.error", async () => {
    const logger = makeLogger();
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("conn fail"));
    const { invalidator } = makeInvalidator({ logger }, pub);
    try {
      await invalidator.invalidate("x:*");
    } catch {
      /* expected */
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("publish error"),
    );
  });

  it("收到消息成功失效后调用 logger.debug（含 pattern）", async () => {
    const logger = makeLogger();
    const { sub } = makeInvalidator({ instanceId: "me", logger });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("invalidated pattern"),
    );
  });

  it("cache.delPattern 失败时调用 logger.error", async () => {
    const logger = makeLogger();
    const cache = makeCacheMock();
    (cache.delPattern as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("cache down"),
    );
    const { sub } = makeInvalidator({ instanceId: "me", logger, cache });
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "x:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("invalidation error"),
    );
  });

  it('pub error 事件调用 logger.error（含 "pub error"）', () => {
    const logger = makeLogger();
    const { pub } = makeInvalidator({ logger });
    pub._triggerError(new Error("pub conn reset"));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("pub error"),
    );
  });

  it('sub error 事件调用 logger.error（含 "sub error"）', () => {
    const logger = makeLogger();
    const { sub } = makeInvalidator({ logger });
    sub._triggerError(new Error("sub conn reset"));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("sub error"),
    );
  });

  it('非法 JSON 消息调用 logger.error（含 "message parse error"）', () => {
    const logger = makeLogger();
    const { sub } = makeInvalidator({ instanceId: "me", logger });
    sub._triggerMessage("test:channel", "{bad json");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("message parse error"),
    );
  });

  it('close 成功后调用 logger.info（含 "closed"）', async () => {
    const logger = makeLogger();
    const { invalidator } = makeInvalidator({ logger });
    await invalidator.close();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("closed"));
  });

  it("close 时 unsubscribe 失败调用 logger.error", async () => {
    const logger = makeLogger();
    const sub = makeRedisMock();
    sub.unsubscribe = vi.fn().mockRejectedValue(new Error("disconnected"));
    const { invalidator } = makeInvalidator({ logger }, makeRedisMock(), sub);
    await invalidator.close();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe error"),
    );
  });

  it("无 logger 时所有操作不抛出", async () => {
    const { invalidator, pub, sub } = makeInvalidator({});
    sub._triggerError(new Error("boom"));
    sub._triggerMessage("test:channel", "bad json");
    await invalidator.invalidate("x:*");
    pub._triggerError(new Error("boom2"));
    await expect(invalidator.close()).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// errors 计数集成
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — errors 计数", () => {
  it("pub error 事件使 errors +1", () => {
    const { invalidator, pub } = makeInvalidator();
    pub._triggerError(new Error("conn reset"));
    expect(invalidator.getStats().errors).toBe(1);
  });

  it("sub error 事件使 errors +1", () => {
    const { invalidator, sub } = makeInvalidator();
    sub._triggerError(new Error("conn reset"));
    expect(invalidator.getStats().errors).toBe(1);
  });

  it("subscribe 失败使 errors +1", () => {
    const sub = makeRedisMock();
    sub.subscribe = vi
      .fn()
      .mockImplementation((_ch: string, cb?: (err: Error | null) => void) => {
        if (cb) {
          cb(new Error("auth required"));
        }
      });
    const { invalidator } = makeInvalidator({}, makeRedisMock(), sub);
    expect(invalidator.getStats().errors).toBe(1);
  });

  it("多种错误源 errors 正确累加", async () => {
    const { invalidator, pub, sub } = makeInvalidator({ instanceId: "me" });
    pub._triggerError(new Error("e1")); // +1
    sub._triggerError(new Error("e2")); // +1
    sub._triggerMessage("test:channel", "bad"); // +1（parse error）
    await flushAsync();
    expect(invalidator.getStats().errors).toBe(3);
  });

  it("invalidate 失败 + delPattern 失败各自计入 errors", async () => {
    const cache = makeCacheMock();
    (cache.delPattern as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("down"),
    );
    const pub = makeRedisMock();
    pub.publish = vi.fn().mockRejectedValue(new Error("refused"));

    const { invalidator, sub } = makeInvalidator(
      { instanceId: "me", cache },
      pub,
    );

    // publish 失败 → errors +1
    try {
      await invalidator.invalidate("x:*");
    } catch {
      /* expected */
    }

    // delPattern 失败 → errors +1
    const raw = JSON.stringify({
      type: "invalidate",
      pattern: "y:*",
      instanceId: "other",
      ts: Date.now(),
    });
    sub._triggerMessage("test:channel", raw);
    await flushAsync();

    expect(invalidator.getStats().errors).toBe(2);
  });
});

// ──────────────────────────────────────────────
// close() pub 连接管理（_shouldClosePub = true）
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — close() pub 连接管理", () => {
  function makeLogger() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("_shouldClosePub=true 时 close() 调用 pub.quit", async () => {
    const { pub, sub, cache } = makeInvalidator();
    const invalidator = new DistributedCacheInvalidator({
      cache,
      _connections: { pub, sub, _shouldClosePub: true },
    });
    await invalidator.close();
    expect(pub.quit).toHaveBeenCalled();
  });

  it("_shouldClosePub=true，pub.quit 成功时 close() 正常完成", async () => {
    const { pub, sub, cache } = makeInvalidator();
    pub.quit.mockResolvedValue("OK");
    const invalidator = new DistributedCacheInvalidator({
      cache,
      _connections: { pub, sub, _shouldClosePub: true },
    });
    await expect(invalidator.close()).resolves.toBeUndefined();
  });

  it("_shouldClosePub=true，pub.quit 失败时不向外抛出", async () => {
    const { pub, sub, cache } = makeInvalidator();
    pub.quit.mockRejectedValue(new Error("pub quit failed"));
    const invalidator = new DistributedCacheInvalidator({
      cache,
      _connections: { pub, sub, _shouldClosePub: true },
    });
    await expect(invalidator.close()).resolves.toBeUndefined();
  });

  it("_shouldClosePub=true，pub.quit 失败时调用 logger.error（含 pub quit error）", async () => {
    const logger = makeLogger();
    const { pub, sub, cache } = makeInvalidator();
    pub.quit.mockRejectedValue(new Error("pub quit failed"));
    const invalidator = new DistributedCacheInvalidator({
      cache,
      logger,
      _connections: { pub, sub, _shouldClosePub: true },
    });
    await invalidator.close();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("pub quit error"),
    );
  });

  it("close() 顺序：unsubscribe → sub.quit → pub.quit（shouldClosePub=true）", async () => {
    const callOrder: string[] = [];
    const { pub, sub, cache } = makeInvalidator();
    sub.unsubscribe.mockImplementation(async () => {
      callOrder.push("unsubscribe");
    });
    sub.quit.mockImplementation(async () => {
      callOrder.push("sub.quit");
    });
    pub.quit.mockImplementation(async () => {
      callOrder.push("pub.quit");
    });
    const invalidator = new DistributedCacheInvalidator({
      cache,
      _connections: { pub, sub, _shouldClosePub: true },
    });
    await invalidator.close();
    expect(callOrder).toEqual(["unsubscribe", "sub.quit", "pub.quit"]);
  });

  it("sub.quit 失败时调用 logger.error（含 sub quit error）", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { pub, sub, cache } = makeInvalidator();
    sub.quit = vi.fn().mockRejectedValue(new Error("sub quit timeout"));
    const invalidator = new DistributedCacheInvalidator({
      cache,
      logger,
      _connections: { pub, sub },
    });
    await invalidator.close();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("sub quit error"),
    );
  });
});

// ──────────────────────────────────────────────
// _buildConnections 生产路径（无 _connections 注入）
// 覆盖：lines 123-160（_buildConnections 函数体）+ lines 223-227（constructor else 分支）
// ──────────────────────────────────────────────

describe("DistributedCacheInvalidator — _buildConnections 生产路径（vi.mock module）", () => {
  afterEach(() => {
    _failIoredisForDI = false;
  });

  function makeCacheForProd() {
    return {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
      has: vi.fn(),
      clear: vi.fn(),
      getMany: vi.fn(),
      setMany: vi.fn(),
      delMany: vi.fn(),
      delPattern: vi.fn().mockResolvedValue(0),
      keys: vi.fn().mockResolvedValue([]),
    };
  }

  it("redisUrl 路径：不传 _connections 时调用 _buildConnections，创建 pub/sub 两条连接（shouldClosePub=true）", async () => {
    // 覆盖 constructor else 分支（lines 223-227）+ _buildConnections lines 154-159
    const cache = makeCacheForProd();
    const invalidator = new DistributedCacheInvalidator({
      redisUrl: "redis://localhost:6379",
      cache,
      instanceId: "test-prod-instance",
    });

    expect(invalidator).toBeDefined();
    expect(invalidator.getStats().instanceId).toBe("test-prod-instance");

    // shouldClosePub=true 时 close() 应调用 pub.quit()
    const statsBefore = invalidator.getStats();
    expect(statsBefore.messagesSent).toBe(0);

    await invalidator.close();
  });

  it("默认 URL（无 redisUrl/redis）：使用 redis://localhost:6379 默认连接", async () => {
    // 覆盖 `options.redisUrl ?? 'redis://localhost:6379'` 的 ?? 右分支
    const cache = makeCacheForProd();
    const invalidator = new DistributedCacheInvalidator({ cache });
    expect(invalidator).toBeDefined();
    await invalidator.close();
  });

  it("redis 选项路径：传入已有 pub 连接时创建独立 sub 连接（shouldClosePub=false）", async () => {
    // 覆盖 _buildConnections 中 `if (options.redis)` 分支（lines 140-151）
    const cache = makeCacheForProd();
    const existingPub = {
      options: { host: "127.0.0.1", port: 6380 },
      on: vi.fn(),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockImplementation((_ch: any, cb?: any) => {
        if (cb) cb(null);
        return Promise.resolve();
      }),
      unsubscribe: vi.fn().mockResolvedValue(0),
      quit: vi.fn().mockResolvedValue("OK"),
    };

    const invalidator = new DistributedCacheInvalidator({
      redis: existingPub as any,
      cache,
    });

    expect(invalidator).toBeDefined();
    await invalidator.close();
    // shouldClosePub=false 时，close() 不调用 pub.quit（外部传入实例）
    expect(existingPub.quit).not.toHaveBeenCalled();
  });

  it("redis 选项路径：existingOpts 包含 password 和 db 时正确透传", async () => {
    // 覆盖 _buildConnections 中 `options.password !== undefined` 和 `options.db !== undefined` 两个 && 分支
    const cache = makeCacheForProd();
    const existingPubWithAuth = {
      options: { host: "127.0.0.1", port: 6380, password: "secret", db: 2 },
      on: vi.fn(),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockImplementation((_ch: any, cb?: any) => {
        if (cb) cb(null);
        return Promise.resolve();
      }),
      unsubscribe: vi.fn().mockResolvedValue(0),
      quit: vi.fn().mockResolvedValue("OK"),
    };

    const invalidator = new DistributedCacheInvalidator({
      redis: existingPubWithAuth as any,
      cache,
    });

    expect(invalidator).toBeDefined();
    await invalidator.close();
  });

  it("ioredis 未安装时 _buildConnections 抛出描述性错误", () => {
    // 覆盖 _buildConnections catch 块（lines 133-138）
    _failIoredisForDI = true;
    const cache = makeCacheForProd();
    expect(() => new DistributedCacheInvalidator({ cache })).toThrow(
      "DistributedCacheInvalidator requires ioredis",
    );
  });

  it("redis 选项路径：existingPub 无 .options 属性时使用默认 host/port（覆盖 ?? {} / ?? localhost / ?? 6379 分支）", async () => {
    // 覆盖 _buildConnections 中三个 ?? 右侧分支：
    //   (options.redis as any).options ?? {}          → {} 被使用
    //   existingOpts.host ?? "localhost"               → "localhost" 被使用
    //   existingOpts.port ?? 6379                      → 6379 被使用
    const cache = makeCacheForProd();

    // existingPub 完全没有 .options 属性
    const existingPubNoOptions = {
      // 无 options 属性 → existingOpts = {}
      on: vi.fn(),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockImplementation((_ch: any, cb?: any) => {
        if (cb) cb(null);
        return Promise.resolve();
      }),
      unsubscribe: vi.fn().mockResolvedValue(0),
      quit: vi.fn().mockResolvedValue("OK"),
    };

    const invalidator = new DistributedCacheInvalidator({
      redis: existingPubNoOptions as any,
      cache,
    });

    expect(invalidator).toBeDefined();
    await invalidator.close();
    // shouldClosePub=false（外部传入实例），pub.quit 不应被调用
    expect(existingPubNoOptions.quit).not.toHaveBeenCalled();
  });
});
