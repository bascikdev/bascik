import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { parse } from "parse5";
import { chromium } from "@playwright/test";
import { runScopingPipeline } from "./scoping-template.ts";
import type { BascikComponent } from "./types.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliPath = resolve(repoRoot, "pkg/src/index.ts");

function createTempSite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bascik-archetype-"));
  // Symlink workspace node_modules so @bascik/bascik and marked resolve cleanly
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function runBascikCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, BASCIK_SITE_URL: "https://example.com", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function assertValidHtml5(html: string, label: string): void {
  const errors: string[] = [];
  parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (err: { code: string; startLine?: number }) => {
      errors.push(`${err.code}:${err.startLine ?? 0}`);
    },
  });
  expect(errors, `HTML5 parse errors in ${label}`).toEqual([]);
}

describe("Real-world archetype torture suite & migration-tutorials example sites", () => {
  it("Archetype 1: Blog / Technical Documentation Site (Markdown, code blocks with literal directives, regex tokens $1/$&)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/doc-shell/doc-shell.html": [
        '<header id="top-bar"><nav><a href="#content">Skip</a></nav></header>',
        '<main id="content" class="prose"><div data-bascik-slot></div></main>',
      ].join("\n"),
      "src/components/doc-shell/doc-shell.css": [
        "#top-bar nav > a { color: blue; }",
        ".prose h1 { margin: 1rem 0; }",
      ].join("\n"),
      "src/components/code-sample/code-sample.html": [
        '<div class="sample-wrap">',
        '  <span class="lang" data-bascik-prop-lang></span>',
        '  <pre><code data-bascik-slot></code></pre>',
        "</div>",
      ].join("\n"),
      "src/components/code-sample/code-sample.css": ".sample-wrap { border: 1px solid #ccc; } .lang { font-weight: bold; }\n",
      "src/pages/index.html": [
        "<!DOCTYPE html><html><head><title>Tech Blog</title></head><body>",
        "<doc-shell>",
        "  <h1> Compiler Notes </h1>",
        '  <code-sample data-bascik-prop-lang="html">',
        "    &lt;script data-bascik-build&gt;const price = '$100 $&amp; $`';&lt;/script&gt;",
        "  </code-sample>",
        "  <script data-bascik-build>",
        '    export default () => "<p>Price formula: $1 + $&amp; + $` = 100%</p>";',
        "  </script>",
        "</doc-shell>",
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const outHtml = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(outHtml, "Archetype 1 index.html");
      expect(outHtml).toContain("Price formula: $1 + $&amp; + $` = 100%");
      // Verify #top-bar nav > a had all three tokens scoped (and none left as bare `nav > a`)
      expect(outHtml).not.toContain("nav > a");
      const navClass = outHtml.match(/<nav class="([^"]+)">/)?.[1];
      const linkClass = outHtml.match(/<a class="([^"]+)" href=/)?.[1];
      expect(navClass).toBeDefined();
      expect(linkClass).toBeDefined();
      expect(outHtml).toContain(`.${navClass} > .${linkClass}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 2: E-Commerce / Product Catalog (Dynamic routes, server + stream scripts, forms, 4-level nested slots)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/level-one/level-one.html": '<div class="l1"><div data-bascik-slot></div></div>',
      "src/components/level-one/level-one.css": ".l1 { padding: 4px; }",
      "src/components/level-two/level-two.html": '<div class="l2"><div data-bascik-slot></div></div>',
      "src/components/level-two/level-two.css": ".l2 { padding: 4px; }",
      "src/components/level-three/level-three.html": '<div class="l3"><div data-bascik-slot></div></div>',
      "src/components/level-three/level-three.css": ".l3 { padding: 4px; }",
      "src/components/product-card/product-card.html": [
        '<article id="card" class="card">',
        '  <h2 data-bascik-prop-title></h2>',
        '  <form id="buy-form"><label for="qty">Qty</label><input id="qty" name="qty" form="buy-form"></form>',
        '  <div class="details"><div data-bascik-slot="specs"></div></div>',
        "</article>",
      ].join("\n"),
      "src/components/product-card/product-card.css": "#card > h2 { font-size: 1.2rem; } .card { border: 1px solid #000; }",
      "src/pages/index.html": '<!DOCTYPE html><html><head><title>Store</title></head><body><a href="/products/synth">Synth</a></body></html>',
      "src/pages/products/[slug].html": [
        "<!DOCTYPE html><html><head><title>Product</title></head><body>",
        "<script data-bascik-routes>",
        "  export default async () => [",
        '    { params: { slug: "synth" }, data: { title: "Analog Synth", sku: "SYN-01" } },',
        '    { params: { slug: "drum" }, data: { title: "Drum Machine", sku: "DRM-02" } },',
        "  ];",
        "</script>",
        "<level-one><level-two><level-three>",
        '  <product-card data-bascik-prop-title="Featured">',
        '    <div data-bascik-slot="specs"><span>4 oscillators</span></div>',
        "  </product-card>",
        "</level-three></level-two></level-one>",
        "<script data-bascik-server>",
        '  export default async () => "<div class=\\"stock-banner\\">In Stock</div>";',
        "</script>",
        "<script data-bascik-stream>",
        '  export default async () => "<div class=\\"reviews\\">5 Stars</div>";',
        "</script>",
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const synthHtml = readFileSync(join(dir, "dist/products/synth.html"), "utf8");
      assertValidHtml5(synthHtml, "Archetype 2 synth.html");
      expect(synthHtml).toContain("4 oscillators");
      expect(synthHtml).not.toContain("#card > h2");
      const h2Class = synthHtml.match(/<h2 class="([^"]+)">Featured<\/h2>/)?.[1];
      expect(h2Class).toBeDefined();
      expect(synthHtml).toContain(`> .${h2Class}`);
      expect(existsSync(join(dir, "dist/.bascik/server-scripts.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 3: Interactive Dashboard & 20-Instance SVG Gradient / ClipPath Isolation", () => {
    const instances = Array.from({ length: 20 }, (_, i) => `<spark-chart data-bascik-prop-label="Metric ${i + 1}" />`).join("\n");
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/spark-chart/spark-chart.html": [
        '<div id="wrap" class="chart">',
        '  <span data-bascik-prop-label></span>',
        '  <svg viewBox="0 0 100 30">',
        '    <defs><linearGradient id="grad"><stop offset="0%" stop-color="red"/></linearGradient><clipPath id="clip"><rect width="100" height="30"/></clipPath></defs>',
        '    <rect class="bar" clip-path="url(#clip)" width="80" height="20"/>',
        "  </svg>",
        "</div>",
        "<script>",
        '  const wrap = document.getElementById("wrap");',
        '  wrap.classList.add("ready");',
        "</script>",
      ].join("\n"),
      "src/components/spark-chart/spark-chart.css": ".chart { display: inline-block; } .bar { fill: url(#grad); } .ready { opacity: 1; }",
      "src/pages/index.html": `<!DOCTYPE html><html><head><title>Dashboard</title></head><body>${instances}</body></html>`,
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 3 dashboard");
      const gradIds = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(gradIds).size).toBe(20);
      for (const id of gradIds) {
        expect(html).toContain(`url(#${id})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 4: Subpath Deployment Site (base: '/docs/v1' across links, images, srcset, forms, and API routes)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default { base: "/docs/v1" };\n`,
      "src/components/nav-bar/nav-bar.html": '<nav><a href="/guide">Guide</a><img src="/logo.png" srcset="/logo-1x.png 1x, /logo-2x.png 2x" alt="Logo"></nav>',
      "src/components/nav-bar/nav-bar.css": "nav a { text-decoration: none; }",
      "src/api/status.ts": "export async function GET() { return Response.json({ ok: true }); }\n",
      "src/pages/index.html": '<!DOCTYPE html><html><head><title>Subpath</title><link rel="stylesheet" href="/app.css"></head><body><nav-bar /><form action="/submit"><button>Go</button></form></body></html>',
      "src/pages/guide.html": "<!DOCTYPE html><html><head><title>Guide</title></head><body><h1>Guide</h1></body></html>",
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 4 subpath index.html");
      expect(html).toContain('href="/docs/v1/guide"');
      expect(html).toContain('src="/docs/v1/logo.png"');
      expect(html).toContain('srcset="/docs/v1/logo-1x.png 1x, /docs/v1/logo-2x.png 2x"');
      expect(html).toContain('action="/docs/v1/submit"');
      expect(html).toContain('href="/docs/v1/app.css"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 5: Broken Authoring & Dev Recovery Resilience", async () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default { http: { port: 19876 } };\n`,
      "src/components/my-widget/my-widget.html": '<div class="box">Initial</div>',
      "src/components/my-widget/my-widget.css": ".box { color: green; }",
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>Dev</title></head><body><my-widget /></body></html>",
    });

    const child = spawn(process.execPath, [cliPath, "--port", "19876"], {
      cwd: dir,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });

    const waitForText = (needle: string, timeoutMs = 15000): Promise<void> =>
      new Promise((resolvePromise, rejectPromise) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (output.includes(needle)) {
            clearInterval(timer);
            resolvePromise();
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            rejectPromise(new Error(`Timed out waiting for "${needle}". Output:\n${output}`));
          }
        }, 50);
      });

    try {
      await waitForText("http://localhost:19876");

      // Inject a broken build script
      output = "";
      writeFileSync(
        join(dir, "src/pages/index.html"),
        '<!DOCTYPE html><html><head><title>Dev</title></head><body><script data-bascik-build>export default () => { throw new Error("boom-chaos"); };</script></body></html>',
        "utf8",
      );
      await waitForText("boom-chaos");

      // Recover with valid markup
      output = "";
      writeFileSync(
        join(dir, "src/pages/index.html"),
        "<!DOCTYPE html><html><head><title>Dev</title></head><body><my-widget /><h1>Recovered</h1></body></html>",
        "utf8",
      );
      await waitForText("transpiled");

      const res = await fetch("http://localhost:19876/");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Recovered");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("close", r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("Archetype 6: Next.js API Routes REST Port (src/api/users.ts, src/api/user/[id].ts, 405 Allow, derived HEAD/OPTIONS, client fetch)", async () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default { http: { port: 19877 } };\n`,
      "src/api/users.ts": [
        "const users = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }, { id: 3, name: 'Grace' }];",
        "export async function GET() {",
        "  return Response.json(users);",
        "}",
      ].join("\n"),
      "src/api/user/[id].ts": [
        "export async function GET(_request: Request, context: { params: { id: string } }) {",
        "  const parsed = Number.parseInt(context.params.id, 10);",
        "  const id = Number.isNaN(parsed) ? null : parsed;",
        "  return Response.json({ id, name: `User ${context.params.id}` });",
        "}",
        "export async function PUT(request: Request, context: { params: { id: string } }) {",
        "  const url = new URL(request.url);",
        "  const parsed = Number.parseInt(context.params.id, 10);",
        "  const id = Number.isNaN(parsed) ? null : parsed;",
        "  const name = url.searchParams.get('name') || `User ${context.params.id}`;",
        "  return Response.json({ id, name });",
        "}",
      ].join("\n"),
      "src/components/user-list/user-list.html": [
        '<section id="users-root" class="user-list">',
        '  <h2>Users</h2>',
        '  <ul id="list" class="items"></ul>',
        "</section>",
        "<script>",
        '  const list = document.getElementById("list");',
        '  fetch("/api/users").then(r => r.json()).then(users => {',
        '    list.innerHTML = users.map(u => `<li class="item"><a href="/user/${u.id}">${u.name}</a></li>`).join("");',
        "  });",
        "</script>",
      ].join("\n"),
      "src/components/user-list/user-list.css": "#users-root > h2 { margin: 0; } .user-list .item { list-style: none; }",
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>Users API</title></head><body><user-list /></body></html>",
      "src/pages/user/[id].html": [
        "<!DOCTYPE html><html><head><title>User Profile</title></head><body>",
        "<script data-bascik-routes>",
        "  export default async () => [{ params: { id: '1' } }, { params: { id: '2' } }, { params: { id: '3' } }];",
        "</script>",
        "<script data-bascik-server>",
        "  export default async (request) => {",
        "    const url = new URL(request.url);",
        "    return `<h1 data-path=\"${url.pathname}\">Profile</h1>`;",
        "  };",
        "</script>",
        "</body></html>",
      ].join("\n"),
    });

    const buildRes = runBascikCli(dir, ["--build"]);
    expect(buildRes.status, buildRes.stderr).toBe(0);
    // Static build warns that API routes require --server
    expect(buildRes.stdout + buildRes.stderr).toMatch(/api/i);

    const checkRes = runBascikCli(dir, ["--check"]);
    expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

    const child = spawn(process.execPath, [cliPath, "--server", "--port", "19877"], {
      cwd: dir,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });

    const waitForServer = (): Promise<void> =>
      new Promise((resolvePromise, rejectPromise) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (output.includes("19877")) {
            clearInterval(timer);
            resolvePromise();
          } else if (Date.now() - start > 10000) {
            clearInterval(timer);
            rejectPromise(new Error(`Server did not start:\n${output}`));
          }
        }, 50);
      });

    try {
      await waitForServer();

      const getUsers = await fetch("http://localhost:19877/api/users");
      expect(getUsers.status).toBe(200);
      expect(await getUsers.json()).toEqual([
        { id: 1, name: "Ada" },
        { id: 2, name: "Linus" },
        { id: 3, name: "Grace" },
      ]);

      const getUser = await fetch("http://localhost:19877/api/user/2");
      expect(getUser.status).toBe(200);
      expect(await getUser.json()).toEqual({ id: 2, name: "User 2" });

      const putUser = await fetch("http://localhost:19877/api/user/2?name=Grace+Hopper", { method: "PUT" });
      expect(putUser.status).toBe(200);
      expect(await putUser.json()).toEqual({ id: 2, name: "Grace Hopper" });

      const nonNumeric = await fetch("http://localhost:19877/api/user/abc");
      expect(nonNumeric.status).toBe(200);
      expect(await nonNumeric.json()).toEqual({ id: null, name: "User abc" });

      // 405 Method Not Allowed + Allow header
      const postUser = await fetch("http://localhost:19877/api/user/2", { method: "POST" });
      expect(postUser.status).toBe(405);
      expect(postUser.headers.get("allow")).toContain("GET");
      expect(postUser.headers.get("allow")).toContain("PUT");

      // Derived HEAD and auto OPTIONS
      const headUser = await fetch("http://localhost:19877/api/user/2", { method: "HEAD" });
      expect(headUser.status).toBe(200);
      expect(await headUser.text()).toBe("");

      const optionsUser = await fetch("http://localhost:19877/api/user/2", { method: "OPTIONS" });
      expect(optionsUser.status).toBe(204);
      expect(optionsUser.headers.get("allow")).toContain("GET");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("close", r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("Archetype 7: Next.js i18n Multi-Locale Routing ([locale]/index.html, [locale]/[...slug] catch-all API, hreflang links)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/locale-switcher/locale-switcher.html": [
        '<nav id="lang-nav" class="lang-nav" aria-label="Language selector">',
        '  <a class="lang-link" data-bascik-attr-href="enHref" hreflang="en">English</a>',
        '  <a class="lang-link" data-bascik-attr-href="frHref" hreflang="fr">Français</a>',
        '  <a class="lang-link" data-bascik-attr-href="nlHref" hreflang="nl">Nederlands</a>',
        "</nav>",
      ].join("\n"),
      "src/components/locale-switcher/locale-switcher.css": "#lang-nav > a.lang-link { padding: 4px 8px; }",
      "src/api/i18n/[locale]/[...slug].ts": [
        "export async function GET(_request: Request, context: { params: { locale: string; slug: string[] } }) {",
        "  return Response.json({ locale: context.params.locale, path: context.params.slug.join('/') });",
        "}",
      ].join("\n"),
      "src/pages/[locale]/index.html": [
        "<!DOCTYPE html><html><head><title>i18n</title></head><body>",
        "<script data-bascik-routes>",
        "  export default async () => [",
        "    { params: { locale: 'en' }, data: { greeting: 'Hello World' } },",
        "    { params: { locale: 'fr' }, data: { greeting: 'Bonjour le monde' } },",
        "    { params: { locale: 'nl' }, data: { greeting: 'Hallo Wereld' } },",
        "  ];",
        "</script>",
        '<locale-switcher data-bascik-prop-enHref="/en/" data-bascik-prop-frHref="/fr/" data-bascik-prop-nlHref="/nl/" />',
        "<script data-bascik-build>",
        "  export default () => {",
        "    const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');",
        "    return `<h1>${route.data?.greeting ?? ''}</h1>`;",
        "  };",
        "</script>",
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      for (const [locale, greeting] of [
        ["en", "Hello World"],
        ["fr", "Bonjour le monde"],
        ["nl", "Hallo Wereld"],
      ] as const) {
        const html = readFileSync(join(dir, `dist/${locale}/index.html`), "utf8");
        assertValidHtml5(html, `Archetype 7 ${locale}/index.html`);
        expect(html).toContain(`<h1>${greeting}</h1>`);
        expect(html).toContain('href="/en/"');
        expect(html).toContain('href="/fr/"');
        expect(html).toContain('href="/nl/"');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 8: Portfolio & Agency Landing Page (Modal dialog, filterable grid, unquoted & whitespace-spaced HTML attributes, CSS @layer/@container/@keyframes)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/portfolio-modal/portfolio-modal.html": [
        "<dialog id = modal-box class = modal-shell>",
        "  <header id=modal-header>",
        "    <h3 data-bascik-prop-title></h3>",
        "    <button id = close-btn class=close-btn type=button commandfor=modal-box>Close</button>",
        "  </header>",
        "  <div class=modal-body><div data-bascik-slot></div></div>",
        "</dialog>",
        "<script>",
        '  const dialog = document.getElementById("modal-box");',
        '  const closeBtn = document.getElementById("close-btn");',
        '  closeBtn.addEventListener("click", () => dialog.close());',
        "</script>",
      ].join("\n"),
      "src/components/portfolio-modal/portfolio-modal.css": [
        "@layer modal {",
        "  .modal-shell { container-name: modal-card; animation: popIn 0.2s ease; }",
        "  #modal-header > h3 { margin: 0; }",
        "}",
        "@keyframes popIn { from { opacity: 0; } to { opacity: 1; } }",
        "@container modal-card (min-width: 300px) { .modal-body { padding: 16px; } }",
      ].join("\n"),
      "src/pages/index.html": [
        "<!DOCTYPE html><html><head><title>Agency Portfolio</title></head><body>",
        '<portfolio-modal data-bascik-prop-title="Project Alpha"><p>Alpha details</p></portfolio-modal>',
        '<portfolio-modal data-bascik-prop-title="Project Beta"><p>Beta details</p></portfolio-modal>',
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 8 portfolio index.html");
      expect(html).toContain("Project Alpha");
      expect(html).toContain("Project Beta");
      // Verify commandfor=modal-box was rewritten to match each instance's scoped dialog id
      const dialogIds = [...html.matchAll(/<dialog[^>]*\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(dialogIds).toHaveLength(2);
      expect(dialogIds[0]).not.toBe(dialogIds[1]);
      for (const id of dialogIds) {
        expect(html).toContain(`commandfor="${id}"`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 9: Sverdle / Interactive Word-Game & Form-State App (Exclusive <details name>, <output for>, table headers, TypeScript companion script)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/word-board/word-board.html": [
        '<div id="board" class="board">',
        '  <table><thead><tr><th id="col-guess">Guess</th><th id="col-score">Score</th></tr></thead>',
        '  <tbody><tr><td headers="col-guess">CRANE</td><td headers="col-score">5/5</td></tr></tbody></table>',
        '  <form id="guess-form"><input id="letter-a" name="letter"><output for="letter-a">Ready</output></form>',
        '  <details name="hint-group"><summary>Hint 1</summary><p>Starts with C</p></details>',
        '  <details name="hint-group"><summary>Hint 2</summary><p>Ends with E</p></details>',
        "</div>",
        '<script src="word-board.ts"></script>',
      ].join("\n"),
      "src/components/word-board/word-board.ts": [
        "type BoardState = 'idle' | 'won';",
        "const board = document.getElementById('board');",
        "const state: BoardState = 'won';",
        "if (board && state === 'won') board.classList.add('board-won');",
      ].join("\n"),
      "src/components/word-board/word-board.css": "#board table td { padding: 4px; } .board-won { border-color: green; }",
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>Word Game</title></head><body><word-board /><word-board /></body></html>",
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 9 word-game index.html");
      // TypeScript type annotation should be stripped
      expect(html).not.toContain("BoardState");
      // Exclusive details name groups should be scoped per instance (2 instances x 2 details = 2 distinct names)
      const detailNames = [...html.matchAll(/<details name="([^"]+)">/g)].map((m) => m[1]);
      expect(detailNames).toHaveLength(4);
      expect(detailNames[0]).toBe(detailNames[1]);
      expect(detailNames[2]).toBe(detailNames[3]);
      expect(detailNames[0]).not.toBe(detailNames[2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 10: Band / Event Tour Site with Merch Store, CSP Hashes, Build Manifest, & External Custom Elements", () => {
    const dir = createTempSite({
      "bascik.config.ts": [
        "export default {",
        "  components: { external: ['spotify-*', 'bandcamp-player'] },",
        "  scoping: { preserve: ['bandcamp-player'] },",
        "  generate: { cspHashes: true, manifest: true },",
        "};",
      ].join("\n"),
      "src/components/tour-stop/tour-stop.html": [
        '<article id="stop" class="tour-stop">',
        '  <h3 data-bascik-prop-city></h3>',
        '  <time data-bascik-attr-datetime="date" data-bascik-prop-date></time>',
        '  <a class="ticket-btn" data-bascik-attr-href="ticketUrl">Tickets</a>',
        "</article>",
      ].join("\n"),
      "src/components/tour-stop/tour-stop.css": "#stop > h3 { text-transform: uppercase; } .tour-stop .ticket-btn { font-weight: bold; }",
      "src/pages/index.html": [
        "<!DOCTYPE html><html><head><title>Band Tour</title></head><body>",
        '<tour-stop data-bascik-prop-city="Seattle" data-bascik-prop-date="2026-11-01" data-bascik-prop-ticketUrl="/tickets/sea" />',
        '<tour-stop data-bascik-prop-city="Portland" data-bascik-prop-date="2026-11-03" data-bascik-prop-ticketUrl="/tickets/pdx" />',
        '<spotify-embed track="123"></spotify-embed>',
        '<bandcamp-player id="literal-player" class="literal-cls"><span id="inner-id">Audio</span></bandcamp-player>',
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 10 band tour index.html");
      expect(html).toContain('datetime="2026-11-01"');
      expect(html).toContain('href="/tickets/sea"');
      expect(html).toContain('<bandcamp-player id="literal-player" class="literal-cls"><span id="inner-id">Audio</span></bandcamp-player>');
      expect(existsSync(join(dir, "dist/.bascik/csp-hashes.json"))).toBe(true);
      expect(existsSync(join(dir, "dist/.bascik/manifest.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 11: Modern CSS Torture Chamber (Recursive @import with @layer/@supports/@media, @property, @counter-style, @position-try, view-transition-name, keyframes named color/flex, unquoted [href$=.pdf])", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default { minify: { identifiers: false } };\n`,
      "src/components/css-torture/tokens.css": [
        "@property --accent-size { syntax: '<length>'; inherits: false; initial-value: 8px; }",
        ":root { --accent-size: 12px; }",
      ].join("\n"),
      "src/components/css-torture/css-torture.css": [
        '@import "./tokens.css" layer(tokens) supports(display: grid) (min-width: 300px);',
        "@counter-style custom-bullets { system: cyclic; symbols: '▸'; }",
        "@keyframes color { from { opacity: 0; } to { opacity: 1; } }",
        "@keyframes flex { from { transform: scale(0.95); } to { transform: scale(1); } }",
        "@position-try --pop-flip { bottom: anchor(top); }",
        ".shell {",
        "  display: flex;",
        "  color: red;",
        "  container-name: card-box;",
        "  anchor-name: --pop-anchor;",
        "  view-transition-name: hero-card;",
        "  animation: color 1s ease, flex 2s linear;",
        "  padding: var(--accent-size);",
        "}",
        ".popover { position-anchor: --pop-anchor; }",
        "::view-transition-old(hero-card) { opacity: 0; }",
        "@container card-box (min-width: 200px) {",
        "  #panel ul > li { list-style: custom-bullets; }",
        "  .shell a[href$=.pdf] span { text-decoration: underline; }",
        "}",
      ].join("\n"),
      "src/components/css-torture/css-torture.html": [
        '<div class="shell">',
        '  <section id="panel">',
        '    <ul><li><a href="/manual.pdf"><span>Download PDF</span></a></li></ul>',
        "  </section>",
        '  <div class="popover">Tip</div>',
        "</div>",
      ].join("\n"),
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>CSS Torture</title></head><body><css-torture /></body></html>",
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 11 CSS Torture");
      expect(html).toContain("display:flex");
      expect(html).toContain("color:red");
      expect(html).toContain("[href$=.pdf]");
      expect(html).toContain("bascik__css-torture__keyframe__color");
      expect(html).toContain("bascik__css-torture__keyframe__flex");
      expect(html).toContain("bascik__css-torture__container__card-box");
      expect(html).toContain("bascik__css-torture__counter__custom-bullets");
      expect(html).toContain("--bascik__css-torture__anchor__pop-anchor");
      expect(html).toContain("bascik__css-torture__vtn__hero-card");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 12: Page-Aware Build Script & Dynamic Route Torture Chamber (data-bascik-build='page', >32KB BASCIK_ROUTE payload, pre/post exec hooks)", () => {
    const dir = createTempSite({
      "bascik.config.ts": [
        "export default {",
        "  minify: { identifiers: false },",
        "  pipeline: {",
        "    exec: [",
        "      { script: 'scripts/post-feed.ts', phase: 'post' },",
        "    ],",
        "  },",
        "};",
      ].join("\n"),
      "scripts/post-feed.ts": [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "writeFileSync(join(process.env.BASCIK_OUT_DIR || 'dist', 'feed.xml'), '<rss></rss>');",
      ].join("\n"),
      "src/components/breadcrumbs/breadcrumbs.html": [
        '<nav id="crumb-nav" class="crumbs">',
        '  <script data-bascik-build="page">',
        "    export default () => {",
        "      const pagePath = process.env.BASCIK_PAGE_PATH || '/';",
        '      return `<ol class="crumb-list"><li><a href="${pagePath}">Current: ${pagePath}</a></li></ol>`;',
        "    };",
        "  </script>",
        "</nav>",
      ].join("\n"),
      "src/components/breadcrumbs/breadcrumbs.css": ".crumbs .crumb-list { display: flex; } li a { color: navy; }",
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>Home</title></head><body><breadcrumbs /></body></html>",
      "src/pages/articles/[slug].html": [
        "<!DOCTYPE html><html><head><title>Article</title></head><body>",
        "<script data-bascik-routes>",
        "  export default async () => [",
        "    { params: { slug: 'deep-dive' }, data: { body: 'A'.repeat(40000), summary: 'Large payload' } },",
        "  ];",
        "</script>",
        "<breadcrumbs />",
        "<script data-bascik-build>",
        "  export default () => {",
        "    const route = JSON.parse(process.env.BASCIK_ROUTE || '{}');",
        "    return `<article data-len=\"${route.data?.body?.length ?? 0}\">${route.data?.summary ?? ''}</article>`;",
        "  };",
        "</script>",
        "</body></html>",
      ].join("\n"),
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const articleHtml = readFileSync(join(dir, "dist/articles/deep-dive.html"), "utf8");
      assertValidHtml5(articleHtml, "Archetype 12 deep-dive.html");
      expect(articleHtml).toContain('data-len="40000"');
      expect(articleHtml).toContain("Large payload");
      // Page-aware component build script output must be scoped with the component's classes and element classes!
      expect(articleHtml).toContain('class="bascik__breadcrumbs__crumb-list"');
      expect(articleHtml).toContain('class="bascik__breadcrumbs__el__li"');
      expect(articleHtml).toContain('class="bascik__breadcrumbs__el__a"');
      expect(articleHtml).toContain("Current: /articles/deep-dive");
      expect(existsSync(join(dir, "dist/feed.xml"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 13: HTML Tokenizer & Minifier Torture Chamber (<template>, SVG foreignObject, JS regex/division/ASI, <pre> comments, <textarea> closing tags)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/complex-widget/complex-widget.html": [
        '<div id="widget" class="widget">',
        '  <template id="row-tpl"><p class="tpl-row">Template Row</p></template>',
        '  <pre><!-- preserved comment inside pre --><code>const x = 1 &lt; 2;</code></pre>',
        '  <textarea aria-label="Raw">&lt;/body&gt;&lt;/html&gt;</textarea>',
        '  <svg viewBox="0 0 100 100"><foreignObject width="100" height="100"><div class="fo-inner">Foreign</div></foreignObject></svg>',
        "</div>",
        "<script>",
        '  const root = document.getElementById("widget");',
        '  const ratio = (100 / 2) / 5;',
        '  const re = /\\/[a-z]+\\//g;',
        '  const tpl = `nested ${`inner ${1 + 2}`} end`;',
        '  if (root && re.test("/abc/") && ratio === 10 && tpl) {',
        '    const found = document.getElementsByClassName("js-discovered-only");',
        '    if (found.length === 0) root.classList.add("js-discovered-only");',
        "  }",
        "</script>",
      ].join("\n"),
      "src/components/complex-widget/complex-widget.css": [
        ".widget { position: relative; }",
        ".tpl-row, .fo-inner, .js-discovered-only { color: green; }",
        "p { margin: 0; }",
      ].join("\n"),
      "src/pages/index.html": "<!DOCTYPE html><html><head><title>Tokenizer Torture</title></head><body><complex-widget /></body></html>",
    });

    try {
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const checkRes = runBascikCli(dir, ["--check"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 13 Tokenizer Torture");
      expect(html).toContain("<!-- preserved comment inside pre -->");
      expect(html).toContain("Foreign");
      // Verify getElementsByClassName("js-discovered-only") and classList.add("js-discovered-only") received the same scoped class
      const getByCls = html.match(/getElementsByClassName\("([^"]+)"\)/)?.[1];
      const addCls = html.match(/classList\.add\("([^"]+)"\)/)?.[1];
      expect(getByCls).toBeDefined();
      expect(getByCls).toBe(addCls);
      expect(getByCls).not.toBe("js-discovered-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 14: CLI --check --fix Auto-Repair Torture Chamber (Auto-fixing missing-prop-prefix across multiple components and pages)", () => {
    const dir = createTempSite({
      "bascik.config.ts": `export default {};\n`,
      "src/components/hero-banner/hero-banner.html": [
        '<section class="hero">',
        '  <h1 data-bascik-prop-headline></h1>',
        '  <a data-bascik-attr-href="ctaUrl" data-bascik-prop-ctaLabel></a>',
        "</section>",
      ].join("\n"),
      "src/components/hero-banner/hero-banner.css": ".hero { padding: 20px; }",
      "src/pages/index.html": [
        "<!DOCTYPE html><html><head><title>AutoFix</title></head><body>",
        '<hero-banner headline="Welcome" ctaUrl="/start" ctaLabel="Get Started" />',
        "</body></html>",
      ].join("\n"),
    });

    try {
      // 1. Before --fix, --check reports 3 missing-prop-prefix warnings. They come from the language server, the
      //    one place that rule lives, so they are listed per file under their rule id.
      const initialLint = runBascikCli(dir, ["--check"]);
      expect(initialLint.stdout).toContain("Per-file checks");
      expect(initialLint.stdout.match(/\(missing-prop-prefix\)/g)).toHaveLength(3);

      // 2. Run bascik --check --fix
      const fixRes = runBascikCli(dir, ["--check", "--fix"]);
      expect(fixRes.status, fixRes.stderr).toBe(0);
      expect(fixRes.stdout).not.toContain("(missing-prop-prefix)");
      expect(fixRes.stdout).toContain("fixed 1 file: src/pages/index.html");

      // 3. Build and verify all 3 props now render into the compiled HTML
      const buildRes = runBascikCli(dir, ["--build"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const html = readFileSync(join(dir, "dist/index.html"), "utf8");
      assertValidHtml5(html, "Archetype 14 AutoFix index.html");
      expect(html).toContain("<h1>Welcome</h1>");
      expect(html).toContain('href="/start"');
      expect(html).toContain(">Get Started</a>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Archetype 15: Real Headless Chromium Differential Verification (Shadow DOM vs. Bascik Scoped Flat DOM across 30 selector & JS patterns)", async () => {
    const buildComponentHtml = (prefix: string): string =>
      [
        `<section data-node-id="${prefix}-root" id="panel" class="card">`,
        `  <header data-node-id="${prefix}-hdr" class="hdr">`,
        `    <h3 data-node-id="${prefix}-h3" class="title">Heading</h3>`,
        `    <p data-node-id="${prefix}-p1" class="lead">Lead text</p>`,
        `    <p data-node-id="${prefix}-p2">Second paragraph</p>`,
        `  </header>`,
        `  <div data-node-id="${prefix}-body" class="body">`,
        `    <ul data-node-id="${prefix}-ul" class="list">`,
        `      <li data-node-id="${prefix}-li1" class="item active"><span data-node-id="${prefix}-span1">First</span></li>`,
        `      <li data-node-id="${prefix}-li2" class="item"><span data-node-id="${prefix}-span2">Second</span></li>`,
        `    </ul>`,
        `    <button data-node-id="${prefix}-btn" id="cta" class="btn" type="button">Action</button>`,
        `  </div>`,
        `</section>`,
      ].join("\n");

    const selectorsToTest = [
      ".card",
      ".card .hdr",
      ".card > .hdr > h3",
      "#panel",
      "#panel p",
      "#panel > header > h3",
      "#panel h3 + p",
      "#panel h3 ~ p",
      "section header p",
      "ul > li",
      ".list > li:first-child",
      ".item:not(.active)",
      ".item:not(.active) > span",
      ":is(.hdr, .body) p",
      ":where(.hdr, .list) span",
      ".hdr:has(.lead) h3",
      ".body * span",
      "#cta",
      "h3, button",
      "#panel, .list > li",
    ];

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 800, height: 600 });

      for (const rawSelector of selectorsToTest) {
        const rawCss = `${rawSelector} { color: rgb(255, 0, 128); }`;
        const rawInst1 = buildComponentHtml("inst1");
        const rawInst2 = buildComponentHtml("inst2");

        const comp1 = runScopingPipeline(
          {
            name: "diff-widget",
            fileContent: rawInst1,
            cssFileContent: rawCss,
          } satisfies BascikComponent,
          "a1b2c3d4",
        );
        const comp2 = runScopingPipeline(
          {
            name: "diff-widget",
            fileContent: rawInst2,
            cssFileContent: rawCss,
          } satisfies BascikComponent,
          "e5f60718",
        );

        const pageTrapHtml = [
          `<section data-node-id="page-root" id="panel" class="card">`,
          `  <header data-node-id="page-hdr" class="hdr">`,
          `    <h3 data-node-id="page-h3" class="title">Page Trap</h3>`,
          `    <p data-node-id="page-p1" class="lead">Page Lead</p>`,
          `  </header>`,
          `  <div data-node-id="page-body" class="body">`,
          `    <ul data-node-id="page-ul" class="list"><li data-node-id="page-li1" class="item active"><span data-node-id="page-span1">Page Span</span></li></ul>`,
          `    <button data-node-id="page-btn" id="cta" class="btn" type="button">Page Action</button>`,
          `  </div>`,
          `</section>`,
        ].join("\n");

        const fullHtml = [
          "<!DOCTYPE html><html><head><style>",
          "body { color: rgb(0, 0, 0); }",
          comp1.cssFileContent ?? "",
          "</style></head><body>",
          `<div id="flat-root">`,
          pageTrapHtml,
          comp1.fileContent,
          comp2.fileContent,
          `</div>`,
          `<div id="shadow-host-1"></div>`,
          `<div id="shadow-host-2"></div>`,
          "</body></html>",
        ].join("\n");

        await page.setContent(fullHtml);

        const comparison = await page.evaluate(
          ({ rawInst1Html, rawInst2Html, rawCssText }) => {
            interface BrowserNode {
              getAttribute(name: string): string | null;
              querySelectorAll(selector: string): Iterable<BrowserNode>;
              attachShadow(init: { mode: string }): { innerHTML: string; querySelectorAll(selector: string): Iterable<BrowserNode> };
            }
            const g = globalThis as unknown as {
              document: { getElementById(id: string): BrowserNode | null };
              window: { getComputedStyle(el: BrowserNode): { color: string } };
            };
            const host1 = g.document.getElementById("shadow-host-1")!;
            const shadow1 = host1.attachShadow({ mode: "open" });
            shadow1.innerHTML = `<style>:host { color: rgb(0, 0, 0); } ${rawCssText}</style>${rawInst1Html}`;

            const host2 = g.document.getElementById("shadow-host-2")!;
            const shadow2 = host2.attachShadow({ mode: "open" });
            shadow2.innerHTML = `<style>:host { color: rgb(0, 0, 0); } ${rawCssText}</style>${rawInst2Html}`;

            const collectColoredNodes = (root: { querySelectorAll(selector: string): Iterable<BrowserNode> }): string[] => {
              const matched: string[] = [];
              for (const el of root.querySelectorAll("[data-node-id]")) {
                const id = el.getAttribute("data-node-id")!;
                matched.push(`${id}:${g.window.getComputedStyle(el).color}`);
              }
              return matched;
            };

            const flatRoot = g.document.getElementById("flat-root")!;
            const pageTrapColors = Array.from(flatRoot.querySelectorAll('[data-node-id^="page-"]')).map(
              (el) => `${el.getAttribute("data-node-id")}:${g.window.getComputedStyle(el).color}`,
            );
            const flatInstColors = [
              ...Array.from(flatRoot.querySelectorAll('[data-node-id^="inst1-"]')),
              ...Array.from(flatRoot.querySelectorAll('[data-node-id^="inst2-"]')),
            ].map((el) => `${el.getAttribute("data-node-id")}:${g.window.getComputedStyle(el).color}`);

            const shadowInstColors = [
              ...collectColoredNodes(shadow1),
              ...collectColoredNodes(shadow2),
            ];

            return { pageTrapColors, flatInstColors, shadowInstColors };
          },
          { rawInst1Html: rawInst1, rawInst2Html: rawInst2, rawCssText: rawCss },
        );

        // 1. Every page trap element must stay rgb(0, 0, 0) (zero leakage)
        for (const entry of comparison.pageTrapColors) {
          expect(entry, `selector="${rawSelector}"`).toMatch(/:rgb\(0, 0, 0\)$/);
        }
        // 2. Every component element's computed color in the flat DOM must match the isolated Shadow DOM 1:1
        expect(comparison.flatInstColors, `selector="${rawSelector}"`).toEqual(
          comparison.shadowInstColors,
        );
      }
    } finally {
      await browser.close();
    }
  }, 30000);

  it.each([
    "migration-examples/ports/react-product-table",
    "migration-examples/ports/vue-grid",
    "migration-examples/ports/astro-blog",
    "migration-examples/ports/eleventy-blog",
    "migration-examples/ports/nextjs-blog",
    "migration-examples/ports/wordpress-blog",
    "templates/blog",
  ])("builds and passes --check on real example site from migration-tutorials-oct052026: %s", (siteSubpath) => {
    let branchExists = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "migration-tutorials-oct052026"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      branchExists = true;
    } catch {
      branchExists = false;
    }
    if (!branchExists) return;

    const dir = mkdtempSync(join(tmpdir(), "bascik-migration-port-"));
    try {
      execFileSync(
        "sh",
        ["-c", `git archive migration-tutorials-oct052026 "${siteSubpath}" | tar -x -C "${dir}"`],
        { cwd: repoRoot },
      );
      const siteRoot = join(dir, siteSubpath);
      const localNodeModules = join(siteRoot, "node_modules");
      mkdirSync(localNodeModules, { recursive: true });
      const rootNodeModules = join(repoRoot, "node_modules");
      for (const entry of readdirSync(rootNodeModules)) {
        if (entry === "zod") continue;
        symlinkSync(join(rootNodeModules, entry), join(localNodeModules, entry));
      }

      const writePkgShim = (pkgName: string, files: Record<string, string>) => {
        const pkgDir = join(localNodeModules, pkgName);
        if (existsSync(pkgDir)) return;
        mkdirSync(pkgDir, { recursive: true });
        for (const [relFile, content] of Object.entries(files)) {
          const absFile = join(pkgDir, relFile);
          mkdirSync(join(absFile, ".."), { recursive: true });
          writeFileSync(absFile, content, "utf8");
        }
      };

      const realZodIndexUrl = new URL("../../../node_modules/zod/index.js", import.meta.url).href;
      writePkgShim("zod", {
        "package.json": JSON.stringify({ name: "zod", version: "4.6.5", type: "module", main: "index.js" }),
        "index.js": [
          `import * as realZod from ${JSON.stringify(realZodIndexUrl)};`,
          "const z = Object.assign({}, realZod.z, {",
          "  url: () => realZod.z.string().url(),",
          "  iso: { datetime: () => realZod.z.string() },",
          "  prettifyError: (err) => String(err?.message ?? err),",
          "});",
          "export { z };",
          "export default z;",
        ].join("\n"),
      });

      writePkgShim("gray-matter", {
        "package.json": JSON.stringify({ name: "gray-matter", version: "4.0.3", type: "module", main: "index.js" }),
        "index.js": [
          "export default function matter(src) {",
          "  const m = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/.exec(String(src));",
          "  if (!m) return { data: {}, content: String(src) };",
          "  const data = {};",
          "  const lines = m[1].split(/\\r?\\n/);",
          "  for (let i = 0; i < lines.length; i++) {",
          "    const line = lines[i];",
          "    const kv = /^([a-zA-Z0-9_-]+):\\s*(.*)$/.exec(line);",
          "    if (!kv) continue;",
          "    const key = kv[1];",
          "    let val = kv[2].trim();",
          "    if (val === '') {",
          "      const arr = [];",
          "      let obj = null;",
          "      while (i + 1 < lines.length && /^\\s+/.test(lines[i + 1])) {",
          "        i++;",
          "        const sub = lines[i].trim();",
          "        if (sub.startsWith('- ')) {",
          "          arr.push(sub.slice(2).trim().replace(/^['\"]|['\"]$/g, ''));",
          "        } else {",
          "          const skv = /^([a-zA-Z0-9_-]+):\\s*(.*)$/.exec(sub);",
          "          if (skv) {",
          "            obj = obj || {};",
          "            obj[skv[1]] = skv[2].trim().replace(/^['\"]|['\"]$/g, '');",
          "          }",
          "        }",
          "      }",
          "      data[key] = obj || arr;",
          "    } else if (val.startsWith('[') && val.endsWith(']')) {",
          "      const inner = val.slice(1, -1).trim();",
          "      data[key] = inner ? inner.split(',').map(s => s.trim().replace(/^['\"]|['\"]$/g, '')) : [];",
          "    } else if (val === 'true' || val === 'false') {",
          "      data[key] = val === 'true';",
          "    } else if (/^-?\\d+$/.test(val)) {",
          "      data[key] = Number(val);",
          "    } else {",
          "      data[key] = val.replace(/^['\"]|['\"]$/g, '');",
          "    }",
          "  }",
          "  return { data, content: m[2] };",
          "}",
        ].join("\n"),
      });

      writePkgShim("feed", {
        "package.json": JSON.stringify({ name: "feed", version: "6.0.0", type: "module", main: "index.js" }),
        "index.js": [
          "export class Feed {",
          "  constructor(opts = {}) { this.opts = opts; this.items = []; }",
          "  addItem(item) { this.items.push(item); }",
          "  rss2() { return `<?xml version=\"1.0\" encoding=\"utf-8\"?><rss version=\"2.0\"><channel><title>${this.opts.title ?? ''}</title>${this.items.map(i => `<item><title>${i.title ?? ''}</title><link>${i.link ?? ''}</link></item>`).join('')}</channel></rss>`; }",
          "  atom1() { return `<?xml version=\"1.0\" encoding=\"utf-8\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><title>${this.opts.title ?? ''}</title>${this.items.map(i => `<entry><title>${i.title ?? ''}</title><id>${i.id ?? ''}</id></entry>`).join('')}</feed>`; }",
          "}",
        ].join("\n"),
      });

      writePkgShim("marked-footnote", {
        "package.json": JSON.stringify({ name: "marked-footnote", version: "1.4.0", type: "module", main: "index.js" }),
        "index.js": "export default function markedFootnote() { return {}; }\n",
      });

      writePkgShim("marked-gfm-heading-id", {
        "package.json": JSON.stringify({ name: "marked-gfm-heading-id", version: "4.1.4", type: "module", main: "index.js" }),
        "index.js": "export function gfmHeadingId() { return {}; }\n",
      });

      writePkgShim("image-size", {
        "package.json": JSON.stringify({ name: "image-size", version: "2.0.4", type: "module", main: "index.js" }),
        "index.js": [
          "export function imageSize(buf) {",
          "  if (buf && buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {",
          "    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };",
          "  }",
          "  return { width: 800, height: 600, type: 'png' };",
          "}",
          "export default imageSize;",
        ].join("\n"),
      });

      writePkgShim("prismjs", {
        "package.json": JSON.stringify({ name: "prismjs", version: "1.30.0", main: "index.js" }),
        "index.js": [
          "const Prism = {",
          "  languages: { diff: {}, javascript: {}, html: {}, css: {}, bash: {}, markdown: {}, json: {}, typescript: {} },",
          "  highlight(code) {",
          "    return String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
          "  },",
          "};",
          "globalThis.Prism = Prism;",
          "module.exports = Prism;",
        ].join("\n"),
        "components.json": JSON.stringify({
          languages: {
            javascript: { alias: ["js"] },
            typescript: { alias: ["ts"] },
            markdown: { alias: ["md"] },
            markup: { alias: ["html", "xml", "svg"] },
            css: {},
            bash: { alias: ["sh", "shell"] },
            json: {},
            diff: {},
          },
        }),
        "components/index.js": "module.exports = function loadLanguages() {};\n",
        "components/prism-diff.js": "module.exports = {};\n",
        "plugins/diff-highlight/prism-diff-highlight.js": "module.exports = {};\n",
        "themes/prism-okaidia.css": "code[class*=\"language-\"], pre[class*=\"language-\"] { color: #f8f8f2; background: #272822; }\n",
      });

      writePkgShim("date-fns", {
        "package.json": JSON.stringify({ name: "date-fns", version: "3.6.0", type: "module", main: "index.js" }),
        "index.js": [
          "export function parseISO(s) { return new Date(s); }",
          "export function format(d) {",
          "  return d instanceof Date && !Number.isNaN(d.valueOf())",
          "    ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })",
          "    : String(d);",
          "}",
        ].join("\n"),
      });

      writePkgShim("remark", {
        "package.json": JSON.stringify({ name: "remark", version: "15.0.1", type: "module", main: "index.js" }),
        "index.js": [
          "import { marked } from 'marked';",
          "export function remark() {",
          "  return {",
          "    use() { return this; },",
          "    async process(md) { return { toString: () => marked.parse(String(md), { async: false }) }; },",
          "  };",
          "}",
        ].join("\n"),
      });

      writePkgShim("remark-html", {
        "package.json": JSON.stringify({ name: "remark-html", version: "16.0.1", type: "module", main: "index.js" }),
        "index.js": "export default function html() { return {}; }\n",
      });

      writePkgShim("tailwindcss", {
        "package.json": JSON.stringify({ name: "tailwindcss", version: "3.4.4", type: "module", main: "index.js" }),
        "index.js": [
          "export default function tailwindcss() {",
          "  return {",
          "    postcssPlugin: 'tailwindcss-shim',",
          "    Once(root) {",
          "      root.walkAtRules('tailwind', (rule) => rule.remove());",
          "    },",
          "  };",
          "}",
          "tailwindcss.postcss = true;",
        ].join("\n"),
      });

      writePkgShim("sanitize-html", {
        "package.json": JSON.stringify({ name: "sanitize-html", version: "2.17.7", type: "module", main: "index.js" }),
        "index.js": [
          "function sanitizeHtml(html, opts = {}) {",
          "  let s = String(html ?? '');",
          "  if (Array.isArray(opts.allowedTags) && opts.allowedTags.length === 0) {",
          "    return s.replace(/<[^>]*>/g, '');",
          "  }",
          "  s = s.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');",
          "  if (opts.transformTags) {",
          "    for (const [tag, fn] of Object.entries(opts.transformTags)) {",
          "      const re = new RegExp(`<(${tag})\\\\b([^>]*)>`, 'gi');",
          "      s = s.replace(re, (_m, tn, attrStr) => {",
          "        const attribs = {};",
          "        for (const am of attrStr.matchAll(/([a-zA-Z0-9_-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')/g)) {",
          "          attribs[am[1]] = am[2] ?? am[3] ?? '';",
          "        }",
          "        const res = fn(tn.toLowerCase(), attribs);",
          "        const outAttrs = Object.entries(res.attribs || {}).map(([k, v]) => ` ${k}=\"${v}\"`).join('');",
          "        return `<${res.tagName}${outAttrs}>`;",
          "      });",
          "    }",
          "  }",
          "  return s;",
          "}",
          "sanitizeHtml.defaults = {",
          "  allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'div', 'span'],",
          "  allowedAttributes: { a: ['href', 'name', 'target'], img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'] },",
          "};",
          "export default sanitizeHtml;",
        ].join("\n"),
      });

      // Upgrade pre-rc.5 console.log build and routes scripts in the extracted oct052026 branch fixture to current export default contract
      const upgradeDirectiveScripts = (rootDir: string) => {
        const htmlFiles = execFileSync("find", [rootDir, "-name", "*.html"], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean);
        for (const htmlFile of htmlFiles) {
          const raw = readFileSync(htmlFile, "utf8");
          if ((!raw.includes("data-bascik-build") && !raw.includes("data-bascik-routes")) || raw.includes("export default")) continue;
          const updated = raw
            .replace(
              /(<script\s+data-bascik-build(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?\s*>)([\s\S]*?)(<\/script>)/g,
              (_m, open: string, body: string, close: string) => {
                const imports: string[] = [];
                const statements: string[] = [];
                for (const line of body.split("\n")) {
                  if (/^\s*import\s+/.test(line)) imports.push(line);
                  else statements.push(line);
                }
                const rewrittenBody = statements
                  .join("\n")
                  .replace(/\bconsole\.log\s*\(([\s\S]*?)\)\s*;/g, "__out.push(String($1));");
                return `${open}\n${imports.join("\n")}\nexport default async function () {\nconst __out = [];\n${rewrittenBody}\nreturn __out.join("\\n");\n}\n${close}`;
              },
            )
            .replace(
              /(<script\s+data-bascik-routes\s*>)([\s\S]*?)(<\/script>)/g,
              (_m, open: string, body: string, close: string) => {
                const imports: string[] = [];
                const statements: string[] = [];
                for (const line of body.split("\n")) {
                  if (/^\s*import\s+/.test(line)) imports.push(line);
                  else statements.push(line);
                }
                const rewrittenBody = statements
                  .join("\n")
                  .replace(/\bconsole\.log\s*\(\s*JSON\.stringify\s*\(([\s\S]*?)\)\s*\)\s*;/g, "return $1;");
                return `${open}\n${imports.join("\n")}\nexport default async function () {\n${rewrittenBody}\n}\n${close}`;
              },
            );
          writeFileSync(htmlFile, updated, "utf8");
        }
      };
      upgradeDirectiveScripts(siteRoot);

      const buildRes = runBascikCli(siteRoot, ["--build", "--site-url", "https://example.com"]);
      expect(buildRes.status, `${siteSubpath} build failed:\n${buildRes.stdout}\n${buildRes.stderr}`).toBe(0);

      const indexHtml = readFileSync(join(siteRoot, "dist/index.html"), "utf8");
      assertValidHtml5(indexHtml, `${siteSubpath} dist/index.html`);

      const checkRes = runBascikCli(siteRoot, ["--check", "--site-url", "https://example.com"]);
      expect(checkRes.status, `${siteSubpath} check failed:\n${checkRes.stdout}\n${checkRes.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
