/**
 * The request-time scanning budget (prompt 157 security audit, item G;
 * component-scan-budget.ts) against real pages and hostile shapes.
 *
 * Legitimate outputs come from the pages themselves: each page's server and
 * stream scripts are run as written (they import nothing) and their output
 * is rendered with a manifest built from the components on disk: the docs'
 * request-time demos (server-scripts.md, stream-scripts.md), the Cloudflare
 * catalog fixture the live demo is deployed from, the pkg e2e
 * server-components pages, and 1000 small cards in one output. Each must
 * spend at most a tenth of its budget. The hostile shapes, a visitor's
 * unescaped `<` that cuts every nested usage mid-tag, must fail fast with
 * the located RequestRenderError, at every size up to the 4 MiB limit.
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    minify: { identifiers: true, html: false, css: false, js: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    scripts: {
      cache: { enabled: true },
      onBuildScriptError: "error",
      onServerScriptError: "error",
      timeout: 30000,
    },
    components: { external: [] },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import {
  SCAN_BUDGET,
  __scanBudgetStatsForTests,
} from "./component-scan-budget.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import { getAttributeNameHash } from "./names.ts";
import type { ExecutionPlan } from "./request-execution.ts";
import {
  REQUEST_RENDER_LIMITS,
  RequestRenderError,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ComponentList } from "./types.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = BascikConfig as unknown as {
  minify: { identifiers: boolean };
};

const sha256hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const plan = (id: string): ExecutionPlan => ({
  segments: [{ kind: "script", mode: "server", id }],
  firstStreamIndex: -1,
});

const build = async (list: ComponentList): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(list, BascikConfig);
};

/** Render one script output; what it spent of its budget, and the result. */
const render = async (
  manifest: ComponentManifest,
  output: string,
  nested = "<b>live</b>",
): Promise<{ html: string; share: number; spent: number }> => {
  const host: RenderHost = {
    manifest,
    hashName: manifest.identifiers ? getAttributeNameHash : (s) => s,
    hashHex: sha256hex,
    httpPath: "/budget",
    timeoutMs: 5000,
    runComponentJob: async () => nested,
    externalTags: createExternalTagMatcher([]),
  };
  __scanBudgetStatsForTests.lastSpent = 0;
  const html = await wrapRunner(
    async () => output,
    plan("a"),
    host,
  )("a", new AbortController().signal);
  const spent = __scanBudgetStatsForTests.lastSpent;
  const budget = SCAN_BUDGET.perOutputChar * output.length + SCAN_BUDGET.base;
  return { html, share: spent / budget, spent };
};

// ─── Components and pages from disk ─────────────────────────────────────────

/** Every `<dir>/<name>/<name>.html` (with its .css and .js) under `root`. */
const componentsIn = async (root: string): Promise<ComponentList> => {
  const list: ComponentList = {};
  for (const name of await readdir(root)) {
    const html = join(root, name, `${name}.html`);
    if (!existsSync(html)) continue;
    const css = join(root, name, `${name}.css`);
    const js = join(root, name, `${name}.js`);
    list[name] = {
      fileName: `src/components/${name}/${name}.html`,
      fileContent:
        (await readFile(html, "utf8")) +
        (existsSync(js)
          ? `<script>${await readFile(js, "utf8")}</script>`
          : ""),
      ...(existsSync(css)
        ? { cssFileContent: await readFile(css, "utf8") }
        : {}),
    };
  }
  return list;
};

/** Only the components named (and the ones they use, transitively). */
const pick = (all: ComponentList, names: string[]): ComponentList => {
  const picked: ComponentList = {};
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift()!;
    if (picked[name] || !all[name]) continue;
    picked[name] = all[name];
    for (const other of Object.keys(all))
      if (all[name].fileContent.includes(`<${other}`)) queue.push(other);
  }
  return picked;
};

const SCRIPT_RE =
  /<script\b[^>]*\bdata-bascik-(?:server|stream)\b[^>]*>([\s\S]*?)<\/script>/g;

