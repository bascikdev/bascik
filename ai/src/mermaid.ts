/**
 * Mermaid diagrams, drawn on the server.
 *
 * A model already knows Mermaid, and a diagram with branches is something a
 * catalog component cannot lay out. `mermaidFence()` is a fence renderer: it
 * turns the text of a ```mermaid fence into an inline SVG, so the diagram
 * reaches the browser as finished markup, like everything else in a reply.
 *
 * The diagram text is untrusted. The SVG is written by beautiful-mermaid,
 * which escapes every label; `safeSvg` then checks the result against a short
 * list of elements and attributes, and a diagram that fails the check is
 * shown as code instead.
 */
import { renderMermaidSVG } from "beautiful-mermaid";
import type { FenceRenderer } from "./render.ts";

/** What to tell a model about the fence: pass it to `catalogPrompt`'s `fences`. */
export const MERMAID_PROMPT =
  "Write Mermaid in it to show a process with branches, a sequence of messages, states, classes, or entities. Supported diagrams: flowchart (or graph), sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, and xychart-beta. Keep labels short, and put spaces around arrows (`A --> B`).";

const ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "style",
  "defs",
  "marker",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
]);

/*
 * A tag as the HTML parser reads it. HTML ends a name only at one of these
 * five spaces (tab, line feed, form feed, carriage return, space), `/`, or
 * `>`; JavaScript's \s also matches U+00A0, \v, and other spaces, which HTML
 * reads as part of a name, so it is never used here. A quoted value holds no
 * `<` or `>`: beautiful-mermaid escapes both in every label, and refusing
 * them means no value can read as markup if this and the browser disagree.
 */
const SPACE = "[ \\t\\n\\f\\r]";
const TAG = new RegExp(
  `<(\\/?)([A-Za-z][\\w:-]*)((?:${SPACE}+[\\w:-]+="[^"<>]*")*)${SPACE}*(\\/?)>`,
  "y",
);
const ATTRIBUTE = new RegExp(`${SPACE}+([\\w:-]+)="([^"]*)"`, "g");

const BASIC_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const codePoint = (value: number): string =>
  value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : "�";

/**
 * The text after character references are decoded, as the browser's CSS
 * parser receives it (an SVG attribute and a stylesheet inside HTML both get
 * them decoded). Null when it holds a named character reference other than
 * the five basic ones, which this cannot decode and need not accept.
 */
function decodeReferences(value: string): string | null {
  let unknown = false;
  const decoded = value.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));?/g,
    (_, hex?: string, decimal?: string, name?: string) => {
      if (hex !== undefined) return codePoint(parseInt(hex, 16));
      if (decimal !== undefined) return codePoint(parseInt(decimal, 10));
      const known = BASIC_REFERENCES[name!];
      if (known === undefined) unknown = true;
      return known ?? "";
    },
  );
  return unknown ? null : decoded;
}

/**
 * Text that could change how the rest of the CSS reads, so that a check by
 * search would see something other than the browser: an escape, a comment
 * (which a string can hide, or which can hide a string), and any at-rule.
 * beautiful-mermaid writes none of them in what reaches `safeSvg`.
 */
const CHANGES_READING = /\\|\/\*|@|javascript:/i;

