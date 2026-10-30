import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Location, Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  findCommentEnd,
  findComponentUsages,
  maskLikeCompiler,
} from "./component-usages.js";
import {
  isInsideComponentRoots,
  normalizeComponentName,
  type ProjectSnapshot,
} from "./project.js";

export { findCommentEnd };

/** One tag the compiler would read as a tag: outside comments, attribute values and raw-text bodies. */
export interface HtmlTag {
  /** The tag name as written. */
  name: string;
  closing: boolean;
  /** Offset of the `<`. */
  start: number;
  /** Offset of the first character of the name. */
  nameStart: number;
  /** Offset just past the closing `>`. */
  end: number;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "textarea"]);

const isTagNameStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isTagNameChar = (code: number): boolean =>
  isTagNameStart(code) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 45;
const isTagNameEnd = (code: number): boolean =>
  Number.isNaN(code) ||
  code === 9 ||
  code === 10 ||
  code === 12 ||
  code === 13 ||
  code === 32 ||
  code === 47 /* / */ ||
  code === 62; /* > */

/**
 * The tags of an HTML source in order, as a reader sees them: a comment, an attribute value, or the body of
 * a `<script>`, `<style>` or `<textarea>` hides any tag text inside it, and a comment with no end hides
 * nothing. Literal tags inside `<pre>`, `<code>` and `<template>` are tags. It places the cursor on a closing
 * tag and finds a component's root element; which opening tags are usages is decided by
 * `findComponentUsages`, which follows the compiler exactly. Linear time: the end of a tag body depends only
 * on where its scan starts, so it is remembered per position.
 */
export function scanHtmlTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  const length = html.length;
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
      const code = html.charCodeAt(position);
      if (code === 62 /* > */) {
        end = position + 1;
        break;
      }
      if (code === 34 /* " */ || code === 39 /* ' */) {
        const close = html.indexOf(html[position], position + 1);
        if (close < 0) break;
        position = close + 1;
        continue;
      }
      position++;
    }
    for (const index of visited) tagEndFrom[index] = end;
    return end;
  };
  // Where each raw-text closer was last found, so a run of unclosed openers does not rescan the rest.
  const closerSearch = new Map<string, { from: number; at: number }>();
  const findCloser = (name: string, from: number): number => {
    const known = closerSearch.get(name);
    if (known && known.from <= from && (known.at < 0 || known.at >= from))
      return known.at;
    const pattern = new RegExp(`</${name}\\s*>`, "gi");
    pattern.lastIndex = from;
    const match = pattern.exec(html);
    const at = match ? match.index : -1;
    closerSearch.set(name, { from, at });
    return at;
  };

  // After a comment with no end, no later comment can end either, so none is looked for.
  let comments = true;
  let cursor = 0;
  while (cursor < length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) break;
    if (comments && html.startsWith("<!--", open)) {
      const end = findCommentEnd(html, open);
      if (end < 0) comments = false;
      cursor = end < 0 ? open + 4 : end;
      continue;
    }
    const closing = html.charCodeAt(open + 1) === 47; /* / */
    const nameStart = open + (closing ? 2 : 1);
    if (!isTagNameStart(html.charCodeAt(nameStart))) {
      cursor = open + 1;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < length && isTagNameChar(html.charCodeAt(nameEnd)))
      nameEnd++;
    const end = findTagEnd(nameEnd);
    if (end < 0 || !isTagNameEnd(html.charCodeAt(nameEnd))) {
      cursor = open + 1;
      continue;
    }
    const name = html.slice(nameStart, nameEnd);
    tags.push({ name, closing, start: open, nameStart, end });
    cursor = end;
    const lower = name.toLowerCase();
    if (
      !closing &&
      RAW_TEXT_TAGS.has(lower) &&
      !/\/\s*>$/.test(html.slice(open, end))
    ) {
      const closer = findCloser(lower, end);
      if (closer >= 0) cursor = closer;
    }
  }
  return tags;
}

/** The leading `<!-- @bascik` doc comment's `[start, end)`, when the file starts with one. */
function findDocComment(html: string): [number, number] | undefined {
  const start = html.search(/\S/);
  if (start < 0 || !html.startsWith("<!--", start)) return undefined;
  if (!/^<!--\s*@bascik(?:\s|-->|$)/.test(html.slice(start, start + 64)))
    return undefined;
  const end = findCommentEnd(html, start);
  return [start, end < 0 ? html.length : end];
}

/** Elements that may sit ahead of a component's root element without being it. */
const NON_ROOT_TAGS = new Set(["script", "style", "link", "meta"]);

export interface ReferencesRequest {
  /** The requesting document, with its unsaved text. */
  document: TextDocument;
  fsPath: string;
  position: Position;
  includeDeclaration: boolean;
  snapshot: ProjectSnapshot;
  /** The text of every HTML file that can use a component, keyed by absolute path, unsaved buffers included. */
  sources: Map<string, string>;
}

