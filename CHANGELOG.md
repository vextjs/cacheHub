# Changelog

本项目的所有对外可见变更都会记录在本文件中（遵循 Keep a Changelog 与 SemVer）。

## [Unreleased]
### Added
- 初始版本能力：内存缓存（LRU/TTL/惰性过期/统计）、稳定序列化键、命名空间失效、读穿与并发去重。
- 远端 Redis 适配器（可选依赖），支持 PX 毫秒 TTL、SCAN 失效。
- Multi-tier 双层缓存（local+remote），远端命中回填本地（优先剩余 TTL）。
- createCache(mode: local|remote|multi) 一处开关。

### Changed
- （预留）

### Fixed
- （预留）

### Deprecated
- （预留）

### Removed
- （预留）

### Performance
- （预留）

### Security
- （预留）

## [0.1.0] - 2025-09-xx
### Added
- 首个公开版本（同上）。

[Unreleased]: https://github.com/<your-org>/cachehub/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<your-org>/cachehub/releases/tag/v0.1.0
