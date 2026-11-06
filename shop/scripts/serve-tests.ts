import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const config = JSON.parse(await readFile(".output/wrangler.json", "utf8"));
const runtime = new Miniflare({
  modules: true,
  modulesRoot: resolve(".output"),
  scriptPath: resolve(".output/worker.js"),
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  host: "127.0.0.1",
  port: Number(process.env.SHOP_TEST_PORT ?? 8790),
  bindings: {
    SHOP_ORIGIN: "http://127.0.0.1:8790",
    SHOP_ENABLED: "false",
    SHOP_MODE: "test",
    SHOP_FULFILLMENT_ENABLED: "false",
  },
  d1Databases: ["DB"],
  assets: {
    directory: config.assets.directory,
    binding: "ASSETS",
    assetConfig: {
      not_found_handling: "404-page",
      html_handling: "auto-trailing-slash",
    },
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: false,
      static_routing: { user_worker: config.assets.run_worker_first },
    },
  },
});
console.log(
  `Shop test runtime ready at ${await runtime.ready}; no secrets or provider credentials loaded.`,
);
const shutdown = async () => {
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