/** The outputs of every server and stream script in `page`, run as written. */
const pageOutputs = async (page: string, url: string): Promise<string[]> => {
  const outputs: string[] = [];
  for (const [, body] of page.matchAll(SCRIPT_RE)) {
    const module = (await import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(body)}`
    )) as {
      default: (
        request: Request,
        context: unknown,
        options: { signal: AbortSignal },
      ) => unknown;
    };
    const output = await module.default(
      new Request(url),
      {},
      { signal: new AbortController().signal },
    );
    outputs.push(String(output));
  }
  return outputs;
};

/** The files a docs page's `<!-- demo:... -->` blocks name on their first line. */
const docsDemoFiles = async (
  ...pages: string[]
): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  for (const page of pages) {
    const text = await readFile(join(REPO, "docs/content", page), "utf8");
    for (const [, body] of text.matchAll(
      /<!-- demo:rtc-[\w-]+-source-\w+ -->\s*```\w+\n([\s\S]*?)\n```/g,
    )) {
      const path = /^(?:<!--|\/\*|\/\/)\s*(src\/\S+?)\s*(?:-->|\*\/)?$/m.exec(
        body.split("\n")[0],
      )?.[1];
      if (path) files.set(path, body);
    }
  }
  return files;
};

beforeEach(() => {
  config.minify.identifiers = true;
  serverSidecarRegistry.clear();
  clearScopingTemplates();
});

describe("the scan budget leaves legitimate pages far under it", () => {
  const FAR_UNDER = 0.1;

  it("the docs' request-time demos (server-scripts.md, stream-scripts.md)", async () => {
    const files = await docsDemoFiles("server-scripts.md", "stream-scripts.md");
    const list: ComponentList = {};
    for (const [path, body] of files) {
      const match = /^src\/components\/([\w-]+)\/\1\.(html|css|js)$/.exec(path);
      if (!match) continue;
      const [, name, ext] = match;
      list[name] ??= { fileName: path, fileContent: "" };
      if (ext === "html")
        list[name].fileContent = body + list[name].fileContent;
      if (ext === "js") list[name].fileContent += `<script>${body}</script>`;
      if (ext === "css") list[name].cssFileContent = body;
    }
    expect(Object.keys(list).sort()).toEqual(["product-card", "stock-line"]);
    const manifest = await build(list);
    const pages = [...files].filter(([path]) => path.startsWith("src/pages/"));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    let rendered = 0;
    for (const [path, page] of pages) {
      for (const output of await pageOutputs(
        page,
        "http://localhost/search?q=",
      )) {
        const { html, share } = await render(manifest, output);
        if (html !== output) rendered++;
        expect(share, `${path}: ${output.slice(0, 80)}`).toBeLessThan(
          FAR_UNDER,
        );
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });

  it("the Cloudflare catalog fixture (the live demo's pages and cards)", async () => {
    const root = join(REPO, "adapters/cloudflare/e2e/fixture/src");
    const manifest = await build(await componentsIn(join(root, "components")));
    let rendered = 0;
    for (const page of ["catalog.html", "catalog-stream.html"]) {
      const text = await readFile(join(root, "pages", page), "utf8");
      for (const q of ["", "frother", "kettle"]) {
        for (const output of await pageOutputs(
          text,
          `http://localhost/${page}?q=${q}`,
        )) {
          const { html, share } = await render(manifest, output);
          if (html !== output) rendered++;
          expect(share, `${page}?q=${q}`).toBeLessThan(FAR_UNDER);
        }
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });

  it("the pkg e2e server-components pages", async () => {
    const root = join(REPO, "pkg/e2e/src");
    const manifest = await build(
      pick(await componentsIn(join(root, "components")), ["server-card"]),
    );
    let rendered = 0;
    for (const page of [
      "server-components.html",
      "server-components-pre.html",
      "server-components-stream.html",
    ]) {
      const text = await readFile(join(root, "pages", page), "utf8");
      for (const output of await pageOutputs(
        text,
        `http://localhost/${page}`,
      )) {
        const { html, share } = await render(manifest, output);
        if (html !== output) rendered++;
        expect(share, page).toBeLessThan(FAR_UNDER);
      }
    }
    expect(rendered).toBeGreaterThan(0);
  });

  it("1000 small cards in one output, written whole, inside a wrapper and as one usage's slot", async () => {
    const list: ComponentList = {
      "small-card": {
        fileName: "src/components/small-card/small-card.html",
        fileContent: `<article class="card"><h3 data-bascik-prop-name>n</h3><!-- a note --><p data-bascik-slot>s</p><script>void 0;</script></article>`,
        cssFileContent: ".card { color: red }",
      },
      "card-list": {
        fileName: "src/components/card-list/card-list.html",
        fileContent: `<section class="list"><div data-bascik-slot></div></section>`,
      },
    };
    const manifest = await build(list);
    const cards = Array.from(
      { length: REQUEST_RENDER_LIMITS.maxInstances - 1 },
      (_, index) =>
        `<small-card data-bascik-prop-name="Card ${index}">Body &lt;${index}&gt;</small-card>`,
    ).join("\n");
    for (const output of [
      cards,
      `<ul>${cards}</ul>`,
      `<card-list>${cards}</card-list>`,
    ]) {
      const { html, share } = await render(manifest, output);
      expect(html).toContain("Card 998");
      expect(share).toBeLessThan(FAR_UNDER);
    }
  });
});

