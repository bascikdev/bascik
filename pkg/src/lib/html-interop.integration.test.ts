/**
 * @bascik/bascik/html on the real Node servers (Collin 2026-10-28).
 *
 * A site's server, stream and build scripts import the helpers through the
 * package's export map, exactly as a user's do, and return what `html`
 * returns (an object that stringifies to the HTML). The real CLI runs from
 * source: `bascik` (dev) and `bascik --build` + `bascik --server` (prod).
 *
 * The temp site's node_modules/@bascik/bascik is a package with pkg's own
 * `./html` export entry and src/html.ts bundled to the file it names, so the
 * test does not depend on whether pkg/dist was built, but does fail when the
 * export map lacks `./html`.
 *
 * Also covers the opt-in `contentSecurityPolicy` option: absent, no header
 * (default unchanged); present, the header carries the directives plus the
 * route's build hashes, never a hash of what a script returned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_ENTRY = join(PKG, "src/index.ts");

const page = (title: string, body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <main>\n${body}\n  </main>\n</body>\n</html>\n`;

const ATTACK = `<product-card data-bascik-prop-name=x><img src=x onerror=alert(1)></product-card>`;

const SITE: Record<string, string> = {
  "src/components/product-card/product-card.html": `<article class="tile" data-testid="product-card">
  <h3 class="tile-name" data-testid="product-card-name" data-bascik-prop-name>Unnamed</h3>
</article>
<style>.tile { color: rgb(1, 2, 3); }</style>
`,
  "src/lib/cards.ts": `import { html } from "@bascik/bascik/html";
export const item = (name: string) => html\`<li>\${name}</li>\`;
`,
  "src/pages/index.html": page(
    "Home",
    `    <p>static</p>\n    <script>console.log("inline");</script>`,
  ),
  "src/pages/search.html": page(
    "Search",
    `    <script data-bascik-server>
      import { html } from "@bascik/bascik/html";
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return html\`<p data-testid="echo">You searched for \${q}</p>
<product-card data-bascik-prop-name="\${q}"></product-card>
<a data-testid="link" href="\${q}">again</a>
<ul>\${["a<", "b&"].map((n) => html\`<li>\${n}</li>\`)}</ul>\`;
      }
    </script>`,
  ),
  "src/pages/stream.html": page(
    "Stream",
    `    <p>shell</p>
    <script data-bascik-stream>
      import { html } from "@bascik/bascik/html";
      export default async function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return html\`<p data-testid="echo">\${q}</p><product-card data-bascik-prop-name="\${q}"></product-card>\`;
      }
    </script>`,
  ),
  "src/pages/json.html": page(
    "Json",
    `    <script data-bascik-server>
      import { html, json } from "@bascik/bascik/html";
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return html\`<script type="application/json" id="data">\${json({ q })}<\\/script>\`;
      }
    </script>`,
  ),
  "src/pages/shared.html": page(
    "Shared",
    `    <script data-bascik-server>
      import { html } from "@bascik/bascik/html";
      import { item } from "@/lib/cards.ts";
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return html\`<ul data-testid="shared">\${[q, "x"].map(item)}</ul>\`;
      }
    </script>`,
  ),
  "src/pages/built.html": page(
    "Built",
    `    <script data-bascik-build>
      import { html } from "@bascik/bascik/html";
      import { item } from "@/lib/cards.ts";
      export default () => html\`<ul data-testid="built">\${["<b>", "c"].map(item)}</ul>\`;
    </script>`,
  ),
  "src/pages/misuse.html": page(
    "Misuse",
    `    <script data-bascik-server>
      import { html } from "@bascik/bascik/html";
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return html\`<button onclick="\${q}">go</button>\`;
      }
    </script>`,
  ),
  "src/pages/reflect.html": page(
    "Reflect",
    `    <script data-bascik-server>
      import { raw } from "@bascik/bascik/html";
      // An author bug on purpose: raw() around visitor text. The CSP header
      // must never carry a hash of what a script returned.
      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return raw("<script>" + q + "</script>");
      }
    </script>`,
  ),
};

/** node_modules/@bascik/bascik with pkg's own ./html export entry, bundled from source. */
const installHtmlPackage = async (root: string): Promise<void> => {
  const real = JSON.parse(
    await readFile(join(PKG, "package.json"), "utf8"),
  ) as {
    exports: Record<string, { types: string; default: string }>;
  };
  const entry = real.exports["./html"];
  const dir = join(root, "node_modules/@bascik/bascik");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@bascik/bascik",
      type: "module",
      exports: entry ? { "./html": entry } : {},
    }),
  );
  if (!entry) return;
  await build({
    entryPoints: [join(PKG, "src/html.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: join(dir, entry.default),
    logLevel: "silent",
  });
};

const writeProject = async (
  files: Record<string, string>,
  config: string,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-safe-html-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, "bascik.config.ts"), config);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "safe-html-site", type: "module", private: true }),
  );
  await installHtmlPackage(root);
  return root;
};

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  BASCIK_BUILD: "0",
  BASCIK_SERVER: "0",
  VITEST: "",
  ...extra,
});

