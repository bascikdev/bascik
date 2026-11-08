import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const config = JSON.parse(await readFile(".output/wrangler.json", "utf8"));
const staticRules: Record<
  string,
  { to: string; status: number; lineNumber: number }
> = {};
const redirects = await readFile(".output/public/_redirects", "utf8");
for (const [index, line] of redirects.split("\n").entries()) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  const match = /^(\/[^\s*:]*)\s+(\/\S*)\s+(301|302|303|307|308)$/.exec(line);
  if (!match)
    throw new Error(`Unsupported test asset redirect on line ${index + 1}.`);
  staticRules[match[1]] = {
    to: match[2],
    status: Number(match[3]),
    lineNumber: index + 1,
  };
}
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
    directory: resolve(".output", config.assets.directory),
    binding: "ASSETS",
    assetConfig: {
      not_found_handling: "404-page",
      html_handling: "auto-trailing-slash",
      redirects: { version: 1, staticRules, rules: {} },
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
