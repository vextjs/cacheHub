#!/usr/bin/env node
/**
 * CJS 构建脚本
 *
 * 职责：
 * 1. 运行 tsc -p tsconfig.cjs.json 生成 CJS 产物（允许 TS1343 警告）
 * 2. 将 dist/cjs/ 中所有 .js 文件的 import.meta.url 替换为 __filename
 *    原因：源码使用 createRequire(import.meta.url) 动态加载 ioredis（ESM 语法），
 *    CJS 等效写法为 createRequire(__filename)，两者语义相同
 *
 * 为何不直接改源码：源码需同时支持 ESM（import.meta.url）和 CJS（__filename），
 * post-build 替换是 dual-format 库的标准做法。
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cjsDir = join(root, "dist", "cjs");

// ── Step 1: 运行 tsc ──────────────────────────────────────────────────────────

console.log("[build-cjs] 运行 tsc -p tsconfig.cjs.json ...");

const tscResult = spawnSync("npx", ["tsc", "-p", "tsconfig.cjs.json"], {
  cwd: root,
  encoding: "utf-8",
  shell: true,
});

// TS1343（import.meta 不兼容 CJS module 模式）是预期中的警告；
// 其他非零退出才视为真正失败（如 TS 类型错误、配置错误等）。
if (tscResult.status !== 0 && tscResult.status !== null) {
  const combinedOutput = `${tscResult.stdout ?? ""}${tscResult.stderr ?? ""}`;
  const diagnosticLines = combinedOutput
    .split(/\r?\n/)
    .filter((line) => /error TS\d+:/.test(line));
  const unexpectedDiagnostics = diagnosticLines.filter(
    (line) => !/error TS1343:/.test(line),
  );

  if (unexpectedDiagnostics.length > 0) {
    if (tscResult.stdout) {
      process.stdout.write(tscResult.stdout);
    }
    if (tscResult.stderr) {
      process.stderr.write(tscResult.stderr);
    }
    process.exit(tscResult.status);
  }

  console.warn(
    `[build-cjs] 已忽略 ${diagnosticLines.length} 条预期 TS1343 中间诊断，继续执行 CJS 修补。`,
  );
} else {
  if (tscResult.stdout) {
    process.stdout.write(tscResult.stdout);
  }
  if (tscResult.stderr) {
    process.stderr.write(tscResult.stderr);
  }
}

// ── Step 2: 替换 import.meta.url → __filename ─────────────────────────────────

console.log("[build-cjs] 修补 import.meta.url → __filename ...");

let patchCount = 0;

/**
 * 递归遍历目录，对所有 .js 文件执行替换
 * @param {string} dir
 */
function patchDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`[build-cjs] 无法读取目录 ${dir}，跳过`);
    return;
  }

  for (const name of entries) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      patchDir(fullPath);
    } else if (name.endsWith(".js")) {
      const original = readFileSync(fullPath, "utf-8");
      if (original.includes("import.meta.url")) {
        const patched = original.replace(/import\.meta\.url/g, "__filename");
        writeFileSync(fullPath, patched, "utf-8");
        console.log(`  ✔ ${name}: import.meta.url → __filename`);
        patchCount++;
      }
    }
  }
}

patchDir(cjsDir);

if (patchCount === 0) {
  console.log("[build-cjs] 未发现需要修补的文件");
} else {
  console.log(`[build-cjs] 修补完成，共处理 ${patchCount} 个文件`);
}

console.log("[build-cjs] ✅ CJS 构建完成");
