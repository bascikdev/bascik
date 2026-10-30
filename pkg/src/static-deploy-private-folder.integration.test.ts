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
import { createHash } from "node:crypto";
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
          expect(warnings[0]).toContain(
            "To start without this warning, make the change in a `post` exec script",
          );
          // An external script needs no hash: nothing is blocked.
          expect(warnings[0]).not.toContain("Content-Security-Policy");
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

    it("a minifier that removes attribute quotes and collapses whitespace keeps the server script running", async () => {
      const root = fixtureRoot("private-folder-minified");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "live.html");
        const built = await readFile(page, "utf8");
        // What html-minifier-terser 7.2.0 writes with --remove-attribute-quotes
        // --remove-script-type-attributes --collapse-whitespace --minify-js.
        const minified = built
          .replace(/>\s+</g, "><")
          .replace(
            /<script type="text\/bascik-server" data-bascik-server-id="([^"]+)">/,
            "<script type=text/bascik-server data-bascik-server-id=$1>",
          );
        expect(minified).toContain("<script type=text/bascik-server ");
        await writeFile(page, minified);

        const server = await startServer(root, 19300 + (process.pid % 80));
        try {
          expect(server.up, server.output()).toBe(true);
          const live = await (await fetch(`${server.base}/live`)).text();
          expect(live).toContain("server-v1");
          expect(live).not.toContain("bascik-server");
          expect(differenceWarnings(server.output())[0]).toContain(
            "dist/live.html",
          );
        } finally {
          await server.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 180_000);

    it("misuse: a deploy step that removes or breaks a page's placeholder stops bascik --server, naming the page", async () => {
      const root = fixtureRoot("private-folder-lost-placeholder");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "live.html");
        const built = await readFile(page, "utf8");
        const placeholder =
          /<script type="text\/bascik-server"[^>]*><\/script>/;
        expect(built).toMatch(placeholder);
        for (const [n, rewritten] of [
          // A rewrite that dropped the type: an empty script, not a placeholder.
          built.replace(/ type="text\/bascik-server"/, ""),
          // A rewrite that dropped the element.
          built.replace(placeholder, ""),
        ].entries()) {
          await writeFile(page, rewritten);
          const server = await startServer(
            root,
            19200 + (process.pid % 40) * 2 + n,
          );
          if (server.up) await server.close();
          expect(server.up, server.output()).toBe(false);
          expect(await server.exited).not.toBe(0);
          expect(server.output()).toContain(
            "dist/live.html: .bascik/dist/server-scripts.json holds 1 server script for this page",
          );
          expect(server.output()).toContain(
            '<script type="text/bascik-server" data-bascik-server-id=',
          );
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);

    it("with contentSecurityPolicy, the warning names a changed page whose own inline script no longer matches its hash", async () => {
      const root = fixtureRoot("private-folder-csp-rewrite");
      try {
        await writeRelease(root, "v1");
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "index.html");
        const built = await readFile(page, "utf8");
        expect(built).toContain('document.title="v1"');
        // A minifier's rewrite of the page's own inline script.
        await writeFile(
          page,
          built.replace('document.title="v1"', 'document.title="v1";'),
        );
        const server = await startServer(root, 19100 + (process.pid % 80));
        try {
          expect(server.up, server.output()).toBe(true);
          const warnings = differenceWarnings(server.output());
          expect(warnings, server.output()).toHaveLength(1);
          expect(warnings[0]).toContain(
            "browsers will block the inline code in these changed pages that is not in .bascik/dist/csp-hashes.json: dist/index.html (1 inline script).",
          );
          // A post script that made the same rewrite would ship with
          // matching hashes: the build hashes the post-phase pages.
          expect(warnings[0]).toContain(
            "make the change in a `post` exec script, which runs before the build records its pages and hashes their inline code.",
          );
        } finally {
          await server.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 180_000);

    /** A release whose config runs `scripts/post-edit.mjs` (`source`) in the post phase. */
    const writePostRelease = async (
      root: string,
      source: string,
      csp = `{ directives: { "script-src": ["'self'"] } }`,
    ) => {
      await writeRelease(root, "v1");
      await writeFixtureFile(
        root,
        "bascik.config.js",
        `module.exports = {
  generate: { sitemap: false, robots: false },
  contentSecurityPolicy: ${csp},
  pipeline: { exec: [{ script: "scripts/post-edit.mjs", phase: "post" }] },
};`,
      );
      await writeFixtureFile(root, "scripts/post-edit.mjs", source);
    };

    const sha = (body: string) =>
      `sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`;

    it("a post exec script that rewrites an inline script ships with hashes and a CSP header that allow it, and no warning", async () => {
      const root = fixtureRoot("private-folder-post-csp");
      try {
        await writePostRelease(
          root,
          `import { readFile, writeFile } from "node:fs/promises";
const page = "dist/index.html";
const html = await readFile(page, "utf8");
await writeFile(page, html.replace('document.title="v1"', 'document.title="post"'));
`,
        );
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        expect(
          await readFile(join(root, "dist", "index.html"), "utf8"),
        ).toContain('document.title="post"');
        const hashes = JSON.parse(
          await readFile(
            join(root, ".bascik", "dist", "csp-hashes.json"),
            "utf8",
          ),
        ) as Record<string, { scripts: string[] }>;
        expect(hashes["/"].scripts).toEqual([sha('document.title="post"')]);

        const server = await startServer(root, 19050 + (process.pid % 40));
        try {
          expect(server.up, server.output()).toBe(true);
          const res = await fetch(`${server.base}/`);
          expect(await res.text()).toContain('document.title="post"');
          const csp = res.headers.get("content-security-policy") ?? "";
          expect(csp).toContain(`'${sha('document.title="post"')}'`);
          expect(csp).not.toContain(`'${sha('document.title="v1"')}'`);
          expect(differenceWarnings(server.output())).toEqual([]);
        } finally {
          await server.close();
        }

        // A targeted build runs the post script again over the rebuilt
        // page and records the final hashes too.
        await writeFixtureFile(
          root,
          "src/pages/index.html",
          `<!DOCTYPE html><html><head><title>Home</title></head><body><script>document.title="v1"</script><p>again</p></body></html>`,
        );
        await runRealBuild({
          projectRoot: root,
          cliPath: PKG_ENTRY,
          args: ["--only", "index.html"],
        });
        const after = JSON.parse(
          await readFile(
            join(root, ".bascik", "dist", "csp-hashes.json"),
            "utf8",
          ),
        ) as Record<string, { scripts: string[] }>;
        expect(after["/"].scripts).toEqual([sha('document.title="post"')]);
        expect(Object.keys(after)).toContain("/live");
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);

    it("misuse: a post exec script that drops a stream placeholder fails bascik --build, naming the page and the tag to paste back", async () => {
      const root = fixtureRoot("private-folder-post-lost-stream");
      try {
        await writePostRelease(
          root,
          `import { readFile, writeFile } from "node:fs/promises";
const page = "dist/live.html";
const html = await readFile(page, "utf8");
await writeFile(page, html.replace(/<script type="text\\/bascik-server"[^>]*data-bascik-stream[^>]*><\\/script>/, ""));
`,
        );
        await writeFixtureFile(
          root,
          "src/pages/live.html",
          `<!DOCTYPE html><html><head><title>Live</title></head><body>
<script data-bascik-server>export default () => 'server-v1';</script>
<script data-bascik-stream>export default () => 'stream-v1';</script>
</body></html>`,
        );
        let output = "";
        await expect(
          runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY }).catch(
            (err: { stdout?: string; stderr?: string }) => {
              output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
              throw err;
            },
          ),
        ).rejects.toThrow();
        expect(output).toContain(
          "[bascik] --build: a page lost a server-script placeholder after the build wrote it. " +
            "dist/live.html: .bascik/dist/server-scripts.json holds 2 server scripts for this page, but 1 of their placeholders is gone",
        );
        expect(output).toContain(
          "A `post` exec script removed or rewrote the placeholder",
        );
        expect(output).toContain("does not remove empty elements");
        expect(output).not.toContain("Build complete");
        // The build failed before it recorded its pages.
        expect(
          existsSync(join(root, ".bascik", "dist", "build-state.json")),
        ).toBe(false);
        const tag = output.match(
          /`(<script type="text\/bascik-server" data-bascik-server-id="[^"]+" data-bascik-stream><\/script>)`/,
        )?.[1];
        expect(tag, output).toBeDefined();

        // A post script that puts the tag back where it likes (here, at the
        // end of the body) keeps every placeholder, and the build passes.
        await writeFixtureFile(
          root,
          "scripts/post-edit.mjs",
          `import { readFile, writeFile } from "node:fs/promises";
const page = "dist/live.html";
const html = await readFile(page, "utf8");
await writeFile(page, html
  .replace(/<script type="text\\/bascik-server"[^>]*data-bascik-stream[^>]*><\\/script>/, "")
  .replace("</body>", ${JSON.stringify(tag)} + "</body>"));
`,
        );
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const port = 19000 + (process.pid % 20) * 2;
        const server = await startServer(root, port);
        try {
          expect(server.up, server.output()).toBe(true);
          const live = await (await fetch(`${server.base}/live`)).text();
          expect(live).toContain("server-v1");
          expect(live).toContain("stream-v1");
          expect(differenceWarnings(server.output())).toEqual([]);
        } finally {
          await server.close();
        }
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);

    it("misuse: a post exec script that drops a server placeholder fails a plain bascik --build", async () => {
      const root = fixtureRoot("private-folder-post-lost-server");
      try {
        await writePostRelease(
          root,
          `import { readFile, writeFile } from "node:fs/promises";
const page = "dist/live.html";
const html = await readFile(page, "utf8");
await writeFile(page, html.replace(/<script type="text\\/bascik-server"[^>]*><\\/script>/, "<p>gone</p>"));
`,
        );
        await expect(
          runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY }),
        ).rejects.toThrow(
          /dist\/live\.html: \.bascik\/dist\/server-scripts\.json holds 1 server script for this page, but the page has no placeholder for it \(`<script type="text\/bascik-server" data-bascik-server-id="server_script_[0-9a-f]+"><\/script>`\)/,
        );
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);

    it("the CSP part of the warning counts only kinds the sent policy restricts, and says report for reportOnly", async () => {
      const root = fixtureRoot("private-folder-csp-kinds");
      try {
        await writeRelease(root, "v1");
        await writeFixtureFile(
          root,
          "bascik.config.js",
          `module.exports = {
  generate: { sitemap: false, robots: false },
  contentSecurityPolicy: { reportOnly: true, directives: { "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"] } },
};`,
        );
        await runRealBuild({ projectRoot: root, cliPath: PKG_ENTRY });
        const page = join(root, "dist", "index.html");
        const built = await readFile(page, "utf8");
        await writeFile(
          page,
          built
            .replace('document.title="v1"', 'document.title="v1";')
            .replace("</head>", "<style>h1{color:red}</style></head>"),
        );
        const server = await startServer(root, 19040 + (process.pid % 10));
        try {
          expect(server.up, server.output()).toBe(true);
          const warnings = differenceWarnings(server.output());
          expect(warnings, server.output()).toHaveLength(1);
          expect(warnings[0]).toContain(
            "The site sends a Content-Security-Policy-Report-Only, and browsers will report the inline code in " +
              "these changed pages that is not in .bascik/dist/csp-hashes.json: dist/index.html (1 inline script).",
          );
          expect(warnings[0]).not.toContain("inline style");
          expect(warnings[0]).not.toContain("will block");
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
        ).rejects.toThrow(
          /--only: dist\/index\.html is not the page that build wrote[\s\S]*if you copied \.bascik\/dist\/ from another build/,
        );
      } finally {
        await cleanupFixture(root);
      }
    }, 240_000);
  });
});
