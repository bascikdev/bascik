import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Plain Node: the key parser, the guards, the configs, the catalog.
        test: { name: "node", include: ["tests/**/*.node.test.ts"] },
      },
      {
        // Inside local workerd: the Durable Objects and their clients.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./tests/wrangler.test.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/**/*.workers.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
