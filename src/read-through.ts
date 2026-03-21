/**
 * 读穿缓存（Read-Through Cache）
 * 提取自 monSQLize readThrough 模式，增加模块级并发去重
 *
 * 来源：技术方案 §5
 */

import type { CacheLike } from './types.js';

// ── 模块级 inflight 表（跨实例共享，仅用于去重，不影响正确性）──
const __inflight = new Map<string, Promise<any>>();

/**
 * inflight 表上限（防止极端并发场景下内存无限增长）
 * 超限时清理最旧 10% 的条目
 */
const INFLIGHT_MAX_SIZE = 10000;

/**
 * inflight 条目超时兜底：5 分钟后强制清理
 * 防止 fetcher 永久挂起导致后续请求永远复用同一个 rejected Promise
 */
const INFLIGHT_TIMEOUT_MS = 300000;

/**
 * 读穿缓存：先查缓存，未命中则调用 fetcher，并发请求自动去重。
 *
 * 已知边界（undefined 缓存语义）：
 * - readThrough 以 undefined 作为"缓存未命中"的唯一信号
 * - 若 fetcher() 返回 undefined，不写入缓存（否则下次 get 仍返回 undefined，与 miss 无法区分）
 * - 调用层建议：需缓存"有效的空结果"时，fetcher 应返回 null 而非 undefined
 *
 * 跨实例限制：
 * - __inflight 是模块级 Map，不同 cache 实例共用
 * - cache1.readThrough('key', f) 与 cache2.readThrough('key', f) 并发时，cache2 会复用
 *   cache1 的 Promise，但结果仅写入 cache1。这是预期行为（不影响正确性，仅影响去重效率）
 *
 * @param cache  - 目标缓存实例
 * @param ttlMs  - 缓存 TTL（毫秒），<= 0 时直接调用 fetcher（不缓存）
 * @param key    - 缓存键
 * @param fetcher - 数据获取函数，未命中时调用
 * @returns fetcher 的返回值（已缓存或新获取）
 */
export async function readThrough<T>(
    cache: CacheLike,
    ttlMs: number,
    key: string,
    fetcher: () => Promise<T>
): Promise<T> {
    // ttl <= 0：直接穿透，不经过缓存
    if (ttlMs <= 0) {
        return fetcher();
    }

    // 缓存命中：直接返回
    const cached = await cache.get<T>(key);
    if (cached !== undefined) {
        return cached;
    }

    // 并发去重：已有相同 key 的 inflight Promise，复用它
    if (__inflight.has(key)) {
        try {
            return await (__inflight.get(key) as Promise<T>);
        } catch {
            // 复用的 Promise 失败时，回退到重新执行 fetcher
        }
    }

    // 防内存泄漏：超限时清理最旧 10%
    if (__inflight.size >= INFLIGHT_MAX_SIZE) {
        const toDelete = Math.ceil(__inflight.size * 0.1);
        let count = 0;
        for (const k of __inflight.keys()) {
            if (count++ >= toDelete) {
                break;
            }
            __inflight.delete(k);
        }
    }

    // 构造 inflight Promise（写入 + 返回）
    const p = (async (): Promise<T> => {
        const fresh = await fetcher();
        // A04：undefined 不写入缓存，避免与 miss 信号混淆
        if (fresh !== undefined) {
            try {
                await cache.set(key, fresh, ttlMs);
            } catch {
                // 写入失败静默忽略：缓存写入失败不影响调用方获取数据
            }
        }
        return fresh;
    })();

    __inflight.set(key, p);

    // 超时兜底：INFLIGHT_TIMEOUT_MS 后强制清理，防止 fetcher 挂起导致 inflight 永久占用
    const timer = setTimeout(() => {
        __inflight.delete(key);
    }, INFLIGHT_TIMEOUT_MS);

    // 不阻止 Node.js 进程退出
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
    }

    try {
        return await p;
    } finally {
        // 已知边界（设计决策）：fetcher 抛出异常时，此处 delete 可能清除其他并发请求
        // 放入 inflight 的新 Promise（极端并发 + fetcher 异常的罕见场景）。
        // 影响：仅降低去重效率（下一次请求重新触发 fetch），不影响数据正确性。
        __inflight.delete(key);
        clearTimeout(timer);
    }
}
