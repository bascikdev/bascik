import { readFile, writeFile } from "node:fs/promises";
import { assertProductionPrelaunch } from "./production-config.ts";

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
assertProductionPrelaunch(config);
await writeFile(
  ".output/wrangler.production.json",
  JSON.stringify(config, null, 2),
);
console.log(
  "Packaged isolated production prelaunch. Commerce and hostname cutover remain disabled.",
);
