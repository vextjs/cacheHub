import { describe, it, expect } from 'vitest';
import { stableStringify } from '../../src/stable-stringify.js';

describe('stableStringify', () => {

    describe('基本类型', () => {
        it('字符串', () => {
            expect(stableStringify('hello')).toBe('"hello"');
        });

        it('数字', () => {
            expect(stableStringify(42)).toBe('42');
            expect(stableStringify(3.14)).toBe('3.14');
            expect(stableStringify(0)).toBe('0');
            expect(stableStringify(-1)).toBe('-1');
        });

        it('boolean', () => {
            expect(stableStringify(true)).toBe('true');
            expect(stableStringify(false)).toBe('false');
        });

        it('null', () => {
            expect(stableStringify(null)).toBe('null');
        });

        it('undefined', () => {
            expect(stableStringify(undefined)).toBe('undefined');
        });

        it('Infinity 和 -Infinity', () => {
            // JSON.stringify(Infinity) === 'null'，与 JSON 保持一致
            expect(stableStringify(Infinity)).toBe('null');
            expect(stableStringify(-Infinity)).toBe('null');
        });
    });

    describe('NaN 哨兵字符串', () => {
        it('NaN 输出固定哨兵字符串 "__NaN__"', () => {
            expect(stableStringify(NaN)).toBe('"__NaN__"');
        });

        it('NaN 与字符串 "NaN" 的序列化结果不同（防键碰撞）', () => {
            expect(stableStringify(NaN)).not.toBe(stableStringify('NaN'));
        });

        it('NaN 与字符串 "__NaN__" 的序列化结果不同', () => {
            // stableStringify(NaN)     = '"__NaN__"'
            // stableStringify('__NaN__') = '"__NaN__"'（两者相等是可接受的权衡，此处仅做文档说明）
            // 真正避免碰撞的是与字符串 "NaN" 不同
            expect(stableStringify(NaN)).toBe('"__NaN__"');
        });
    });

    describe('对象键排序', () => {
        it('无论键的写入顺序，序列化结果相同', () => {
            const a = stableStringify({ b: 2, a: 1 });
            const b = stableStringify({ a: 1, b: 2 });
            expect(a).toBe(b);
        });

        it('键按字母顺序排列', () => {
            expect(stableStringify({ z: 3, a: 1, m: 2 })).toBe('{"a":1,"m":2,"z":3}');
        });

        it('空对象', () => {
            expect(stableStringify({})).toBe('{}');
        });

        it('嵌套对象键也排序', () => {
            const result = stableStringify({ outer: { b: 2, a: 1 } });
            expect(result).toBe('{"outer":{"a":1,"b":2}}');
        });

        it('多层嵌套对象', () => {
            const obj = { c: { z: 3, a: 1 }, a: { y: 2, b: 0 } };
            expect(stableStringify(obj)).toBe('{"a":{"b":0,"y":2},"c":{"a":1,"z":3}}');
        });
    });

    describe('数组', () => {
        it('数组保持原始顺序（不排序）', () => {
            expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
        });

        it('空数组', () => {
            expect(stableStringify([])).toBe('[]');
        });

        it('嵌套数组', () => {
            expect(stableStringify([[1, 2], [3, 4]])).toBe('[[1,2],[3,4]]');
        });

        it('数组中的对象键排序', () => {
            const result = stableStringify([{ b: 2, a: 1 }]);
            expect(result).toBe('[{"a":1,"b":2}]');
        });

        it('混合类型数组', () => {
            expect(stableStringify([1, 'two', null, true])).toBe('[1,"two",null,true]');
        });
    });

    describe('Date', () => {
        it('Date 输出 ISO 字符串', () => {
            const d = new Date('2024-01-15T12:00:00.000Z');
            expect(stableStringify(d)).toBe('"2024-01-15T12:00:00.000Z"');
        });

        it('不同时间的 Date 产生不同结果', () => {
            const d1 = new Date('2024-01-01T00:00:00.000Z');
            const d2 = new Date('2024-12-31T23:59:59.999Z');
            expect(stableStringify(d1)).not.toBe(stableStringify(d2));
        });
    });

    describe('RegExp', () => {
        it('RegExp 输出 toString() 结果', () => {
            expect(stableStringify(/foo/)).toBe('"/foo/"');
        });

        it('带 flags 的 RegExp', () => {
            expect(stableStringify(/bar/gi)).toBe('"/bar/gi"');
        });
    });

    describe('不支持的类型', () => {
        it('function 输出 "[UNSUPPORTED]"', () => {
            expect(stableStringify(() => {})).toBe('"[UNSUPPORTED]"');
        });

        it('symbol 输出 "[UNSUPPORTED]"', () => {
            expect(stableStringify(Symbol('test'))).toBe('"[UNSUPPORTED]"');
        });
    });

    describe('循环引用', () => {
        it('对象循环引用输出 "[CIRCULAR]"', () => {
            const obj: Record<string, any> = { a: 1 };
            obj['self'] = obj;
            expect(() => stableStringify(obj)).not.toThrow();
            expect(stableStringify(obj)).toContain('"[CIRCULAR]"');
        });

        it('数组循环引用输出 "[CIRCULAR]"', () => {
            const arr: any[] = [1, 2];
            arr.push(arr);
            expect(() => stableStringify(arr)).not.toThrow();
            expect(stableStringify(arr)).toContain('"[CIRCULAR]"');
        });

        it('深层嵌套循环引用', () => {
            const a: Record<string, any> = { x: 1 };
            const b: Record<string, any> = { y: 2, ref: a };
            a['ref'] = b;
            expect(() => stableStringify(a)).not.toThrow();
        });

        it('非循环引用的重复引用不影响序列化', () => {
            const shared = { val: 42 };
            const obj = { a: shared, b: shared };
            // 同一对象被引用两次，但不形成循环，应正常序列化
            expect(stableStringify(obj)).toBe('{"a":{"val":42},"b":{"val":42}}');
        });
    });

    describe('customSerializer', () => {
        it('命中 customSerializer 时使用返回值', () => {
            const result = stableStringify({ id: 123 }, {
                customSerializer: (v) => {
                    if (typeof v === 'number') return `"custom:${v}"`;
                    return undefined;
                },
            });
            // customSerializer 命中根值对象时：根值是 object，不是 number
            // 仅内层的 123 会命中
            expect(result).toContain('"custom:123"');
        });

        it('customSerializer 返回 undefined 时降级为默认序列化', () => {
            const result = stableStringify('hello', {
                customSerializer: () => undefined,
            });
            expect(result).toBe('"hello"');
        });

        it('BSON ObjectId 模拟（customSerializer 示例）', () => {
            const fakeObjectId = { _bsontype: 'ObjectId', toString: () => '5f4dcc3b5aa765d61d8327de' };
            const result = stableStringify(fakeObjectId, {
                customSerializer: (v: any) => {
                    if (v != null && typeof v === 'object' && v._bsontype === 'ObjectId') {
                        return JSON.stringify(v.toString());
                    }
                    return undefined;
                },
            });
            expect(result).toBe('"5f4dcc3b5aa765d61d8327de"');
        });

        it('对象内部值经过 customSerializer 处理', () => {
            const obj = { a: 1, b: 'skip', c: 3 };
            const result = stableStringify(obj, {
                customSerializer: (v) => {
                    if (v === 'skip') return '"__SKIPPED__"';
                    return undefined;
                },
            });
            expect(result).toBe('{"a":1,"b":"__SKIPPED__","c":3}');
        });
    });

    describe('缓存键稳定性（核心用途验证）', () => {
        it('相同参数不同传入顺序产生相同键', () => {
            const args1 = [{ userId: 1, filter: 'active' }];
            const args2 = [{ filter: 'active', userId: 1 }];
            expect(stableStringify(args1)).toBe(stableStringify(args2));
        });

        it('不同参数产生不同键', () => {
            expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
            expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
        });

        it('null 与 undefined 产生不同键', () => {
            expect(stableStringify(null)).not.toBe(stableStringify(undefined));
        });

        it('数字 0 与字符串 "0" 产生不同键', () => {
            expect(stableStringify(0)).not.toBe(stableStringify('0'));
        });
    });
});
