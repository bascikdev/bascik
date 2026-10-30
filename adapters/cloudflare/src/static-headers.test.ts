/**
 * The security headers on Cloudflare static files, in workerd (miniflare's
 * asset layer is the same workers-shared code Cloudflare runs): the build
 * writes them into public/_headers, the asset layer adds them to static
 * files, and the Worker adds them to what it answers. A header is never
 * sent twice (Cloudflare would join the two values with a comma), a static
 * page and a page the Worker renders send the same set, and an author's own
 * _headers rule replaces Bascik's value. headers-file.test.ts covers the
 * text; serverless-parity compares with `bascik --server`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SiteGraph } from "@bascik/bascik/adapter";
import { resolveResponseSecurity } from "@bascik/bascik/runtime";
import { build } from "./build.ts";
import {
  startHarness,
  type Harness,
} from "./cloudflare-harness.test-helper.ts";

const SECURITY_HEADERS = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
];

const JOB_ID = "server_script_dyn";

interface SetupOptions {
  /** Extra static pages: dist-relative file -> body. */
  pages?: Record<string, string>;
  /** The opt-in CSP (staticRoutes are the static pages' HTTP paths). */
  csp?: SiteGraph["contentSecurityPolicy"];
  /** An authored wrangler.jsonc at the project root. */
  wrangler?: string;
  /** The Worker page's path (default /dyn). */
  dynPath?: string;
  base?: string;
  logs?: string[];
}

