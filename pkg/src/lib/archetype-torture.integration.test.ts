import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { parse } from "parse5";

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
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, BASCIK_SITE_URL: "https://example.com", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
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

  it.each([
    "migration-examples/ports/react-product-table",
    "migration-examples/ports/vue-grid",
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
      symlinkSync(join(repoRoot, "node_modules"), join(siteRoot, "node_modules"), "dir");

      // Upgrade pre-rc.5 console.log build scripts in the extracted oct052026 branch fixture to current export default contract
      const upgradeBuildScripts = (rootDir: string) => {
        const htmlFiles = execFileSync("find", [rootDir, "-name", "*.html"], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean);
        for (const htmlFile of htmlFiles) {
          const raw = readFileSync(htmlFile, "utf8");
          if (!raw.includes("data-bascik-build") || raw.includes("export default")) continue;
          const updated = raw.replace(
            /(<script\s+data-bascik-build>)([\s\S]*?)(<\/script>)/g,
            (_m, open: string, body: string, close: string) => {
              const imports: string[] = [];
              const statements: string[] = [];
              for (const line of body.split("\n")) {
                if (/^\s*import\s+/.test(line)) imports.push(line);
                else statements.push(line);
              }
              const rewrittenBody = statements
                .join("\n")
                .replace(/\bconsole\.log\s*\(([\s\S]*?)\)\s*;/g, "return $1;");
              return `${open}\n${imports.join("\n")}\nexport default async function () {\n${rewrittenBody}\n}\n${close}`;
            },
          );
          writeFileSync(htmlFile, updated, "utf8");
        }
      };
      upgradeBuildScripts(siteRoot);

      const buildRes = runBascikCli(siteRoot, ["--build", "--site-url", "https://example.com"]);
      expect(buildRes.status, buildRes.stderr).toBe(0);

      const indexHtml = readFileSync(join(siteRoot, "dist/index.html"), "utf8");
      assertValidHtml5(indexHtml, `${siteSubpath} dist/index.html`);

      const checkRes = runBascikCli(siteRoot, ["--check", "--site-url", "https://example.com"]);
      expect(checkRes.status, checkRes.stdout + checkRes.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
