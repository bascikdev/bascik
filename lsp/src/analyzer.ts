import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Diagnostic,
  DiagnosticSeverity,
  type Position,
  type Range,
  type CompletionItem,
  CompletionItemKind,
  type LocationLink,
  type Hover,
  MarkupKind,
  type CodeAction,
  CodeActionKind,
  type TextEdit,
} from "vscode-languageserver";
import { type TextDocumentLike } from "./types.js";
import {
  type ProjectSnapshot,
  isPathInside,
  isInsideComponentRoots,
  normalizeComponentName,
  htmlSuppliesComponentProp,
} from "./project.js";
import { findCompatibilityMatches } from "./rules.js";
import { analyzeApiRouteSource } from "./api-rules.js";
import {
  findComponentStructureProblems,
  isKnownBascikAttribute,
  isKnownBuildValue,
  unknownBascikAttributeMessage,
  unknownDirectiveValueMessage,
} from "./directive-rules.js";
import { findModuleSpecifiers } from "./module-specifiers.js";
import { analyzeServerScriptSource } from "./server-script-rules.js";
import { parseImportSpecifier } from "./server-script-templates.js";
import {
  analyzeComponentSource,
  type ComponentMetadata,
} from "./component-metadata.js";
import {
  parseIgnoreDirectives,
  isDiagnosticIgnored,
} from "./ignore-comments.js";
import { loadExtensionConfig } from "./config.js";
import {
  countInstancesOnPages,
  findNameGroups,
  sharedNameGroupMessage,
} from "./name-groups.js";

export const BUILT_IN_HTML_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

export const SCRIPT_DIRECTIVES = [
  {
    name: "data-bascik-build",
    detail: "Bascik build-time script",
    documentation:
      "Executes in Node.js at build time. In a component, it runs for each use with that page's context. The default exported handler function returns HTML markup that replaces this script tag in the generated HTML.",
  },
  {
    name: "data-bascik-build-once",
    detail: "Bascik build-time script, run once",
    documentation:
      "Executes once, without page or route context, and reuses its markup wherever the file is used. In a component, it runs when the component is registered and every use shares the output; in a dynamic route template, every generated page shares it.",
  },
  {
    name: "data-bascik-routes",
    detail: "Bascik dynamic routes script",
    documentation:
      "Executes in Node.js at build time. The default exported handler function returns an array of dynamic route parameters to generate multiple pages from a template.",
  },
  {
    name: "data-bascik-server",
    detail: "Bascik server-side request script",
    documentation:
      "Executes in Node.js per request on production and dev servers. The default exported handler function replaces this script tag.",
  },
  {
    name: "data-bascik-stream",
    detail: "Bascik server-side streaming script",
    documentation:
      "Executes in Node.js per request on production servers. Streams chunked HTML responses to the client as data becomes available.",
  },
];

export const SCRIPT_BLOCK_RE =
  /(<script(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;

export function maskHtmlRawTextContents(html: string): string {
  return html.replace(
    /(<(script|style|textarea)(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2(?:[\t\n\f\r /][^>]*)?>)/gi,
    (
      _match,
      openTag: string,
      _tagName: string,
      content: string,
      closeTag: string,
    ) => `${openTag}${" ".repeat(content.length)}${closeTag}`,
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMatchingClose(
  html: string,
  tagName: string,
  contentStart: number,
): number {
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp(`<${tn}[\\s>]`, "gi");
  const closeRe = new RegExp(`<\\/${tn}>`, "gi");
  let depth = 1;
  let pos = contentStart;
  while (pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(html);
    const closeMatch = closeRe.exec(html);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.index) {
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    } else {
      let inDoubleQuote = false;
      let inSingleQuote = false;
      let tagEnd = -1;
      for (let i = openMatch.index; i < html.length; i++) {
        const char = html[i];
        if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        } else if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (char === ">" && !inDoubleQuote && !inSingleQuote) {
          tagEnd = i + 1;
          break;
        }
      }
      if (tagEnd !== -1) {
        const fullOpenTag = html.slice(openMatch.index, tagEnd);
        if (/\/\s*>$/.test(fullOpenTag)) {
          pos = tagEnd;
          continue;
        }
        depth++;
        pos = tagEnd;
      } else {
        depth++;
        pos = openMatch.index + openMatch[0].length;
      }
    }
  }
  return -1;
}

const isTagNameStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameChar = (code: number): boolean =>
  isTagNameStart(code) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 45;

/**
 * Tag tokens in source order, matching what
 * `/<\/?([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g` finds, in linear time.
 * The regex retries every `<` and rescans to the end on an unclosed tag, which
 * is quadratic. The tag-body scan is deterministic (first `>` outside quotes),
 * so its result depends only on where the scan stands; `tagEndFrom` remembers
 * it per position and no position is scanned twice.
 */
function* scanTags(
  source: string,
  from = 0,
): Generator<{
  name: string;
  closing: boolean;
  text: string;
  start: number;
  end: number;
}> {
  const length = source.length;
  // 0 = not scanned yet, -1 = no closing `>`, otherwise the index after `>`.
  const tagEndFrom = new Int32Array(length + 1);
  const visited: number[] = [];
  const findTagEnd = (from: number): number => {
    let position = from;
    let end = -1;
    visited.length = 0;
    while (position < length) {
      const known = tagEndFrom[position];
      if (known !== 0) {
        end = known;
        break;
      }
      visited.push(position);
      const code = source.charCodeAt(position);
      if (code === 62 /* > */) {
        end = position + 1;
        break;
      }
      if (code === 34 /* " */ || code === 39 /* ' */) {
        const close = source.indexOf(source[position], position + 1);
        if (close < 0) break;
        position = close + 1;
        continue;
      }
      position++;
    }
    for (const index of visited) tagEndFrom[index] = end;
    return end;
  };

  let cursor = from;
  while (cursor < length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) return;
    const closing = source.charCodeAt(open + 1) === 47; /* / */
    const nameStart = open + (closing ? 2 : 1);
    if (!isTagNameStart(source.charCodeAt(nameStart))) {
      cursor = open + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < length && isTagNameChar(source.charCodeAt(nameEnd)))
      nameEnd++;
    const end = findTagEnd(nameEnd);
    if (end < 0) {
      cursor = open + 1;
      continue;
    }
    yield {
      name: source.slice(nameStart, nameEnd),
      closing,
      text: source.slice(open, end),
      start: open,
      end,
    };
    cursor = end;
  }
}

export function findNearestParentComponent(
  source: string,
  componentMap: Map<string, string>,
): string | undefined {
  return findNearestParentComponents(source, [source.length], componentMap)[0];
}

/**
 * For each offset (ascending), the component that `findNearestParentComponent(source.slice(0, offset))`
 * finds, from one scan of `source`. Rescanning the prefix for every offset was quadratic in the number of
 * offsets (one per `data-bascik-slot` tag).
 *
 * The open-element stack carries, per entry, the nearest component at or below it, so each answer is
 * read in constant time. A tag that starts before an offset but ends after it is not a tag in that prefix
 * (its `>` is cut off), so for that offset the prefix scan is continued from just after its `<`, exactly
 * as the prefix scan would, on a copy of the stack.
 */
export function findNearestParentComponents(
  source: string,
  offsets: readonly number[],
  componentMap: Map<string, string>,
): (string | undefined)[] {
  const apply = (
    stack: string[],
    nearest: (string | undefined)[],
    tag: { name: string; closing: boolean; text: string },
  ): void => {
    const name = tag.name.toLowerCase();
    if (tag.closing) {
      const matchingIndex = stack.lastIndexOf(name);
      if (matchingIndex >= 0) {
        stack.length = matchingIndex;
        nearest.length = matchingIndex;
      }
    } else if (!/\/\s*>$/.test(tag.text)) {
      stack.push(name);
      nearest.push(componentMap.has(name) ? name : nearest.at(-1));
    }
  };
  const stack: string[] = [];
  const nearest: (string | undefined)[] = [];
  const tags = scanTags(source);
  let pending = tags.next();
  const results: (string | undefined)[] = [];
  for (const offset of offsets) {
    while (!pending.done && pending.value.end <= offset) {
      apply(stack, nearest, pending.value);
      pending = tags.next();
    }
    if (!pending.done && pending.value.start < offset) {
      const prefixStack = stack.slice();
      const prefixNearest = nearest.slice();
      for (const tag of scanTags(
        source.slice(0, offset),
        pending.value.start + 1,
      ))
        apply(prefixStack, prefixNearest, tag);
      results.push(prefixNearest.at(-1));
    } else {
      results.push(nearest.at(-1));
    }
  }
  return results;
}

export function parseScriptOpenTagAttributes(
  openTag: string,
): Map<string, string | true> {
  const attrs = new Map<string, string | true>();
  const insideTag = openTag.replace(/^<script\b/i, "").replace(/>$/, "");
  const attrRe =
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(insideTag)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4];
    attrs.set(name, value === undefined ? true : value);
  }
  return attrs;
}

