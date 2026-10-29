/**
 * A static deploy never publishes Bascik's private build folder.
 *
 * A static host (Cloudflare Pages, Netlify, GitHub Pages, S3, a web root)
 * serves every file of the folder it deploys, dotfiles included, and
 * bascik.dev served /.bascik/ownership.json from its dist/. The private
 * files (ownership inventory, build state, server-script sidecar with every
 * server script's source, component manifest, CSP hashes, file manifest) now
 * live beside the output directory, in `.bascik/<out>/`, so `dist/` is only
 * the site. These tests run real `bascik --build`, `--build --only` and
 * `--server` processes and check that `bascik --server`, targeted builds and
 * the ownership coordinator keep working from the new place, and that the
 * old place is never written.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupFixture,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./lib/build-fixtures.ts";

const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every path under `dir`, directories included, relative with forward slashes. */
const walk = async (dir: string, prefix = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    out.push(rel);
    if (entry.isDirectory())
      out.push(...(await walk(join(dir, entry.name), `${rel}/`)));
  }
  return out;
};

const hasBascikSegment = (rel: string) =>
  rel
    .split("/")
    .some((s) => s.replace(/[. ]+$/, "").toLowerCase() === ".bascik");

const writeSite = async (root: string, outDir = "dist") => {
  await writeFixtureFile(
    root,
    "bascik.config.js",
    `module.exports = {
  directory: { components: ["src/components"], out: ${JSON.stringify(outDir)} },
  generate: { manifest: true, cspHashes: true, sitemap: false, robots: false },
};`,
  );
  await writeFixtureFile(
    root,
    "src/components/note-card.html",
    `<p class="note" data-testid="note-card"><span data-bascik-slot></span></p>`,
  );
  await writeFixtureFile(
    root,
    "src/pages/index.html",
    `<!DOCTYPE html><html><head><title>Home</title></head><body><h1 data-testid="home">Home</h1><note-card>static</note-card></body></html>`,
  );
  await writeFixtureFile(
    root,
    "src/pages/live.html",
    `<!DOCTYPE html><html><head><title>Live</title></head><body>
<script data-bascik-server>export default () => '<note-card>live ' + 'value</note-card>';</script>
</body></html>`,
  );
  await writeFixtureFile(root, "src/pages/.well-known/security.txt", "x\n");
};

const startServer = async (root: string, port: number) => {
  const child = spawn(process.execPath, [PKG_ENTRY, "--server"], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => (output += d.toString()));
  child.stderr?.on("data", (d) => (output += d.toString()));
  const exited = new Promise<number | null>((r) => child.on("exit", r));
  const base = `http://localhost:${port}`;
  const started = Date.now();
  let up = false;
  while (!up && Date.now() - started < 20000 && child.exitCode === null) {
    try {
      up = (await fetch(`${base}/`)).status >= 200;
    } catch {
      await wait(150);
    }
  }
  return {
    base,
    up,
    output: () => output,
    exited,
    async close() {
      child.kill();
      await exited;
    },
  };
};

