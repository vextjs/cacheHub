# Unreleased

## Fixed

- 修复 `MultiLevelCache` 在 L2 命中回填 L1 时丢失剩余 TTL 的问题，避免短 TTL 远端数据被扩展成本地长 TTL 或永久缓存。
- 修复 `DistributedCacheInvalidator.invalidate()` 只广播不先清发送方本地缓存的语义偏差，并同步 README / docs 示例。
- 修复 `MultiLevelCache` 遇到不支持 TTL 查询的远端 `CacheLike` 时不回填 L1 的兼容性回归；TTL-aware 远端保留剩余 TTL，TTL-unaware 远端按 L1 默认 TTL 策略回填。
- 修复 `withCache.invalidateAll()` 前缀删除可能误删同前缀手工键的问题，改为精确删除该包装函数实际写入的 key，并在失效前清理已淘汰/过期的历史 key。
- 修复 `RedisCacheAdapter` 的 `getMany/setMany/delMany` 未统一执行 key 校验的问题。
- 补齐新增缓存语义分支测试，恢复 Statements / Branches / Functions / Lines 全部 100% 覆盖率。
- 优化 CJS 构建脚本日志，隐藏预期 `TS1343` 中间诊断，避免成功构建看起来像失败。
