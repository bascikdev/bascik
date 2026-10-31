/**
 * The generated Worker in workerd under the settings an authored Wrangler
 * config deploys it with: compatibility date and flags, `html_handling` and
 * `not_found_handling` reach the harness from the generated wrangler.jsonc
 * (cloudflare-harness.test-helper.ts, readHarnessSettings), so a test here
 * runs what `wrangler deploy` would, not the adapter's defaults.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SiteGraph } from "@bascik/bascik/adapter";
import { build } from "./build.ts";
import {
  readHarnessSettings,
  startHarness,
  type Harness,
} from "./cloudflare-harness.test-helper.ts";

interface SiteOptions {
  variant?: "pages" | "workers";
  /** dist-relative file -> body. */
  files?: Record<string, string>;
  /** An authored wrangler.jsonc at the project root. */
  wrangler?: string;
  /** project-relative module file -> source, one API route each. */
  apiRoutes?: Record<string, { path: string; source: string }>;
  csp?: SiteGraph["contentSecurityPolicy"];
  logs?: string[];
}

const roots: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const buildSite = async (options: SiteOptions = {}) => {
  const variant = options.variant ?? "workers";
  // The real path: esbuild reports importers by it (macOS tmpdir is a link).
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-cf-authored-")),
  );
  roots.push(root);
  const distDir = join(root, "dist");
  const outDir = join(distDir, ".bascik", `cloudflare-${variant}`);
  await mkdir(join(outDir, ".staging"), { recursive: true });
  const files = { "index.html": "<p>home</p>", ...options.files };
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(distDir, file)), { recursive: true });
    await writeFile(join(distDir, file), body);
  }
  if (options.wrangler !== undefined)
    await writeFile(join(root, "wrangler.jsonc"), options.wrangler);
  const apiRoutes: SiteGraph["apiRoutes"] = [];
  for (const [file, route] of Object.entries(options.apiRoutes ?? {})) {
    const filePath = join(root, file);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, route.source);
    apiRoutes.push({
      path: route.path,
      filePath,
      paramNames: [],
      isDynamic: false,
    });
  }
  const graph: SiteGraph = {
    base: "/",
    release: "test-rel",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    publicFiles: Object.keys(files),
    pages: {},
    apiRoutes,
    importRoot: root,
    ...(options.csp ? { contentSecurityPolicy: options.csp } : {}),
  };
  const result = await build({
    graph,
    distDir,
    outDir,
    projectRoot: root,
    variant,
    log: (message) => options.logs?.push(message),
    runtimeEntry: "",
  });
  return { root, outDir, result, variant };
};

const serve = async (site: Awaited<ReturnType<typeof buildSite>>) => {
  const harness = await startHarness({
    projectRoot: site.root,
    target: `cloudflare-${site.variant}`,
  });
  harnesses.push(harness);
  return harness;
};

describe("the harness runs the Worker under the generated wrangler.jsonc's settings", () => {
  it("reads an authored compatibility date and flags, html_handling and not_found_handling", async () => {
    const site = await buildSite({
      wrangler: JSON.stringify({
        compatibility_date: "2026-09-01",
        compatibility_flags: ["enable_nodejs_os_module"],
        assets: {
          html_handling: "force-trailing-slash",
          not_found_handling: "none",
        },
      }),
    });
    const settings = await readHarnessSettings(
      await realpath(site.outDir),
      "cloudflare-workers",
    );
    expect(settings.compatibilityDate).toBe("2026-09-01");
    expect(settings.compatibilityFlags).toEqual([
      "enable_nodejs_os_module",
      "nodejs_compat",
    ]);
    expect(settings.assetConfig).toEqual({
      html_handling: "force-trailing-slash",
      not_found_handling: "none",
    });
  }, 60_000);

  it("without an authored config, the adapter's pinned settings and Cloudflare's asset defaults", async () => {
    const site = await buildSite();
    const wrangler = JSON.parse(
      await readFile(join(site.outDir, "wrangler.jsonc"), "utf8"),
    ) as { compatibility_date: string };
    const settings = await readHarnessSettings(
      await realpath(site.outDir),
      "cloudflare-workers",
    );
    expect(settings.compatibilityDate).toBe(wrangler.compatibility_date);
    expect(settings.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(settings.assetConfig).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
    });
  }, 60_000);

  it("an authored html_handling and not_found_handling change what workerd serves, as they would deployed", async () => {
    const site = await buildSite({
      files: { "about.html": "<p>about</p>", "404.html": "<p>lost</p>" },
      wrangler: JSON.stringify({
        assets: {
          html_handling: "force-trailing-slash",
          not_found_handling: "none",
        },
      }),
    });
    const harness = await serve(site);
    const about = await harness.fetch("/about", { redirect: "manual" });
    await about.arrayBuffer();
    expect(about.status).toBe(307);
    expect(about.headers.get("location")).toBe("/about/");
    const missing = await harness.fetch("/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("lost");
  }, 60_000);
});

