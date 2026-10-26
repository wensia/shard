import os from "node:os"
import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

/**
 * 网页版端到端：真实的 shard-server（带 test-auth 的调试构建，临时数据目录，导入 vault-golden）+ vite
 *（`/api` 代理到服务器）。运行：`pnpm test:e2e`。
 *
 * 端口避开主工作区与其他 worktree（1420 / 1423 / 1425 / 18788）。origin 必须是域名（服务器要求，
 * 本地用 localhost），浏览器与代理都走 http://localhost:1429。
 */
const SERVER_PORT = 18795
const WEB_PORT = 1429
const ORIGIN = `http://localhost:${WEB_PORT}`
const DATA_DIR = path.join(os.tmpdir(), `shard-e2e-${SERVER_PORT}`)
const BROWSER = process.env.SHARD_E2E_BROWSER === "webkit" ? "webkit" : "chromium"

// 用例在跑完后检查服务器数据目录里有没有明文（worker 进程会重新读这个文件，路径必须确定）。
process.env.SHARD_E2E_DATA_DIR = DATA_DIR

const server = [
  "cargo build -p shard-server --features test-auth",
  `rm -rf '${DATA_DIR}'`,
  `mkdir -p '${DATA_DIR}'`,
  `target/debug/shard-server import --data-dir '${DATA_DIR}' --vault tests/fixtures/vault-golden`,
  `exec target/debug/shard-server serve --data-dir '${DATA_DIR}' --origin ${ORIGIN} --listen 127.0.0.1:${SERVER_PORT}`,
].join(" && ")

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: "line",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: ORIGIN,
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: server,
      url: `http://127.0.0.1:${SERVER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `bash scripts/build-lockbox-wasm.sh --if-stale && pnpm exec vite --port ${WEB_PORT} --strictPort`,
      env: { SHARD_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}` },
      url: ORIGIN,
      reuseExistingServer: false,
      timeout: 600_000,
    },
  ],
  // 一次只跑一种浏览器（用例共用一个服务器数据目录）：SHARD_E2E_BROWSER=webkit pnpm test:e2e 跑 WebKit。
  projects: [
    {
      name: BROWSER,
      use: {
        ...devices[BROWSER === "webkit" ? "Desktop Safari" : "Desktop Chrome"],
        locale: "zh-CN",
        viewport: { height: 800, width: 1280 },
      },
    },
  ],
})
