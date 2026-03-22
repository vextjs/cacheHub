import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/index.ts 是纯 re-export 入口，无可执行逻辑
      // src/types.ts 是纯 TypeScript 接口/类型声明，无可执行代码
      exclude: ["src/index.ts", "src/types.ts"],
      thresholds: {
        statements: 100,
        lines: 100,
        branches: 100,
        functions: 100,
      },
    },
  },
});