const setup = async (
  variant: "pages" | "workers",
  security: Parameters<typeof resolveResponseSecurity>[0],
  authoredHeaders?: string,
  options: SetupOptions = {},
) => {
  const root = await mkdtemp(join(tmpdir(), `bascik-cf-static-headers-`));
  const distDir = join(root, "dist");
  const outDir = join(distDir, ".bascik", `cloudflare-${variant}`);
  await mkdir(join(outDir, ".staging"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<p>home</p>");
  await writeFile(join(distDir, "embed.html"), "<p>embed</p>");
  await writeFile(join(distDir, "logo.txt"), "logo");
  const publicFiles = ["index.html", "embed.html", "logo.txt"];
  for (const [file, body] of Object.entries(options.pages ?? {})) {
    await mkdir(dirname(join(distDir, file)), { recursive: true });
    await writeFile(join(distDir, file), body);
    publicFiles.push(file);
  }
  if (authoredHeaders !== undefined) {
    await writeFile(join(distDir, "_headers"), authoredHeaders);
    publicFiles.push("_headers");
  }
  if (options.wrangler !== undefined)
    await writeFile(join(root, "wrangler.jsonc"), options.wrangler);
  const jobPath = join(outDir, ".staging", "dyn.mjs");
  await writeFile(jobPath, `export default () => "<p>dynamic</p>";`);
  const dynPath = options.dynPath ?? "/dyn";
  const graph: SiteGraph = {
    base: options.base ?? "/",
    release: "test-rel",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    publicFiles,
    pages: {
      [dynPath]: {
        path: dynPath,
        is404: false,
        segments: [
          { kind: "static", text: "<main>" },
          { kind: "script", id: JOB_ID },
          { kind: "static", text: "</main>" },
        ],
        jobs: {
          [JOB_ID]: {
            id: JOB_ID,
            mode: "server",
            source: { kind: "inline", code: "", stagedPath: jobPath },
            owner: "server script in src/pages/dyn.html:1",
          },
        },
      },
    },
    apiRoutes: [],
    importRoot: root,
    responseSecurity: resolveResponseSecurity(security),
    ...(options.csp ? { contentSecurityPolicy: options.csp } : {}),
  };
  try {
    await build({
      graph,
      distDir,
      outDir,
      projectRoot: root,
      variant,
      log: (message) => options.logs?.push(message),
      runtimeEntry: "",
    });
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
  const harness = await startHarness({
    projectRoot: root,
    target: `cloudflare-${variant}`,
  });
  return { root, outDir, harness };
};

/** The security headers of a response, over https so the Worker sends HSTS. */
const securityOf = async (harness: Harness, path: string) => {
  const res = await harness.mf.dispatchFetch(`https://example.test${path}`);
  await res.arrayBuffer();
  const headers: Record<string, string> = {};
  for (const name of SECURITY_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: res.status, headers };
};

describe.each(["pages", "workers"] as const)(
  "cloudflare-%s: security headers on static files",
  (variant) => {
    describe("defaults", () => {
      let ctx: Awaited<ReturnType<typeof setup>>;
      beforeAll(async () => {
        ctx = await setup(variant, undefined);
      }, 60_000);
      afterAll(async () => {
        await ctx?.harness.dispose();
        if (ctx) await rm(ctx.root, { recursive: true, force: true });
      });

      it("a static page, an asset and a Worker-rendered page send the same five headers and HSTS, each once", async () => {
        const dynamic = await securityOf(ctx.harness, "/dyn");
        expect(dynamic.status).toBe(200);
        expect(dynamic.headers).toEqual({
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "strict-origin-when-cross-origin",
          "cross-origin-opener-policy": "same-origin-allow-popups",
          "cross-origin-resource-policy": "cross-origin",
          "strict-transport-security": "max-age=31536000",
        });
        for (const path of ["/", "/embed", "/logo.txt"]) {
          const got = await securityOf(ctx.harness, path);
          expect(got.status, path).toBe(200);
          expect(got.headers, path).toEqual(dynamic.headers);
        }
      });

      it("the generated _headers holds one site-wide rule", async () => {
        const text = await readFile(
          join(ctx.outDir, "public/_headers"),
          "utf8",
        );
        expect(text.match(/^\/\*$/gm)).toHaveLength(1);
      });
    });

    describe("an author's own rules and changed settings", () => {
      let ctx: Awaited<ReturnType<typeof setup>>;
      beforeAll(async () => {
        ctx = await setup(
          variant,
          {
            headers: {
              "referrer-policy": "no-referrer",
              "x-frame-options": false,
            },
            hsts: { includeSubDomains: true },
          },
          "/embed\n  X-Frame-Options: DENY\n  Referrer-Policy: same-origin\n/logo.txt\n  ! Cross-Origin-Resource-Policy\n",
        );
      }, 60_000);
      afterAll(async () => {
        await ctx?.harness.dispose();
        if (ctx) await rm(ctx.root, { recursive: true, force: true });
      });

      it("the static home page and the Worker page follow security.headers and security.hsts alike", async () => {
        const dynamic = await securityOf(ctx.harness, "/dyn");
        const home = await securityOf(ctx.harness, "/");
        expect(home.headers).toEqual(dynamic.headers);
        expect(home.headers["referrer-policy"]).toBe("no-referrer");
        expect(home.headers["x-frame-options"]).toBeUndefined();
        expect(home.headers["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains",
        );
      });

      it("the author's value replaces Bascik's on their path, never joined to it", async () => {
        const embed = await securityOf(ctx.harness, "/embed");
        expect(embed.headers["x-frame-options"]).toBe("DENY");
        expect(embed.headers["referrer-policy"]).toBe("same-origin");
        expect(embed.headers["x-content-type-options"]).toBe("nosniff");
      });

      it("the author's ! Name removes a header on their path", async () => {
        const logo = await securityOf(ctx.harness, "/logo.txt");
        expect(logo.headers["cross-origin-resource-policy"]).toBeUndefined();
        expect(logo.headers["x-content-type-options"]).toBe("nosniff");
      });
    });

    describe("security.headers false and security.hsts false", () => {
      let ctx: Awaited<ReturnType<typeof setup>>;
      beforeAll(async () => {
        ctx = await setup(variant, { headers: false, hsts: false });
      }, 60_000);
      afterAll(async () => {
        await ctx?.harness.dispose();
        if (ctx) await rm(ctx.root, { recursive: true, force: true });
      });

      it("no _headers is written and neither host sends the headers", async () => {
        await expect(
          readFile(join(ctx.outDir, "public/_headers"), "utf8"),
        ).rejects.toThrow();
        expect((await securityOf(ctx.harness, "/")).headers).toEqual({});
        expect((await securityOf(ctx.harness, "/dyn")).headers).toEqual({});
      });
    });
  },
);

const policy = { directives: { "default-src": ["'self'"] } };

/** A response's header, read over https. */
const headerOf = async (harness: Harness, path: string, name: string) => {
  const res = await harness.mf.dispatchFetch(`https://example.test${path}`);
  await res.arrayBuffer();
  return { status: res.status, value: res.headers.get(name) };
};

describe.each(["pages", "workers"] as const)(
  "cloudflare-%s: an author's _headers rules and the static pages' CSP",
  (variant) => {
    describe("an author's wildcard CSP rule under a base", () => {
      let ctx: Awaited<ReturnType<typeof setup>>;
      beforeAll(async () => {
        ctx = await setup(
          variant,
          undefined,
          "/shop/blog/*\n  Content-Security-Policy: default-src *\n",
          {
            base: "/shop/",
            pages: {
              "blog/post.html": "<p>post</p>",
              "about.html": "<p>about</p>",
            },
            csp: {
              policy,
              hashes: {},
              staticRoutes: ["/", "/blog/post", "/about"],
            },
          },
        );
      }, 60_000);
      afterAll(async () => {
        await ctx?.harness.dispose();
        if (ctx) await rm(ctx.root, { recursive: true, force: true });
      });

      it("the static page under the rule sends the author's policy alone, never two policies joined", async () => {
        const post = await headerOf(
          ctx.harness,
          "/shop/blog/post",
          "content-security-policy",
        );
        expect(post.status).toBe(200);
        expect(post.value).toBe("default-src *");
      });

      it("a static page outside the rule keeps Bascik's policy", async () => {
        const about = await headerOf(
          ctx.harness,
          "/shop/about",
          "content-security-policy",
        );
        expect(about.value).toBe("default-src 'self'");
      });
    });

    describe("a static page whose CSP line is over Cloudflare's 2000 characters", () => {
      const hashes = {
        "/many": {
          scripts: Array.from(
            { length: 45 },
            (_, i) => `'sha256-${String(i).padStart(43, "A")}='`,
          ),
          styles: [],
        },
      };

      it("fails the build, naming the page, instead of shipping it with no CSP", async () => {
        await expect(
          setup(variant, undefined, undefined, {
            pages: { "many.html": "<p>many</p>" },
            csp: { policy, hashes, staticRoutes: ["/many"] },
          }),
        ).rejects.toThrow(/static page \/many is \d+ characters.*2000/s);
      }, 60_000);

      if (variant === "workers")
        it("with run_worker_first: true, as the error says, the build passes and the Worker sends the full policy on the static page", async () => {
          const ctx = await setup(variant, undefined, undefined, {
            pages: { "many.html": "<p>many</p>" },
            csp: { policy, hashes, staticRoutes: ["/many"] },
            wrangler: `{ "assets": { "run_worker_first": true } }`,
          });
          try {
            const many = await headerOf(
              ctx.harness,
              "/many",
              "content-security-policy",
            );
            expect(many.status).toBe(200);
            expect(many.value).toBe(
              `default-src 'self'; script-src 'self' ${hashes["/many"].scripts.join(" ")}`,
            );
            expect(many.value!.length).toBeGreaterThan(2000);
          } finally {
            await ctx.harness.dispose();
            await rm(ctx.root, { recursive: true, force: true });
          }
        }, 60_000);
    });

    describe("more static pages with CSP than _headers holds", () => {
      const pages = Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`p${i}.html`, `<p>${i}</p>`]),
      );
      const csp = {
        policy,
        hashes: {},
        staticRoutes: Array.from({ length: 100 }, (_, i) => `/p${i}`),
      };

      it("fails with the count and Cloudflare's limit", async () => {
        await expect(
          setup(variant, undefined, undefined, { pages, csp }),
        ).rejects.toThrow(
          /needs 101 rules.*reads at most 100.*run_worker_first/s,
        );
      }, 60_000);

      if (variant === "workers")
        it("following the message (run_worker_first: true in wrangler.jsonc) builds, and every static page gets its CSP and the security headers from the Worker, each once", async () => {
          const ctx = await setup(
            variant,
            undefined,
            "/p1\n  X-Frame-Options: DENY\n",
            {
              pages,
              csp,
              wrangler: `{\n  // the error's advice\n  "assets": { "run_worker_first": true },\n}`,
            },
          );
          try {
            const wrangler = JSON.parse(
              await readFile(join(ctx.outDir, "wrangler.jsonc"), "utf8"),
            ) as { assets: { run_worker_first: unknown } };
            expect(wrangler.assets.run_worker_first).toBe(true);
            // The author's file is left as written.
            expect(
              await readFile(join(ctx.outDir, "public/_headers"), "utf8"),
            ).toBe("/p1\n  X-Frame-Options: DENY\n");
            const dynamic = await securityOf(ctx.harness, "/dyn");
            for (const path of ["/p0", "/p99", "/logo.txt"]) {
              const got = await securityOf(ctx.harness, path);
              expect(got.status, path).toBe(200);
              expect(got.headers, path).toEqual(dynamic.headers);
            }
            expect(
              (await headerOf(ctx.harness, "/p42", "content-security-policy"))
                .value,
            ).toBe("default-src 'self'");
            expect(
              (
                await headerOf(
                  ctx.harness,
                  "/logo.txt",
                  "content-security-policy",
                )
              ).value,
            ).toBeNull();
            // The author's own rule still wins on its path.
            expect(
              (await securityOf(ctx.harness, "/p1")).headers["x-frame-options"],
            ).toBe("DENY");
          } finally {
            await ctx.harness.dispose();
            await rm(ctx.root, { recursive: true, force: true });
          }
        }, 120_000);
    });

    describe("a page the Worker renders under an author's wildcard rule", () => {
      let ctx: Awaited<ReturnType<typeof setup>>;
      const logs: string[] = [];
      beforeAll(async () => {
        ctx = await setup(
          variant,
          undefined,
          "/embed/*\n  X-Frame-Options: ALLOWALL\n",
          {
            pages: { "embed/static.html": "<p>static</p>" },
            dynPath: "/embed/dyn",
            logs,
          },
        );
      }, 60_000);
      afterAll(async () => {
        await ctx?.harness.dispose();
        if (ctx) await rm(ctx.root, { recursive: true, force: true });
      });

      it("_headers reaches the static page only; the Worker page keeps security.headers' value, and the build says so", async () => {
        expect(
          (await securityOf(ctx.harness, "/embed/static")).headers[
            "x-frame-options"
          ],
        ).toBe("ALLOWALL");
        expect(
          (await securityOf(ctx.harness, "/embed/dyn")).headers[
            "x-frame-options"
          ],
        ).toBe("SAMEORIGIN");
        expect(logs.join("\n")).toMatch(
          /rule \/embed\/\* sets X-Frame-Options.*\/embed\/dyn is rendered by the Worker.*security\.headers/s,
        );
      });
    });
  },
);
