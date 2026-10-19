import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFixtureTrust } from "./profile-tls.ts";

/** Relative to the fixture root; the subject passes the absolute CA path to the load generator. */
export const fixtureTlsFiles = {
  key: "tls/server-key.pem",
  cert: "tls/server.pem",
  ca: "tls/ca.pem",
};

export const seed = 128;
export const pageCount = 8;
export const componentsPerPage = 64;
export const streamBody =
  "<!DOCTYPE html><html><head></head><body><p>before</p><p>stream-128</p><p>after</p></body></html>";
export const apiBody = '{"seed":128,"ok":true}';
export function assetBytes(index = 0) {
  let state = seed + index;
  return Buffer.from(
    Array.from({ length: 128 * 1024 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return 32 + (state % 95);
    }),
  );
}
export function pageSource(index: number, edited = false) {
  return `<!DOCTYPE html><html><head></head><body><h1 data-testid="page">page-${index}${edited ? "-edited" : ""}</h1>${Array.from({ length: componentsPerPage }, (_, component) => `<profile-card><span>slot-${component}</span></profile-card>`).join("")}<script data-bascik-build>export default () => '<p data-testid="build">build-128</p>';</script></body></html>`;
}
export async function createFixture(
  root: string,
  workers: boolean,
  port: number,
  tls: boolean,
) {
  for (const directory of ["src/pages", "src/components", "src/api"])
    await mkdir(join(root, directory), { recursive: true });
  if (tls) await createFixtureTrust(join(root, "tls"), ["127.0.0.1"]);
  await writeFile(
    join(root, "bascik.config.ts"),
    `export default ${JSON.stringify({
      directory: {
        pages: "src/pages",
        components: "src/components",
        out: "dist",
        api: "src/api",
      },
      pipeline: { workers },
      minify: false,
      http: {
        hostname: "127.0.0.1",
        port,
        tls: tls
          ? {
              enabled: true,
              keyFile: fixtureTlsFiles.key,
              certFile: fixtureTlsFiles.cert,
            }
          : { enabled: false },
        rateLimit: false,
      },
      logging: { level: "error" },
      generate: { sitemap: false, robots: false },
    })};`,
  );
  await writeFile(
    join(root, "src/components/profile-card.html"),
    '<style>.card { color: red; }</style><article class="card"><p>component-128</p><div data-bascik-slot></div></article>',
  );
  for (let index = 0; index < pageCount; index++)
    await writeFile(
      join(root, `src/pages/page-${index}.html`),
      pageSource(index),
    );
  await writeFile(
    join(root, "src/pages/stream.html"),
    streamBody.replace(
      "<p>stream-128</p>",
      () =>
        '<script data-bascik-stream>export default async () => "<p>stream-128</p>";</script>',
    ),
  );
  await writeFile(
    join(root, "src/api/probe.ts"),
    'export const GET = () => new Response(\'{"seed":128,"ok":true}\', { headers: { "content-type": "application/json" } });',
  );
  await writeFile(join(root, "src/pages/asset.txt"), assetBytes());
  for (let index = 0; index < 8; index++)
    await writeFile(
      join(root, `src/pages/asset-${index}.txt`),
      assetBytes(index + 1),
    );
  await writeFile(
    join(root, "src/pages/readiness.json"),
    '{"status":"ok","ready":true}',
  );
}

export const pipelineFixtureComponentCount = 10;
export const pipelineFixturePageCount = 25;
export const pipelineFixtureInstancesPerPage = 40;

/**
 * Generates a synthetic pipeline-heavy benchmark project (25 pages, 10 components,
 * 1,000 component instances total) that exercises ID scoping, element and #id CSS
 * selector rewriting, aria/href ID reference rewriting, dynamic data-bascik-attr-*
 * and data-bascik-prop-* bindings, and build scripts importing an external package.
 */
export async function createPipelineBenchmarkFixture(
  root: string,
  workers = false,
) {
  for (const directory of ["src/pages", "src/components"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(
    join(root, "bascik.config.ts"),
    `export default ${JSON.stringify({
      directory: {
        pages: "src/pages",
        components: "src/components",
        out: "dist",
      },
      pipeline: { workers },
      minify: { html: true, css: true, js: true, identifiers: false },
      generate: { sitemap: false, robots: false },
    })};\n`,
  );
  for (let c = 0; c < pipelineFixtureComponentCount; c++) {
    const html = `<style>
  section { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
  header h3 { font-size: 1.1rem; margin: 0; color: #111; }
  div p { line-height: 1.5; color: #333; }
  ul li a { text-decoration: none; color: #0055cc; }
  footer span { font-size: 0.85rem; opacity: 0.8; }
  button { cursor: pointer; border-radius: 4px; }
  #panel-${c} { border: 1px solid #ddd; background: #fafafa; }
  #btn-${c}:hover { background: #eee; }
</style>
<section id="panel-${c}" class="widget-${c}" data-bascik-attr-data-slug="slug">
  <header>
    <h3 id="title-${c}" data-bascik-prop-heading>Default Heading ${c}</h3>
  </header>
  <div>
    <p data-bascik-prop-summary>Paragraph content inside component ${c} with nested elements and attributes.</p>
    <ul>
      <li><a href="#title-${c}">Jump to title</a></li>
      <li><span>Secondary item</span></li>
    </ul>
  </div>
  <footer>
    <span id="status-${c}">Ready</span>
    <button id="btn-${c}" aria-labelledby="title-${c}" aria-describedby="status-${c}">Action</button>
  </footer>
</section>
<script>
  const btn = document.getElementById("btn-${c}");
  const panel = document.querySelector("#panel-${c}");
  if (btn && panel) btn.addEventListener("click", () => panel.classList.toggle("active"));
</script>`;
    await writeFile(join(root, `src/components/ui-widget-${c}.html`), html);
  }

  for (let p = 0; p < pipelineFixturePageCount; p++) {
    const instances = Array.from(
      { length: pipelineFixtureInstancesPerPage },
      (_, i) => {
        const c = i % pipelineFixtureComponentCount;
        return `<ui-widget-${c} data-bascik-prop-slug="p${p}-i${i}" data-bascik-prop-heading="Page ${p} Item ${i}" data-bascik-prop-summary="Summary for ${p}.${i}"></ui-widget-${c}>`;
      },
    );
    const pageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Benchmark Page ${p}</title>
</head>
<body>
  <main>
    <h1>Benchmark Page ${p}</h1>
    <script data-bascik-build>
      import { marked } from "marked";
      export default () => marked.parse("Rendered **markdown** summary for page ${p}.");
    </script>
    ${instances.join("\n    ")}
  </main>
</body>
</html>`;
    await writeFile(join(root, `src/pages/page-${p}.html`), pageHtml);
  }
}