const run = (
  root: string,
  args: string[],
): Promise<{ code: number | null; output: string }> =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [PKG_ENTRY, ...args], {
      cwd: root,
      env: childEnv({}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });

const freePort = (): Promise<number> =>
  new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

interface Running {
  base: string;
  output: () => string;
  stop: () => Promise<void>;
}

const startServer = async (root: string, args: string[]): Promise<Running> => {
  const port = await freePort();
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [PKG_ENTRY, ...args], {
    cwd: root,
    env: childEnv({
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const started = Date.now();
  while (!/Server running at/.test(output)) {
    if (child.exitCode !== null || Date.now() - started > 60_000)
      throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base: `http://localhost:${port}`,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((done) => {
        child.once("close", () => done());
        child.kill("SIGINT");
      });
    },
  };
};

const MODES = [
  { mode: "dev server (`bascik`)", args: [] as string[], build: false },
  {
    mode: "production server (`bascik --server`)",
    args: ["--server"],
    build: true,
  },
];

const DEFAULT_CONFIG = `export default { directory: { components: ["src/components"] }, scripts: { importRoot: "src" } };\n`;

describe.each(MODES)(
  "html in server, stream and build scripts (real $mode)",
  ({ args, build: needsBuild }) => {
    let root: string;
    let server: Running;

    beforeAll(async () => {
      root = await writeProject(SITE, DEFAULT_CONFIG);
      if (needsBuild) {
        const { code, output } = await run(root, [
          "--build",
          "--site-url",
          "https://example.com",
        ]);
        if (code !== 0) throw new Error(`build exited ${code}:\n${output}`);
      }
      server = await startServer(root, args);
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
      if (root) await rm(root, { recursive: true, force: true });
    });

    const get = async (path: string) => {
      const response = await fetch(new URL(path, server.base));
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    };

    it("a server script's html result is the page content: escaped text, one rendered card, a list without commas", async () => {
      const { status, body } = await get(
        `/search?q=${encodeURIComponent(ATTACK)}`,
      );
      expect(status).toBe(200);
      expect(body).toContain(
        "You searched for &lt;product-card data-bascik-prop-name=x&gt;&lt;img src=x onerror=alert(1)&gt;&lt;/product-card&gt;",
      );
      expect(body).not.toMatch(/<img[\s>]/i);
      expect(body.match(/data-testid="product-card"/g)).toHaveLength(1);
      expect(body).toContain("<ul><li>a&lt;</li><li>b&amp;</li></ul>");
      expect(body).not.toContain("[object Object]");
    });

    it("a visitor's javascript: URL in href becomes about:invalid", async () => {
      const { body } = await get(
        `/search?q=${encodeURIComponent("javascript:alert(1)")}`,
      );
      expect(body).toMatch(/data-testid="link" href="about:invalid"/);
    });

    it("a stream script's html result streams as text", async () => {
      const { status, body } = await get(
        `/stream?q=${encodeURIComponent(ATTACK)}`,
      );
      expect(status).toBe(200);
      expect(body).toContain("<p>shell</p>");
      expect(body).not.toMatch(/<img[\s>]/i);
      expect(body.match(/data-testid="product-card"/g)).toHaveLength(1);
    });

    it('json() fills <script type="application/json"> and a visitor cannot end it', async () => {
      const q = `</script><script>alert(1)</script> `;
      const { body } = await get(`/json?q=${encodeURIComponent(q)}`);
      const text =
        /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(
          body,
        )?.[1];
      expect(text).toBeDefined();
      expect(JSON.parse(text!)).toEqual({ q });
      expect(body).not.toContain("<script>alert(1)");
    });

    it("a helper module shared through @/ returns html fragments the page nests", async () => {
      const { body } = await get(`/shared?q=${encodeURIComponent("<i>")}`);
      expect(body).toContain(
        `<ul data-testid="shared"><li>&lt;i&gt;</li><li>x</li></ul>`,
      );
    });

    it("a build script may return an html value (the shared card helper works at build time too)", async () => {
      const { body } = await get("/built");
      expect(body).toContain(
        `<ul data-testid="built"><li>&lt;b&gt;</li><li>c</li></ul>`,
      );
    });

    it("misuse: an onclick hole is the 500 page, and the log names the template, the hole and the file", async () => {
      const { status, body } = await get("/misuse?q=x");
      expect(status).toBe(500);
      expect(body).not.toContain("onclick");
      const deadline = Date.now() + 5000;
      while (!server.output().includes("html: hole 1") && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(server.output()).toContain(
        'html: hole 1 in html`<button onclick="${…}">go</button>` is inside the onclick attribute.',
      );
      expect(server.output()).toContain("src/pages/misuse.html");
    }, 20_000);

    it("default: no Content-Security-Policy header is added", async () => {
      for (const path of ["/", "/search?q=a"]) {
        const { headers } = await get(path);
        expect(headers.get("content-security-policy"), path).toBeNull();
        expect(
          headers.get("content-security-policy-report-only"),
          path,
        ).toBeNull();
      }
    });
  },
);

describe("build scripts: other non-string results still fail (handler-runner)", () => {
  it("a build script returning a plain object fails with the located must-return-a-string error", async () => {
    const root = await writeProject(
      {
        "src/pages/index.html": page(
          "Bad",
          `    <script data-bascik-build>\n      export default () => ({ toString: () => "<p>x</p>" });\n    </script>`,
        ),
      },
      DEFAULT_CONFIG,
    );
    try {
      const { code, output } = await run(root, [
        "--build",
        "--site-url",
        "https://example.com",
      ]);
      expect(code).not.toBe(0);
      expect(output).toContain("must return a string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── opt-in contentSecurityPolicy ──────────────────────────────────────────

const sha256 = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const CSP_CONFIG = (extra = ""): string => `export default {
  directory: { components: ["src/components"] },
  scripts: { importRoot: "src" },
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://cdn.example.com"],
      "img-src": ["'self'", "data:"],
    },${extra}
  },
};
`;

describe.each(MODES)(
  "contentSecurityPolicy (real $mode)",
  ({ args, build: needsBuild }) => {
    let root: string;
    let server: Running;

    beforeAll(async () => {
      root = await writeProject(SITE, CSP_CONFIG());
      if (needsBuild) {
        const { code, output } = await run(root, [
          "--build",
          "--site-url",
          "https://example.com",
        ]);
        if (code !== 0) throw new Error(`build exited ${code}:\n${output}`);
      }
      server = await startServer(root, args);
    }, 180_000);

    afterAll(async () => {
      await server?.stop();
      if (root) await rm(root, { recursive: true, force: true });
    });

    const header = async (path: string): Promise<string> => {
      const response = await fetch(new URL(path, server.base));
      await response.text();
      return response.headers.get("content-security-policy") ?? "";
    };

    it("a static page's header is the directives plus the page's inline script hash", async () => {
      const csp = await header("/");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toMatch(
        /script-src 'self' https:\/\/cdn\.example\.com( 'sha256-[A-Za-z0-9+/=]+')+/,
      );
      expect(csp).toContain(sha256(`console.log("inline");`));
    });

    it("a page whose script returns components carries the widened component hashes (style-src created from default-src 'self' plus hashes)", async () => {
      const csp = await header("/search?q=a");
      expect(csp).toMatch(/style-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+/);
    });

    it("never hashes what a script returned (a reflected <script> gets no hash)", async () => {
      const payload = "alert(document.domain)";
      const csp = await header(`/reflect?q=${encodeURIComponent(payload)}`);
      expect(csp).not.toContain(sha256(payload));
    });

    it("a HEAD carries the same policy as the GET", async () => {
      const response = await fetch(new URL("/", server.base), {
        method: "HEAD",
      });
      expect(response.headers.get("content-security-policy")).toBe(
        await header("/"),
      );
    });
  },
);

describe("contentSecurityPolicy.reportOnly (real production server)", () => {
  it("sends Content-Security-Policy-Report-Only instead", async () => {
    const root = await writeProject(
      SITE,
      CSP_CONFIG(`\n    reportOnly: true,\n    hashes: true,`).replace(
        `"img-src": ["'self'", "data:"],`,
        `"img-src": ["'self'", "data:"],\n      "report-to": ["csp"],`,
      ),
    );
    let server: Running | undefined;
    try {
      const { code, output } = await run(root, [
        "--build",
        "--site-url",
        "https://example.com",
      ]);
      if (code !== 0) throw new Error(`build exited ${code}:\n${output}`);
      server = await startServer(root, ["--server"]);
      const response = await fetch(new URL("/", server.base));
      await response.text();
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(
        response.headers.get("content-security-policy-report-only"),
      ).toContain("default-src 'self'");
    } finally {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