const normalize = (fsPath: string): string =>
  path.resolve(fsPath).replace(/\\/g, "/");

/** Is `fsPath` the file that defines a component, and which one? */
export function componentNameForFile(
  fsPath: string,
  snapshot: ProjectSnapshot,
): string | undefined {
  if (!isInsideComponentRoots(normalize(fsPath), snapshot.componentRoots))
    return undefined;
  const name = normalizeComponentName(fsPath);
  const defined = snapshot.componentMap.get(name);
  return defined && normalize(defined) === normalize(fsPath) ? name : undefined;
}

/** The component a references request at `offset` asks about, or undefined. */
export function resolveReferencedComponent(
  text: string,
  offset: number,
  fsPath: string,
  snapshot: ProjectSnapshot,
): string | undefined {
  const tags = scanHtmlTags(text);
  // (a) A component tag name, opening or closing, wins wherever it is. An opening tag counts where the
  // compiler expands it; a closing tag counts outside what the compiler masks.
  const masked = maskLikeCompiler(text);
  const opening = findComponentUsages(
    text,
    new Set(snapshot.componentMap.keys()),
    masked,
  ).find((usage) => offset >= usage.nameStart && offset <= usage.nameEnd);
  if (opening) return opening.name;
  const closing = tags.find(
    (tag) =>
      tag.closing &&
      offset >= tag.nameStart &&
      offset <= tag.nameStart + tag.name.length &&
      masked.startsWith(tag.name, tag.nameStart),
  );
  if (closing) {
    const name = closing.name.toLowerCase();
    if (snapshot.componentMap.has(name)) return name;
  }
  // (b) A line of the component's own file that identifies it.
  const ownName = componentNameForFile(fsPath, snapshot);
  if (!ownName) return undefined;
  const lineOf = (at: number): number => {
    let line = 0;
    for (
      let i = text.indexOf("\n");
      i >= 0 && i < at;
      i = text.indexOf("\n", i + 1)
    )
      line++;
    return line;
  };
  const cursorLine = lineOf(offset);
  if (cursorLine === 0) return ownName;
  const docComment = findDocComment(text);
  if (docComment && offset >= docComment[0] && offset <= docComment[1])
    return ownName;
  const root = tags.find(
    (tag) => !tag.closing && !NON_ROOT_TAGS.has(tag.name.toLowerCase()),
  );
  if (
    root &&
    cursorLine >= lineOf(root.start) &&
    cursorLine <= lineOf(root.end - 1)
  )
    return ownName;
  return undefined;
}

/**
 * Find All References for a component: one Location per opening tag that uses it, spanning the tag name,
 * pages first, then component files, each by path and then position. With `includeDeclaration`, the
 * component file's first line comes first. Anything that does not resolve to a component is an empty list.
 */
export function createReferences(request: ReferencesRequest): Location[] {
  const { document, fsPath, position, snapshot, sources } = request;
  if (document.languageId !== "html" || !fsPath.toLowerCase().endsWith(".html"))
    return [];
  const name = resolveReferencedComponent(
    document.getText(),
    document.offsetAt(position),
    fsPath,
    snapshot,
  );
  if (!name) return [];
  const componentPath = snapshot.componentMap.get(name);
  if (!componentPath) return [];

  const found: { file: string; isComponent: boolean; locations: Location[] }[] =
    [];
  const names = new Set(snapshot.componentMap.keys());
  for (const [file, text] of sources) {
    const usages = findComponentUsages(text, names).filter(
      (usage) => usage.name === name,
    );
    if (usages.length === 0) continue;
    const lines = TextDocument.create("file:///", "html", 0, text);
    const uri = pathToFileURL(file).toString();
    found.push({
      file: normalize(file),
      isComponent: isInsideComponentRoots(
        normalize(file),
        snapshot.componentRoots,
      ),
      locations: usages.map((usage) => ({
        uri,
        range: {
          start: lines.positionAt(usage.nameStart),
          end: lines.positionAt(usage.nameEnd),
        },
      })),
    });
  }
  found.sort((left, right) =>
    left.isComponent !== right.isComponent
      ? left.isComponent
        ? 1
        : -1
      : left.file < right.file
        ? -1
        : left.file > right.file
          ? 1
          : 0,
  );
  const locations = found.flatMap((entry) => entry.locations);
  if (!request.includeDeclaration) return locations;

  const declarationText = sources.get(componentPath) ?? "";
  const firstLineEnd = declarationText.search(/\r?\n|\r|$/);
  return [
    {
      uri: pathToFileURL(componentPath).toString(),
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: Math.max(0, firstLineEnd) },
      },
    },
    ...locations,
  ];
}
