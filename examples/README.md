# Examples

本目录包含在不同 Node 框架中的最小接入示例（后续补充）：
- express-basic：以 readThrough 包装 DAO 层读操作
- koa-basic：相同思路
- fastify-basic：在插件生命周期创建 cache 实例
- nest-basic：在模块中提供 CacheProvider 注入

运行：
- 仅本地：无需额外依赖
- 启用 Redis：npm i redis 并确保 REDIS_URL 可用
