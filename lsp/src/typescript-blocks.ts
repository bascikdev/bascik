/**
 * The `<script type="text/typescript">` blocks of an HTML file, and the virtual TypeScript file each one becomes.
 *
 * Blocks are checked in the scope Bascik runs them in. A block with a Bascik directive (`data-bascik-build`,
 * `-build-once`, `-routes`, `-server`, `-stream`) runs in Node as its own module. A client block (no directive)
 * runs in the browser as a classic script: in a component with `scoping.scriptBlocks` on, each block is wrapped
 * in its own function, so it is checked on its own; otherwise (a page) the blocks share the page's scope, so they
 * are checked together, as one text (`sharedScriptText`). Client and server blocks are checked in different
 * programs, with different libraries.
 *
 * Offsets map back to the HTML through segments: the virtual text is the block's own text, with a few inserted
 * characters (the call that gives a directive script's default export its type) and a footer after it.
 *
 * The scan is linear in the length of the HTML, so a keystroke in a long page costs the same as in a short one.
 */
import { readOpenTagAttributes } from "./analyzer.js";

/** Which program checks a block: the browser one (DOM, no Node types) or the server one (Node, no DOM). */
export type TypeScriptProgramKind = "client" | "server";

/** The Bascik directive on a block's script tag, or `undefined` for a client script. */
export type TypeScriptBlockDirective =
  "build" | "build-once" | "routes" | "server" | "stream";

export interface TypeScriptBlock {
  /** Position among the file's TypeScript blocks, from 0. */
  index: number;
  directive: TypeScriptBlockDirective | undefined;
  program: TypeScriptProgramKind;
  /** Offset of the block's first character in the HTML. */
  contentStart: number;
  content: string;
}

/** In the order Bascik's compiler resolves a tag that (wrongly) carries more than one. */
const DIRECTIVES: TypeScriptBlockDirective[] = [
  "server",
  "stream",
  "build",
  "build-once",
  "routes",
];

/** Elements whose content is text, so a `<script` inside them is not a tag. */
const RAW_TEXT_ELEMENTS = ["script", "style", "textarea", "title"];

const isTagNameEnd = (char: string | undefined): boolean =>
  char === undefined || /[\t\n\f\r />]/.test(char);

/**
 * The index of the `>` that ends the open tag whose name ends at `from`, or -1 when the tag never ends. A quote
 * runs to its partner, as in `SCRIPT_BLOCK_RE`, so a `>` inside a quoted value does not end the tag.
 */
