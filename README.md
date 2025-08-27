# cacheHub

一个面向 Node.js 的多层缓存（Multi-tier Cache）库：开箱即用的本地内存缓存 + 可选远端缓存（Redis），支持双重缓存模式、命名空间精准失效与稳定序列化键，并提供读穿（read-through）与并发去重。可无侵入接入任何 Node 服务端或库。

- English: A tiny multi-tier cache hub for Node.js: in-memory + optional Redis, namespace invalidation, stable keys, and read-through with in-flight dedupe.


## 状态与路线图
参见 ./STATUS.md。

## 兼容性
- Node LTS（>=16）
- CJS/ESM 条件导出（规划中）
- Redis：redis@^4（remote/multi 模式时才需要；未安装会提示或自动降级）

## 许可证
MIT，见 ./LICENSE。
