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
import {
  type ComponentSource,
  type ProjectSnapshot,
  usedComponentSources,
} from "./project.js";

/** Which program checks a block: the browser one (DOM, no Node types) or the server one (Node, no DOM). */
export type TypeScriptProgramKind = "client" | "server";

/** The language VS Code's HTML support embeds a script as, or `undefined` for one it leaves alone. */
export type EditorScriptLanguage = "typescript" | "javascript" | undefined;

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
  /**
   * The language VS Code's HTML support embeds the block as, so its own in-file mode answers about it, or
   * `undefined` when it embeds nothing (see `editorScriptLanguage`). An uppercase `TYPE="text/typescript"` leaves
   * the block JavaScript there: its JavaScript mode reads it with the page's plain scripts.
   */
  editorLanguage: EditorScriptLanguage;
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

/**
 * Whether `html` holds `name` (lowercase ASCII letters) at `at`, in any ASCII case, as an HTML parser compares tag
 * names. Setting bit 0x20 lowercases an ASCII letter and leaves every other code unequal to a lowercase letter.
 */
function hasTagNameAt(html: string, at: number, name: string): boolean {
  if (at + name.length > html.length) return false;
  for (let k = 0; k < name.length; k++)
    if ((html.charCodeAt(at + k) | 0x20) !== name.charCodeAt(k)) return false;
  return true;
}

/** The index of `</name` (any ASCII case, followed by a tag-name end) at or after `from`, or -1. */
function findCloseTag(html: string, from: number, name: string): number {
  for (
    let at = html.indexOf("</", from);
    at >= 0;
    at = html.indexOf("</", at + 2)
  )
    if (
      hasTagNameAt(html, at + 2, name) &&
      isTagNameEnd(html[at + 2 + name.length])
    )
      return at;
  return -1;
}

/** Whether a TypeScript block needs scanning at all: a cheap test before any work. */
export function mayHaveTypeScriptBlocks(html: string): boolean {
  return /text\/typescript/i.test(html);
}

/** A `<script>` element of an HTML file, with its open tag's attributes. */
interface ScriptElement {
  attributes: Map<string, string>;
  /** The open tag's text, `<script` to `>`. */
  openTag: string;
  contentStart: number;
  content: string;
}

/**
 * Every `<script>` element of an HTML file, in source order. A script inside an HTML comment or another raw-text
 * element, and one whose tag or element never closes, is not one.
 *
 * Tag names are compared in place, in ASCII case only. Lowercasing the page instead copied all of it on every scan
 * (the language server scans on each keystroke), and Unicode lowercasing can change a string's length ("İ" becomes
 * two characters), which moved every offset after it.
 */
function scanScripts(html: string): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      // An unclosed comment runs to the end of the file, as in a browser.
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const name = RAW_TEXT_ELEMENTS.find(
      (candidate) =>
        hasTagNameAt(html, lt + 1, candidate) &&
        isTagNameEnd(html[lt + 1 + candidate.length]),
    );
    if (!name) {
      i = lt + 1;
      continue;
    }
    const tagEnd = findOpenTagEnd(html, lt + 1 + name.length);
    if (tagEnd < 0) break;
    const contentStart = tagEnd + 1;
    const close = findCloseTag(html, contentStart, name);
    // An element that never closes swallows the rest of the file; nothing after it is a tag.
    if (close < 0) break;
    if (name === "script") {
      const openTag = html.slice(lt, contentStart);
      scripts.push({
        attributes: readOpenTagAttributes(openTag),
        openTag,
        contentStart,
        content: html.slice(contentStart, close),
      });
    }
    i = close + 2 + name.length;
  }
  return scripts;
}

const directiveOf = (
  attributes: Map<string, string>,
): TypeScriptBlockDirective | undefined =>
  DIRECTIVES.find((candidate) => attributes.has(`data-bascik-${candidate}`));

/**
 * The language VS Code's HTML support embeds a script as. Its scanner starts every script as JavaScript, and an
 * attribute whose name is `type` as written (so not `TYPE`) with a value changes that: the value as written, quotes
 * included, matching `/["'](module|(text|application)\/(java|ecma)script|text\/babel)["']/` makes it JavaScript,
 * `/["']text\/typescript["']/` TypeScript, and anything else nothing. The last such attribute wins. So
 * `type="text/TypeScript"`, `type=text/typescript` and `type=" text/typescript"`, which Bascik compiles as
 * TypeScript, are embedded as nothing, and `TYPE="text/typescript"` as JavaScript.
 */