/** Every CSS function that can fetch something, and `attr()`, which reads one. */
const FETCHES =
  /(?:url|image-set|-webkit-image-set|src|cross-fade|-webkit-cross-fade|image|element|attr)\(/gi;

/** The one fetch a diagram may hold: a reference to an element in itself. */
const LOCAL_URL = /^url\(#[\w-]+\)/i;

/**
 * True when CSS text (a stylesheet, a style attribute, or a presentation
 * attribute) is refused. This does not parse CSS: it refuses anything that
 * would need parsing to read safely, so a plain search is enough for the
 * rest.
 */
const refusedCss = (value: string): boolean => {
  const css = decodeReferences(value);
  if (css === null || CHANGES_READING.test(css)) return true;
  for (const fetch of css.matchAll(FETCHES)) {
    if (!LOCAL_URL.test(css.slice(fetch.index))) return true;
  }
  return false;
};

/**
 * The SVG when it holds only drawing elements, no event handlers, and no
 * reference outside itself; null otherwise. Its stylesheet and every
 * attribute but a `data-` one are read as CSS, and refused when they hold an
 * escape, a comment, an at-rule, or any fetching function other than
 * `url(#id)`.
 */
export function safeSvg(svg: string): string | null {
  let at = 0;
  let inStyle = false;
  while (at < svg.length) {
    const open = svg.indexOf("<", at);
    if (open < 0) break;
    TAG.lastIndex = open;
    const tag = TAG.exec(svg);
    if (!tag) return null;
    const [, closing, rawName, attributes] = tag;
    const name = rawName!;
    if (!ELEMENTS.has(name)) return null;
    // A stylesheet is text up to its closing tag: no markup inside it.
    if (inStyle) {
      if (!closing || name !== "style") return null;
      if (refusedCss(svg.slice(at, open))) return null;
    }
    inStyle = name === "style" && !closing;
    for (const [, attribute, value] of attributes!.matchAll(ATTRIBUTE)) {
      const lower = attribute!.toLowerCase();
      if (lower.startsWith("on") || lower.endsWith("href")) return null;
      // A data attribute is never read as CSS; it holds the diagram's labels.
      if (!lower.startsWith("data-") && refusedCss(value!)) return null;
    }
    at = TAG.lastIndex;
  }
  return inStyle ? null : svg;
}

/**
 * Take the two things out of the library's SVG that belong to the page: the
 * web font it imports, and the fixed colors on the root element. Without
 * them the text uses the page's font, and the diagram's colors come from the
 * custom properties it inherits (`--bg` and `--fg`, and optionally `--line`,
 * `--accent`, `--muted`, `--surface`, and `--border`). The comment lines in
 * its stylesheet go too, since `safeSvg` refuses a comment.
 */
const adopt = (svg: string): string =>
  svg
    .replace(/^\s*@import [^\n]*\n/gm, () => "")
    .replace(/^\s*text \{ font-family:[^\n]*\n/m, () => "")
    .replace(/<style>[^<]*<\/style>/g, (sheet) =>
      sheet.replace(/^[ \t]*\/\*[^\n]*?\*\/[ \t]*\n/gm, () => ""),
    )
    .replace(/^(<svg\b[^>]*?) style="[^"]*"/, (_, start: string) => start);

const PROTECTED = /("[^"]*"|\[[^\]]*\]|\{[^}]*\}|\([^)]*\)|\|[^|]*\|)/;
const ARROW = /\s*(<?-\.->|<?-->|<?==>|-\.-|---|===)\s*/g;

/**
 * Models often write a flowchart edge with no spaces (`A-->B`, `A-->|yes|B`),
 * which the library reads as one node named `A--`. Put the spaces in, leaving
 * quoted text and the text inside a node's brackets alone.
 */
export function spaceArrows(source: string): string {
  if (!/^\s*(?:flowchart|graph)\b/.test(source)) return source;
  return source
    .split("\n")
    .map((line) =>
      line
        .split(PROTECTED)
        .map((part, index) =>
          index % 2 ? part : part.replace(ARROW, (_, arrow) => ` ${arrow} `),
        )
        .join("")
        // An edge label belongs to its arrow: `A -->|yes| B`.
        .replace(
          /(->|--|==) (\|[^|]*\|)\s*/g,
          (_, end, label) => `${end}${label} `,
        )
        .replace(/^(\s*) (?=\S)/, (_, indent) => indent),
    )
    .join("\n");
}

export interface MermaidFenceOptions {
  /** How many drawn diagrams to remember (default 200). A stored reply is drawn on every page load. */
  cache?: number;
  /** A diagram longer than this many characters is shown as code (default 20,000). */
  maxLength?: number;
}

/**
 * A renderer for ```mermaid fences. The result is a `<figure class="diagram">`
 * holding one inline SVG. Give the figure, or any ancestor, `--bg` and `--fg`
 * colors; light and dark themes then need no second render.
 */
export function mermaidFence(options: MermaidFenceOptions = {}): FenceRenderer {
  const { cache: limit = 200, maxLength = 20_000 } = options;
  const cache = new Map<string, string | null>();
  return (source) => {
    const text = source.trim();
    if (!text || text.length > maxLength) return null;
    const known = cache.get(text);
    if (known !== undefined) return known;
    let html: string | null = null;
    try {
      const svg = safeSvg(
        adopt(renderMermaidSVG(spaceArrows(text), { transparent: true })),
      );
      if (svg) {
        html = `<figure class="diagram" data-testid="diagram">${svg}</figure>`;
      }
    } catch {
      // Not Mermaid, or a diagram type the library does not draw.
    }
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(text, html);
    return html;
  };
}
