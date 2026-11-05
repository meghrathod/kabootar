import { defineConfig, devices } from "@playwright/test";

const port = 8090;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  // Starting a share first asks public STUN servers for the public IP (up to
  // 3.5s), which on CI runners plus a cold worker can exceed the 5s default.
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Serves dist/ plus the worker with local Durable Objects.
    command: `npx wrangler dev --port ${port} --var SERVER_SECRET:e2e-secret --var STUN_URLS:stun:127.0.0.1:9`,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
