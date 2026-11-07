import { readFile, writeFile } from "node:fs/promises";
import { updateCheckoutNotice } from "./checkout-notice.ts";
import {
  assertProductionPrelaunch,
  assertProductionLaunch,
  productionLaunch,
} from "./production-config.ts";

const launch = process.argv.includes("--launch");
const production = JSON.parse(
  await readFile("wrangler.production.json", "utf8"),
);
assertProductionPrelaunch(production);
const bundle = JSON.parse(await readFile(".output/wrangler.json", "utf8"));
const config = {
  ...bundle,
  ...production,
  main: "./worker.js",
  assets: { ...bundle.assets, directory: "./public" },
  triggers: { crons: ["*/5 * * * *"] },
  d1_databases: production.d1_databases.map(
    (database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: "./migrations",
    }),
  ),
};
delete config.routes;
const final = launch ? productionLaunch(config) : config;
if (launch) {
  assertProductionLaunch(final);
  const checkoutPath = ".output/public/checkout.html";
  const checkout = await readFile(checkoutPath, "utf8");
  await writeFile(checkoutPath, updateCheckoutNotice(checkout));
  const headersPath = ".output/public/_headers";
  const headers = await readFile(headersPath, "utf8");
  await writeFile(
    headersPath,
    headers.replace(
      /^\/\*\r?\n[ \t]+X-Robots-Tag: noindex, nofollow\r?\n/gm,
      "",
    ),
  );
} else assertProductionPrelaunch(final);
await writeFile(
  ".output/wrangler.production.json",
  JSON.stringify(final, null, 2),
);
console.log(
  launch
    ? "Packaged live shop.bascik.dev with commerce enabled and indexable assets."
    : "Packaged isolated production prelaunch. Commerce and hostname cutover remain disabled.",
);
