/**
 * The "Returning component tags" demos on the docs site.
 *
 * Four <component-demo> boxes show what a server or stream script that returns component tags sends:
 *
 *   search       server-scripts.md   ### Render a card per search result     GET /search
 *   live         server-scripts.md   ### A card with its own server script   GET /featured
 *   stream       stream-scripts.md   ### Stream cards in batches             GET /new-arrivals
 *   passthrough  troubleshooting.md  ### A component tag in script output…   GET /help
 *
 * The Markdown is the single source: every Source and Output pane is a <!-- demo:rtc-* --> block, so llms.txt and
 * the bundled skill get the same text the boxes show.
 *
 * Output panes are never hand-written. scripts/rtc-demos.ts builds ONE temp site from the md source blocks (each
 * written whole, path comment included, to the path its first line names, plus the documented bascik.config.ts), runs the real
 * `bascik --build` and `bascik --server`, and fetches the four URLs. This test regenerates through it and compares
 * with the committed blocks:
 *   - search, live and stream are compared after formatting the raw body exactly as `prettier --write` formats an
 *     ```html fence in Markdown (the formatter is applied here, independently of the generator);
 *   - passthrough is compared verbatim (its block sits under <!-- prettier-ignore -->).
 * The ONLY normalization is of request-time instance ids (`r` followed by 7 hex digits, pkg request-render.ts
 * REQUEST_INSTANCE_ID_RE), matched only where Bascik writes them: inside a scoped id, `bascik__<component>__<id>__`.
 * They are deterministic today, but the comparison should not depend on the hash: each
 * distinct id is renamed by order of first appearance, so the mapping is bijective and a change in how many
 * distinct ids the response carries still fails.
 *
 * Misuse lens: a hand-edited Output, an Output from a stale renderer, a docs component that drifted from the block a
 * reader copies, a Preview showing different cards from the Output, a box under the wrong heading or with a missing
 * pane, a fence leaking into the page because its range does not strip demo blocks, and a Usage snippet that only
 * works inside this repository (an `@/lib` import).
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDemoBlock } from "../src/lib/md-renderer.ts";
import { slugFromHeadingHtml } from "../src/lib/heading-slug.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");
const SCRATCH = "/tmp/bascik-rtc-docs-demos";
const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");

type DemoId = "search" | "live" | "stream" | "passthrough";
type Slot =
  | "example"
  | "source-usage"
  | "source-html"
  | "source-css"
  | "source-js"
  | "output-html";

interface Spec {
  id: DemoId;
  md: string;
  page: string;
  heading: string;
  anchor: string;
  /** The heading after this demo's H3: the page range before the box ends there and the next one starts there. */
  successor: string;
  url: string;
  format: "prettier" | "verbatim";
  preview: boolean;
  /** Pointer printed right before the box (null: none required). */
  pointer: { path: string; q?: string } | null;
  /** Each pane slot and the [md file, marker] its extractDemoBlock reads. */
  slots: Partial<Record<Exclude<Slot, "example">, [string, string]>>;
  /** First-line path comment of each source block: where a reader puts the file. */
  paths: Partial<
    Record<"source-usage" | "source-html" | "source-css" | "source-js", string>
  >;
}

const SERVER_MD = "content/server-scripts.md";
const STREAM_MD = "content/stream-scripts.md";
const TROUBLE_MD = "content/testing/troubleshooting.md";

