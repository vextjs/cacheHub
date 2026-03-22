import { defineConfig } from "rspress/config";

export default defineConfig({
  root: "website/docs",
  title: "cache-hub",
  description: "零运行时依赖的 Node.js 多层缓存库",
  lang: "zh",
  themeConfig: {
    nav: [
      {
        text: "指南",
        link: "/guide/getting-started",
        activeMatch: "/guide/",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "入门",
          items: [
            {
              text: "快速开始",
              link: "/guide/getting-started",
            },
          ],
        },
        {
          text: "参考",
          items: [
            {
              text: "API 参考",
              link: "/guide/api-reference",
            },
          ],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/vextjs/cacheHub",
      },
    ],
    footer: {
      message: "Released under the MIT License.",
    },
  },
});
