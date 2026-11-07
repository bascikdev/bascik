import {
  readFile,
  mkdir,
  writeFile,
  appendFile,
  cp,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import sharp from "sharp";

await mkdir(".output", { recursive: true });
const generated = JSON.parse(
  await readFile("dist/.bascik/cloudflare/wrangler.jsonc", "utf8"),
);
const mode = process.env.SHOP_BUILD_MODE ?? generated.vars?.SHOP_MODE ?? "test";
if (mode !== "test" && mode !== "live")
  throw new Error("SHOP_BUILD_MODE must be test or live");
generated.vars = { ...generated.vars, SHOP_MODE: mode };
const publicDirectory = resolve("dist/.bascik/cloudflare/public");
await sharp("src/pages/assets/bascik-logo.svg", { density: 288 })
  .resize(456, 112)
  .png()
  .toFile(`${publicDirectory}/assets/bascik-email-logo.png`);
const cacheHeaders = [
  "/assets/products/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "/cart*",
  "  Cache-Control: no-store",
  "/checkout*",
  "  Cache-Control: no-store",
  "/order*",
  "  Cache-Control: no-store",
];
if (generated.vars?.SHOP_MODE !== "live")
  cacheHeaders.push("/*", "  X-Robots-Tag: noindex, nofollow");
await appendFile(
  `${publicDirectory}/_headers`,
  `\n${cacheHeaders.join("\n")}\n`,
);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", ...(await import("../src/lib/catalog.ts")).products.map((product) => `/products/${product.slug}`)].map((path) => `<url><loc>https://shop.bascik.dev${path}</loc></url>`).join("")}</urlset>`;
await writeFile(`${publicDirectory}/sitemap.xml`, sitemap);
await writeFile(
  ".output/entry.js",
  `
import bascik from "../dist/.bascik/cloudflare/worker.js";
import { sweep, processOrderMessage } from "../src/lib/fulfillment.ts";
export default {
  fetch(request, env, ctx) { return bascik.fetch(request, env, ctx); },
  async scheduled(event, env, ctx) { await sweep(env); },
  async queue(batch, env) {
    for (const message of batch.messages) {
      if (!message.body || typeof message.body.orderId !== "string") {
        console.error("Invalid shop queue message");
        message.ack();
        continue;
      }
      await processOrderMessage(env, message.body.orderId);
      message.ack();
    }
  }
};`,
);
await build({
  entryPoints: [".output/entry.js"],
  outfile: ".output/worker.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
  minify: true,
});
generated.main = "./worker.js";
await rm(".output/public", { recursive: true, force: true });
await rm(".output/migrations", { recursive: true, force: true });
await cp(publicDirectory, ".output/public", { recursive: true });
await cp("migrations", ".output/migrations", { recursive: true });
generated.assets.directory = "./public";
delete generated.$schema;
generated.triggers = { crons: ["*/5 * * * *"] };
generated.d1_databases = generated.d1_databases.map(
  (database: Record<string, unknown>) => ({
    ...database,
    migrations_dir: "./migrations",
  }),
);
await writeFile(".output/wrangler.json", JSON.stringify(generated, null, 2));
console.log(
  "Packaged Bascik fetch handler with shop recovery and queue handlers. Checkout remains gated by SHOP_ENABLED.",
);
