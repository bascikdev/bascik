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
import { installDataUrlResolveHook } from "./data-url-resolve-hook.ts";
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
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectCostRatio,
  expectLinearTimeAsync,
  measureCostRatioAsync,
  spliceCopies,
  type CalibratedRatio,
} from "./linear-time.test-helper.ts";
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
  // The docs' scripts import @bascik/bascik/html; resolve it from a data: module as the servers do.
  installDataUrlResolveHook(process.cwd());
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

// A visitor's text that leaves a tag open between nested usages, or leaves a
// raw-text element open before them. Each unit starts with the `>` that
// closes the tag the one before it left open: a `<x-p>` written while a tag
// is still open is part of that tag (an attribute name), as a browser reads
// it, and is no usage. Each splice re-masked the whole instance, and
// each unclosed usage looked for its close to the end, up to 1000 times
// (about 7 s at 200k characters and 40 s at 1 MB, stopped only by the scan
// budget). The mask now resumes from the masker's state at the splice, and a
// usage after the last close of its name has none, so these render far
// under the budget.
//
// Fixed wall-clock bounds for that (1.5 s at 200k, 3 s at 1 MB) failed on a
// loaded CI runner (3.2 s), and both old loops are linear in the output at a
// fixed usage count, so a growth in the output cannot see them either. So:
//
// - Usages nested in one `<my-card>` expand as one fragment, and each
//   substitution splices it whole: the render is pinned to twice its
//   calibrated ratio to 999 such splices of its output (`spliceCopies`),
//   timed in the same process. The old loops cost tens of times that.
// - Usages side by side each expand on their own, at a cost per usage that
//   the padding hardly moves, and the old loops were quadratic in their
//   count: the usage count grows, from a quarter of 996 to all of them, each
//   usage padded as at the size named.
describe("usages cut mid-tag render without re-masking the instance", () => {
  // The highest ratio of every shape in four runs on an M-series Mac,
  // without and with coverage (which slows the renderer, not the copying),
  // at each size: the copying is a larger share of a larger output (200k:
  // 1.35 to 1.53 plain, 1.63 to 2.71 coverage; 1M: 1.04 to 1.26 plain, 1.05
  // to 2.39 coverage). Measure again after a change that makes these renders
  // cheaper.
  const NESTED_COST: Record<string, CalibratedRatio> = {
    "200k": { plain: 1.53, coverage: 2.71 },
    "1M": { plain: 1.26, coverage: 2.39 },
  };
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
  type Shape = (size: number, count?: number) => string;
  /**
   * `count` copies of `unit`, each padded with text to a 999th of `size`:
   * `size` characters in all for 999 copies.
   */
  const fill = (unit: string, size: number, count = 999): string =>
    (
      unit + "x".repeat(Math.max(0, Math.ceil(size / 999) - unit.length))
    ).repeat(count);
  /** `unit` filled to `size` characters in all inside a `<my-card>` slot. */
  const wrapped =
    (head: string, unit: string): Shape =>
    (size, count) =>
      `<my-card>${head}${fill(unit, size - 19 - head.length, count)}</my-card>`;

  const SIZES = [
    ["200k", 200_000],
    ["1M", 1_000_000],
  ] as const;
  /** Renders the shape at each size, then checks its cost. */
  const check = (shapes: Array<[string, "nested" | "flat", Shape]>) =>
    it.each(
      shapes.flatMap(([label, kind, make]) =>
        SIZES.map(([name, size]) => [label, name, size, kind, make] as const),
      ),
    )(
      "%s at %s characters",
      async (label, name, size, kind, make) => {
        const manifest = await build(list);
        const output = make(size);
        const { html, share } = await render(manifest, output);
        expect(html.split(">v</p>").length - 1).toBe(999);
        expect(share).toBeLessThan(0.25);
        if (kind === "nested")
          expectCostRatio(
            await measureCostRatioAsync(
              () => render(manifest, output),
              () => spliceCopies(output, 999),
            ),
            NESTED_COST[name],
            `${label} at ${name}`,
          );
        else
          await expectLinearTimeAsync(
            (count) => make(size, count),
            996,
            (html) => render(manifest, html),
            { label: `${label} at ${name}, usage count` },
          );
      },
      LINEAR_TIME_TIMEOUT_MS,
    );

  check([
    [
      "fill('><x-p><a ') (each usage its own)",
      "flat",
      (size, count) => fill("><x-p><a ", size, count),
    ],
    [
      "<my-card> + fill('><x-p><a ') + </my-card>",
      "nested",
      wrapped("", "><x-p><a "),
    ],
    [
      "<my-card> + fill('><x-p><s') + </my-card>",
      "nested",
      wrapped("", "><x-p><s"),
    ],
    [
      "<my-card> + fill('><x-p><scr') + </my-card>",
      "nested",
      wrapped("", "><x-p><scr"),
    ],
    [
      "<my-card> + fill('><x-p><!-') + </my-card>",
      "nested",
      wrapped("", "><x-p><!-"),
    ],
    [
      "<my-card> + fill('><x-p><a b=1 c ') + </my-card>",
      "nested",
      wrapped("", "><x-p><a b=1 c "),
    ],
    [
      "<my-card> + fill('><x-p><a <') + </my-card>",
      "nested",
      wrapped("", "><x-p><a <"),
    ],
    [
      "<my-card><script> + fill('<x-p>') + </my-card> (a script never closed)",
      "nested",
      wrapped("<script>", "<x-p>"),
    ],
    [
      "<my-card><style> + fill('><x-p><a ') + </my-card> (a style never closed)",
      "nested",
      wrapped("<style>", "><x-p><a "),
    ],
    [
      "<my-card><textarea> + fill('><x-p><s') + </my-card> (a textarea never closed)",
      "nested",
      wrapped("<textarea>", "><x-p><s"),
    ],
  ]);

  // Text that only looks like a close of the usages, or like the closer of a
  // raw-text element opened before them: a longer name (`</x-pa>`,
  // `</x-p-list>`), a close the mask blanks (in a comment or a script), a
  // custom element named like a raw-text one (`<style-box>`), or a closer
  // with a longer name (`</textareax>`). None ends anything, so none may
  // bring back the walk to the end of the page for each unclosed usage, or a
  // whole re-mask after each splice.
  check([
    [
      "<my-card> + fill('><x-p><a ') + </x-pa></my-card>",
      "nested",
      (size, count) =>
        `<my-card>${fill("><x-p><a ", size - 26, count)}</x-pa></my-card>`,
    ],
    [
      "fill('<x-p>') + </x-p-list>",
      "flat",
      (size, count) => `${fill("<x-p>", size - 11, count)}</x-p-list>`,
    ],
    [
      "fill('<x-p>') + <!-- </x-p> -->",
      "flat",
      (size, count) => `${fill("<x-p>", size - 15, count)}<!-- </x-p> -->`,
    ],
    [
      "fill('<x-p>') + <script></x-p></script>",
      "flat",
      (size, count) =>
        `${fill("<x-p>", size - 23, count)}<script></x-p></script>`,
    ],
    [
      "<style-box>hi</style-box> + fill('<x-p v=\"a\"></x-p>')",
      "flat",
      (size, count) =>
        `<style-box>hi</style-box>${fill('<x-p v="a"></x-p>', size - 25, count)}`,
    ],
    [
      "<script-x></script-x> + fill('<x-p></x-p>')",
      "flat",
      (size, count) =>
        `<script-x></script-x>${fill("<x-p></x-p>", size - 21, count)}`,
    ],
    [
      "<textarea-field></textarea-field> + fill('<x-p>')",
      "flat",
      (size, count) =>
        `<textarea-field></textarea-field>${fill("<x-p>", size - 33, count)}`,
    ],
    [
      "<my-card><textarea> + fill('<x-p>') + </textareax></my-card>",
      "nested",
      (size, count) =>
        `<my-card><textarea>${fill("<x-p>", size - 41, count)}</textareax></my-card>`,
    ],
  ]);
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

  // "Fast" is a calibrated ratio, not a wall-clock bound like the 3 s that
  // failed at 3.2 s on a loaded CI runner above: the request's CPU time
  // against copying its output as many times as the budget lets the
  // renderer rescan it (`SCAN_BUDGET`, `spliceCopies`), timed in the same
  // process. Each limit is the highest ratio of four runs on an M-series
  // Mac, without and with coverage (the four runs spread by at most 12%),
  // and a check fails at twice it: a third of the rescans left uncharged,
  // which triples the work before the budget trips, fails it.
  const REFUSED_COST: CalibratedRatio = { plain: 0.44, coverage: 2.12 };
  const expectFast = async (
    manifest: ComponentManifest,
    output: string,
    calibrated: CalibratedRatio,
    label: string,
  ): Promise<void> =>
    expectCostRatio(
      await measureCostRatioAsync(
        () => render(manifest, output).catch(() => null),
        () =>
          spliceCopies(
            output,
            Math.ceil(
              (SCAN_BUDGET.perOutputChar * output.length + SCAN_BUDGET.base) /
                output.length,
            ),
          ),
      ),
      calibrated,
      label,
    );

  it(
    "misuse: fill('><x-p><s') of 1 MB with more usages than the instance budget is refused fast",
    async () => {
      const manifest = await build(list);
      const output = fill("><x-p><s", 1_000_000, 1200);
      await expect(render(manifest, output)).rejects.toBeInstanceOf(
        RequestRenderError,
      );
      await expectFast(manifest, output, REFUSED_COST, "1200 usages");
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  // Usages written whole, each level's slot read again: before spans were
  // charged these rendered after 3 s (1 MB) and 8 s (4 MiB) of blocked
  // event loop with nothing spent.
  it.each([
    [
      "1000 nested usages around 1 MB of slot text",
      "<my-card>".repeat(999) +
        "a".repeat(1_000_000) +
        "</my-card>".repeat(999),
      { plain: 22.52, coverage: 39.06 },
    ],
    [
      "1000 nested usages, 4000 characters of text at each level",
      ("<my-card>" + "a".repeat(4000)).repeat(999) + "</my-card>".repeat(999),
      { plain: 21.99, coverage: 24.59 },
    ],
    [
      "nesting at the 4 MiB limit",
      "<my-card>".repeat(999) +
        "a".repeat(REQUEST_RENDER_LIMITS.maxOutputLength - 20_000) +
        "</my-card>".repeat(999),
      { plain: 21.16, coverage: 26.34 },
    ],
  ] satisfies Array<[string, string, CalibratedRatio]>)(
    "%s fails with the located budget error",
    async (label, output, calibrated) => {
      const manifest = await build(list);
      const error = await render(manifest, output).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(RequestRenderError);
      expect((error as RequestRenderError).message).toMatch(
        /server-script output at "\/budget" made the renderer rescan more than \d+ characters while expanding components \(<my-card>, components\/my-card\.html\), over the limit of 16 times the output's \d+ characters plus 33554432\./,
      );
      expect((error as RequestRenderError).httpPath).toBe("/budget");
      const budget =
        SCAN_BUDGET.perOutputChar * output.length + SCAN_BUDGET.base;
      // The work bound is exact: the charged rescans stop within one
      // iteration past the budget, which reads the text at most four times
      // over (a re-mask, the attribute state, an unclosed usage's close
      // search or a closed one's span), and the text at most doubles.
      expect(__scanBudgetStatsForTests.lastSpent).toBeGreaterThan(budget);
      expect(__scanBudgetStatsForTests.lastSpent).toBeLessThan(
        budget + 4 * 2 * output.length,
      );
      await expectFast(manifest, output, calibrated, label);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

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