describe("the static 404 page's Content-Security-Policy on a 404 for any URL", () => {
  const policy = { directives: { "default-src": ["'self'"] } };
  const csp = {
    policy,
    hashes: {
      "/404": { scripts: ["'sha256-notfound'"], styles: [] },
      "/docs/404": { scripts: ["'sha256-docsnotfound'"], styles: [] },
    },
    staticRoutes: ["/", "/404", "/docs/404"],
  };
  const files = {
    "404.html": "<p>lost</p><script>1</script>",
    "docs/404.html": "<p>docs lost</p><script>2</script>",
  };
  const cspOf = async (harness: Harness, path: string) => {
    const res = await harness.mf.dispatchFetch(`https://example.test${path}`);
    return {
      status: res.status,
      body: await res.text(),
      value: res.headers.get("content-security-policy"),
    };
  };

  it("with run_worker_first: true, the Worker sends the policy of the 404 page whose body the asset layer serves", async () => {
    const site = await buildSite({
      files,
      csp,
      wrangler: JSON.stringify({ assets: { run_worker_first: true } }),
    });
    const harness = await serve(site);
    const missing = await cspOf(harness, "/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("<p>lost</p>");
    expect(missing.value).toBe(
      "default-src 'self'; script-src 'self' 'sha256-notfound'",
    );
    // Cloudflare serves the nearest 404.html: its own policy goes with it.
    const nested = await cspOf(harness, "/docs/nope");
    expect(nested.status).toBe(404);
    expect(nested.body).toContain("docs lost");
    expect(nested.value).toBe(
      "default-src 'self'; script-src 'self' 'sha256-docsnotfound'",
    );
    // The 404 page at its own URL keeps answering 404 with its policy.
    const own = await cspOf(harness, "/404");
    expect(own.status).toBe(404);
    expect(own.value).toBe(
      "default-src 'self'; script-src 'self' 'sha256-notfound'",
    );
  }, 60_000);

  it.each(["pages", "workers"] as const)(
    "misuse: cloudflare-%s without the Worker in front of static files, the build says the policy reaches the 404 page's own URL only",
    async (variant) => {
      const logs: string[] = [];
      await buildSite({ variant, files, csp, logs });
      const warning = logs.find((l) => l.includes("404"));
      expect(warning).toMatch(
        new RegExp(
          `^\\[bascik\\] --target cloudflare-${variant}: .*Content-Security-Policy.*static 404 page.*/404, /docs/404.*_headers.*status`,
          "s",
        ),
      );
      expect(warning).toContain(
        variant === "workers"
          ? `"run_worker_first": true`
          : "--target cloudflare-workers",
      );
    },
    60_000,
  );

  it("no warning when the Worker runs first, or without a policy", async () => {
    const logs: string[] = [];
    await buildSite({
      files,
      csp,
      logs,
      wrangler: JSON.stringify({ assets: { run_worker_first: true } }),
    });
    await buildSite({ files, logs });
    expect(logs.filter((l) => l.includes("404"))).toEqual([]);
  }, 60_000);
});

describe("the static 404 page at its own URLs under an authored html_handling", () => {
  it.each([
    "auto-trailing-slash",
    "force-trailing-slash",
    "drop-trailing-slash",
    "none",
  ])(
    "html_handling %s: /404, /404/ and /404.html answer 404 with the page, never a redirect",
    async (htmlHandling) => {
      const site = await buildSite({
        files: { "404.html": "<p>lost</p>" },
        wrangler: JSON.stringify({ assets: { html_handling: htmlHandling } }),
      });
      const harness = await serve(site);
      for (const path of ["/404", "/404/", "/404.html"]) {
        const res = await harness.fetch(path, { redirect: "manual" });
        expect(res.status, `${path} under ${htmlHandling}`).toBe(404);
        expect(await res.text(), path).toContain("<p>lost</p>");
        const head = await harness.fetch(path, {
          method: "HEAD",
          redirect: "manual",
        });
        await head.arrayBuffer();
        expect(head.status, `HEAD ${path}`).toBe(404);
      }
    },
    60_000,
  );

  it("misuse: not_found_handling none and html_handling none still find the page by its file name", async () => {
    const site = await buildSite({
      files: { "404.html": "<p>lost</p>" },
      wrangler: JSON.stringify({
        assets: { html_handling: "none", not_found_handling: "none" },
      }),
    });
    const harness = await serve(site);
    const res = await harness.fetch("/404/", { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<p>lost</p>");
  }, 60_000);
});

describe("node:* imports against the compatibility date the Worker deploys with", () => {
  const route = (imports: string[]) => ({
    "src/api/node.ts": {
      path: "/api/node",
      source: `${imports.map((m, i) => `import * as m${i} from "${m}";`).join("\n")}\nexport const GET = () => new Response(String([${imports.map((_, i) => `Object.keys(m${i}).length`).join(", ")}].every((n) => n > 0)));`,
    },
  });

  it.each([
    ["2025-08-15", ["node:http", "node:https"]],
    ["2025-09-15", ["node:fs", "node:fs/promises", "node:os"]],
    ["2026-03-17", ["node:perf_hooks"]],
  ])(
    "at %s, %j build and load in workerd",
    async (date, imports) => {
      const site = await buildSite({
        apiRoutes: route(imports),
        wrangler: JSON.stringify({ compatibility_date: date }),
      });
      const harness = await serve(site);
      const res = await harness.fetch("/api/node");
      expect(await res.text()).toBe("true");
      expect(res.status).toBe(200);
    },
    60_000,
  );

  it("misuse: an authored older compatibility_date fails the build for a module it does not provide, naming the date, the file and the route", async () => {
    await expect(
      buildSite({
        apiRoutes: route(["node:fs/promises"]),
        wrangler: `{\n  // copied from an older project\n  "compatibility_date": "2024-10-01",\n}`,
      }),
    ).rejects.toThrow(
      /"node:fs\/promises" \(imported by src\/api\/node\.ts\).*compatibility date 2024-10-01 \(wrangler\.jsonc\)[\s\S]*Reached from: API route \/api\/node[\s\S]*needs compatibility_date "2025-09-15" or later/,
    );
  }, 60_000);

  it("misuse: an env section's older date fails the build too, naming the section", async () => {
    await expect(
      buildSite({
        apiRoutes: route(["node:os"]),
        wrangler: JSON.stringify({
          env: { legacy: { compatibility_date: "2025-01-01" } },
        }),
      }),
    ).rejects.toThrow(
      /"node:os".*compatibility date 2025-01-01 \(wrangler\.jsonc env\.legacy\)/,
    );
  }, 60_000);

  it("the module's own enable flag in the authored config is honored", async () => {
    const site = await buildSite({
      apiRoutes: route(["node:os"]),
      wrangler: JSON.stringify({
        compatibility_date: "2025-01-01",
        compatibility_flags: ["enable_nodejs_os_module"],
      }),
    });
    const harness = await serve(site);
    expect(await (await harness.fetch("/api/node")).text()).toBe("true");
  }, 60_000);

  it("misuse: node:http2 and v8 (digits in the name) get the adapter's located message, not esbuild's platform hint", async () => {
    for (const specifier of ["node:http2", "v8"]) {
      const error = await buildSite({ apiRoutes: route([specifier]) }).then(
        () => undefined,
        (err: Error) => err,
      );
      expect(error?.message, specifier).toMatch(
        new RegExp(
          `"${specifier}" \\(imported by src/api/node\\.ts\\) is not available[\\s\\S]*Reached from: API route /api/node`,
        ),
      );
      expect(error?.message, specifier).not.toContain("platform");
    }
  }, 60_000);

  it("the Pages variant ignores the Wrangler config and uses the pinned date", async () => {
    const site = await buildSite({
      variant: "pages",
      apiRoutes: route(["node:fs"]),
      wrangler: JSON.stringify({ compatibility_date: "2024-10-01" }),
    });
    expect(site.result.notes).toContain("compatibility date: 2026-08-01");
  }, 60_000);
});

describe("build notes report the settings the Worker deploys with", () => {
  it("an authored compatibility date and flags, not the pinned ones", async () => {
    const site = await buildSite({
      wrangler: JSON.stringify({
        compatibility_date: "2026-09-01",
        compatibility_flags: ["enable_nodejs_os_module"],
      }),
    });
    expect(site.result.notes).toContain("compatibility date: 2026-09-01");
    expect(site.result.notes).toContain(
      "compatibility flags: enable_nodejs_os_module, nodejs_compat",
    );
  }, 60_000);

  it("misuse: the unsupported-import message names the authored date too", async () => {
    await expect(
      buildSite({
        apiRoutes: {
          "src/api/run.ts": {
            path: "/api/run",
            source: `import { execFile } from "node:child_process";\nexport const GET = () => new Response(typeof execFile);`,
          },
        },
        wrangler: JSON.stringify({ compatibility_date: "2026-09-01" }),
      }),
    ).rejects.toThrow(/for compatibility date 2026-09-01 \(wrangler\.jsonc\)/);
  }, 60_000);
});

describe("a project reached through a symlinked folder", () => {
  it("misuse: an unsupported import still names the project-relative file and the route", async () => {
    const real = await realpath(
      await mkdtemp(join(tmpdir(), "bascik-cf-linked-real-")),
    );
    roots.push(real);
    const linkParent = await mkdtemp(join(tmpdir(), "bascik-cf-linked-"));
    roots.push(linkParent);
    const root = join(linkParent, "site");
    await symlink(real, root, "junction");
    const distDir = join(root, "dist");
    const outDir = join(distDir, ".bascik", "cloudflare-workers");
    await mkdir(join(outDir, ".staging"), { recursive: true });
    const filePath = join(root, "src/api/run.ts");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `import { execFile } from "node:child_process";\nexport const GET = () => new Response(typeof execFile);`,
    );
    const graph: SiteGraph = {
      base: "/",
      release: "test-rel",
      scriptTimeoutMs: 1000,
      apiTimeoutMs: 1000,
      onServerScriptError: "error",
      publicFiles: [],
      pages: {},
      apiRoutes: [
        { path: "/api/run", filePath, paramNames: [], isDynamic: false },
      ],
      importRoot: root,
    };
    const error = await build({
      graph,
      distDir,
      outDir,
      projectRoot: root,
      variant: "workers",
      log: () => {},
      runtimeEntry: "",
    }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toMatch(
      /"node:child_process" \(imported by src\/api\/run\.ts\)[\s\S]*Reached from: API route \/api\/run/,
    );
  }, 60_000);
});

describe("authored files named like the adapter's own", () => {
  it("a service worker at src/pages/worker.js deploys and is served: the generated worker.js sits beside public/", async () => {
    const site = await buildSite({
      files: { "worker.js": "self.addEventListener('fetch', () => {});" },
    });
    const harness = await serve(site);
    const res = await harness.fetch("/worker.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("addEventListener");
  }, 60_000);

  it("misuse: an authored _routes.json on the Workers variant fails the build instead of deploying unreachable", async () => {
    await expect(
      buildSite({ files: { "_routes.json": "{}" } }),
    ).rejects.toThrow(
      /--target cloudflare-workers: authored file "_routes\.json" would never be served/,
    );
  }, 60_000);
});

describe("an API route that upgrades to a WebSocket", () => {
  const live = {
    "src/api/live.ts": {
      path: "/api/live",
      source: `export const GET = (request: Request) => {
  if (request.headers.get("upgrade") !== "websocket")
    return new Response("expected a WebSocket upgrade", { status: 426 });
  // @ts-expect-error WebSocketPair is a Workers global.
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event: MessageEvent) => server.send("echo:" + event.data));
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
};`,
    },
  };

  it("returns the handler's 101 with its webSocket, and the socket echoes", async () => {
    const site = await buildSite({ apiRoutes: live });
    const harness = await serve(site);
    const res = await harness.mf.dispatchFetch("http://example.test/api/live", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const socket = res.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();
    const reply = new Promise<string>((resolve) =>
      socket!.addEventListener("message", (event) =>
        resolve(String(event.data)),
      ),
    );
    socket!.send("frother");
    expect(await reply).toBe("echo:frother");
    socket!.close();
  }, 60_000);

  it("misuse: the same route without an upgrade keeps the handler's own answer and the security headers", async () => {
    const site = await buildSite({ apiRoutes: live });
    const harness = await serve(site);
    const res = await harness.fetch("/api/live");
    expect(res.status).toBe(426);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }, 60_000);
});