const SPECS: Spec[] = [
  {
    id: "search",
    md: SERVER_MD,
    page: "src/pages/server-scripts.html",
    heading: "Render a card per search result",
    anchor: "render-a-card-per-search-result",
    successor: "A card with its own server script",
    url: "/search",
    format: "prettier",
    preview: true,
    pointer: { path: "/catalog", q: "frother" },
    slots: {
      "source-usage": [SERVER_MD, "rtc-search-source-usage"],
      "source-html": [SERVER_MD, "rtc-search-source-html"],
      "source-css": [SERVER_MD, "rtc-search-source-css"],
      "source-js": [SERVER_MD, "rtc-search-source-js"],
      "output-html": [SERVER_MD, "rtc-search-output-html"],
    },
    paths: {
      "source-usage": "src/pages/search.html",
      "source-html": "src/components/product-card/product-card.html",
      "source-css": "src/components/product-card/product-card.css",
      "source-js": "src/components/product-card/product-card.js",
    },
  },
  {
    id: "live",
    md: SERVER_MD,
    page: "src/pages/server-scripts.html",
    heading: "A card with its own server script",
    anchor: "a-card-with-its-own-server-script",
    successor: "Rules for returned tags",
    url: "/featured",
    format: "prettier",
    preview: false,
    pointer: { path: "/catalog" },
    slots: {
      "source-usage": [SERVER_MD, "rtc-live-source-usage"],
      "source-html": [SERVER_MD, "rtc-live-source-html"],
      "source-css": [SERVER_MD, "rtc-live-source-css"],
      "output-html": [SERVER_MD, "rtc-live-output-html"],
    },
    paths: {
      "source-usage": "src/pages/featured.html",
      "source-html": "src/components/stock-line/stock-line.html",
      "source-css": "src/components/stock-line/stock-line.css",
    },
  },
  {
    id: "stream",
    md: STREAM_MD,
    page: "src/pages/stream-scripts.html",
    heading: "Stream cards in batches",
    anchor: "stream-cards-in-batches",
    successor: "Rules when streaming",
    url: "/new-arrivals",
    format: "prettier",
    preview: true,
    pointer: { path: "/catalog-stream" },
    slots: {
      "source-usage": [STREAM_MD, "rtc-stream-source-usage"],
      "source-html": [SERVER_MD, "rtc-search-source-html"],
      "source-css": [SERVER_MD, "rtc-search-source-css"],
      "source-js": [SERVER_MD, "rtc-search-source-js"],
      "output-html": [STREAM_MD, "rtc-stream-output-html"],
    },
    paths: { "source-usage": "src/pages/new-arrivals.html" },
  },
  {
    id: "passthrough",
    md: TROUBLE_MD,
    page: "src/pages/testing/troubleshooting.html",
    heading: "A component tag in script output reaches the browser as written",
    anchor: "a-component-tag-in-script-output-reaches-the-browser-as-written",
    successor: "`Components a server or stream script cannot return`",
    url: "/help",
    format: "verbatim",
    preview: false,
    pointer: null,
    slots: {
      "source-usage": [TROUBLE_MD, "rtc-passthrough-source-usage"],
      "output-html": [TROUBLE_MD, "rtc-passthrough-output-html"],
    },
    paths: { "source-usage": "src/pages/help.html" },
  },
];

/** The products the search demo's Usage lists, in order. A missing badge renders the slot fallback. */
const PRODUCTS = [
  { name: "Milk frother", price: "$129", badge: "Best seller" },
  { name: "Pour-over kettle", price: "$48", badge: "New" },
  { name: "Glass carafe", price: "$31", badge: "Standard" },
];

/** The md text of a block, failing with the reader-facing problem when it is missing. */
const block = async (md: string, marker: string): Promise<string> => {
  const result = await readDemoBlock(path.join(DOCS_ROOT, md), marker);
  expect(result.problem, `${md} ${marker}`).toBeUndefined();
  return result.code!;
};

// ---- Markdown helpers --------------------------------------------------------------------------------------------

/** Index of the line that is the heading `text` (exact), as md-renderer's renderMdRange finds it. */
const headingIndex = (md: string, text: string): number => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|\\n)(#{1,6} ${escaped}[ \\t]*)(?=\\n|$)`).exec(md);
  if (!m) return -1;
  return m[1] === "" ? m.index : m.index + 1;
};

