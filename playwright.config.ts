import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  forbidOnly: true,
  reporter: "line",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    // Historical component fixtures omit the desktop connection protocol. Only
    // this explicit DEV test server may render those legacy component harnesses.
    env: { VITE_SHARD_LEGACY_UI_TESTS: "1" },
    reuseExistingServer: true,
    timeout: 120_000,
    url: "http://127.0.0.1:1420",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        locale: "zh-CN",
        viewport: { height: 720, width: 1280 },
      },
    },
  ],
})