/**
 * Attribute values of any open tag, keyed by lowercased name. A bare attribute
 * maps to `""`, as the DOM reports it. The first occurrence of a name wins, as
 * in the HTML tokenizer, and text inside a quoted value is never read as an
 * attribute. An unquoted value keeps its slashes; a trailing `/>` ends it.
 */
function readOpenTagAttributes(openTag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const insideTag = openTag.replace(/^<[^\s/>]+/, "").replace(/\/?>$/, "");
  const attrRe =
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(insideTag)) !== null) {
    const name = match[1].toLowerCase();
    if (!attrs.has(name))
      attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

export function resolveScriptTarget(
  value: string,
  documentDir: string,
  importRootAbs: string,
  kind: "specifier" | "src",
): string | undefined {
  if (value.startsWith("./") || value.startsWith("../"))
    return path.resolve(documentDir, value);
  if (value.startsWith("@/"))
    return path.resolve(importRootAbs, value.slice(2));
  if (value.startsWith("/")) return undefined;
  if (kind === "src") {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
    return path.resolve(documentDir, value);
  }
  return undefined;
}

export function leadingSlashSpecifierMessage(specifier: string): string {
  const rest = specifier.replace(/^\/+/, "");
  return (
    `Leading-slash specifier '${specifier}' is not supported in Bascik scripts. ` +
    `A bare '/' is ambiguous (filesystem root vs. site root). ` +
    `Use '@/${rest}' to resolve against scripts.importRoot, ` +
    `or './${rest}' to resolve relative to this file.`
  );
}

/**
 * The script directives that run in Node and resolve `./`, `../` and `@/` specifiers against the
 * file and `scripts.importRoot`. Leading-slash diagnostics and Go to Definition share this list.
 */
const MODULE_RESOLVING_DIRECTIVES = [
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-server",
  "data-bascik-routes",
  "data-bascik-stream",
] as const;

function hasModuleResolvingDirective(
  attrs: Map<string, string | true>,
): boolean {
  return MODULE_RESOLVING_DIRECTIVES.some((name) => attrs.has(name));
}

export function collectLeadingSlashDiagnostics(
  document: TextDocumentLike,
  openTag: string,
  scriptBody: string,
  blockStart: number,
  attrs: Map<string, string | true>,
): Diagnostic[] {
  if (!hasModuleResolvingDirective(attrs)) {
    return [];
  }
  const out: Diagnostic[] = [];
  const push = (start: number, end: number, specifier: string) => {
    out.push({
      range: {
        start: document.positionAt(start),
        end: document.positionAt(end),
      },
      message: leadingSlashSpecifierMessage(specifier),
      severity: DiagnosticSeverity.Error,
      source: "bascik",
      code: "leading-slash-specifier",
    });
  };

  const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
    openTag,
  );
  if (srcMatch) {
    const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
    if (srcValue.startsWith("/")) {
      const valueStart =
        blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
      push(valueStart, valueStart + srcValue.length, srcValue);
    }
  }

  const bodyStart = blockStart + openTag.length;
  for (const { start, end, value } of findModuleSpecifiers(scriptBody)) {
    if (value.startsWith("/")) push(bodyStart + start, bodyStart + end, value);
  }
  return out;
}

/**
 * Escapes plain text so it renders as typed inside markdown: syntax characters are backslash-escaped, runs of
 * spaces become `&nbsp;`, `>` is escaped, and a newline becomes a hard break. Descriptions come from a
 * component's `<!-- @bascik -->` header and are prose, not markdown, so `<unsafe>` or `*not bold*` stay literal.
 * Matches VS Code's `MarkdownString.appendText`, so the text looks the same in every editor.
 */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#+\-!~]/g, "\\$&")
    .replace(/([ \t]+)/g, (_match, spaces: string) =>
      "&nbsp;".repeat(spaces.length),
    )
    .replace(/>/g, "\\>")
    .replace(/\n/g, "\\\n");
}

export function createComponentDocumentationMarkdown(
  relativePath: string,
  metadata: ComponentMetadata | undefined,
): string {
  const parts: string[] = [];
  if (metadata?.description) {
    parts.push(escapeMarkdownText(metadata.description), "\n\n");
  }
  parts.push(`Bascik component from \`${relativePath}\`.`);
  if (metadata) {
    parts.push("\n\n");
    appendMetadataMembersMarkdown(parts, "Props", metadata.props);
    appendMetadataMembersMarkdown(parts, "Slots", [
      ...metadata.slots,
      ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
    ]);
  }
  return parts.join("");
}

function appendMetadataMembersMarkdown(
  parts: string[],
  label: string,
  members: ComponentMetadata["props"],
): void {
  if (members.length === 0) return;
  parts.push(`**${label}:**\n\n`);
  for (const member of members) {
    parts.push(`- \`${member.name}\``);
    if (member.description) {
      parts.push(`: ${escapeMarkdownText(member.description)}`);
    }
    parts.push("\n");
  }
  parts.push("\n");
}