/** The md under heading `text` up to the next heading of its level or above (fences skipped). */
const sectionOf = (md: string, text: string): string => {
  const start = headingIndex(md, text);
  expect(start, `heading "${text}"`).toBeGreaterThanOrEqual(0);
  const lines = md.slice(start).split("\n");
  const level = /^(#+)/.exec(lines[0])![1].length;
  let inFence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    const h = !inFence && /^(#+)\s/.exec(lines[i]);
    if (h && h[1].length <= level) return lines.slice(0, i).join("\n");
  }
  return lines.join("\n");
};

const DEMO_BLOCK_RE =
  /<!--\s*demo:[\w-]+\s*-->\s*\n(?:\s*<!--\s*prettier-ignore\s*-->\s*\n)?\s*```[\w-]*\n[\s\S]*?\n```/g;

/** Paragraphs a reader sees once the demo blocks are moved into the box. */
const proseParagraphs = (md: string): string[] =>
  md
    .replace(DEMO_BLOCK_RE, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

// ---- Page helpers ------------------------------------------------------------------------------------------------

type PageItem =
  | {
      kind: "range";
      file: string;
      from?: string;
      to?: string;
      strip: boolean;
      whole: boolean;
      text: string;
    }
  | { kind: "demo"; open: string; body: string };

/** The page's top-level renderMd/renderMdRange calls and <component-demo> boxes, in document order. */
const pageItems = (html: string): PageItem[] => {
  const items: { at: number; item: PageItem }[] = [];
  const demos: [number, number][] = [];
  for (const m of html.matchAll(
    /(<component-demo\b[^>]*>)([\s\S]*?)<\/component-demo>/g,
  )) {
    demos.push([m.index, m.index + m[0].length]);
    items.push({ at: m.index, item: { kind: "demo", open: m[1], body: m[2] } });
  }
  for (const m of html.matchAll(
    /<script data-bascik-build>([\s\S]*?)<\/script>/g,
  )) {
    if (demos.some(([a, b]) => m.index > a && m.index < b)) continue;
    const text = m[1];
    const call = /await\s+(renderMdRange|renderMd)\(\s*"([^"]+)"/.exec(text);
    if (!call) continue;
    const from = /\bfrom:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    const to = /\bto:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    items.push({
      at: m.index,
      item: {
        kind: "range",
        file: call[2].replace(/^\.\//, ""),
        from,
        to,
        strip: /stripDemoBlocks:\s*true/.test(text),
        whole: call[1] === "renderMd",
        text,
      },
    });
  }
  return items.sort((a, b) => a.at - b.at).map((x) => x.item);
};

/** The md a range item renders. */
const rangeSlice = (
  md: string,
  item: Extract<PageItem, { kind: "range" }>,
): string => {
  let slice = md;
  if (item.from)
    slice = slice.slice(Math.max(0, headingIndex(slice, item.from)));
  if (item.to) {
    const end = headingIndex(slice, item.to);
    if (end >= 0) slice = slice.slice(0, end);
  }
  return slice;
};

/** Each named slot in a demo box and its content. */
const slotsOf = (body: string): Map<string, string> => {
  const slots = new Map<string, string>();
  const re = /<div data-bascik-slot="([\w-]+)">/g;
  const starts = [...body.matchAll(re)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : body.length;
    slots.set(m[1], body.slice(m.index + m[0].length, end));
  });
  return slots;
};

/** The box on `spec.page` whose Output reads `spec`'s output marker. */
const boxFor = (spec: Spec) => {
  const items = pageItems(readDocs(spec.page));
  const [file, marker] = spec.slots["output-html"]!;
  const index = items.findIndex(
    (it) =>
      it.kind === "demo" &&
      it.body.includes(`"./${file}"`) &&
      it.body.includes(`"${marker}"`),
  );
  return { items, index };
};

/** Preview cards: the <product-card> tags written in a box's example slot. */
const previewCards = (example: string) =>
  [
    // Prettier may wrap the closing tag as `</product-card\n>`.
    ...example.matchAll(
      /<product-card\b([^>]*)>([\s\S]*?)<\/product-card\s*>/g,
    ),
  ].map((m) => ({
    name: /data-bascik-prop-name="([^"]*)"/.exec(m[1])?.[1],
    price: /data-bascik-prop-price="([^"]*)"/.exec(m[1])?.[1],
    badge: m[2].replace(/<[^>]+>/g, "").trim() || "Standard",
  }));

