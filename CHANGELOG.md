# 变更日志 (CHANGELOG)

> **说明**: 版本概览索引，详细变更见 [changelogs/](./changelogs/) 目录  
> **最后更新**: 2026-06-03

---

## 📁 文件说明

| 文件/目录 | 用途 | 关系 |
|----------|------|------|
| `CHANGELOG.md` | 版本概览索引 | 本文件，仅存储版本摘要表，保持简洁 |
| `changelogs/` | 详细变更 | 每个版本一个文件，包含完整变更内容 + 后续补丁 |

**设计理念**:
- 本文件（CHANGELOG.md）作为**纯索引**，快速了解版本历史，永远不膨胀
- `changelogs/vX.Y.Z.md` 作为**详情**，记录完整变更内容 + 后续补丁
- 所有详细变更（核心变更、Bug 修复清单、后续补丁等）**只写入** `changelogs/vX.Y.Z.md`
- 本文件仅更新版本概览表中对应行的摘要文字

---

## 版本概览

| 版本 | 日期 | 变更摘要 | 详细 |
|------|------|---------|------|
| [v2.2.0](./changelogs/v2.2.0.md) | 2026-06-03 | Minor 更新：新增 Redis tag index、跨实例 tag 失效、Redis lease 与 `readThroughWithLease`，支撑响应缓存短 TTL 并发去重 | [查看](./changelogs/v2.2.0.md) |
| [v2.1.0](./changelogs/v2.1.0.md) | 2026-06-01 | Minor 更新：新增 `cache-hub/atomic` 原子状态后端，并扩展 `cache-hub/rate-limit` 的滑窗与桶类 Redis Lua 状态原语 | [查看](./changelogs/v2.1.0.md) |
| [v2.0.0](./changelogs/v2.0.0.md) | 2026-06-01 | Major 更新：Node.js 基线调整为 `>=18.0.0`，新增限流原语、性能优化、benchmark、Redis 真实集成验证与英文默认 README | [查看](./changelogs/v2.0.0.md) |
| [v1.0.3](./changelogs/v1.0.3.md) | 2026-05-30 | Patch 修复：收口多级缓存 TTL 回填、分布式失效、函数缓存精确失效、Redis 批量 key 校验，并移除 website 与 source map 发布产物 | [查看](./changelogs/v1.0.3.md) |
| [v1.0.0](./changelogs/v1.0.0.md) | 2026-03-22 | 🎉 首个正式发布版本。零运行时依赖的 Node.js 多层缓存库，统一工作区所有项目的缓存基础设施 | [查看](./changelogs/v1.0.0.md) |

---

## 变更统计

| 版本 | 新增 | 变更 | 修复 | 移除 |
|------|------|------|------|------|
| v2.2.0 | Redis tag index、`cache-hub/lease`、`readThroughWithLease` | `CacheLike.set` 支持 `CacheSetOptions`，publish workflow 补充 Redis 集成测试 | Redis tag 元数据覆盖清理，短 TTL 并发回源去重 | - |
| v2.1.0 | `cache-hub/atomic`、滑窗/token-bucket/leaky-bucket 状态原语 | fixed-window 内部复用原子后端，README/profile 同步 | Redis 高并发状态更新补齐原子路径 | - |
| v2.0.0 | `cache-hub/rate-limit`、benchmark、中文文档 | Node.js `>=18.0.0`、性能热点优化、README 英文化、package metadata | Redis 集成测试真实验证链 | Node.js 16 支持 |
| v1.0.3 | - | 构建产物精简、README 说明补齐 | 缓存语义与发布前验证链收口 | Rspress website |
| v1.0.0 | 初始版本 | - | - | - |

---

## 维护说明

- **版本策略**: [语义化版本](https://semver.org/lang/zh-CN/)
- **详细变更**: 每个版本的详细变更见 `changelogs/vX.Y.Z.md`
- **后续补丁**: PATCH 级修复追加到对应 `changelogs/vX.Y.0.md` 的"后续补丁"章节（本文件不更新）
- **快速定位**: 使用版本概览表的链接直接跳转
- **本文件定位**: 纯索引，禁止在此展开详细变更内容

---

**最后更新**: 2026-06-03