export function completionReplacementRange(
  document: TextDocumentLike,
  position: Position,
): Range {
  const offset = document.offsetAt(position);
  const prefix =
    /[^\s<>"'=]*$/.exec(document.getText().slice(0, offset))?.[0] ?? "";
  return {
    start: document.positionAt(offset - prefix.length),
    end: position,
  };
}

export function createDiagnostics(
  document: TextDocumentLike,
  fsPath: string,
  snapshot: ProjectSnapshot | undefined,
  openDocumentTexts: { fsPath: string; text: string }[] = [],
): Diagnostic[] {
  const { languageId } = document;

  if (
    languageId !== "css" &&
    languageId !== "javascript" &&
    languageId !== "typescript" &&
    languageId !== "html"
  ) {
    return [];
  }

  const normalizedDocumentPath = fsPath.replace(/\\/g, "/");
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(normalizedDocumentPath)) {
    return [];
  }

  const text = document.getText();
  const diagnostics: Diagnostic[] = [];
  const earlyExtConfig = snapshot
    ? loadExtensionConfig(snapshot.projectRoot)
    : {};
  const isComponentDocument =
    snapshot !== undefined &&
    isInsideComponentRoots(normalizedDocumentPath, snapshot.componentRoots);
  // The API folder is `directory.api`, so it is read from the project when there is one. Without a project
  // (a file opened on its own), the default folder name is the best guess.
  const isInsideApiRoot = snapshot?.apiRoot
    ? isInsideComponentRoots(normalizedDocumentPath, [snapshot.apiRoot])
    : normalizedDocumentPath.includes("/src/api/");
  const isApiRouteDocument =
    isInsideApiRoot &&
    (languageId === "typescript" || languageId === "javascript");

  if (isApiRouteDocument) {
    if (path.basename(normalizedDocumentPath).startsWith("_middleware.")) {
      diagnostics.push({
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: Math.min(text.length, 10) },
        },
        message:
          "Middleware chains (_middleware.ts) are not supported by design in Bascik API routes. Compose plain functions directly in handler files.",
        severity: DiagnosticSeverity.Error,
        source: "bascik",
        code: "middleware-unsupported",
      });
    }
    const apiDiags = analyzeApiRouteSource(text);
    for (const diag of apiDiags) {
      let severity: DiagnosticSeverity = DiagnosticSeverity.Warning;
      if (diag.severity === "error") {
        severity = DiagnosticSeverity.Error;
      } else if (diag.severity === "info") {
        severity = DiagnosticSeverity.Information;
      }
      diagnostics.push({
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: Math.min(text.length, 10) },
        },
        message: diag.message,
        severity,
        source: "bascik",
        code: diag.code,
      });
    }
  }

  if (languageId === "html" && fsPath.startsWith("/")) {
    if (
      snapshot &&
      isInsideComponentRoots(normalizedDocumentPath, snapshot.componentRoots)
    ) {
      const fileName = path.basename(normalizedDocumentPath);
      const nameWithoutExt = fileName.replace(/\.html$/i, "").toLowerCase();
      if (
        !nameWithoutExt.includes("-") &&
        !BUILT_IN_HTML_ELEMENTS.has(nameWithoutExt)
      ) {
        diagnostics.push({
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: Math.min(text.length, 10) },
          },
          code: "component-name-not-hyphenated",
          message: `Component "${nameWithoutExt}" is not hyphenated. Under WHATWG HTML §4.13, custom elements should include a hyphen (e.g. "my-${nameWithoutExt}") to avoid collisions with future HTML standards.`,
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
        });
      }
    }
  }

  // Scoping rules describe what Bascik cannot rewrite, so they apply to component files, the only code it scopes.
  // Pages and API routes are not scoped. Without a project there is no way to tell, so every file is checked.
  const appliesScopingRules = snapshot === undefined || isComponentDocument;

  const addCompatibilityDiagnostics = (
    sourceText: string,
    kind: "css" | "js",
    offset: number,
  ) => {
    if (!appliesScopingRules) return;
    for (const { rule, index, length } of findCompatibilityMatches(
      sourceText,
      kind,
    )) {
      const start = document.positionAt(offset + index);
      const end = document.positionAt(offset + index + length);
      const severity =
        rule.severity === "warning"
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Error;
      diagnostics.push({
        range: { start, end },
        message: `${rule.message} ${rule.suggestion}`,
        severity,
        source: "bascik",
        code: rule.id,
      });
    }
  };

  const isJavaScriptScriptTag = (openTag: string): boolean => {
    const attrs = parseScriptOpenTagAttributes(openTag);
    const typeValue = attrs.get("type");
    if (!typeValue || typeValue === true) return true;
    const normalized = String(typeValue).trim().toLowerCase();
    return (
      normalized === "module" ||
      normalized === "text/javascript" ||
      normalized === "application/javascript" ||
      normalized === "text/ecmascript" ||
      normalized === "application/ecmascript" ||
      // Bascik transpiles inline TypeScript and scopes it like JavaScript (components.ts isJs).
      normalized === "text/typescript"
    );
  };

  const scriptBlockRe = new RegExp(
    SCRIPT_BLOCK_RE.source,
    SCRIPT_BLOCK_RE.flags,
  );
  const styleBlockRe =
    /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style(?:[\t\n\f\r /][^>]*)?>/gi;

  if (languageId === "html") {
    if (isComponentDocument) {
      const metadata = analyzeComponentSource(text, {
        hasCompanionStyles: fs.existsSync(fsPath.replace(/\.html$/i, ".css")),
      });
      for (const metadataDiagnostic of metadata.diagnostics) {
        diagnostics.push({
          range: {
            start: document.positionAt(metadataDiagnostic.start),
            end: document.positionAt(metadataDiagnostic.end),
          },
          message: metadataDiagnostic.message,
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
          code: metadataDiagnostic.code,
        });
      }

      const referenceScanText = maskHtmlRawTextContents(text).replace(
        /<!--[\s\S]*?(?:-->|$)/g,
        (comment) => " ".repeat(comment.length),
      );
      const declaredIds = new Set(
        Array.from(
          referenceScanText.matchAll(
            /\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`/>]+))/gi,
          ),
        )
          .map((match) => match[1] ?? match[2] ?? match[3])
          .filter((id): id is string => Boolean(id)),
      );
      const idReferenceAttributeRegex =
        /\s(for|itemref|aria-activedescendant|aria-details|aria-errormessage|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-flowto)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+))/gi;
      let idReferenceMatch: RegExpExecArray | null;
      while (
        (idReferenceMatch =
          idReferenceAttributeRegex.exec(referenceScanText)) !== null
      ) {
        const value =
          idReferenceMatch[2] ??
          idReferenceMatch[3] ??
          idReferenceMatch[4] ??
          "";
        for (const id of value.trim().split(/\s+/).filter(Boolean)) {
          if (declaredIds.has(id)) continue;
          const valueOffset = idReferenceMatch[0].indexOf(id);
          const start = document.positionAt(
            idReferenceMatch.index + Math.max(valueOffset, 0),
          );
          const end = document.positionAt(
            idReferenceMatch.index + Math.max(valueOffset, 0) + id.length,
          );
          diagnostics.push({
            range: { start, end },
            code: "id-reference-undeclared",
            message: `ID reference "${id}" is not declared in this component and will be left unscoped.`,
            severity: DiagnosticSeverity.Information,
            source: "bascik",
          });
        }
      }
      const fragmentReferenceRegex =
        /\shref\s*=\s*(?:"#([^"]+)"|'#([^']+)'|#([^\s"'=<>`/>]+))/gi;
      let fragmentReferenceMatch: RegExpExecArray | null;
      while (
        (fragmentReferenceMatch =
          fragmentReferenceRegex.exec(referenceScanText)) !== null
      ) {
        const id =
          fragmentReferenceMatch[1] ??
          fragmentReferenceMatch[2] ??
          fragmentReferenceMatch[3];
        if (!id || declaredIds.has(id)) continue;
        const idOffset = fragmentReferenceMatch[0].indexOf(id);
        const start = document.positionAt(
          fragmentReferenceMatch.index + Math.max(idOffset, 0),
        );
        const end = document.positionAt(
          fragmentReferenceMatch.index + Math.max(idOffset, 0) + id.length,
        );
        diagnostics.push({
          range: { start, end },
          code: "id-reference-undeclared",
          message: `ID reference "${id}" is not declared in this component and will be left unscoped.`,
          severity: DiagnosticSeverity.Information,
          source: "bascik",
        });
      }
    }

    const preserveDirectiveRegex =
      /data-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?/gi;
    let preserveMatch: RegExpExecArray | null;
    while ((preserveMatch = preserveDirectiveRegex.exec(text)) !== null) {
      if (preserveMatch[1] === undefined) continue;
      const value =
        preserveMatch[2] ?? preserveMatch[3] ?? preserveMatch[4] ?? "";
      for (const preserveToken of value.trim().split(/\s+/).filter(Boolean)) {
        if (
          preserveToken === "id" ||
          preserveToken === "name" ||
          preserveToken === "class"
        )
          continue;
        const tokenOffset = preserveMatch[0].indexOf(preserveToken);
        const start = document.positionAt(
          preserveMatch.index + Math.max(tokenOffset, 0),
        );
        const end = document.positionAt(
          preserveMatch.index + Math.max(tokenOffset, 0) + preserveToken.length,
        );
        diagnostics.push({
          range: { start, end },
          code: "unknown-preserve-token",
          message: `Unknown data-bascik-preserve token "${preserveToken}". Valid tokens are id, name, and class.`,
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
        });
      }
    }

    // Field names are renamed only when the project opts in to name scoping; by default they ship as written,
    // so a form that posts elsewhere needs nothing.
    const formOpenTagRegex = /<form\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let formMatch: RegExpExecArray | null;
    while (
      isComponentDocument &&
      snapshot?.scopesName === true &&
      (formMatch = formOpenTagRegex.exec(text)) !== null
    ) {
      const formAttributes = readOpenTagAttributes(formMatch[0]);
      const action = formAttributes.get("action");
      if (!action || !/^(?:https?:)?\/\//i.test(action)) continue;
      const preserveValue = formAttributes.get("data-bascik-preserve");
      // A bare directive, or an empty value (the bare form as serializers
      // write it), preserves every attribute, `name` included.
      const preserveTokens = (preserveValue ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const preservesName =
        preserveValue !== undefined &&
        (preserveTokens.length === 0 || preserveTokens.includes("name"));
      if (preservesName) continue;
      const start = document.positionAt(formMatch.index);
      const end = document.positionAt(formMatch.index + formMatch[0].length);
      diagnostics.push({
        range: { start, end },
        code: "external-form-missing-preserve-name",
        message:
          'External form actions require data-bascik-preserve="name" so submitted field names remain literal.',
        severity: DiagnosticSeverity.Warning,
        source: "bascik",
      });
    }

    if (snapshot && isComponentDocument && !snapshot.scopesName) {
      const groups = findNameGroups(text);
      const componentName = normalizeComponentName(fsPath);
      const instances =
        groups.length > 0
          ? countInstancesOnPages(componentName, snapshot, openDocumentTexts)
          : undefined;
      if (instances && instances.count > 1) {
        for (const group of groups) {
          diagnostics.push({
            range: {
              start: document.positionAt(group.attributeStart),
              end: document.positionAt(group.attributeEnd),
            },
            code: "shared-name-group",
            message: sharedNameGroupMessage(
              group,
              componentName,
              instances,
              snapshot.projectRoot,
            ),
            severity: DiagnosticSeverity.Warning,
            source: "bascik",
          });
        }
      }
    }

    if (snapshot && isComponentDocument) {
      const componentName = normalizeComponentName(fsPath);
      const directiveRegex =
        /data-bascik-attr-([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))/gi;
      let directiveMatch: RegExpExecArray | null;
      while ((directiveMatch = directiveRegex.exec(text)) !== null) {
        const targetName = directiveMatch[1];
        const propName =
          directiveMatch[2] ?? directiveMatch[3] ?? directiveMatch[4];
        const suppliedInOpen = openDocumentTexts.some(({ text }) =>
          htmlSuppliesComponentProp(text, componentName, propName),
        );
        const suppliedInDisk = Array.from(
          snapshot.htmlUsageByFile.values(),
        ).some((usageHtml) =>
          htmlSuppliesComponentProp(usageHtml, componentName, propName),
        );
        if (suppliedInOpen || suppliedInDisk) continue;

        const start = document.positionAt(directiveMatch.index);
        const end = document.positionAt(
          directiveMatch.index + directiveMatch[0].length,
        );
        diagnostics.push({
          range: { start, end },
          // A hint, not a warning. Whether anything supplies the prop is a question about every page, and the
          // snapshot only reads src/**/*.html, so usage from Markdown or a build script is invisible to it.
          code: "attr-prop-unsupplied",
          message: `data-bascik-attr-${targetName} references prop "${propName}", but no <${componentName}> usage supplies data-bascik-prop-${propName}.`,
          severity: DiagnosticSeverity.Information,
          source: "bascik",
        });
      }
    }

    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = scriptBlockRe.exec(text)) !== null) {
      const openTag = scriptMatch[1];
      const scriptBody = scriptMatch[2] ?? "";
      const scriptBodyOffset = (scriptMatch.index ?? 0) + openTag.length;
      const attrs = parseScriptOpenTagAttributes(openTag);

      const directiveAttrs = [
        "data-bascik-build",
        "data-bascik-build-once",
        "data-bascik-server",
        "data-bascik-routes",
        "data-bascik-stream",
      ];
      const presentDirectives = directiveAttrs.filter((d) => attrs.has(d));
      for (let i = 0; i < presentDirectives.length; i++) {
        for (let j = i + 1; j < presentDirectives.length; j++) {
          const d1 = presentDirectives[i];
          const d2 = presentDirectives[j];
          let message: string;
          if (
            (d1 === "data-bascik-build" && d2 === "data-bascik-build-once") ||
            (d1 === "data-bascik-build-once" && d2 === "data-bascik-build")
          ) {
            message =
              "data-bascik-build and data-bascik-build-once cannot both appear on the same <script> tag. Choose one build-script mode.";
          } else if (
            (d1 === "data-bascik-build" && d2 === "data-bascik-server") ||
            (d1 === "data-bascik-server" && d2 === "data-bascik-build")
          ) {
            message =
              "data-bascik-build and data-bascik-server cannot both appear on the same <script> tag. Remove one - a script runs at build time or at request time, not both.";
          } else if (
            (d1 === "data-bascik-routes" && d2 === "data-bascik-server") ||
            (d1 === "data-bascik-server" && d2 === "data-bascik-routes")
          ) {
            message =
              "data-bascik-routes and data-bascik-server cannot both appear on the same <script> tag. Remove one - a routes script runs at build time, while a server script runs at request time.";
          } else if (
            (d1 === "data-bascik-routes" && d2 === "data-bascik-build") ||
            (d1 === "data-bascik-build" && d2 === "data-bascik-routes")
          ) {
            message =
              "data-bascik-routes and data-bascik-build cannot both appear on the same <script> tag. Remove one.";
          } else {
            message = `${d1} and ${d2} cannot both appear on the same <script> tag. Remove one.`;
          }

          const start = document.positionAt(scriptMatch.index ?? 0);
          const end = document.positionAt(
            (scriptMatch.index ?? 0) + openTag.length,
          );
          diagnostics.push({
            range: { start, end },
            message,
            severity: DiagnosticSeverity.Error,
            source: "bascik",
            code: "script-mode-conflict",
          });
        }
      }

      const buildValue = attrs.get("data-bascik-build");
      if (typeof buildValue === "string" && !isKnownBuildValue(buildValue)) {
        diagnostics.push({
          range: {
            start: document.positionAt(scriptMatch.index ?? 0),
            end: document.positionAt((scriptMatch.index ?? 0) + openTag.length),
          },
          message: unknownDirectiveValueMessage(),
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
          code: "unknown-directive-value",
        });
      }
      const buildOnceValue = attrs.get("data-bascik-build-once");
      if (
        typeof buildOnceValue === "string" &&
        !isKnownBuildValue(buildOnceValue)
      ) {
        diagnostics.push({
          range: {
            start: document.positionAt(scriptMatch.index ?? 0),
            end: document.positionAt((scriptMatch.index ?? 0) + openTag.length),
          },
          message: unknownDirectiveValueMessage("data-bascik-build-once"),
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
          code: "unknown-directive-value",
        });
      }
      const hasServerDirective =
        attrs.has("data-bascik-server") ||
        attrs.has("data-bascik-stream") ||
        attrs.has("data-bascik-build") ||
        attrs.has("data-bascik-build-once") ||
        attrs.has("data-bascik-routes");

      if (hasServerDirective) {
        const directive: "stream" | "server" | "build" | "routes" = attrs.has(
          "data-bascik-stream",
        )
          ? "stream"
          : attrs.has("data-bascik-server")
            ? "server"
            : attrs.has("data-bascik-build") ||
                attrs.has("data-bascik-build-once")
              ? "build"
              : "routes";
        const hasSrcAttribute = /\ssrc\s*=/i.test(openTag);
        const serverDiags =
          earlyExtConfig.diagnostics?.serverScriptRules === false
            ? []
            : analyzeServerScriptSource(scriptBody, {
                hasSrcAttribute,
                directive,
                escapeFunctions:
                  earlyExtConfig.diagnostics?.escapeFunctions ?? [],
                lineOffset: document.positionAt(scriptBodyOffset).line,
              });

        for (const sd of serverDiags) {
          const start = document.positionAt(scriptBodyOffset + sd.start);
          const end = document.positionAt(scriptBodyOffset + sd.end);
          let severity: DiagnosticSeverity = DiagnosticSeverity.Error;
          if (sd.severity === "warning") {
            severity = DiagnosticSeverity.Warning;
          } else if (sd.severity === "info") {
            severity = DiagnosticSeverity.Information;
          }
          diagnostics.push({
            range: { start, end },
            message: sd.message,
            severity,
            source: "bascik",
            code: sd.code,
            ...(sd.template
              ? {
                  data: {
                    templateStart: scriptBodyOffset + sd.template.start,
                    fixable: sd.template.fixable,
                    bodyStart: scriptBodyOffset,
                    bodyEnd: scriptBodyOffset + scriptBody.length,
                  } satisfies WrapHtmlData,
                }
              : {}),
          });
        }
      }

      diagnostics.push(
        ...collectLeadingSlashDiagnostics(
          document,
          openTag,
          scriptBody,
          scriptMatch.index ?? 0,
          attrs,
        ),
      );
      // A directive script runs in Node, at build time or per request, and never in the browser Bascik scopes.
      if (isJavaScriptScriptTag(openTag) && !hasServerDirective) {
        addCompatibilityDiagnostics(scriptBody, "js", scriptBodyOffset);
      }
    }

    let styleMatch: RegExpExecArray | null;
    const hasCompanionCss =
      fsPath.toLowerCase().endsWith(".html") &&
      fs.existsSync(fsPath.replace(/\.html$/i, ".css"));

    const maskedText = text
      .replace(
        /(<(style|textarea|script)(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2(?:[\t\n\f\r /][^>]*)?>)/gi,
        (_m, open: string, _tag: string, content: string, close: string) =>
          open + " ".repeat(content.length) + close,
      )
      .replace(
        /<!--([\s\S]*?)-->/g,
        (_m, content: string) => "<!--" + " ".repeat(content.length) + "-->",
      );

    const componentMap = snapshot?.componentMap ?? new Map<string, string>();
    const componentNames = Array.from(componentMap.keys());

    // Typos in Bascik's own attributes. Bascik ignores an attribute it does not know, so nothing else reports
    // them. `<code>` contents are shown as text by default (`scoping.preserve`), so they are not scanned.
    const attributeScanText = maskedText.replace(
      /(<code(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/code(?:[\t\n\f\r /][^>]*)?>)/gi,
      (_m, open: string, content: string, close: string) =>
        open + content.replace(/[^\n]/g, " ") + close,
    );
    const anyOpenTagRe = /<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let anyOpenTag: RegExpExecArray | null;
    while ((anyOpenTag = anyOpenTagRe.exec(attributeScanText)) !== null) {
      const attributesOffset = anyOpenTag.index + 1 + anyOpenTag[1].length;
      const attributeNameRe =
        /(?:^|\s)([^\s"'=<>`/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
      let attributeMatch: RegExpExecArray | null;
      while ((attributeMatch = attributeNameRe.exec(anyOpenTag[2])) !== null) {
        const attributeName = attributeMatch[1].toLowerCase();
        if (
          !attributeName.startsWith("data-bascik-") ||
          isKnownBascikAttribute(attributeName)
        )
          continue;
        const nameStart =
          attributesOffset +
          attributeMatch.index +
          attributeMatch[0].indexOf(attributeMatch[1]);
        diagnostics.push({
          range: {
            start: document.positionAt(nameStart),
            end: document.positionAt(nameStart + attributeMatch[1].length),
          },
          message: unknownBascikAttributeMessage(attributeName),
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
          code: "unknown-bascik-attribute",
        });
      }
    }

    // Component layout convention: styles above the markup, scripts below it.
    if (isComponentDocument) {
      for (const problem of findComponentStructureProblems(maskedText)) {
        const tagLength =
          problem.kind === "script-before-markup"
            ? "<script".length
            : "<style".length;
        diagnostics.push({
          range: {
            start: document.positionAt(problem.index),
            end: document.positionAt(problem.index + tagLength),
          },
          message: problem.message,
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
          code: "component-structure-order",
        });
      }
    }

    // 1. Diagnose script directives on non-script tags
    const elementOpenTagRe =
      /<([A-Za-z][\w-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*?)?\/?>/gi;
    let elementMatch: RegExpExecArray | null;
    while ((elementMatch = elementOpenTagRe.exec(maskedText)) !== null) {
      const tagName = elementMatch[1].toLowerCase();
      if (tagName === "script") continue;
      const openTag = elementMatch[0];
      const matchStart = elementMatch.index;
      const scriptDirectives = new Set([
        "data-bascik-build",
        "data-bascik-build-once",
        "data-bascik-server",
        "data-bascik-routes",
        "data-bascik-stream",
      ]);

      const insideTag = openTag
        .replace(/^<[A-Za-z][\w-]*\s*/i, "")
        .replace(/\/?>$/, "");
      const baseOffset =
        openTag.length - insideTag.length - (openTag.endsWith("/>") ? 2 : 1);
      const attrRe =
        /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRe.exec(insideTag)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        if (scriptDirectives.has(attrName)) {
          const start = document.positionAt(
            matchStart + baseOffset + attrMatch.index,
          );
          const end = document.positionAt(
            matchStart + baseOffset + attrMatch.index + attrMatch[1].length,
          );
          diagnostics.push({
            range: { start, end },
            code: "directive-on-non-script",
            message: `\`${attrMatch[1]}\` is only valid on <script> tags. It has no effect on <${tagName}>.`,
            severity: DiagnosticSeverity.Error,
            source: "bascik",
          });
        }
      }
    }

    // 2. Diagnose data-bascik-slot outside of components, on the component itself, or targeting undeclared slots
    const slotTagRe =
      /<([A-Za-z][\w-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*?)?\/?>/gi;
    let slotMatch: RegExpExecArray | null;
    const slotTags: {
      matchStart: number;
      baseOffset: number;
      slotAttr: { name: string; value?: string; index: number };
    }[] = [];
    while ((slotMatch = slotTagRe.exec(maskedText)) !== null) {
      const openTag = slotMatch[0];
      const matchStart = slotMatch.index;
      const insideTag = openTag
        .replace(/^<[A-Za-z][\w-]*\s*/i, "")
        .replace(/\/?>$/, "");
      const baseOffset =
        openTag.length - insideTag.length - (openTag.endsWith("/>") ? 2 : 1);
      const attrRe =
        /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
      let attrMatch: RegExpExecArray | null;
      let slotAttr: { name: string; value?: string; index: number } | null =
        null;
      while ((attrMatch = attrRe.exec(insideTag)) !== null) {
        if (attrMatch[1].toLowerCase() === "data-bascik-slot") {
          slotAttr = {
            name: attrMatch[1],
            value: attrMatch[2] ?? attrMatch[3] ?? attrMatch[4],
            index: attrMatch.index,
          };
          break;
        }
      }
      if (slotAttr) slotTags.push({ matchStart, baseOffset, slotAttr });
    }
    // One scan finds every slot tag's parent; a prefix rescan per tag was quadratic.
    const slotParents = findNearestParentComponents(
      maskedText,
      slotTags.map(({ matchStart }) => matchStart),
      componentMap,
    );
    for (const [slotIndex, slotTag] of slotTags.entries()) {
      const { matchStart, baseOffset, slotAttr } = slotTag;
      const slotName = slotAttr.value;
      const parentName = slotParents[slotIndex];

      const isInsideComponentDefinition = isComponentDocument;
      if (!parentName && !isInsideComponentDefinition) {
        const start = document.positionAt(
          matchStart + baseOffset + slotAttr.index,
        );
        const end = document.positionAt(
          matchStart + baseOffset + slotAttr.index + slotAttr.name.length,
        );
        diagnostics.push({
          range: { start, end },
          code: "slot-outside-component",
          message:
            "`data-bascik-slot` is only valid inside a Bascik component body.",
          severity: DiagnosticSeverity.Error,
          source: "bascik",
        });
      } else if (parentName) {
        const parentMeta = snapshot?.componentMetadata.get(parentName);
        if (slotName !== undefined && parentMeta) {
          const declaredSlot = parentMeta.slots.some(
            (s) => s.name.toLowerCase() === slotName.toLowerCase(),
          );
          if (!declaredSlot) {
            const start = document.positionAt(
              matchStart + baseOffset + slotAttr.index,
            );
            const end = document.positionAt(
              matchStart + baseOffset + slotAttr.index + slotAttr.name.length,
            );
            diagnostics.push({
              range: { start, end },
              code: "undeclared-slot",
              message: `Component <${parentName}> does not declare slot "${slotName}".`,
              severity: DiagnosticSeverity.Error,
              source: "bascik",
            });
          }
        }
      }
    }

    if (componentNames.length > 0) {
      componentNames.sort((a, b) => b.length - a.length);
      const escapedNames = componentNames.map((name) =>
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      const componentTagRe = new RegExp(
        `<(${escapedNames.join("|")})\\b`,
        "gi",
      );
      let compMatch: RegExpExecArray | null;
      while ((compMatch = componentTagRe.exec(maskedText)) !== null) {
        const tagStartIndex = compMatch.index;
        const tagName = compMatch[1].toLowerCase();

        let inDoubleQuote = false;
        let inSingleQuote = false;
        let openTagEndIndex = -1;
        for (let i = tagStartIndex; i < maskedText.length; i++) {
          const char = maskedText[i];
          if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
          } else if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
          } else if (char === ">" && !inDoubleQuote && !inSingleQuote) {
            openTagEndIndex = i + 1;
            break;
          }
        }

        if (openTagEndIndex !== -1) {
          const openTagText = maskedText.slice(tagStartIndex, openTagEndIndex);

          const compMeta = snapshot?.componentMetadata.get(tagName);
          if (compMeta) {
            const propRe = /\b(data-bascik-prop-([\w-]+))\b/gi;
            let propMatch: RegExpExecArray | null;
            while ((propMatch = propRe.exec(openTagText)) !== null) {
              const fullPropAttr = propMatch[1];
              const propName = propMatch[2];
              const isDeclared = compMeta.props.some(
                (p) => p.name.toLowerCase() === propName.toLowerCase(),
              );
              if (!isDeclared) {
                const start = document.positionAt(
                  tagStartIndex + propMatch.index,
                );
                const end = document.positionAt(
                  tagStartIndex + propMatch.index + fullPropAttr.length,
                );
                diagnostics.push({
                  range: { start, end },
                  message: `Component <${tagName}> does not declare prop "${propName}".`,
                  severity: DiagnosticSeverity.Warning,
                  source: "bascik",
                  code: "undeclared-prop",
                });
              }
            }

            if (compMeta.props.length > 0) {
              const insideOpenTag = openTagText
                .replace(new RegExp(`^<${escapeRegExp(tagName)}\\b`, "i"), "")
                .replace(/\/?>$/, "");
              const baseAttrOffset = openTagText.indexOf(insideOpenTag);
              const bareAttrRe =
                /([^\s"'=<>`/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gi;
              let bareMatch: RegExpExecArray | null;
              while ((bareMatch = bareAttrRe.exec(insideOpenTag)) !== null) {
                const attrName = bareMatch[1];
                const lowerAttr = attrName.toLowerCase();
                if (lowerAttr.startsWith("data-bascik-")) continue;
                const declaredProp = compMeta.props.find(
                  (p) => p.name.toLowerCase() === lowerAttr,
                );
                if (!declaredProp) continue;
                const alreadySupplied = new RegExp(
                  `\\bdata-bascik-prop-${escapeRegExp(declaredProp.name)}\\b`,
                  "i",
                ).test(openTagText);
                if (alreadySupplied) continue;
                const attrOffset =
                  tagStartIndex + baseAttrOffset + bareMatch.index;
                const start = document.positionAt(attrOffset);
                const end = document.positionAt(attrOffset + attrName.length);
                diagnostics.push({
                  range: { start, end },
                  message: `Component <${tagName}> declares prop "${declaredProp.name}". Pass it with the data-bascik-prop-${declaredProp.name} prefix instead of "${attrName}".`,
                  severity: DiagnosticSeverity.Warning,
                  source: "bascik",
                  code: "missing-prop-prefix",
                });
              }
            }
          }

          const isSelfClosing = /\/\s*>$/.test(openTagText);
          if (!isSelfClosing) {
            const closeIndex = findMatchingClose(
              maskedText,
              tagName,
              openTagEndIndex,
            );
            if (closeIndex === -1) {
              const start = document.positionAt(tagStartIndex);
              const end = document.positionAt(openTagEndIndex);
              diagnostics.push({
                range: { start, end },
                message: `Component tag <${tagName}> is unclosed. It will be treated as self-closing (<${tagName}/>), but an explicit closing tag is recommended to avoid layout or scoping issues.`,
                severity: DiagnosticSeverity.Warning,
                source: "bascik",
                code: "unclosed-component-tag",
              });
            } else if (compMeta) {
              const hasZeroSlots =
                !compMeta.defaultSlot && compMeta.slots.length === 0;
              if (hasZeroSlots) {
                const start = document.positionAt(tagStartIndex);
                const end = document.positionAt(
                  closeIndex + `</${tagName}>`.length,
                );
                diagnostics.push({
                  range: { start, end },
                  message: `Component <${tagName}> defines no slots and accepts no children. Use self-closing tag <${tagName} /> instead of paired <${tagName}></${tagName}>.`,
                  severity: DiagnosticSeverity.Warning,
                  source: "bascik",
                  code: "prefer-self-closing-component",
                });
              }
            }
          }
        }
      }
    }

    const styleMatches: RegExpExecArray[] = [];
    while ((styleMatch = styleBlockRe.exec(maskedText)) !== null) {
      styleMatches.push(styleMatch);
    }

    for (const match of styleMatches) {
      const openTag = match[1];
      const styleBodyOffset = (match.index ?? 0) + openTag.length;
      // maskedText blanks style bodies (same length), so read the real body from text.
      const styleBody = text.slice(
        styleBodyOffset,
        styleBodyOffset + (match[2] ?? "").length,
      );

      if (hasCompanionCss) {
        const start = document.positionAt(match.index ?? 0);
        const end = document.positionAt((match.index ?? 0) + openTag.length);
        diagnostics.push({
          range: { start, end },
          code: "inline-and-companion-styles",
          message:
            "Component has both a companion .css file and an inline <style> tag. They will be combined at build time, but mixing both is not recommended for readability and maintainability.",
          severity: DiagnosticSeverity.Warning,
          source: "bascik",
        });
      }

      addCompatibilityDiagnostics(styleBody, "css", styleBodyOffset);
    }
  } else if (languageId === "css") {
    addCompatibilityDiagnostics(text, "css", 0);
  } else {
    addCompatibilityDiagnostics(text, "js", 0);
  }

  const ignoreRanges = parseIgnoreDirectives(text, languageId);
  const extConfig = earlyExtConfig;
  const disabledRules = new Set(
    extConfig.diagnostics?.disabledRules?.map((r) => r.toLowerCase()) ?? [],
  );

  if (extConfig.diagnostics?.enabled === false) {
    return [];
  }

  return diagnostics.filter((diag) => {
    const line = diag.range.start.line;
    const code = typeof diag.code === "string" ? diag.code : undefined;
    if (code && disabledRules.has(code.toLowerCase())) {
      return false;
    }
    if (
      code === "prefer-self-closing-component" &&
      extConfig.diagnostics?.selfClosingComponents === false
    ) {
      return false;
    }
    if (
      code === "unclosed-component-tag" &&
      extConfig.diagnostics?.unclosedComponents === false
    ) {
      return false;
    }
    if (isDiagnosticIgnored(line, code, ignoreRanges)) return false;
    // A hole on a later line of a multi-line template: an ignore comment
    // above the template's first line covers it too.
    const templateStart = (diag.data as Partial<WrapHtmlData> | undefined)
      ?.templateStart;
    if (typeof templateStart === "number") {
      const templateLine = document.positionAt(templateStart).line;
      if (
        templateLine !== line &&
        isDiagnosticIgnored(templateLine, code, ignoreRanges)
      )
        return false;
    }
    return true;
  });
}

export function createCompletions(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
): CompletionItem[] | undefined {
  if (document.languageId !== "html") return undefined;

  const offset = document.offsetAt(position);
  const maskedSource = maskHtmlRawTextContents(document.getText()).replace(
    /<!--[\s\S]*?(?:-->|$)/g,
    (comment) => " ".repeat(comment.length),
  );
  const sourceBeforeCursor = maskedSource.slice(0, offset);
  const tagMatch = /<([A-Za-z][\w-]*)?$/.exec(sourceBeforeCursor);
  if (!tagMatch) {
    const openTagMatch = /<([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*$/.exec(
      sourceBeforeCursor,
    );
    if (!openTagMatch) return undefined;

    const currentTagName = openTagMatch[1].toLowerCase();
    const openTagText = openTagMatch[0];
    const currentTagStart = offset - openTagText.length;

    if (currentTagName === "script") {
      const hasAnyDirective = SCRIPT_DIRECTIVES.some((dir) =>
        new RegExp(`\\b${dir.name}\\b`, "i").test(openTagText),
      );
      if (hasAnyDirective) return [];

      const range = completionReplacementRange(document, position);
      return SCRIPT_DIRECTIVES.map((dir) => ({
        label: dir.name,
        kind: CompletionItemKind.Property,
        textEdit: {
          range,
          newText: dir.name,
        },
        sortText: `0_${dir.name}`,
        detail: dir.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: dir.documentation,
        },
      }));
    }

    const currentComponentMetadata =
      snapshot.componentMetadata.get(currentTagName);
    if (currentComponentMetadata) {
      const range = completionReplacementRange(document, position);
      return currentComponentMetadata.props
        .filter(
          ({ name }) =>
            !new RegExp(
              `\\bdata-bascik-prop-${escapeRegExp(name)}\\s*=`,
              "i",
            ).test(openTagText),
        )
        .map((prop) => {
          const attribute = `data-bascik-prop-${prop.name}`;
          const item: CompletionItem = {
            label: attribute,
            kind: CompletionItemKind.Property,
            textEdit: {
              range,
              newText: `${attribute}="$1"`,
            },
            insertTextFormat: 2, // Snippet
            sortText: `0_${attribute}`,
            detail: "Bascik component prop",
          };
          if (prop.description) {
            item.documentation = {
              kind: MarkupKind.Markdown,
              value: escapeMarkdownText(prop.description),
            };
          }
          return item;
        });
    }

    const parentComponentName = findNearestParentComponent(
      maskedSource.slice(0, currentTagStart),
      snapshot.componentMap,
    );
    if (!parentComponentName) return undefined;
    const parentMetadata = snapshot.componentMetadata.get(parentComponentName);
    if (!parentMetadata) return undefined;

    if (/\bdata-bascik-slot(?:\s*=|\s|\/?>|$)/i.test(openTagText)) return [];
    const range = completionReplacementRange(document, position);
    return parentMetadata.slots.map((slot) => {
      const item: CompletionItem = {
        label: `data-bascik-slot="${slot.name}"`,
        kind: CompletionItemKind.Property,
        textEdit: {
          range,
          newText: `data-bascik-slot="${slot.name}"`,
        },
        filterText: `data-bascik-slot ${slot.name}`,
        sortText: `0_data-bascik-slot_${slot.name}`,
        detail: "Bascik named slot",
      };
      if (slot.description) {
        item.documentation = {
          kind: MarkupKind.Markdown,
          value: escapeMarkdownText(slot.description),
        };
      }
      return item;
    });
  }

  const tagStart = offset - tagMatch[0].length;
  const sourceBeforeTag = sourceBeforeCursor.slice(0, tagStart);
  const previousTagStart = sourceBeforeTag.lastIndexOf("<");
  const previousTagEnd = sourceBeforeTag.lastIndexOf(">");
  if (previousTagStart > previousTagEnd) return undefined;

  const prefix = (tagMatch[1] ?? "").toLowerCase();
  const start = document.positionAt(offset - prefix.length);
  const replacementRange: Range = { start, end: position };

  const scriptShorthands = [
    {
      label: "bascik-build",
      detail: "Bascik build-time script block",
      documentation:
        "Executes in Node.js at build time. The default exported handler function returns HTML markup that replaces this script tag in the generated HTML.",
      insertText: `<script data-bascik-build>\n  export default async function () {\n    return \`$0\`;\n  }\n</script>`,
    },
    {
      label: "bascik-routes",
      detail: "Bascik dynamic routes script block",
      documentation:
        "Executes in Node.js at build time. The default exported handler function returns an array of dynamic route parameters to generate multiple pages from a template.",
      insertText: `<script data-bascik-routes>\n  export default async function () {\n    return [\n      $0\n    ];\n  }\n</script>`,
    },
    {
      label: "bascik-server",
      detail: "Bascik server-side request script block",
      documentation:
        "Executes in Node.js per request on production and dev servers. The default exported handler function replaces this script tag.",
      insertText: `<script data-bascik-server>\n  export default async function (request, context, { signal }) {\n    return \`$0\`;\n  }\n</script>`,
    },
    {
      label: "bascik-stream",
      detail: "Bascik server-side streaming script block",
      documentation:
        "Executes in Node.js per request on production servers. Streams chunked HTML responses to the client as data becomes available.",
      insertText: `<script data-bascik-stream>\n  export default async function (request, context, { signal }) {\n    return \`$0\`;\n  }\n</script>`,
    },
  ];

  // The replacement starts at the "<" already typed, so the filter text must start there too, or the editor
  // compares what was typed ("<my-b") against a label without it and hides every item.
  const tagRange: Range = {
    start: document.positionAt(tagStart),
    end: replacementRange.end,
  };

  const shorthandItems: CompletionItem[] = scriptShorthands
    .filter((shorthand) => shorthand.label.startsWith(prefix))
    .map((shorthand) => ({
      label: shorthand.label,
      kind: CompletionItemKind.Snippet,
      sortText: `0_${shorthand.label}`,
      textEdit: { range: tagRange, newText: shorthand.insertText },
      insertTextFormat: 2, // Snippet
      filterText: `<${shorthand.label}`,
      detail: shorthand.detail,
      documentation: {
        kind: MarkupKind.Markdown,
        value: shorthand.documentation,
      },
    }));

  const componentItems: CompletionItem[] = Array.from(snapshot.componentMap)
    .filter(([componentName]) => componentName.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([componentName, componentPath]) => {
      const metadata = snapshot.componentMetadata.get(componentName);
      const relativePath = path
        .relative(snapshot.projectRoot, componentPath)
        .replace(/\\/g, "/");

      return {
        label: componentName,
        kind: CompletionItemKind.Class,
        sortText: `0_${componentName}`,
        textEdit: {
          range: tagRange,
          newText: metadata?.defaultSlot
            ? `<${componentName}>$0</${componentName}>`
            : `<${componentName} />$0`,
        },
        insertTextFormat: 2, // Snippet
        filterText: `<${componentName}`,
        detail: "Bascik component",
        documentation: {
          kind: MarkupKind.Markdown,
          value: createComponentDocumentationMarkdown(relativePath, metadata),
        },
      };
    });

  return [...shorthandItems, ...componentItems];
}

export function createHover(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
): Hover | undefined {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  const wordRegex = /[A-Za-z0-9-]+/g;
  let wordMatch: RegExpExecArray | null;
  let targetWord: string | undefined;
  let wordRange: Range | undefined;

  while ((wordMatch = wordRegex.exec(line)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (position.character >= start && position.character <= end) {
      targetWord = wordMatch[0];
      wordRange = {
        start: { line: position.line, character: start },
        end: { line: position.line, character: end },
      };
      break;
    }
  }

  if (!targetWord || !wordRange) return undefined;
  const componentName = targetWord.toLowerCase();
  if (BUILT_IN_HTML_ELEMENTS.has(componentName)) return undefined;

  const componentPath = snapshot.componentMap.get(componentName);
  if (!componentPath) return undefined;
  const metadata = snapshot.componentMetadata.get(componentName);
  if (!metadata) return undefined;

  const relativePath = path
    .relative(snapshot.projectRoot, componentPath)
    .replace(/\\/g, "/");
  const details: string[] = [`### \`<${componentName}>\`\n\n`];
  if (metadata.description) {
    details.push(escapeMarkdownText(metadata.description), "\n\n");
  }
  details.push(
    `**Source:** [\`${relativePath}\`](${pathToFileURL(componentPath).toString()})\n\n`,
  );
  appendMetadataMembersMarkdown(details, "Props", metadata.props);
  appendMetadataMembersMarkdown(details, "Slots", [
    ...metadata.slots,
    ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
  ]);
  const features = [
    metadata.hasStyles ? "styles" : "",
    metadata.hasScripts ? "scripts" : "",
  ].filter(Boolean);
  if (features.length > 0) {
    details.push(`**Includes:** ${features.join(", ")}`);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: details.join(""),
    },
    range: wordRange,
  };
}

export function createDefinition(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
  fsPath: string,
): LocationLink[] | undefined {
  if (document.languageId !== "html") return undefined;

  // 1. Check for script import definition
  const text = document.getText();
  const offset = document.offsetAt(position);

  SCRIPT_BLOCK_RE.lastIndex = 0;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = SCRIPT_BLOCK_RE.exec(text)) !== null) {
    const openTag = scriptMatch[1];
    const scriptBody = scriptMatch[2] ?? "";
    const blockStart = scriptMatch.index ?? 0;
    const openTagEnd = blockStart + openTag.length;
    const blockEnd = blockStart + scriptMatch[0].length;
    if (offset < blockStart || offset > blockEnd) continue;

    const attrs = parseScriptOpenTagAttributes(openTag);
    if (!hasModuleResolvingDirective(attrs)) {
      return undefined;
    }

    const baseDir = path.dirname(fsPath);
    const importRootAbs = snapshot.importRoot;

    if (offset >= blockStart && offset <= openTagEnd) {
      const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
        openTag,
      );
      if (!srcMatch) return undefined;
      const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
      if (!srcValue) return undefined;
      const valueStart =
        blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
      const valueEnd = valueStart + srcValue.length;
      if (offset < valueStart || offset > valueEnd) return undefined;
      const resolved = resolveScriptTarget(
        srcValue,
        baseDir,
        importRootAbs,
        "src",
      );
      if (!resolved || !fs.existsSync(resolved)) return undefined;
      return [
        {
          originSelectionRange: {
            start: document.positionAt(valueStart),
            end: document.positionAt(valueEnd),
          },
          targetUri: pathToFileURL(resolved).toString(),
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }

    const bodyOffset = offset - openTagEnd;
    for (const { start, end, value: specifier } of findModuleSpecifiers(
      scriptBody,
    )) {
      if (bodyOffset < start || bodyOffset > end) continue;
      const resolved = resolveScriptTarget(
        specifier,
        baseDir,
        importRootAbs,
        "specifier",
      );
      if (!resolved || !fs.existsSync(resolved)) return undefined;
      return [
        {
          originSelectionRange: {
            start: document.positionAt(openTagEnd + start),
            end: document.positionAt(openTagEnd + end),
          },
          targetUri: pathToFileURL(resolved).toString(),
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }
  }

  // 2. Check for component tag jump-to-definition
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  const wordRegex = /[A-Za-z0-9-]+/g;
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordRegex.exec(line)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (position.character >= start && position.character <= end) {
      const word = wordMatch[0].toLowerCase();
      if (BUILT_IN_HTML_ELEMENTS.has(word)) return undefined;
      const componentPath = snapshot.componentMap.get(word);
      if (!componentPath) return undefined;
      return [
        {
          originSelectionRange: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
          targetUri: pathToFileURL(componentPath).toString(),
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }
  }

  return undefined;
}

function rangesOverlap(a: Range, b: Range): boolean {
  if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
  if (a.end.line === b.start.line && a.end.character < b.start.character)
    return false;
  if (b.end.line === a.start.line && b.end.character < a.start.character)
    return false;
  return true;
}

export function buildAutoFixEdit(
  document: TextDocumentLike,
  diag: Diagnostic,
): { title: string; edit: TextEdit } | undefined {
  const code = typeof diag.code === "string" ? diag.code : undefined;
  if (code === "missing-prop-prefix") {
    const rawAttr = document.getText(diag.range);
    if (!rawAttr || rawAttr.toLowerCase().startsWith("data-bascik-prop-")) {
      return undefined;
    }
    const newText = `data-bascik-prop-${rawAttr}`;
    return {
      title: `Prefix prop with data-bascik-prop- (${newText})`,
      edit: {
        range: diag.range,
        newText,
      },
    };
  }
  if (code === "prefer-self-closing-component") {
    const fullText = document.getText(diag.range);
    const match =
      /^<([A-Za-z][\w-]*)(\s+(?:[^>"']|"[^"]*"|'[^']*')*?)?>\s*<\/\1\s*>$/is.exec(
        fullText,
      );
    if (!match) return undefined;
    const tagName = match[1];
    const attrs = (match[2] ?? "").trimEnd();
    const newText = `<${tagName}${attrs} />`;
    return {
      title: `Convert <${tagName}> to self-closing tag`,
      edit: {
        range: diag.range,
        newText,
      },
    };
  }
  return undefined;
}

/** Where the "Wrap template in html`...`" fix applies (offsets in the document). */
interface WrapHtmlData {
  templateStart: number;
  fixable: boolean;
  bodyStart: number;
  bodyEnd: number;
}

const sameEdits = (action: CodeAction, wrap: { edits: TextEdit[] }): boolean =>
  JSON.stringify(Object.values(action.edit?.changes ?? {})[0]) ===
  JSON.stringify(wrap.edits);

/**
 * `body` with string contents, comments and template-literal text replaced
 * by spaces (offsets kept), and the code inside template holes kept.
 */
function codeOnly(body: string): string {
  const out = body.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++)
      if (out[k] !== "\n") out[k] = " ";
  };
  // A stack of open template literals; each entry is the brace depth of
  // the hole code that the template sits in.
  const holes: number[] = [];
  let depth = 0;
  let i = 0;
  const template = (from: number): void => {
    // Scan template text from `from` (just past ` or }) to the end or `${`.
    let k = from;
    while (k < body.length) {
      if (body[k] === "\\") k += 2;
      else if (body[k] === "`") {
        blank(from, k);
        i = k + 1;
        return;
      } else if (body[k] === "$" && body[k + 1] === "{") {
        blank(from, k);
        holes.push(depth);
        depth = 0;
        i = k + 2;
        return;
      } else k++;
    }
    blank(from, body.length);
    i = body.length;
  };
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      const end = nl === -1 ? body.length : nl;
      blank(i, end);
      i = end;
    } else if (c === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      const end = close === -1 ? body.length : close + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < body.length && body[k] !== c && body[k] !== "\n")
        k += body[k] === "\\" ? 2 : 1;
      blank(i + 1, k);
      i = k + 1;
    } else if (c === "`") template(i + 1);
    else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      if (depth === 0 && holes.length > 0) {
        depth = holes.pop()!;
        template(i + 1);
      } else {
        if (depth > 0) depth--;
        i++;
      }
    } else i++;
  }
  return out.join("");
}

/**
 * The quick fix for server-script-unescaped-markup: put `html` before the
 * template's backtick and import it from @bascik/bascik/html (after the
 * script's last import, or merged into an existing import from the module).
 * When the name html is already used in the script's code (a variable, a
 * parameter, another import), it imports `html as safeHtml` instead, so the
 * fix never tags with a binding that means something else; when safeHtml is
 * taken too, or a hole sits where html would throw, it is not offered.
 */
export function buildWrapHtmlEdits(
  document: TextDocumentLike,
  diag: Diagnostic,
): { title: string; edits: TextEdit[] } | undefined {
  if (diag.code !== "server-script-unescaped-markup") return undefined;
  const data = diag.data as WrapHtmlData | undefined;
  if (!data || !data.fixable) return undefined;
  const text = document.getText();
  const body = text.slice(data.bodyStart, data.bodyEnd);
  const at = (offset: number): Position =>
    document.positionAt(data.bodyStart + offset);
  const edits: TextEdit[] = [];

  const existing =
    /\bimport\s*\{([^}]*)\}\s*from\s*["']@bascik\/bascik\/html["']/.exec(body);
  // Identifiers in code only: strings, comments and template text blanked,
  // and the import from the module left out, so `<html>` or "html" is no
  // clash but a parameter, a variable or another import named html is.
  const code = codeOnly(
    existing
      ? body.slice(0, existing.index) +
          " ".repeat(existing[0].length) +
          body.slice((existing.index ?? 0) + existing[0].length)
      : body,
  );
  const word = (name: string): string =>
    `(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`;
  const uses = (name: string): boolean => new RegExp(word(name)).test(code);
  // An imported name is safe to tag with when it is only ever a tag or a
  // callee: anywhere else (a parameter, a variable, a function declaration)
  // it may be shadowed.
  const onlyTagOrCall = (name: string): boolean =>
    !new RegExp(`(?<!\\bfunction\\s*)${word(name)}(?!\\s*[\`(])`).test(code) &&
    !new RegExp(`\\bfunction\\s*${word(name)}`).test(code);
  const ALIAS = "safeHtml";
  let tag: string | undefined;
  let specifier: string | undefined;
  const entries = existing
    ? existing[1]
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : [];
  // Names that are not identifiers (a half-typed `html as h(`) bind nothing.
  const bound = entries
    .map(parseImportSpecifier)
    .filter((parts) => parts?.[0] === "html")
    .map((parts) => parts![1]);
  tag = bound.find(onlyTagOrCall);
  if (tag === undefined) {
    if (!bound.includes("html") && !uses("html")) {
      tag = "html";
      specifier = "html";
    } else if (!bound.includes(ALIAS) && !uses(ALIAS)) {
      tag = ALIAS;
      specifier = `html as ${ALIAS}`;
    } else return undefined;
  }

  if (specifier !== undefined && existing) {
    const open = (existing.index ?? 0) + existing[0].indexOf("{") + 1;
    const close = open + existing[1].length;
    edits.push({
      range: { start: at(open), end: at(close) },
      newText: ` ${[...entries, specifier].join(", ")} `,
    });
  } else if (specifier !== undefined) {
    const statement = `import { ${specifier} } from "@bascik/bascik/html";`;
    const imports = [
      ...body.matchAll(
        /^([ \t]*)import\b[^;]*?from\s*["'][^"']+["'][ \t]*;?[ \t]*$/gm,
      ),
    ];
    const last = imports[imports.length - 1];
    if (last) {
      const end = (last.index ?? 0) + last[0].length;
      edits.push({
        range: { start: at(end), end: at(end) },
        newText: `\n${last[1]}${statement}`,
      });
    } else {
      const first = /^([ \t]*)\S/m.exec(body);
      const lineStart = first?.index ?? 0;
      edits.push({
        range: { start: at(lineStart), end: at(lineStart) },
        newText: `${first?.[1] ?? ""}${statement}\n`,
      });
    }
  }
  const backtick = document.positionAt(data.templateStart);
  edits.push({ range: { start: backtick, end: backtick }, newText: tag });
  return { title: "Wrap template in html`...`", edits };
}

export function createCodeActions(
  document: TextDocumentLike,
  range: Range,
  diagnostics: Diagnostic[],
  snapshot?: ProjectSnapshot,
  fsPath?: string,
): CodeAction[] {
  const activeDiagnostics =
    diagnostics.length > 0
      ? diagnostics
      : fsPath
        ? createDiagnostics(document, fsPath, snapshot)
        : [];
  const actions: CodeAction[] = [];

  for (const diag of activeDiagnostics) {
    if (!rangesOverlap(diag.range, range)) continue;
    // Editor only: wrapping changes the value from a string to SafeHtml, so
    // `bascik --check --fix` (applyAutoFixes) never applies it.
    const wrap = buildWrapHtmlEdits(document, diag);
    if (wrap) {
      if (actions.some((a) => a.title === wrap.title && sameEdits(a, wrap)))
        continue;
      actions.push({
        title: wrap.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        isPreferred: true,
        edit: { changes: { [document.uri]: wrap.edits } },
      });
      continue;
    }
    const fix = buildAutoFixEdit(document, diag);
    if (!fix) continue;
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diag],
      isPreferred: true,
      edit: {
        changes: {
          [document.uri]: [fix.edit],
        },
      },
    });
  }

  return actions;
}

export function applyAutoFixes(
  document: TextDocumentLike,
  snapshot: ProjectSnapshot | undefined,
  fsPath = "/virtual.html",
): { text: string; fixedCount: number } {
  const diags = createDiagnostics(document, fsPath, snapshot);
  const edits: Array<{
    startOffset: number;
    endOffset: number;
    newText: string;
  }> = [];

  for (const diag of diags) {
    const fix = buildAutoFixEdit(document, diag);
    if (!fix) continue;
    const startOffset = document.offsetAt(fix.edit.range.start);
    const endOffset = document.offsetAt(fix.edit.range.end);
    edits.push({ startOffset, endOffset, newText: fix.edit.newText });
  }

  if (edits.length === 0) {
    return { text: document.getText(), fixedCount: 0 };
  }

  edits.sort((a, b) => b.startOffset - a.startOffset);
  let text = document.getText();
  let fixedCount = 0;
  let lastStart = Number.POSITIVE_INFINITY;

  for (const edit of edits) {
    if (edit.endOffset > lastStart) continue;
    text =
      text.slice(0, edit.startOffset) +
      edit.newText +
      text.slice(edit.endOffset);
    lastStart = edit.startOffset;
    fixedCount++;
  }

  return { text, fixedCount };
}