/** Output cards: the text of each rendered <article> in a response body. */
const outputCards = (html: string) =>
  [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map((m) =>
    m[1]
      .replace(/<script\b[\s\S]*?<\/script>/g, "")
      .replace(/<style\b[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

// ---- Request ids -------------------------------------------------------------------------------------------------

/**
 * A request-time instance id (`r` + 7 hex digits, any mix of digits and letters) in the only place Bascik writes
 * one: a scoped id, `bascik__<component>__<id>__`. Anchoring on that context, not on the id's digits, means an
 * all-letter id such as `rabcdefa` is still normalized while an ordinary word such as "rdeadbee" never is.
 */
const REQUEST_ID = /(?<=\bbascik__[a-z][a-z0-9-]*__)r[0-9a-f]{7}(?=__)/g;

/** Renames each distinct request id to `r<ID n>` by order of first appearance (bijective). Nothing else changes. */
const normalizeRequestIds = (html: string): string => {
  const seen = new Map<string, string>();
  return html.replace(REQUEST_ID, (id) => {
    if (!seen.has(id)) seen.set(id, `r<ID ${seen.size + 1}>`);
    return seen.get(id)!;
  });
};

const distinctIds = (html: string) => new Set(html.match(REQUEST_ID) ?? []);

/** What `prettier --write` makes of an ```html fence holding `raw` in a docs Markdown file. */
const prettierFence = async (raw: string, mdFile: string): Promise<string> => {
  const prettier = await import("prettier");
  const options =
    (await prettier.resolveConfig(path.join(DOCS_ROOT, mdFile))) ?? {};
  const md = "```html\n" + raw.replace(/\n+$/, "") + "\n```\n";
  const out = await prettier.format(md, { ...options, parser: "markdown" });
  return /^```html\n([\s\S]*?)\n?```/m.exec(out)![1].replace(/\n$/, "");
};

// ==================================================================================================================

describe("returning component tags demos: markdown blocks", () => {
  it("misuse: the id normalizer is bijective and leaves ordinary words alone", () => {
    const html =
      'id="bascik__product-card__r1a2b3c4__save" for="bascik__product-card__r1a2b3c4__save" ' +
      'id="bascik__stock-line__rabcdefa__x" rdeadbee r1234567 save-r1234567 bascik__product-card__r1234567x__';
    expect(normalizeRequestIds(html)).toBe(
      'id="bascik__product-card__r<ID 1>__save" for="bascik__product-card__r<ID 1>__save" ' +
        'id="bascik__stock-line__r<ID 2>__x" rdeadbee r1234567 save-r1234567 bascik__product-card__r1234567x__',
    );
  });

  it("every r + 7 hex token in a committed Output sits in a scoped id, so the normalizer sees them all", async () => {
    for (const spec of SPECS) {
      const committed = await block(...spec.slots["output-html"]!);
      const loose =
        committed.match(/(?<![0-9A-Za-z])r[0-9a-f]{7}(?![0-9A-Za-z])/g) ?? [];
      expect(committed.match(REQUEST_ID) ?? [], spec.id).toEqual(loose);
    }
  });

  it("search: the prose says which path comments reach the Output, and the Output agrees", async () => {
    const section = sectionOf(
      readDocs(SERVER_MD),
      "Render a card per search result",
    );
    const output = await block(SERVER_MD, "rtc-search-output-html");
    const shown = {
      page: output.includes("<!-- src/pages/search.html -->"),
      html: output.includes(
        "<!-- src/components/product-card/product-card.html -->",
      ),
      css: output.includes(
        "/* src/components/product-card/product-card.css */",
      ),
      js: output.includes("// src/components/product-card/product-card.js"),
    };
    expect(shown).toEqual({ page: true, html: true, css: false, js: true });
    expect(section).not.toMatch(/so it also appears in the Output/);
    expect(section).toMatch(/CSS comment is dropped/);
  });

  it.each(SPECS)(
    "$id: every marker appears exactly once in its file, under ### $heading",
    async (spec) => {
      for (const [slot, [file, marker]] of Object.entries(spec.slots)) {
        const md = readDocs(file);
        const markerRe = new RegExp(`<!--\\s*demo:${marker}\\s*-->`, "g");
        const hits = md.match(markerRe) ?? [];
        expect(hits.length, `${file} ${marker} (${slot})`).toBe(1);
        // A block reused from another file (stream's HTML/CSS/JS tabs read the search card) is checked there.
        if (file !== spec.md) continue;
        const before = md.slice(0, md.search(new RegExp(markerRe.source)));
        const headings = [...before.matchAll(/^(#{2,4}) (.+)$/gm)];
        expect(headings.at(-1)?.[1], `${marker} sits under an H3`).toBe("###");
        expect(headings.at(-1)?.[2]).toBe(spec.heading);
      }
      expect(slugFromHeadingHtml(spec.heading)).toBe(spec.anchor);
    },
  );

  it.each(SPECS)(
    "$id: each source block starts with the path a reader puts the file at",
    async (spec) => {
      for (const [slot, expected] of Object.entries(spec.paths)) {
        const [file, marker] = spec.slots[slot as keyof Spec["slots"]]!;
        const first = (await block(file, marker)).split("\n")[0];
        const comment =
          /^<!--\s*(\S+)\s*-->$/.exec(first)?.[1] ??
          /^\/\*\s*(\S+)\s*\*\/$/.exec(first)?.[1] ??
          /^\/\/\s*(\S+)$/.exec(first)?.[1];
        expect(comment, `${marker} first line: ${first}`).toBe(expected);
      }
    },
  );

  it.each(SPECS)(
    "misuse: $id's Usage works in a new site (no @/lib import)",
    async (spec) => {
      const [file, marker] = spec.slots["source-usage"]!;
      const usage = await block(file, marker);
      expect(usage).not.toMatch(/from\s+["']@\//);
      expect(usage).toMatch(/<script data-bascik-(server|stream)>/);
    },
  );

  it("search: the Usage is the documented shape (reads ?q=, maps products to <product-card>, escapes values)", async () => {
    const usage = await block(SERVER_MD, "rtc-search-source-usage");
    expect(usage).toContain('searchParams.get("q")');
    expect(usage).toMatch(
      /products\s*\.filter[\s\S]*\.map\(|products\.map\(|\.map\(\s*\(p\)/,
    );
    expect(usage).toContain(
      '<product-card data-bascik-prop-name="${escape(p.name)}" data-bascik-prop-price="${escape(p.price)}">',
    );
    expect(usage).toContain("</product-card>`");
    expect(usage).toContain('.join("")');
    expect(usage).toContain("#escaping-and-injection");
    for (const p of PRODUCTS) {
      expect(usage).toContain(p.name);
      expect(usage).toContain(p.price);
    }
    expect(usage).not.toMatch(/import\s/);
  });

  it("live: stock-line has a class-only server script and no id, so it stays supported", async () => {
    const html = await block(SERVER_MD, "rtc-live-source-html");
    expect(html).toContain("<script data-bascik-server>");
    expect(html).toContain('class="stock"');
    expect(html).not.toMatch(/\bid=/);
    const usage = await block(SERVER_MD, "rtc-live-source-usage");
    expect(usage).toMatch(
      /<product-card[^>]*><stock-line><\/stock-line><\/product-card>/,
    );
  });

  it("passthrough: the Usage returns a misspelled tag and an ESCAPED tag inside <pre><code>", async () => {
    const usage = await block(TROUBLE_MD, "rtc-passthrough-source-usage");
    expect(usage).toContain(
      '<prodcut-card data-bascik-prop-name="Milk frother"></prodcut-card>',
    );
    expect(usage).toContain(
      '<pre><code>&lt;product-card data-bascik-prop-name="Milk frother"&gt;&lt;/product-card&gt;</code></pre>',
    );
    // A raw <product-card> inside <pre> is markup and IS rendered; the demo must not teach otherwise.
    expect(usage).not.toMatch(/<pre>[\s\S]*<product-card/);
  });

  it("passthrough: the Output block sits under <!-- prettier-ignore --> so it stays the verbatim bytes", () => {
    const md = readDocs(TROUBLE_MD);
    expect(md).toMatch(
      /<!--\s*demo:rtc-passthrough-output-html\s*-->\s*\n\s*<!--\s*prettier-ignore\s*-->\s*\n\s*```html\n/,
    );
  });

  it("the documented bascik.config.ts turns all four minify flags off, as the Output was made", () => {
    const section = sectionOf(readDocs(SERVER_MD), "Returning component tags");
    const config = /```ts\n(\/\/ bascik\.config\.ts\n[\s\S]*?)\n```/.exec(
      section,
    )?.[1];
    expect(
      config,
      "a ```ts block starting with // bascik.config.ts",
    ).toBeDefined();
    expect(config).toMatch(
      /minify:\s*\{\s*html:\s*false,\s*css:\s*false,\s*js:\s*false,\s*identifiers:\s*false\s*\}/,
    );
  });
});

describe("returning component tags demos: prose around each box", () => {
  it.each(SPECS.filter((s) => s.pointer))(
    "$id: the last line before the box points at the live demo",
    (spec) => {
      const paras = proseParagraphs(sectionOf(readDocs(spec.md), spec.heading));
      const last = paras.at(-1)!;
      expect(last).toMatch(/^Run this on Cloudflare Workers:/);
      const url = /\((https:\/\/cloudflare-adapter\.bascik\.dev[^)\s]*)\)/.exec(
        last,
      )?.[1];
      expect(url).toBeDefined();
      const parsed = new URL(url!);
      expect(parsed.pathname).toBe(spec.pointer!.path);
      if (spec.pointer!.q)
        expect(parsed.searchParams.get("q")).toBe(spec.pointer!.q);
    },
  );

  it.each(SPECS.filter((s) => s.preview))(
    "$id: a sentence says the Preview is drawn by this site's static build",
    (spec) => {
      const paras = proseParagraphs(sectionOf(readDocs(spec.md), spec.heading));
      expect(
        paras.some(
          (p) =>
            /Preview/.test(p) && /static|build/.test(p) && /server/.test(p),
        ),
      ).toBe(true);
    },
  );

  it.each(SPECS.filter((s) => !s.preview && s.id !== "passthrough"))(
    "$id: a sentence says why there is no Preview",
    (spec) => {
      const paras = proseParagraphs(sectionOf(readDocs(spec.md), spec.heading));
      expect(paras.some((p) => /Preview/.test(p))).toBe(true);
    },
  );

  it.each(SPECS)(
    "$id: the prose says the Output is what bascik --server sent",
    (spec) => {
      const text = proseParagraphs(
        sectionOf(readDocs(spec.md), spec.heading),
      ).join("\n");
      expect(text).toContain("bascik --server");
      expect(text).toContain(spec.url);
    },
  );

  it("live: the prose states the remaining-timeout and no-props rules", () => {
    const text = proseParagraphs(
      sectionOf(readDocs(SERVER_MD), "A card with its own server script"),
    ).join(" ");
    expect(text).toMatch(/scripts\.timeout/);
    expect(text).toMatch(/no props/);
    expect(text).toMatch(/once per (rendered )?instance/);
  });

  it("passthrough: the prose says the sample tag is escaped", () => {
    const text = proseParagraphs(
      sectionOf(
        readDocs(TROUBLE_MD),
        "A component tag in script output reaches the browser as written",
      ),
    ).join(" ");
    expect(text).toMatch(/escaped/);
    expect(text).toContain("&lt;product-card");
  });
});

describe("returning component tags demos: the page boxes", () => {
  it.each(SPECS)(
    "$id: $page has the box between the ranges that end and start at ### $successor",
    (spec) => {
      const { items, index } = boxFor(spec);
      expect(
        index,
        "a <component-demo> reading the Output marker",
      ).toBeGreaterThanOrEqual(0);
      const before = items[index - 1];
      const after = items[index + 1];
      expect(before?.kind).toBe("range");
      expect(after?.kind).toBe("range");
      if (before?.kind === "range" && after?.kind === "range") {
        expect(before.from).toBe(spec.heading);
        expect(before.to).toBe(spec.successor);
        expect(after.from).toBe(spec.successor);
        expect(before.strip && after.strip).toBe(true);
      }
    },
  );

  it.each(SPECS)(
    "$id: the box has exactly the expected panes, each reading the right block",
    (spec) => {
      const { items, index } = boxFor(spec);
      const box = items[index];
      expect(box?.kind).toBe("demo");
      if (box?.kind !== "demo") return;
      const slots = slotsOf(box.body);
      const expected = [
        ...(spec.preview ? ["example"] : []),
        ...Object.keys(spec.slots),
      ].sort();
      expect([...slots.keys()].sort()).toEqual(expected);
      expect(/data-bascik-prop-no-preview\b/.test(box.open)).toBe(
        !spec.preview,
      );
      for (const [slot, [file, marker]] of Object.entries(spec.slots)) {
        const call = /extractDemoBlock\(\s*"([^"]+)",\s*"([^"]+)",?\s*\)/.exec(
          slots.get(slot) ?? "",
        );
        expect(call?.slice(1), `${spec.id} ${slot}`).toEqual([
          `./${file}`,
          marker,
        ]);
      }
      expect(/data-bascik-prop-file="([^"]*)"/.exec(box.open)?.[1]).toBe(
        spec.paths["source-usage"],
      );
    },
  );

  it.each([
    "src/pages/server-scripts.html",
    "src/pages/stream-scripts.html",
    "src/pages/testing/troubleshooting.html",
  ])(
    "%s: the ranges cover the whole md in order, and every range holding an rtc block strips demo blocks",
    (page) => {
      const ranges = pageItems(readDocs(page)).filter(
        (it): it is Extract<PageItem, { kind: "range" }> => it.kind === "range",
      );
      const file = ranges[0].file;
      const md = readDocs(file);
      const own = ranges.filter((r) => r.file === file);
      expect(own.length).toBeGreaterThan(1);
      expect(own[0].from).toBeUndefined();
      expect(own.at(-1)!.to).toBeUndefined();
      for (let i = 1; i < own.length; i++)
        expect(own[i].from).toBe(own[i - 1].to);
      for (const range of own) {
        if (/<!--\s*demo:rtc-/.test(rangeSlice(md, range)))
          expect(
            range.strip,
            `range from "${range.from}" to "${range.to}"`,
          ).toBe(true);
      }
    },
  );

  it.each(SPECS.filter((s) => s.preview))(
    "$id: the Preview holds the same three cards the script returns, in order",
    (spec) => {
      const { items, index } = boxFor(spec);
      const box = items[index];
      expect(box?.kind).toBe("demo");
      if (box?.kind !== "demo") return;
      expect(previewCards(slotsOf(box.body).get("example") ?? "")).toEqual(
        PRODUCTS,
      );
    },
  );

  it.each(SPECS.filter((s) => s.preview))(
    "$id: the Preview cards match the committed Output cards",
    async (spec) => {
      const output = await block(...spec.slots["output-html"]!);
      const cards = outputCards(output);
      expect(cards).toHaveLength(PRODUCTS.length);
      PRODUCTS.forEach((p, i) => {
        expect(cards[i]).toContain(p.name);
        expect(cards[i]).toContain(p.price);
        expect(cards[i]).toContain(p.badge);
      });
    },
  );
});

describe("returning component tags demos: the docs product-card is the component a reader copies", () => {
  const strip = (file: string, text: string) =>
    file.endsWith(".html")
      ? text.replace(/^<!--\s*@bascik[\s\S]*?-->\n/, "")
      : text;
  it.each([
    ["product-card.html", "rtc-search-source-html"],
    ["product-card.css", "rtc-search-source-css"],
    ["product-card.js", "rtc-search-source-js"],
  ])(
    "src/components/product-card/%s equals the md block %s (minus the path comment)",
    async (name, marker) => {
      const code = await block(SERVER_MD, marker);
      const withoutPath = code.split("\n").slice(1).join("\n");
      const file = readDocs(`src/components/product-card/${name}`);
      expect(strip(name, file).trim()).toBe(withoutPath.trim());
    },
  );
});

// ---- Regenerate through the real renderer ------------------------------------------------------------------------

interface RtcDemoRun {
  raw: Record<DemoId, string>;
  formatted: Record<DemoId, string>;
  check: { status: number | null; output: string };
}

describe("returning component tags demos: Output is the real bascik --server response", () => {
  let run: RtcDemoRun;
  let lib: typeof import("./rtc-demos.ts");

  beforeAll(async () => {
    // Imported here so a missing generator fails this block only, not the structure checks above.
    lib = await import("./rtc-demos.ts");
    run = await lib.runRtcDemos();
  }, 180_000);

  it("the generator's spec matches this test's", () => {
    expect(
      lib.DEMOS.map((d) => ({
        id: d.id,
        md: d.md,
        url: d.url,
        format: d.format,
        output: d.outputMarker,
      })),
    ).toEqual(
      SPECS.map((s) => ({
        id: s.id,
        md: s.md,
        url: s.url,
        format: s.format,
        output: s.slots["output-html"]![1],
      })),
    );
  });

  it("the generator site is only the md blocks plus the documented config", async () => {
    const files = await lib.demoSiteFiles();
    for (const spec of SPECS) {
      for (const [slot, sitePath] of Object.entries(spec.paths)) {
        const code = await block(...spec.slots[slot as keyof Spec["slots"]]!);
        // The whole block, path comment included: that is what a reader's copy button puts in the file.
        expect(files[sitePath]?.trim(), sitePath).toBe(code.trim());
      }
    }
    const section = sectionOf(readDocs(SERVER_MD), "Returning component tags");
    const config = /```ts\n\/\/ bascik\.config\.ts\n([\s\S]*?)\n```/.exec(
      section,
    )?.[1];
    expect(files["bascik.config.ts"]?.trim()).toBe(config?.trim());
  });

  it.each(SPECS)(
    "$id: the committed Output equals the regenerated response ($format)",
    async (spec) => {
      const committed = await block(...spec.slots["output-html"]!);
      const raw = run.raw[spec.id];
      const expected =
        spec.format === "verbatim"
          ? raw.replace(/\n$/, "")
          : await prettierFence(raw, spec.md);
      expect(normalizeRequestIds(committed)).toBe(
        normalizeRequestIds(expected),
      );
      expect(normalizeRequestIds(run.formatted[spec.id])).toBe(
        normalizeRequestIds(expected),
      );
    },
  );

  it("search: one <style> before the first card, scoped classes, three distinct ids, client script per instance", () => {
    const raw = run.raw.search;
    expect(raw).not.toContain("<product-card");
    expect(raw.match(/<style\b/g)).toHaveLength(1);
    expect(raw.indexOf("<style")).toBeLessThan(raw.indexOf("<article"));
    const cardClass = /<article class="([^"]+)"/.exec(raw)?.[1];
    expect(cardClass).toBeDefined();
    expect(cardClass).not.toBe("card");
    const style = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(raw)![1];
    expect(style).toContain(`.${cardClass}`);
    const ids = distinctIds(raw);
    expect(ids.size).toBe(3);
    const scripts = [
      ...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    expect(scripts).toHaveLength(3);
    for (const id of ids)
      expect(
        scripts.some((s) => s.includes(id)),
        `${id} in a client script`,
      ).toBe(true);
    const names = PRODUCTS.map((p) => raw.indexOf(p.name));
    expect(names.every((n) => n >= 0)).toBe(true);
    expect([...names].sort((a, b) => a - b)).toEqual(names);
    expect(outputCards(raw)[2]).toContain("Standard");
  });

  it("live: the nested stock line is inside the card, scoped, and sent with no component tag left", () => {
    const raw = run.raw.live;
    expect(raw).not.toContain("<product-card");
    expect(raw).not.toContain("<stock-line");
    const article = /<article\b[\s\S]*?<\/article>/.exec(raw)?.[0] ?? "";
    expect(article).toContain("In stock");
    expect(article).toContain("/featured");
    // The stock line fills the card's badge slot, a <span>, so it is a <span> too.
    const stockClass = /<span class="([^"]+)">In stock/.exec(raw)?.[1];
    expect(stockClass).toBeDefined();
    expect(stockClass).not.toBe("stock");
    const styles = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(
      (m) => m[1],
    );
    expect(styles.some((s) => s.includes(`.${stockClass}`))).toBe(true);
    const cardClass = /<article class="([^"]+)"/.exec(raw)![1];
    expect(styles.filter((s) => s.includes(`.${cardClass}`))).toHaveLength(1);
  });

  it("stream: one <style>, sent with the first batch before the first card; cards in source order with distinct ids", () => {
    const raw = run.raw.stream;
    expect(raw).not.toContain("<product-card");
    expect(raw.match(/<style\b/g)).toHaveLength(1);
    const style = raw.indexOf("<style");
    const first = raw.indexOf("<article");
    expect(style).toBeLessThan(first);
    // Batch 2 (Glass carafe) carries no <style>.
    expect(style).toBeLessThan(raw.indexOf("Milk frother"));
    expect(raw.slice(raw.indexOf("Pour-over kettle"))).not.toContain("<style");
    const names = PRODUCTS.map((p) => raw.indexOf(p.name));
    expect(names.every((n) => n >= 0)).toBe(true);
    expect([...names].sort((a, b) => a - b)).toEqual(names);
    expect(distinctIds(raw).size).toBe(3);
  });

  it("passthrough: the body holds the script's exact return string, unexpanded, with no <style> or ids", async () => {
    const raw = run.raw.passthrough;
    expect(raw).toContain(
      '<prodcut-card data-bascik-prop-name="Milk frother"></prodcut-card>',
    );
    expect(raw).toContain("&lt;product-card");
    expect(raw).not.toContain("<style");
    expect(distinctIds(raw).size).toBe(0);
    // Run the Usage's own function and look for its output, byte for byte.
    const usage = await block(TROUBLE_MD, "rtc-passthrough-source-usage");
    const body = /<script data-bascik-server>([\s\S]*?)<\/script>/.exec(
      usage,
    )![1];
    mkdirSync(SCRATCH, { recursive: true });
    const dir = mkdtempSync(path.join(SCRATCH, "usage-"));
    try {
      const file = path.join(dir, "help.mjs");
      writeFileSync(file, body);
      const mod = await import(pathToFileURL(file).href);
      const returned = await mod.default(
        new Request("http://127.0.0.1/help"),
        {},
        { signal: new AbortController().signal },
      );
      expect(typeof returned).toBe("string");
      expect(raw).toContain(returned);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bascik --check on the demo site lists no component a script cannot return", () => {
    expect(run.check.output.length).toBeGreaterThan(0);
    expect(run.check.output).not.toContain(
      "Components a server or stream script cannot return",
    );
  });
});