describe("the scan budget stops hostile outputs fast", () => {
  const list: ComponentList = {
    "my-card": {
      fileName: "src/components/my-card.html",
      fileContent: `<div class="c"><div data-bascik-slot>s</div></div>`,
    },
    "x-p": {
      fileName: "src/components/x-p.html",
      fileContent: `<p class="p" data-bascik-prop-v>v</p>`,
    },
  };
  /** `count` copies of `unit`, padded with text to `size` characters in all. */
  const fill = (unit: string, size: number, count = 999): string =>
    (
      unit + "x".repeat(Math.max(0, Math.ceil(size / count) - unit.length))
    ).repeat(count);

  // Without the budget these shapes take about 6 s at 400 KB and 40 s at
  // 1 MB, and minutes at 4 MiB; with it, well under a second each alone.
  // The wall-clock bounds leave room for a loaded machine; the work bound is
  // exact: the charged rescans stop within one iteration past the budget.
  it.each([
    ["400 KB", 400_000, 2000],
    ["1 MB", 1_000_000, 3000],
    ["4 MiB", REQUEST_RENDER_LIMITS.maxOutputChars - 32, 6000],
  ])(
    "<my-card> + fill('<x-p><a ') + </my-card> at %s fails with the located budget error, its rescans bounded by the budget",
    async (_label, size, bound) => {
      const manifest = await build(list);
      const output = `<my-card>${fill("<x-p><a ", size - 19)}</my-card>`;
      const started = performance.now();
      const error = await render(manifest, output).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      const elapsed = performance.now() - started;
      expect(error).toBeInstanceOf(RequestRenderError);
      expect((error as RequestRenderError).message).toMatch(
        /server-script output at "\/budget" made the renderer rescan more than \d+ characters while expanding components \(<(?:x-p|my-card)>, components\/(?:x-p|my-card)\.html\), over the limit of 16 times the output's \d+ characters plus 33554432\./,
      );
      expect((error as RequestRenderError).httpPath).toBe("/budget");
      const budget =
        SCAN_BUDGET.perOutputChar * output.length + SCAN_BUDGET.base;
      // One iteration reads the text at most four times over (a re-mask,
      // the attribute state, an unclosed usage's close search or a closed
      // one's span); the text at most doubles its slot content here.
      expect(__scanBudgetStatsForTests.lastSpent).toBeGreaterThan(budget);
      expect(__scanBudgetStatsForTests.lastSpent).toBeLessThan(
        budget + 4 * 2 * output.length,
      );
      expect(elapsed).toBeLessThan(bound);
    },
  );

  it("fill('<x-p><s') of 1 MB is refused within 3 s (the instance budget or the scan budget)", async () => {
    const manifest = await build(list);
    const output = fill("<x-p><s", 1_000_000, 1200);
    const started = performance.now();
    await expect(render(manifest, output)).rejects.toBeInstanceOf(
      RequestRenderError,
    );
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Usages written whole, each level's slot read again: before spans were
  // charged these rendered after 3 s (1 MB) and 8 s (4 MiB) of blocked
  // event loop with nothing spent.
  it.each([
    [
      "1000 nested usages around 1 MB of slot text",
      "<my-card>".repeat(999) +
        "a".repeat(1_000_000) +
        "</my-card>".repeat(999),
    ],
    [
      "1000 nested usages, 4000 characters of text at each level",
      ("<my-card>" + "a".repeat(4000)).repeat(999) + "</my-card>".repeat(999),
    ],
    [
      "nesting at the 4 MiB limit",
      "<my-card>".repeat(999) +
        "a".repeat(REQUEST_RENDER_LIMITS.maxOutputChars - 20_000) +
        "</my-card>".repeat(999),
    ],
  ])("%s fails with the located budget error", async (_label, output) => {
    const manifest = await build(list);
    const started = performance.now();
    const error = await render(manifest, output).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(RequestRenderError);
    expect((error as RequestRenderError).message).toMatch(
      /made the renderer rescan more than \d+ characters while expanding components \(<my-card>, components\/my-card\.html\)/,
    );
    const budget = SCAN_BUDGET.perOutputChar * output.length + SCAN_BUDGET.base;
    expect(__scanBudgetStatsForTests.lastSpent).toBeLessThan(
      budget + 4 * 2 * output.length,
    );
    expect(elapsed).toBeLessThan(3000);
  });

  it("misuse: 300 cards with an unclosed usage each, inside a wrapper, render (cheap work the instance limit bounds)", async () => {
    // faq.md: an unclosed component tag falls back to self-closing. Inside
    // a wrapper each one re-masks the whole output, which is quadratic but
    // small: about 3 Mi characters read here, in tens of milliseconds.
    const manifest = await build({
      "x-icon": {
        fileName: "src/components/x-icon/x-icon.html",
        fileContent: `<i class="icon" data-bascik-prop-name data-bascik-attr-title="name">n</i>`,
      },
      "x-card": {
        fileName: "src/components/x-card/x-card.html",
        fileContent: `<article class="c"><header><x-icon data-bascik-prop-name="hdr" /></header><!-- note --><div data-bascik-slot></div><style>.c{color:red}</style><script>if (1 < 2) void 0;</script></article>`,
      },
      "x-list": {
        fileName: "src/components/x-list/x-list.html",
        fileContent: `<ul class="l"><li data-bascik-slot></li></ul>`,
      },
    });
    const cards = Array.from(
      { length: 300 },
      (_, index) =>
        `<x-card><x-icon data-bascik-prop-name="s${index}"><p>after</p></x-card>`,
    ).join("\n");
    const { html, share } = await render(manifest, `<x-list>${cards}</x-list>`);
    expect(html).toContain(`title="s299"`);
    expect(share).toBeLessThan(0.25);
  });

  it("misuse: an output whose usages are left unclosed renders while it stays under the budget", async () => {
    // A page that writes a few void-style usages (no closing tag) is not
    // hostile: each unclosed usage rescans what follows it once.
    const manifest = await build(list);
    const output = Array.from(
      { length: 20 },
      (_, index) => `<x-p data-bascik-prop-v="${index}"><p>after ${index}</p>`,
    ).join("");
    const { html, share } = await render(manifest, output);
    expect(html).toContain(">19</p>");
    expect(share).toBeLessThan(0.1);
  });
});
