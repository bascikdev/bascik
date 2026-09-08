import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixtureTrust } from "./profile-tls.ts";

/** Relative to the fixture root; the subject passes the absolute CA path to the load generator. */
export const fixtureTlsFiles = { key: "tls/server-key.pem", cert: "tls/server.pem", ca: "tls/ca.pem" };

export const seed = 128;
export const pageCount = 8;
export const componentsPerPage = 64;
export const streamBody = "<!DOCTYPE html><html><head></head><body><p>before</p><p>stream-128</p><p>after</p></body></html>";
export const apiBody = '{"seed":128,"ok":true}';
export function assetBytes(index = 0) {
  let state = seed + index;
  return Buffer.from(Array.from({ length: 128 * 1024 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return 32 + state % 95;
  }));
}
export function pageSource(index: number, edited = false) {
  return `<!DOCTYPE html><html><head></head><body><h1 data-testid="page">page-${index}${edited ? "-edited" : ""}</h1>${Array.from({ length: componentsPerPage }, (_, component) => `<profile-card><span>slot-${component}</span></profile-card>`).join("")}<script data-bascik-build>console.log('<p data-testid="build">build-128</p>');</script></body></html>`;
}
export async function createFixture(root: string, workers: boolean, port: number, tls: boolean) {
  for (const directory of ["src/pages", "src/components", "src/api"]) await mkdir(join(root, directory), { recursive: true });
  if (tls) await createFixtureTrust(join(root, "tls"), ["127.0.0.1"]);
  await writeFile(join(root, "bascik.config.ts"), `export default ${JSON.stringify({
    directory: { pages: "src/pages", components: "src/components", out: "dist", api: "src/api" },
    pipeline: { workers }, minify: false,
    http: { hostname: "127.0.0.1", port, tls: tls ? { enabled: true, keyFile: fixtureTlsFiles.key, certFile: fixtureTlsFiles.cert } : { enabled: false }, rateLimit: false },
    logging: { level: "error" }, generate: { sitemap: false, robots: false },
  })};`);
  await writeFile(join(root, "src/components/profile-card.html"), '<style>.card { color: red; }</style><article class="card"><p>component-128</p><div data-bascik-slot></div></article>');
  for (let index = 0; index < pageCount; index++) await writeFile(join(root, `src/pages/page-${index}.html`), pageSource(index));
  await writeFile(join(root, "src/pages/stream.html"), streamBody.replace("<p>stream-128</p>", () => '<script data-bascik-stream>export default async () => "<p>stream-128</p>";</script>'));
  await writeFile(join(root, "src/api/probe.ts"), `export const GET = () => new Response(${JSON.stringify(apiBody)}, { headers: { "content-type": "application/json" } });`);
  await writeFile(join(root, "src/pages/asset.txt"), assetBytes());
  for (let index = 0; index < 8; index++) await writeFile(join(root, `src/pages/asset-${index}.txt`), assetBytes(index + 1));
  await writeFile(join(root, "src/pages/readiness.json"), '{"status":"ok","ready":true}');
}