describe("a static deploy never publishes the private build folder", () => {
  it("bascik --build writes no .bascik into dist/; the private files are in .bascik/dist/, which git ignores", async () => {
    const root = fixtureRoot("private-folder-build");
    await writeSite(root);
    try {
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      const deployed = await walk(join(root, "dist"));
      expect(deployed).toContain("index.html");
      expect(deployed).toContain(".well-known/security.txt");
      expect(deployed.filter(hasBascikSegment)).toEqual([]);
      const priv = join(root, ".bascik", "dist");
      for (const name of [
        "build-state.json",
        "ownership.json",
        "server-scripts.json",
        "components.json",
        "csp-hashes.json",
        "manifest.json",
      ])
        expect(existsSync(join(priv, name)), name).toBe(true);
      expect(await readFile(join(root, ".bascik", ".gitignore"), "utf8")).toBe(
        "*\n",
      );
      // The file manifest lists what is deployed: dist/ only.
      const manifest = JSON.parse(
        await readFile(join(priv, "manifest.json"), "utf8"),
      ) as { files: Record<string, unknown> };
      expect(Object.keys(manifest.files)).toContain("index.html");
      expect(Object.keys(manifest.files).filter(hasBascikSegment)).toEqual([]);
    } finally {
      await cleanupFixture(root);
    }
  }, 120_000);

  it("a nested directory.out keeps its private folder beside it, outside the deployed folder", async () => {
    const root = fixtureRoot("private-folder-nested");
    await writeSite(root, "build/www");
    try {
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      expect(
        (await walk(join(root, "build", "www"))).filter(hasBascikSegment),
      ).toEqual([]);
      expect(
        existsSync(join(root, "build", ".bascik", "www", "ownership.json")),
      ).toBe(true);
    } finally {
      await cleanupFixture(root);
    }
  }, 120_000);

  it("bascik --server and a targeted build work from .bascik/dist/; dist/ stays clean after both", async () => {
    const root = fixtureRoot("private-folder-server");
    await writeSite(root);
    try {
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      const port = 19800 + (process.pid % 150);
      let server = await startServer(root, port);
      try {
        expect(server.up, server.output()).toBe(true);
        const live = await (await fetch(`${server.base}/live`)).text();
        expect(live).toContain("live value");
        expect(live).toContain('data-testid="note-card"');
        expect(
          (await fetch(`${server.base}/.bascik/dist/ownership.json`)).status,
        ).toBe(404);
      } finally {
        await server.close();
      }

      // A targeted build reads the ownership inventory and the build state
      // from the private folder and keeps the untouched page's sidecar entry.
      await writeFixtureFile(
        root,
        "src/pages/index.html",
        `<!DOCTYPE html><html><head><title>Home</title></head><body><h1 data-testid="home">Home again</h1></body></html>`,
      );
      await runRealBuild({
        projectRoot: root,
        cliPath: PKG_ENTRY,
        args: ["--only", "index.html"],
      });
      expect(
        await readFile(join(root, "dist", "index.html"), "utf8"),
      ).toContain("Home again");
      const sidecar = JSON.parse(
        await readFile(
          join(root, ".bascik", "dist", "server-scripts.json"),
          "utf8",
        ),
      ) as { scripts: Record<string, unknown> };
      expect(Object.keys(sidecar.scripts).length).toBeGreaterThan(0);
      expect((await walk(join(root, "dist"))).filter(hasBascikSegment)).toEqual(
        [],
      );

      server = await startServer(root, port + 1);
      try {
        expect(server.up, server.output()).toBe(true);
        expect(await (await fetch(`${server.base}/live`)).text()).toContain(
          "live value",
        );
      } finally {
        await server.close();
      }
    } finally {
      await cleanupFixture(root);
    }
  }, 180_000);

  it("a full build clears the previous build's private files: a removed server script leaves no sidecar behind", async () => {
    const root = fixtureRoot("private-folder-stale");
    await writeSite(root);
    try {
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      const sidecar = join(root, ".bascik", "dist", "server-scripts.json");
      expect(existsSync(sidecar)).toBe(true);
      await rm(join(root, "src", "pages", "live.html"));
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      expect(existsSync(sidecar)).toBe(false);
      expect(existsSync(join(root, ".bascik", "dist", "ownership.json"))).toBe(
        true,
      );
    } finally {
      await cleanupFixture(root);
    }
  }, 120_000);

  it("misuse: bascik --server without the private folder (dist/ copied alone) fails before binding and names the folder", async () => {
    const root = fixtureRoot("private-folder-missing");
    await writeSite(root);
    try {
      await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
      await rm(join(root, ".bascik"), { recursive: true, force: true });
      const server = await startServer(root, 19960 + (process.pid % 30));
      if (server.up) await server.close();
      expect(server.up).toBe(false);
      const code = await server.exited;
      expect(code).not.toBe(0);
      expect(server.output()).toContain(".bascik/dist/");
      expect(server.output()).toContain("bascik --build");
    } finally {
      await cleanupFixture(root);
    }
  }, 120_000);

  describe("misuse: dist/ and .bascik/dist/ from different builds", () => {
    const writeRelease = async (root: string, v: string) => {
      await writeFixtureFile(
        root,
        "bascik.config.js",
        `module.exports = {
  generate: { sitemap: false, robots: false },
  contentSecurityPolicy: { directives: { "script-src": ["'self'"] } },
};`,
      );
      await writeFixtureFile(
        root,
        "src/pages/index.html",
        `<!DOCTYPE html><html><head><title>Home</title></head><body><script>document.title="${v}"</script></body></html>`,
      );
      await writeFixtureFile(
        root,
        "src/pages/live.html",
        `<!DOCTYPE html><html><head><title>Live</title></head><body>
<script data-bascik-server>export default () => 'server-${v}';</script>
</body></html>`,
      );
    };

    /** Copy `parts` of `from` into `to`, replacing what is there. */
    const copyParts = async (from: string, to: string, parts: string[]) => {
      await mkdir(to, { recursive: true });
      for (const part of parts) {
        await rm(join(to, part), { recursive: true, force: true });
        await cp(join(from, part), join(to, part), { recursive: true });
      }
    };

    /** The startup lines that warn about pages that differ from the build record. */
    const differenceWarnings = (output: string) =>
      output.split("\n").filter((l) => /differs? from the pages/.test(l));

    it("a post-build edit to dist/index.html starts with one warning naming the page, and serves the edited page", async () => {
      const root = fixtureRoot("private-folder-post-edit");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "index.html");
        const built = await readFile(page, "utf8");
        // A deploy step (analytics, a CDN rewrite) appends a script tag.
        await writeFile(
          page,
          built.replace(
            "</body>",
            '<script src="/analytics.js" data-testid="analytics"></script></body>',
          ),
        );

        const server = await startServer(root, 19600 + (process.pid % 80));
        try {
          expect(server.up, server.output()).toBe(true);
          const home = await (await fetch(`${server.base}/`)).text();
          expect(home).toContain('data-testid="analytics"');
          expect(await (await fetch(`${server.base}/live`)).text()).toContain(
            "server-v1",
          );
          const warnings = differenceWarnings(server.output());
          expect(warnings, server.output()).toHaveLength(1);
          expect(warnings[0]).toContain("dist/index.html");
          expect(warnings[0]).not.toContain("live.html");
          expect(warnings[0]).toContain(
            "if you edited dist/ after the build this is expected",
          );
          expect(warnings[0]).toContain(
            "if you copied .bascik/dist/ from another build, rebuild",
          );
        } finally {
          await server.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 180_000);

    it("a server-script page edited outside its script segments still renders its script, with the warning", async () => {
      const root = fixtureRoot("private-folder-post-edit-live");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "live.html");
        const built = await readFile(page, "utf8");
        expect(built).toContain("data-bascik-server-id");
        await writeFile(
          page,
          built
            .replace("<title>Live</title>", "<title>Live (edited)</title>")
            .replace(
              "</body>",
              '<footer data-testid="cdn-footer">cdn</footer></body>',
            ),
        );

        const server = await startServer(root, 19500 + (process.pid % 80));
        try {
          expect(server.up, server.output()).toBe(true);
          const live = await (await fetch(`${server.base}/live`)).text();
          expect(live).toContain("server-v1");
          expect(live).toContain("Live (edited)");
          expect(live).toContain('data-testid="cdn-footer"');
          const warnings = differenceWarnings(server.output());
          expect(warnings, server.output()).toHaveLength(1);
          expect(warnings[0]).toContain("dist/live.html");
        } finally {
          await server.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 180_000);

    it("a new dist/ with the old private folder starts with the warning when every server script still resolves", async () => {
      const root = fixtureRoot("private-folder-mixed");
      const deploy = fixtureRoot("private-folder-mixed-deploy");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        await copyParts(root, deploy, ["dist", ".bascik", "bascik.config.js"]);

        // The same release copied whole starts without the warning.
        const port = 19700 + (process.pid % 80);
        const whole = await startServer(deploy, port);
        try {
          expect(whole.up, whole.output()).toBe(true);
          expect(await (await fetch(`${whole.base}/live`)).text()).toContain(
            "server-v1",
          );
          expect(differenceWarnings(whole.output())).toEqual([]);
        } finally {
          await whole.close();
        }

        // v2, and only dist/ is replaced in the deploy folder.
        await writeRelease(root, "v2");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        await copyParts(root, deploy, ["dist"]);

        const mixed = await startServer(deploy, port + 1);
        try {
          expect(mixed.up, mixed.output()).toBe(true);
          const warnings = differenceWarnings(mixed.output());
          expect(warnings, mixed.output()).toHaveLength(1);
          // live.html holds only its script's placeholder, which v2 left
          // as it was; the changed page is index.html.
          expect(warnings[0]).toContain("dist/index.html");
          expect(warnings[0]).toContain(".bascik/dist/");
          // The server runs the scripts the private folder holds: the
          // warning is the deploy's signal that they are v1's.
          expect(await (await fetch(`${mixed.base}/live`)).text()).toContain(
            "server-v1",
          );
        } finally {
          await mixed.close();
        }
      } finally {
        await cleanupFixture(root);
        await cleanupFixture(deploy);
      }
    }, 240_000);

    it("bascik --server refuses a stale .bascik/dist/ that lacks a server script the new dist/ names", async () => {
      const root = fixtureRoot("private-folder-stale-script");
      const deploy = fixtureRoot("private-folder-stale-script-deploy");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        await copyParts(root, deploy, ["dist", ".bascik", "bascik.config.js"]);

        // v2 adds a page with a server script the v1 sidecar never staged.
        await writeRelease(root, "v2");
        await writeFixtureFile(
          root,
          "src/pages/added.html",
          `<!DOCTYPE html><html><head><title>Added</title></head><body>
<script data-bascik-server>export default () => 'added-v2';</script>
</body></html>`,
        );
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        await copyParts(root, deploy, ["dist"]);

        const stale = await startServer(deploy, 19400 + (process.pid % 80));
        if (stale.up) await stale.close();
        expect(stale.up, stale.output()).toBe(false);
        expect(await stale.exited).not.toBe(0);
        expect(stale.output()).toContain(
          "production startup validation failed",
        );
        expect(stale.output()).toContain("pages/added.html");
        expect(stale.output()).toMatch(/could not be resolved from sidecar/);
      } finally {
        await cleanupFixture(root);
        await cleanupFixture(deploy);
      }
    }, 240_000);

    it("a targeted build refuses a dist/ that is not the one the private folder describes", async () => {
      const root = fixtureRoot("private-folder-mixed-only");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const v1 = join(root, "v1-dist");
        await cp(join(root, "dist"), v1, { recursive: true });
        await writeRelease(root, "v2");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        await rm(join(root, "dist"), { recursive: true, force: true });
        await cp(v1, join(root, "dist"), { recursive: true });
        await expect(
          runRealBuild({
            projectRoot: root,
            cliPath: PKG_ENTRY,
            args: ["--only", "index.html"],
          }),
        ).rejects.toThrow(/different builds/);
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);
  });
});
