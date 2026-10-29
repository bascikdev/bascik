/**
 * The line an unsupported component is reported at (`unsupported.line` in
 * .bascik/dist/components.json, which `bascik --check` prints, and the dev
 * log for a tag a server script returns) is the line in the authored file.
 *
 * The components here are read by the real `listComponents`, which extracts
 * inline `<style>` blocks and, under `minify.html`, minifies the markup, so
 * the text the manifest is built from is not the text the author wrote. A
 * line counted on that text is wrong whenever anything precedes the trigger,
 * as in the realistic component below (a one-line `<style>`, then the
 * binding on line 2).
 *
 * The dev log names the component file the way `bascik --check` and the
 * build's own diagnostics do (`getDisplayPath`, relative to the component
 * root), so the two reports of one problem point at the same place.
 *
 * The manifest records that display form itself, so the production server
 * and the Worker, which have no component roots to resolve against, name the
 * file exactly as the dev server and `bascik --check` do.
 *
 * Misuse lens: a binding after a style line, after a multi-line style block
 * and a comment, and under HTML minification that folds lines together; a
 * render failure on a production host that maps no paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return {
    ...original,
    BascikConfig: structuredClone(original.BascikConfig),
  };
});

import { BascikConfig } from "./config.ts";
import { buildComponentManifest } from "./component-manifest.ts";
import { invalidateComponentListCache, listComponents } from "./components.ts";
import { getDisplayPath } from "./page-diagnostics.ts";
import { createNodeRenderHost } from "./request-render-node.ts";
import { wrapRunner } from "./request-render.ts";
import { scriptRegistry } from "./script-registry.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ExecutionPlan } from "./request-execution.ts";

type MutableConfig = {
  directory: { components: string[]; pages: string; out: string };
  minify: { html: boolean; identifiers: boolean };
};
const config = BascikConfig as unknown as MutableConfig;

const FILES: Record<string, string> = {
  // The realistic shape: a one-line style, then the binding on line 2.
  "bad-card/bad-card.html": `<style>.w { color: red; }</style>
<div class="w"><span data-bascik-attr-class="variant">x</span></div>
`,
  // A multi-line style block and a comment before the binding on line 7.
  "late-card/late-card.html": `<style>
  .w { color: red; }
  .x { color: blue; }
</style>
<!-- data-bascik-attr-id="not this one, it is in a comment" -->
<div class="w">
  <span data-bascik-attr-id="anchor">x</span>
</div>
`,
  // A renderable component, so the manifest has something to render and the
  // dev log for the others is on.
  "good-card/good-card.html": `<style>.g { color: green; }</style>
<p class="g">good</p>
`,
};

describe.each([false, true])(
  "unsupported.line on the authored file (minify.html %s)",
  (minifyHtml) => {
    const originalCwd = process.cwd();
    const originalDirectory = { ...config.directory };
    const originalMinify = { ...config.minify };
    let root: string;
    let componentsDir: string;

    beforeAll(async () => {
      // The real path: macOS tmpdir() is a symlink, and cwd is resolved.
      root = await realpath(
        await mkdtemp(join(tmpdir(), "bascik-manifest-lines-")),
      );
      componentsDir = join(root, "src/components");
      for (const [rel, content] of Object.entries(FILES)) {
        const abs = join(componentsDir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
      await mkdir(join(root, "src/pages"), { recursive: true });
      process.chdir(root);
      config.directory = {
        ...config.directory,
        components: [componentsDir],
        pages: join(root, "src/pages"),
        out: join(root, "dist"),
      };
      config.minify = {
        ...config.minify,
        html: minifyHtml,
        identifiers: false,
      };
      invalidateComponentListCache();
    });

    afterAll(async () => {
      process.chdir(originalCwd);
      config.directory = originalDirectory;
      config.minify = originalMinify;
      invalidateComponentListCache();
      await rm(root, { recursive: true, force: true });
    });

    const manifest = async () => {
      clearScopingTemplates();
      serverSidecarRegistry.clear();
      const list = await listComponents(config.directory.components);
      return buildComponentManifest(list, BascikConfig);
    };

    it("a binding on line 2, after a one-line <style>, is reported at line 2", async () => {
      const built = await manifest();
      expect(built.components["bad-card"].unsupported).toEqual({
        reason: "attr-binding-to-scoped-attribute",
        detail:
          "its data-bascik-attr-class binding targets an attribute scoping rewrites",
        line: 2,
      });
    });

    it("a binding after a multi-line <style> and a comment naming a binding is reported at its own line", async () => {
      const built = await manifest();
      expect(built.components["late-card"].unsupported?.line).toBe(7);
    });

    it("the manifest records each file as bascik --check displays it, never the project-relative source path", async () => {
      const built = await manifest();
      for (const name of ["bad-card", "late-card", "good-card"]) {
        const display = getDisplayPath(
          join(componentsDir, `${name}/${name}.html`),
        );
        expect(display).toBe(`components/${name}/${name}.html`);
        expect(built.components[name].filePath).toBe(display);
      }
    });

    it("misuse: a render failure on a production host names the file in the --check form too", async () => {
      const built = await manifest();
      const mode = vi
        .spyOn(scriptRegistry, "mode", "get")
        .mockReturnValue("production");
      try {
        const host = createNodeRenderHost(built, {
          request: new Request("http://localhost/search"),
          context: { remoteIp: "127.0.0.1" },
          timeoutMs: 1000,
          filePath: join(root, "src/pages/search.html"),
        });
        expect(host.warnOnce, "no dev log in production").toBeUndefined();
        const plan: ExecutionPlan = {
          segments: [{ kind: "script", mode: "server", id: "0" }],
          firstStreamIndex: -1,
        };
        const run = wrapRunner(
          async () => "<good-card></good-card>".repeat(1001),
          plan,
          host,
        );
        const failure = run("0", new AbortController().signal);
        await expect(failure).rejects.toThrow(
          /expands to more than 1000 component instances \(<good-card>, components\/good-card\/good-card\.html\)/,
        );
        await expect(failure).rejects.not.toThrow(/src\/components/);
      } finally {
        mode.mockRestore();
      }
    });

    it("the dev log for a returned unsupported tag names the file and line as bascik --check does", async () => {
      const built = await manifest();
      expect(built.components["good-card"].unsupported).toBeUndefined();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const host = createNodeRenderHost(built, {
          request: new Request("http://localhost/search"),
          context: { remoteIp: "127.0.0.1" },
          timeoutMs: 1000,
          filePath: join(root, "src/pages/search.html"),
        });
        expect(host.warnOnce, "the dev log is on in a test run").toBeDefined();
        const plan: ExecutionPlan = {
          segments: [{ kind: "script", mode: "server", id: "0" }],
          firstStreamIndex: -1,
        };
        const run = wrapRunner(async () => "<bad-card></bad-card>", plan, host);
        expect(await run("0", new AbortController().signal)).toBe(
          "<bad-card></bad-card>",
        );
        const messages = warn.mock.calls
          .map((call) => call.join(" "))
          .filter((m) => m.includes("<bad-card>"));
        expect(messages).toHaveLength(1);
        // --check prints the file relative to its component root
        // (check.ts toDisplay, getDisplayPath for components).
        const display = getDisplayPath(
          join(componentsDir, "bad-card/bad-card.html"),
        );
        expect(display).toBe("components/bad-card/bad-card.html");
        expect(messages[0]).toContain(`${display}:2 `);
        expect(messages[0]).not.toContain("src/components/bad-card");
      } finally {
        warn.mockRestore();
      }
    });
  },
);
