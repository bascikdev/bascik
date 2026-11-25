import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
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
        // worker.ts imports the generated Worker as `bascik-worker`; the
        // wrapper's tests put a stand-in there. The route tests import the
        // real one, as `bascik-worker-built` (`yarn build` writes it).
        resolve: {
          alias: {
            "bascik-worker-built": fileURLToPath(
              new URL("./dist/.bascik/cloudflare/worker.js", import.meta.url)
                .href,
            ),
            "bascik-worker": fileURLToPath(
              new URL("./tests/fake-bascik-worker.ts", import.meta.url).href,
            ),
          },
        },
        test: {
          name: "workers",
          include: ["tests/**/*.workers.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