function findOpenTagEnd(html: string, from: number): number {
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (char === ">") return i;
    if (char === '"' || char === "'") {
      const close = html.indexOf(char, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

/** The index of `</name` (followed by a tag-name end) at or after `from`, or -1. */
function findCloseTag(lower: string, from: number, name: string): number {
  const needle = `</${name}`;
  for (let at = lower.indexOf(needle, from); at >= 0;) {
    if (isTagNameEnd(lower[at + needle.length])) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return -1;
}

/** Whether a TypeScript block needs scanning at all: a cheap test before any work. */
export function mayHaveTypeScriptBlocks(html: string): boolean {
  return /text\/typescript/i.test(html);
}

/**
 * The `type="text/typescript"` script blocks of an HTML file, in source order. A block inside an HTML comment, a
 * script with `src`, a script whose tag or element never closes, and a script with any other type are not blocks.
 */
export function extractTypeScriptBlocks(html: string): TypeScriptBlock[] {
  const blocks: TypeScriptBlock[] = [];
  if (!mayHaveTypeScriptBlocks(html)) return blocks;
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = lower.indexOf("<", i);
    if (lt < 0) break;
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      // An unclosed comment runs to the end of the file, as in a browser.
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const name = RAW_TEXT_ELEMENTS.find(
      (candidate) =>
        lower.startsWith(candidate, lt + 1) &&
        isTagNameEnd(lower[lt + 1 + candidate.length]),
    );
    if (!name) {
      i = lt + 1;
      continue;
    }
    const tagEnd = findOpenTagEnd(html, lt + 1 + name.length);
    if (tagEnd < 0) break;
    const contentStart = tagEnd + 1;
    const close = findCloseTag(lower, contentStart, name);
    // An element that never closes swallows the rest of the file; nothing after it is a tag.
    if (close < 0) break;
    if (name === "script") {
      const attributes = readOpenTagAttributes(html.slice(lt, contentStart));
      const type = attributes.get("type")?.trim().toLowerCase();
      if (type === "text/typescript" && !attributes.has("src")) {
        const directive = DIRECTIVES.find((candidate) =>
          attributes.has(`data-bascik-${candidate}`),
        );
        blocks.push({
          index: blocks.length,
          directive,
          program: directive === undefined ? "client" : "server",
          contentStart,
          content: html.slice(contentStart, close),
        });
      }
    }
    i = close + 2 + name.length;
  }
  return blocks;
}

/** A run of virtual text copied unchanged from the HTML. */
export interface Segment {
  /** Offset in the virtual text. */
  generated: number;
  /** Offset in the HTML. */
  source: number;
  length: number;
}

export interface VirtualBlockText {
  text: string;
  segments: Segment[];
  /** Offset in the virtual text where Bascik's footer starts. A diagnostic from there on is Bascik's, not the author's. */
  footerStart: number;
  /**
   * The footer's check of a named default export function (see `FooterCheck`): the argument's range in the virtual
   * text, and the function name's range in the HTML, where an error in that argument is the author's to fix.
   */
  footerCheck?: {
    generatedStart: number;
    generatedEnd: number;
    sourceStart: number;
    sourceEnd: number;
  };
}

/**
 * A named default export function checked from the footer (`__bascikScript(build);`) instead of being wrapped
 * in the call. Wrapping turns the declaration into an expression, which takes its name out of the module's scope,
 * so it is used whenever the block refers to that name outside the function. `start` and `end` are the name's
 * offsets in the block's content.
 */
export interface FooterCheck {
  name: string;
  start: number;
  end: number;
}

/** A place in the block where Bascik inserts text, found by the caller's parser. */
export interface Insertion {
  /** Offset in the block's content. */
  at: number;
  text: string;
}

/** The `@bascik/bascik` type each directive's default export must satisfy. */
export const DIRECTIVE_SCRIPT_TYPES: Record<TypeScriptBlockDirective, string> =
  {
    build: "BuildScript",
    "build-once": "BuildScript",
    routes: "RoutesScript",
    server: "ServerScript",
    stream: "ServerScript",
  };

/** The function a directive script's default export is passed to, so its parameters and result get their types. */
export const SCRIPT_TYPE_CHECK = "__bascikScript";

/**
 * Bascik's footer for a block. A directive script's footer declares the typed function its default export is
 * passed to; the type comes from `@bascik/bascik`. Without those types (the project's `@bascik/bascik` is missing
 * or predates them) the footer is `untyped`: the parameters are `any`, which reports nothing rather than something
 * wrong. The empty export makes every block a module.
 */
export function blockFooter(
  directive: TypeScriptBlockDirective | undefined,
  typed = true,
): string {
  if (directive === undefined) return "\nexport {};\n";
  if (!typed)
    return `\ndeclare function ${SCRIPT_TYPE_CHECK}(script: (...args: any[]) => unknown): unknown;\nexport {};\n`;
  return (
    `\nimport type * as __bascik from "@bascik/bascik";\n` +
    `declare function ${SCRIPT_TYPE_CHECK}(script: __bascik.${DIRECTIVE_SCRIPT_TYPES[directive]}): unknown;\n` +
    "export {};\n"
  );
}

/** The footer line that checks a named default export function, and where its argument starts in that line. */
function footerCheckLine(name: string): { line: string; argumentAt: number } {
  const opening = `${SCRIPT_TYPE_CHECK}(`;
  return { line: `${opening}${name});\n`, argumentAt: opening.length };
}

/** The virtual text for a block: its content with the insertions made, then the footer. */
export function virtualBlockText(
  block: TypeScriptBlock,
  insertions: Insertion[],
  typed = true,
  check?: FooterCheck,
): VirtualBlockText {
  const sorted = [...insertions].sort((a, b) => a.at - b.at);
  const segments: Segment[] = [];
  let text = "";
  let cursor = 0;
  for (const insertion of sorted) {
    segments.push({
      generated: text.length,
      source: block.contentStart + cursor,
      length: insertion.at - cursor,
    });
    text += block.content.slice(cursor, insertion.at) + insertion.text;
    cursor = insertion.at;
  }
  segments.push({
    generated: text.length,
    source: block.contentStart + cursor,
    length: block.content.length - cursor,
  });
  text += block.content.slice(cursor);
  const footerStart = text.length;
  text += blockFooter(block.directive, typed);
  if (check === undefined) return { text, segments, footerStart };
  const { line, argumentAt } = footerCheckLine(check.name);
  const generatedStart = text.length + argumentAt;
  text += line;
  return {
    text,
    segments,
    footerStart,
    footerCheck: {
      generatedStart,
      generatedEnd: generatedStart + check.name.length,
      sourceStart: block.contentStart + check.start,
      sourceEnd: block.contentStart + check.end,
    },
  };
}

/** What goes between two blocks of a shared scope: a new statement, as a new `<script>` element starts one. */
const SHARED_SCOPE_SEPARATOR = "\n;\n";

/**
 * The virtual text for client blocks that share one scope (a page's): their contents in order, then the footer
 * that makes the text a module of its own, so two pages never share a name.
 */
export function sharedScriptText(blocks: TypeScriptBlock[]): VirtualBlockText {
  const segments: Segment[] = [];
  let text = "";
  blocks.forEach((block, index) => {
    if (index > 0) text += SHARED_SCOPE_SEPARATOR;
    segments.push({
      generated: text.length,
      source: block.contentStart,
      length: block.content.length,
    });
    text += block.content;
  });
  const footerStart = text.length;
  text += blockFooter(undefined);
  return { text, segments, footerStart };
}

/**
 * The HTML offset for a virtual offset. A position inside inserted text stands for the source character right
 * after it, and the end of the block stands for the end of its content.
 */
export function toSourceOffset(
  virtual: Pick<VirtualBlockText, "segments">,
  generated: number,
): number {
  const { segments } = virtual;
  for (const segment of segments) {
    if (generated < segment.generated) return segment.source;
    if (generated <= segment.generated + segment.length)
      return segment.source + (generated - segment.generated);
  }
  const last = segments[segments.length - 1];
  return last.source + last.length;
}

/** The virtual offset for an HTML offset, or `undefined` when the offset is outside the block. */
export function toGeneratedOffset(
  virtual: Pick<VirtualBlockText, "segments">,
  source: number,
): number | undefined {
  // A character at a segment boundary is the first of the next segment, after the inserted text.
  for (const segment of virtual.segments) {
    if (source >= segment.source && source < segment.source + segment.length)
      return segment.generated + (source - segment.source);
  }
  const last = virtual.segments[virtual.segments.length - 1];
  return source === last.source + last.length
    ? last.generated + last.length
    : undefined;
}

/**
 * Ranges inside a file's blocks, computed for `oldText`, moved to where the same block text sits in `newText`. A
 * range in a block whose text changed (or that is gone), or outside every block, is dropped: its position in the
 * new text is unknown until it is checked again. A block is found at its old position among the blocks first,
 * then as the first unclaimed block with the same text, so a block inserted above another does not lose its
 * ranges.
 */
export function relocateBlockRanges<T extends { start: number; end: number }>(
  oldText: string,
  newText: string,
  ranges: T[],
): T[] {
  if (ranges.length === 0) return [];
  const oldBlocks = extractTypeScriptBlocks(oldText);
  const newBlocks = extractTypeScriptBlocks(newText);
  // The unclaimed new blocks with each text, in order, so finding a moved block costs no rescan.
  const byContent = new Map<string, { indexes: number[]; next: number }>();
  newBlocks.forEach((block, index) => {
    const entry = byContent.get(block.content);
    if (entry) entry.indexes.push(index);
    else byContent.set(block.content, { indexes: [index], next: 0 });
  });
  const claimed = new Set<number>();
  const take = (content: string): number | undefined => {
    const entry = byContent.get(content);
    if (!entry) return undefined;
    while (
      entry.next < entry.indexes.length &&
      claimed.has(entry.indexes[entry.next])
    )
      entry.next++;
    return entry.indexes[entry.next++];
  };
  const shifts = oldBlocks.map((block, index) => {
    let match: number | undefined =
      newBlocks[index]?.content === block.content && !claimed.has(index)
        ? index
        : undefined;
    match ??= take(block.content);
    if (match === undefined) return undefined;
    claimed.add(match);
    return newBlocks[match].contentStart - block.contentStart;
  });
  const moved: T[] = [];
  for (const range of ranges) {
    // The last block starting at or before the range (blocks are in source order).
    let low = 0;
    let high = oldBlocks.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (oldBlocks[middle].contentStart <= range.start) {
        index = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    const block = oldBlocks[index];
    if (!block || range.end > block.contentStart + block.content.length)
      continue;
    const shift = shifts[index];
    if (shift === undefined) continue;
    moved.push({
      ...range,
      start: range.start + shift,
      end: range.end + shift,
    });
  }
  return moved;
}