export function editorScriptLanguage(openTag: string): EditorScriptLanguage {
  const insideTag = openTag.replace(/^<[^\s/>]+/, "").replace(/\/?>$/, "");
  const attributeRe =
    /([^\s"'=<>`/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'][^\s]*))?/g;
  let language: EditorScriptLanguage = "javascript";
  for (const [, name, value] of insideTag.matchAll(attributeRe)) {
    if (name !== "type" || value === undefined) continue;
    if (
      /["'](module|(text|application)\/(java|ecma)script|text\/babel)["']/.test(
        value,
      )
    )
      language = "javascript";
    else if (/["']text\/typescript["']/.test(value)) language = "typescript";
    else language = undefined;
  }
  return language;
}

/**
 * The text of every script VS Code's HTML support embeds as `language`, in source order: the scripts its mode for
 * that language reads together as one file.
 */
export function editorEmbeddedScripts(
  html: string,
  language: "typescript" | "javascript",
): { contentStart: number; content: string }[] {
  return scanScripts(html).filter(
    (script) => editorScriptLanguage(script.openTag) === language,
  );
}

/**
 * The `type="text/typescript"` script blocks of an HTML file, in source order. A block inside an HTML comment, a
 * script with `src`, a script whose tag or element never closes, and a script with any other type are not blocks.
 */
export function extractTypeScriptBlocks(html: string): TypeScriptBlock[] {
  const blocks: TypeScriptBlock[] = [];
  if (!mayHaveTypeScriptBlocks(html)) return blocks;
  for (const { attributes, openTag, contentStart, content } of scanScripts(
    html,
  )) {
    const type = attributes.get("type")?.trim().toLowerCase();
    if (type !== "text/typescript" || attributes.has("src")) continue;
    const directive = directiveOf(attributes);
    blocks.push({
      index: blocks.length,
      directive,
      program: directive === undefined ? "client" : "server",
      contentStart,
      content,
      editorLanguage: editorScriptLanguage(openTag),
    });
  }
  return blocks;
}

/**
 * Whether an HTML file has a TypeScript block, so checking it needs TypeScript. A page that only names the type (in
 * prose, a `<pre>`, a comment or a data block) has none, and must never load TypeScript or keep it loaded.
 */
export function hasTypeScriptBlocks(html: string): boolean {
  return extractTypeScriptBlocks(html).length > 0;
}

/**
 * What checking a page's blocks needs from the components it uses, directly or through others: `pageScopeHtml`,
 * the HTML of those whose client scripts run in the page's scope (all of them with `scoping.scriptBlocks` off,
 * none otherwise), whose names are the page's globals; and `usedComponents`, those with a TypeScript block, whose
 * additions to the browser's globals (`interface Window { ... }`, `declare global`) hold on the page too, as their
 * scripts run there. `readOpen` gives an open editor buffer's newer text.
 */
export function pageComponentsForTypeScript(
  fsPath: string,
  text: string,
  snapshot: Pick<ProjectSnapshot, "scopesScriptBlocks" | "componentMap"> &
    Partial<Pick<ProjectSnapshot, "componentSourceByFile">>,
  readOpen?: (fsPath: string) => string | undefined,
): { pageScopeHtml: string[]; usedComponents: ComponentSource[] } {
  const used = usedComponentSources(fsPath, text, snapshot, readOpen);
  return {
    pageScopeHtml:
      snapshot.scopesScriptBlocks === false
        ? used.map((component) => component.text)
        : [],
    usedComponents: used.filter((component) =>
      hasTypeScriptBlocks(component.text),
    ),
  };
}

/**
 * The TypeScript block whose content holds `offset` (its end included, where the cursor sits after the last
 * character), or `undefined` when the offset is outside every block.
 */
export function typeScriptBlockAt(
  html: string,
  offset: number,
): TypeScriptBlock | undefined {
  return extractTypeScriptBlocks(html).find(
    (block) =>
      block.contentStart <= offset &&
      offset <= block.contentStart + block.content.length,
  );
}

/** The `type` values a browser runs as a classic script (the HTML standard's JavaScript MIME type essences). */
const CLASSIC_SCRIPT_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/** A script that runs in the browser in a page's shared scope. */
export interface PageScopeScript {
  /** `type="text/typescript"` (Bascik strips the types) or plain JavaScript. */
  typed: boolean;
  content: string;
}

/**
 * The inline scripts of an HTML file that the browser runs as classic scripts, so their top-level names are
 * globals every other classic script on the page sees: plain JavaScript ones (no `type`, or a JavaScript type)
 * and `type="text/typescript"` ones. A module, a data block, a script with `src` and a server-side script (a
 * Bascik directive) are not among them.
 */
export function extractPageScopeScripts(html: string): PageScopeScript[] {
  const scripts: PageScopeScript[] = [];
  for (const { attributes, content } of scanScripts(html)) {
    if (attributes.has("src") || directiveOf(attributes) !== undefined)
      continue;
    const type = (attributes.get("type") ?? "").trim().toLowerCase();
    if (type === "text/typescript") scripts.push({ typed: true, content });
    else if (CLASSIC_SCRIPT_TYPES.has(type))
      scripts.push({ typed: false, content });
  }
  return scripts;
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
  /**
   * Names a block declares that another classic script on the page declares too, and so may have assigned: a
   * `var shared: number;` that types a plain script's `var shared = 1` is not "used before being assigned".
   */
  assignedElsewhere?: string[];
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

/** Appends a block's content, with the insertions made, to `text`, recording its segments. */
function appendBlock(
  text: string,
  segments: Segment[],
  block: Pick<TypeScriptBlock, "contentStart" | "content">,
  insertions: Insertion[],
): string {
  const sorted = [...insertions].sort((a, b) => a.at - b.at);
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
  return text + block.content.slice(cursor);
}

/** The virtual text for a block: its content with the insertions made, then the footer. */
export function virtualBlockText(
  block: TypeScriptBlock,
  insertions: Insertion[],
  typed = true,
  check?: FooterCheck,
): VirtualBlockText {
  const segments: Segment[] = [];
  let text = appendBlock("", segments, block, insertions);
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
 * The global type alias, declared once per client program, for the real `typeof globalThis`: a page that redeclares
 * `globalThis` (see `GlobalObjects`) can no longer name it itself.
 */
export const GLOBAL_THIS_TYPE = "__BascikGlobalThis";

/** The page-local type alias that lists a page's classic globals as properties of its global objects. */
export const PAGE_GLOBALS_TYPE = "__bascikPageGlobals";

/**
 * Text TypeScript shows the author (a message, a hover) without the names the shared text's footer gives the page's
 * global objects: `Window & typeof globalThis & __bascikPageGlobals` reads `Window & typeof globalThis`, the type a
 * classic script sees.
 */
export function withoutGlobalObjectAliases(text: string): string {
  if (!text.includes("__")) return text;
  return text
    .replace(PAGE_GLOBALS_MENTION, "")
    .replace(GLOBAL_THIS_MENTION, "typeof globalThis");
}

const PAGE_GLOBALS_MENTION = new RegExp(
  `\\s*&\\s*${PAGE_GLOBALS_TYPE}\\b|\\b${PAGE_GLOBALS_TYPE}\\s*&\\s*`,
  "g",
);
const GLOBAL_THIS_MENTION = new RegExp(`\\b${GLOBAL_THIS_TYPE}\\b`, "g");

/** The global objects whose properties a classic script's top-level `var` and `function` names become. */
export type GlobalObjectName = "window" | "self" | "globalThis";

/** The library type of each global object, before a page's classic globals are added to it. */
const GLOBAL_OBJECT_TYPES: Record<GlobalObjectName, string> = {
  window: `Window & ${GLOBAL_THIS_TYPE}`,
  self: `Window & ${GLOBAL_THIS_TYPE}`,
  globalThis: GLOBAL_THIS_TYPE,
};

/**
 * A classic script's top-level `var` and `function` names are properties of `window` (and `self`, `globalThis`),
 * which the shared text, checked as a module, does not see: its footer redeclares those objects, for that page only,
 * with the names added. A name a typed block declares gets its declared type; any other page-scope script's, `any`.
 */
export interface GlobalObjects {
  members: { name: string; typed: boolean }[];
  /** The objects to redeclare: not one the page declares itself. */
  objects: GlobalObjectName[];
}

/** What `sharedScriptText` adds to the blocks it joins. */
export interface SharedScriptOptions {
  /** Insertions per block, keyed by the block's `index`. */
  insertions?: Map<number, Insertion[]>;
  /**
   * Globals the page's other classic scripts declare (plain JavaScript ones, components' scripts in the page
   * scope, blocks left out for a syntax error), declared `any` in the footer so a block can use them.
   */
  ambientNames?: string[];
  /** The page's classic globals as properties of its global objects. */
  globalObjects?: GlobalObjects;
  /** See `VirtualBlockText.assignedElsewhere`. */
  assignedElsewhere?: string[];
}

/**
 * The virtual text for client blocks that share one scope (a page's): their contents in order, then the footer
 * that declares the page's other globals and makes the text a module of its own, so two pages never share a name.
 */
export function sharedScriptText(
  blocks: TypeScriptBlock[],
  options: SharedScriptOptions = {},
): VirtualBlockText {
  const segments: Segment[] = [];
  let text = "";
  blocks.forEach((block, index) => {
    if (index > 0) text += SHARED_SCOPE_SEPARATOR;
    text = appendBlock(
      text,
      segments,
      block,
      options.insertions?.get(block.index) ?? [],
    );
  });
  const footerStart = text.length;
  const ambient = options.ambientNames ?? [];
  if (ambient.length > 0)
    text += `\ndeclare var ${ambient.map((name) => `${name}: any`).join(", ")};`;
  const globals = options.globalObjects;
  if (globals && globals.members.length > 0 && globals.objects.length > 0) {
    const members = globals.members
      .map(({ name, typed }) => `${name}: ${typed ? `typeof ${name}` : "any"}`)
      .join("; ");
    text += `\ntype ${PAGE_GLOBALS_TYPE} = { ${members} };`;
    for (const object of globals.objects)
      text += `\ndeclare var ${object}: ${GLOBAL_OBJECT_TYPES[object]} & ${PAGE_GLOBALS_TYPE};`;
  }
  text += blockFooter(undefined);
  const assignedElsewhere = options.assignedElsewhere ?? [];
  return assignedElsewhere.length > 0
    ? { text, segments, footerStart, assignedElsewhere }
    : { text, segments, footerStart };
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
