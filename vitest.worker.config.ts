import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs worker tests inside workerd with real Durable Objects.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { SERVER_SECRET: "test-secret", MASTER_GRACE_SECONDS: "1" },
      },
    }),
  ],
  test: {
    include: ["worker/test/**/*.test.ts"],
  },
});
