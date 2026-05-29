---
pageType: home

hero:
  name: cache-hub
  text: Node.js 多层缓存库
  tagline: 零运行时依赖 · LRU + TTL · 多级联动 · 分布式失效
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: API 参考
      link: /guide/api-reference

features:
  - title: 零运行时依赖
    details: dependencies 永远为空，不会污染你的依赖树。ioredis 作为可选 peerDependency，仅 Redis 功能需要。
    icon: 🚫

  - title: LRU + TTL 内存缓存
    details: 基于 ES6 Map 实现 O(1) 淘汰，支持双重容量限制（条目数 + 内存字节）、惰性过期与周期清理。
    icon: ⚡

  - title: 多级缓存
    details: L1 本地 + L2 远端，自动回填、TTL 保真、超时降级（默认 50ms）、写策略可配，远端故障不影响本地可用性。
    icon: 🏗️

  - title: 函数装饰器
    details: withCache 一行代码缓存任意异步函数，内置并发去重——相同参数的并发调用只执行一次。
    icon: 🎯

  - title: 分布式缓存失效
    details: 基于 Redis Pub/Sub 广播跨实例缓存清除，自动过滤自身消息，适合多节点部署场景。
    icon: 📡

  - title: CJS + ESM 双格式
    details: 支持 require 和 import，多入口按需导入，避免捆绑不需要的模块。100% TypeScript 类型覆盖。
    icon: 📦
---
