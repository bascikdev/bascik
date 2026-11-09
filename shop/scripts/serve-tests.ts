import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  TEST_CONTROL_PORT,
  TEST_ORDER_TOKEN_SECRET,
  fixtureStatements,
} from "./order-fixtures.ts";

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
    // A fixed test value, so the order fixtures' links are reproducible.
    ORDER_TOKEN_SECRET: TEST_ORDER_TOKEN_SECRET,
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
// The order page renders from real rows: apply the migrations and seed the
// fixture orders the e2e suite opens through their private links.
const DB = await runtime.getD1Database("DB");
const applyMigrations = async () => {
  const files = (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const sql = (
    await Promise.all(files.map((f) => readFile(`migrations/${f}`, "utf8")))
  ).join("\n");
  await DB.batch(
    sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => DB.prepare(statement)),
  );
};
const seed = async () => {
  for (const table of ["notifications", "payment_events", "orders", "quotes"])
    await DB.prepare(`DELETE FROM ${table}`).run();
  await DB.batch(
    fixtureStatements(Math.floor(Date.now() / 1000)).map(({ sql, params }) =>
      DB.prepare(sql).bind(...params),
    ),
  );
};
await applyMigrations();
await seed();
// A local-only control endpoint the browser tests use to move an order
// through its states (a webhook would, in production) and to reset the
// fixtures. It listens on a separate port the Worker never sees.
const control = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await new Promise<string>((done) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => done(body));
    });
    const data = text ? JSON.parse(text) : {};
    if (url.pathname === "/reset") await seed();
    else if (url.pathname === "/sql" && typeof data.sql === "string")
      await DB.prepare(data.sql)
        .bind(...(data.params ?? []))
        .run();
    else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  } catch (error) {
    response
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>((done) =>
  control.listen(TEST_CONTROL_PORT, "127.0.0.1", done),
);
console.log(
  `Shop test runtime ready at ${await runtime.ready}; no secrets or provider credentials loaded. Fixture control on 127.0.0.1:${TEST_CONTROL_PORT}.`,
);
const shutdown = async () => {
  control.close();
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
