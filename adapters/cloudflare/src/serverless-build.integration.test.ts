/**
 * Prompt 133: a real `bascik --build --target ...` emits a private executable
 * module graph and a public asset tree, with no source access needed at
 * request time and no dynamic template in the public tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addUnsupportedImportComponent,
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

  it("leaves the default dist/ output unchanged (static tree with placeholders; the sidecar beside it)", async () => {
    const account = await readFile(join(root, "dist", "account.html"), "utf8");
    expect(account).toContain('type="text/bascik-server"');
    await expect(
      stat(join(root, ".bascik", "dist", "server-scripts.json")),
    ).resolves.toBeTruthy();
    // dist/.bascik holds the deployment folder only, never a private file.
    expect(await readdir(join(root, "dist", ".bascik"))).toEqual([
      "cloudflare-pages",
    ]);
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
    expect(files.some((f) => f.endsWith(".map") || f.endsWith(".ts"))).toBe(
      false,
    );
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
    const routes = JSON.parse(
      await readFile(join(publicDir, "_routes.json"), "utf8"),
    ) as { include: string[]; exclude: string[] };
    expect(routes.include).toEqual(
      expect.arrayContaining([
        "/account",
        "/account/",
        "/account.html",
        "/dashboard",
        "/broken-stream",
        "/broken-server",
        "/api/*",
      ]),
    );
    expect(routes.include).not.toContain("/");
    expect(routes.include).not.toContain("/index.html");
    expect(routes.include).not.toContain("/style.css");
    expect(routes.exclude).toEqual([]);
  });

  it("build-info.json records release identity, bundle size, and inventory with notes", async () => {
    const info = JSON.parse(
      await readFile(join(targetDir, "build-info.json"), "utf8"),
    );
    expect(info.target).toBe("cloudflare-pages");
    expect(info.adapter).toBe("cloudflare");
    expect(info.bundleBytes).toBeGreaterThan(1000);
    expect(info.dynamicPages).toEqual([
      "/account",
      "/broken-server",
      "/broken-stream",
      "/dashboard",
    ]);
    expect(info.apiRoutes).toEqual(
      expect.arrayContaining([
        "/api/health",
        "/api/users/[id]",
        "/api/echo",
        "/api/stream",
        "/api/boom",
      ]),
    );
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
  let output: string;

  beforeAll(async () => {
    root = await createServerlessFixture("workers-build", { base: "/docs/" });
    const { stdout, stderr } = await buildServerlessFixture(
      root,
      "cloudflare-workers",
    );
    output = `${stdout}${stderr}`;
  }, 120_000);

  it("dist/ after a --target build is the site plus .bascik/cloudflare-workers/ (the Worker and its config), as the docs say, and the build says not to publish dist/", async () => {
    const files = await listFiles(join(root, "dist"));
    const bascik = files.filter((f) => f.startsWith(".bascik/"));
    // Everything Bascik adds sits in the deploy folder.
    expect(
      bascik.every((f) => f.startsWith(".bascik/cloudflare-workers/")),
    ).toBe(true);
    expect(bascik).toContain(".bascik/cloudflare-workers/worker.js");
    expect(bascik).toContain(".bascik/cloudflare-workers/wrangler.jsonc");
    // The private build files are never in dist/.
    expect(
      files.some((f) =>
        /(^|\/)(server-scripts|csp-hashes|ownership|build-state|components)\.json$/.test(
          f,
        ),
      ),
    ).toBe(false);
    expect(output).toMatch(
      /dist\/ now also holds dist\/\.bascik\/cloudflare-workers\/ \(the Worker and its config\)\. Deploy that folder; do not publish dist\/ to a static host\./,
    );
    // The deployment docs say the same.
    const docs = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../docs/content/deployment/static-hosting.md",
      ),
      "utf8",
    );
    expect(docs).toMatch(/--target[\s\S]{0,300}\.bascik\/<target>\//);
  });

  afterAll(async () => {
    if (root) await cleanupServerlessFixture(root);
  });

  it("emits worker.js beside a public assets directory and a wrangler config with worker-first routing", async () => {
    const targetDir = join(root, "dist", ".bascik", "cloudflare-workers");
    const files = await listFiles(targetDir);
    expect(files).toContain("worker.js");
    expect(files).toContain("wrangler.jsonc");
    // Static files are staged below the base so the asset layer serves them
    // at the same /docs/... URLs the Node server uses.
    expect(files).toContain("public/docs/index.html");
    expect(files).not.toContain("public/index.html");
    expect(files).not.toContain("public/_worker.js");
    expect(files).not.toContain("public/docs/account.html");
    expect(files).not.toContain("public/account.html");
    const wrangler = JSON.parse(
      await readFile(join(targetDir, "wrangler.jsonc"), "utf8"),
    );
    expect(wrangler.main).toBe("worker.js");
    expect(wrangler.assets.directory).toBe("./public");
    expect(wrangler.assets.binding).toBe("ASSETS");
    expect(wrangler.assets.run_worker_first).toEqual(
      expect.arrayContaining(["/docs/account", "/docs/api/*"]),
    );
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
  });
});

describe("serverless build failures", () => {
  it("rejects an unsupported Node builtin with the authored import chain and leaves no bundle", async () => {
    const root = await createServerlessFixture("unsupported");
    try {
      await addUnsupportedImportRoute(root);
      const failure = await buildServerlessFixture(
        root,
        "cloudflare-pages",
      ).catch((e: { stderr?: string; stdout?: string }) => e);
      const text = `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
      expect(text).toContain('"node:child_process"');
      expect(text).toContain("src/lib/run.ts");
      expect(text).toContain("API route /api/run");
      await expect(
        stat(
          join(
            root,
            "dist",
            ".bascik",
            "cloudflare-pages",
            "public",
            "_worker.js",
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);

  it("rejects --target combined with --only", async () => {
    const root = await createServerlessFixture("only");
    try {
      const failure = await buildServerlessFixture(root, "cloudflare-pages", [
        "--only",
        "index.html",
      ]).catch((e: { stderr?: string }) => e);
      expect(failure.stderr).toContain(
        "--target cannot be combined with --only",
      );
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 60_000);
});

// ─── Request-time components (prompt 157) ───────────────────────────────────

const NOT_DECLARED = "does not declare components: true";

describe("serverless build artifacts: request-time components (prompt 157)", () => {
  for (const target of ["cloudflare-pages", "cloudflare-workers"] as const) {
    describe(target, () => {
      let root: string;
      let output: { stdout: string; stderr: string };
      let worker: string;

      beforeAll(async () => {
        root = await createServerlessFixture(`components-build-${target}`, {
          components: true,
        });
        output = await buildServerlessFixture(root, target);
        const targetDir = join(root, "dist", ".bascik", target);
        worker = await readFile(
          join(
            targetDir,
            target === "cloudflare-pages" ? "public/_worker.js" : "worker.js",
          ),
          "utf8",
        );
      }, 120_000);

      afterAll(async () => {
        if (root) await cleanupServerlessFixture(root);
      });

      it("the Cloudflare adapter declares components: the core warning stays silent", () => {
        expect(`${output.stdout}${output.stderr}`).toContain(
          `✓ ${target} (cloudflare) bundle`,
        );
        expect(`${output.stdout}${output.stderr}`).not.toContain(NOT_DECLARED);
      });

      it("the bundle carries the manifest and the component scripts it names", async () => {
        const manifest = JSON.parse(
          await readFile(join(root, ".bascik/dist/components.json"), "utf8"),
        ) as {
          components: Record<
            string,
            { css: { text?: string } | null; jobs: Array<{ id: string }> }
          >;
        };
        const css = manifest.components["product-card"].css?.text;
        expect(css).toContain(".bascik__product-card__tile{");
        expect(worker).toContain(css);
        const [liveJob] = manifest.components["product-card-live"].jobs;
        expect(worker).toContain(liveJob.id);
        // The nested job's own source, not just its id.
        expect(worker).toContain("at request time");
      });

      // What the target deploys: Pages uploads public/; Workers uploads
      // worker.js and the assets directory wrangler.jsonc names. A static
      // host serves every file there, dotfiles included, so Bascik's
      // private build folder must never be in it (Collin 2026-10-29).
      it("the deployable output holds no .bascik folder at any depth", async () => {
        const targetDir = join(root, "dist", ".bascik", target);
        const isBascik = (rel: string) =>
          rel
            .split("/")
            .some(
              (seg) => seg.replace(/[. ]+$/, "").toLowerCase() === ".bascik",
            );
        const publicFiles = await listFiles(join(targetDir, "public"));
        expect(publicFiles).toContain("index.html");
        expect(publicFiles.filter(isBascik)).toEqual([]);
        expect(publicFiles.some((f) => f.includes("server-scripts"))).toBe(
          false,
        );
        expect(publicFiles).not.toContain("ownership.json");
        if (target === "cloudflare-workers") {
          const wrangler = JSON.parse(
            await readFile(join(targetDir, "wrangler.jsonc"), "utf8"),
          ) as { main: string; assets: { directory: string } };
          expect(wrangler.main).toBe("worker.js");
          expect(wrangler.assets.directory).toBe("./public");
        }
      });

      it("the build notes report the manifest's size", () => {
        expect(output.stdout).toMatch(
          /note: component manifest: \d+ bytes \(\d+ components\)/,
        );
      });
    });
  }

  it("a hosting adapter that does not declare components gets the warning naming it and the components", async () => {
    const root = await createServerlessFixture("components-stub-adapter", {
      components: true,
    });
    try {
      await writeFile(
        join(root, "stub-adapter.mjs"),
        `import { mkdir } from "node:fs/promises";
import { join } from "node:path";
export default {
  name: "stub-host",
  async build(context) {
    const publicDir = join(context.outDir, "public");
    await mkdir(publicDir, { recursive: true });
    return { publicDir };
  },
};
`,
        "utf8",
      );
      const { stdout, stderr } = await buildServerlessFixture(
        root,
        "./stub-adapter.mjs" as never,
      );
      const text = `${stdout}${stderr}`;
      expect(text).toContain(
        `adapter "stub-host" does not declare components: true, so component tags returned by server and stream scripts are not rendered on this host and reach the client as written`,
      );
      expect(text).toContain("<product-card>, <product-card-live>");
      // An unsupported component is never listed as renderable.
      expect(text).not.toContain("<bound-id-card>");
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);

  it("misuse: a dist whose components.json is missing is refused before the adapter bundles anything", async () => {
    const root = await createServerlessFixture("components-missing-manifest", {
      components: true,
    });
    try {
      await buildServerlessFixture(root, "cloudflare-pages");
      await rm(join(root, ".bascik/dist/components.json"));
      const script = `
        import { emitServerlessArtifacts } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pkg/dist/lib/serverless-artifacts.js"))};
        await emitServerlessArtifacts("cloudflare-pages", { version: "test" });
      `;
      const outcome = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd: root, env: { ...process.env, BASCIK_BUILD: "1" } },
      ).catch((e: { stderr: string }) => e);
      expect(outcome.stderr).toContain(
        "[bascik] --target: the sidecar has server-script entries but .bascik/dist/components.json is missing. Run `bascik --build` again.",
      );
      await expect(
        stat(join(root, "dist/.bascik/cloudflare-pages/public/_worker.js")),
      ).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);

  it("misuse: a component script importing an unsupported builtin fails the build naming the component file, and leaves no bundle", async () => {
    const root = await createServerlessFixture("components-unsupported");
    try {
      await addUnsupportedImportComponent(root);
      const { stdout, stderr } = await buildServerlessFixture(
        root,
        "cloudflare-pages",
      );
      const text = `${stderr}${stdout}`;
      expect(text).toContain('"node:child_process"');
      expect(text).toContain("src/components/forked-card/forked-card.html");
      await expect(
        stat(join(root, "dist/.bascik/cloudflare-pages/public/_worker.js")),
      ).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);
});
