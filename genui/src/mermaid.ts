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

const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/y;
const ATTRIBUTE = /\s+([\w:-]+)="([^"]*)"/g;

/** True when a `url()` in the value points anywhere but inside the document. */
const leavesDocument = (value: string): boolean =>
  /url\(\s*(?!#)/i.test(value) || /@import|javascript:/i.test(value);

/**
 * The SVG when it holds only drawing elements, no event handlers, and no
 * reference outside itself; null otherwise.
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
      if (leavesDocument(svg.slice(at, open))) return null;
    }
    inStyle = name === "style" && !closing;
    for (const [, attribute, value] of attributes!.matchAll(ATTRIBUTE)) {
      const lower = attribute!.toLowerCase();
      if (lower.startsWith("on") || lower.endsWith("href")) return null;
      if (leavesDocument(value!)) return null;
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
 * `--accent`, `--muted`, `--surface`, and `--border`).
 */
const adopt = (svg: string): string =>
  svg
    .replace(/^\s*@import [^\n]*\n/gm, () => "")
    .replace(/^\s*text \{ font-family:[^\n]*\n/m, () => "")
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
