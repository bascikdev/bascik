/**
 * Prompt 133: a real `bascik --build --target ...` emits a private executable
 * module graph and a public asset tree, with no source access needed at
 * request time and no dynamic template in the public tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  addUnsupportedImportRoute,
  buildServerlessFixture,
  cleanupServerlessFixture,
  createServerlessFixture,
} from "./serverless-fixture.test-helper.ts";

const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, "");
  return out.sort();
};

describe("serverless build artifacts (real build, cloudflare-pages)", () => {
  let root: string;
  let targetDir: string;
  let publicDir: string;

  beforeAll(async () => {
    root = await createServerlessFixture("pages-build");
    await buildServerlessFixture(root, "cloudflare-pages");
    targetDir = join(root, "dist", ".bascik", "cloudflare-pages");
    publicDir = join(targetDir, "public");
  }, 120_000);

  afterAll(async () => {
    if (root) await cleanupServerlessFixture(root);
  });

  it("leaves the default dist/ output unchanged (static tree with placeholders and sidecar)", async () => {
    const account = await readFile(join(root, "dist", "account.html"), "utf8");
    expect(account).toContain('type="text/bascik-server"');
    await expect(stat(join(root, "dist", ".bascik", "server-scripts.json"))).resolves.toBeTruthy();
  });

  it("emits a public tree with static files, the worker, and routing, and no dynamic templates", async () => {
    const files = await listFiles(publicDir);
    expect(files).toContain("index.html");
    expect(files).toContain("404.html");
    expect(files).toContain("assets/logo.txt");
    expect(files).toContain("style.css");
    expect(files).toContain("_worker.js");
    expect(files).toContain("_routes.json");
    // Dynamic pages are private.
    expect(files).not.toContain("account.html");
    expect(files).not.toContain("dashboard.html");
    expect(files).not.toContain("broken-stream.html");
    // Metadata, sidecars, and source never reach the upload tree.
    expect(files.some((f) => f.startsWith(".bascik/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".map") || f.endsWith(".ts"))).toBe(false);
    expect(files.some((f) => f.includes("server-scripts.json"))).toBe(false);
  });

  it("the worker bundle contains the handlers and page plans, resolves aliases, and imports no source paths", async () => {
    const worker = await readFile(join(publicDir, "_worker.js"), "utf8");
    // Inline job, src= job with relative + transitive helper, inline job
    // using the @/ alias, API handlers.
    expect(worker).toContain("account-greeting");
    expect(worker).toContain("header-job");
    expect(worker).toContain("alias-job");
    expect(worker).toContain("chunk");
    // Nothing points back at the developer's filesystem.
    expect(worker).not.toContain(root);
    expect(worker).not.toMatch(/from\s+["']node:child_process["']/);
    // No eval or Function constructor is used to load code.
    expect(worker).not.toMatch(/\beval\(/);
    expect(worker).not.toMatch(/new Function\(/);
  });

  it("_routes.json invokes the worker for every dynamic alias and the API prefix only", async () => {
    const routes = JSON.parse(await readFile(join(publicDir, "_routes.json"), "utf8")) as { include: string[]; exclude: string[] };
    expect(routes.include).toEqual(
      expect.arrayContaining(["/account", "/account/", "/account.html", "/dashboard", "/broken-stream", "/broken-server", "/api/*"]),
    );
    expect(routes.include).not.toContain("/");
    expect(routes.include).not.toContain("/index.html");
    expect(routes.include).not.toContain("/style.css");
    expect(routes.exclude).toEqual([]);
  });

  it("build-info.json records release identity, bundle size, and inventory with notes", async () => {
    const info = JSON.parse(await readFile(join(targetDir, "build-info.json"), "utf8"));
    expect(info.target).toBe("cloudflare-pages");
    expect(info.adapter).toBe("cloudflare");
    expect(info.bundleBytes).toBeGreaterThan(1000);
    expect(info.dynamicPages).toEqual(["/account", "/broken-server", "/broken-stream", "/dashboard"]);
    expect(info.apiRoutes).toEqual(expect.arrayContaining(["/api/health", "/api/users/[id]", "/api/echo", "/api/stream", "/api/boom"]));
    expect(typeof info.release).toBe("string");
    expect(info.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^compatibility date: \d{4}-\d{2}-\d{2}$/),
        expect.stringContaining("compatibility flags:"),
        expect.stringContaining("invocation routes:"),
      ]),
    );
  });

  it("is deterministic: a second build produces a byte-identical worker", async () => {
    const first = await readFile(join(publicDir, "_worker.js"));
    await buildServerlessFixture(root, "cloudflare-pages");
    const second = await readFile(join(publicDir, "_worker.js"));
    expect(second.equals(first)).toBe(true);
  }, 120_000);
});

describe("serverless build artifacts (real build, cloudflare-workers)", () => {
  let root: string;

  beforeAll(async () => {
    root = await createServerlessFixture("workers-build", { base: "/docs/" });
    await buildServerlessFixture(root, "cloudflare-workers");
  }, 120_000);

  afterAll(async () => {
    if (root) await cleanupServerlessFixture(root);
  });

  it("emits worker.js beside a public assets directory and a wrangler config with worker-first routing", async () => {
    const targetDir = join(root, "dist", ".bascik", "cloudflare-workers");
    const files = await listFiles(targetDir);
    expect(files).toContain("worker.js");
    expect(files).toContain("wrangler.jsonc");
    expect(files).toContain("public/index.html");
    expect(files).not.toContain("public/_worker.js");
    expect(files).not.toContain("public/account.html");
    const wrangler = JSON.parse(await readFile(join(targetDir, "wrangler.jsonc"), "utf8"));
    expect(wrangler.main).toBe("worker.js");
    expect(wrangler.assets.directory).toBe("./public");
    expect(wrangler.assets.binding).toBe("ASSETS");
    expect(wrangler.assets.run_worker_first).toEqual(expect.arrayContaining(["/docs/account", "/docs/api/*"]));
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
  });
});

describe("serverless build failures", () => {
  it("rejects an unsupported Node builtin with the authored import chain and leaves no bundle", async () => {
    const root = await createServerlessFixture("unsupported");
    try {
      await addUnsupportedImportRoute(root);
      const failure = await buildServerlessFixture(root, "cloudflare-pages").catch((e: { stderr?: string; stdout?: string }) => e);
      const text = `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
      expect(text).toContain('"node:child_process"');
      expect(text).toContain("src/lib/run.ts");
      expect(text).toContain("API route /api/run");
      await expect(stat(join(root, "dist", ".bascik", "cloudflare-pages", "public", "_worker.js"))).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);

  it("rejects --target combined with --only", async () => {
    const root = await createServerlessFixture("only");
    try {
      const failure = await buildServerlessFixture(root, "cloudflare-pages", ["--only", "index.html"]).catch((e: { stderr?: string }) => e);
      expect(failure.stderr).toContain("--target cannot be combined with --only");
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 60_000);
});
