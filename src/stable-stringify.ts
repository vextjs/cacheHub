/**
 * 稳定序列化工具
 * 提取自 monSQLize CacheFactory.stableStringify，解耦 BSON 依赖
 *
 * 来源：技术方案 §4
 */

/**
 * stableStringify 配置选项
 */
export interface StableStringifyOptions {
    /**
     * 自定义序列化钩子，用于处理特殊类型（如 BSON ObjectId）。
     * 返回 string 则使用该字符串作为序列化结果；
     * 返回 undefined 则降级为默认序列化逻辑。
     */
    customSerializer?: (value: unknown) => string | undefined;
}

/**
 * 将任意值序列化为稳定字符串，可用于缓存键生成。
 *
 * - 对象键按字母顺序排序，确保 `{b:1,a:2}` 与 `{a:2,b:1}` 产生相同结果
 * - NaN 输出固定哨兵字符串 `'"__NaN__"'`，避免与字符串 "NaN" 碰撞导致函数缓存键碰撞
 * - 循环引用输出 `'"[CIRCULAR]"'`（WeakSet 检测）
 * - function / symbol 输出 `'"[UNSUPPORTED]"'`
 * - Date 输出 ISO 字符串
 * - RegExp 输出 toString() 结果
 *
 * @param value - 待序列化的值
 * @param options - 可选配置（customSerializer 钩子等）
 * @returns 稳定的 JSON 字符串
 */
export function stableStringify(value: unknown, options?: StableStringifyOptions): string {
    const seen = new WeakSet<object>();
    return _stringify(value, options, seen);
}

/**
 * 递归序列化核心（内部实现）
 */
function _stringify(
    value: unknown,
    options: StableStringifyOptions | undefined,
    seen: WeakSet<object>
): string {
    // 自定义序列化钩子优先（用于 BSON ObjectId 等特殊类型）
    if (options?.customSerializer) {
        const result = options.customSerializer(value);
        if (result !== undefined) {
            return result;
        }
    }

    // null（必须在 object 分支前处理，typeof null === 'object'）
    if (value === null) {
        return 'null';
    }

    // undefined
    if (value === undefined) {
        return 'undefined';
    }

    // NaN：必须输出固定哨兵字符串，不经 JSON.stringify
    // 原因：JSON.stringify(NaN) === 'null'，JSON.stringify('NaN') === '"NaN"'，均不唯一
    if (typeof value === 'number' && Number.isNaN(value)) {
        return '"__NaN__"';
    }

    // 不支持的类型（序列化为固定占位字符串，避免键碰撞）
    if (typeof value === 'function' || typeof value === 'symbol') {
        return '"[UNSUPPORTED]"';
    }

    // Date → ISO 字符串
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }

    // RegExp → toString() 结果（如 "/foo/gi"）
    if (value instanceof RegExp) {
        return JSON.stringify(value.toString());
    }

    // Array（保序递归，循环引用检测）
    if (Array.isArray(value)) {
        if (seen.has(value)) {
            return '"[CIRCULAR]"';
        }
        seen.add(value);
        const parts = value.map(item => _stringify(item, options, seen));
        seen.delete(value);
        return '[' + parts.join(',') + ']';
    }

    // Object（键排序 + 递归，循环引用检测）
    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '"[CIRCULAR]"';
        }
        seen.add(value);
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts = keys.map(k => {
            const serializedKey = JSON.stringify(k);
            const serializedVal = _stringify(
                (value as Record<string, unknown>)[k],
                options,
                seen
            );
            return serializedKey + ':' + serializedVal;
        });
        seen.delete(value);
        return '{' + parts.join(',') + '}';
    }

    // 基本类型（string / number / boolean / bigint）
    return JSON.stringify(value);
}
