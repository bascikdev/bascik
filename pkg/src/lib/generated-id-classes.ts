/**
 * @module generated-id-classes
 *
 * The site-wide check that no two components generate the same `#id` class.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An `#id { }` rule in component `<comp>` compiles to the class
 * `b_id_<comp>_<id>` (`idSelectorClassName` in `styles.ts`), hashed under
 * `minify.identifiers` as a function of that readable string. Component names
 * and ids can both contain `_`, so two different pairs can spell one name:
 * `site-nav_x` with `#btn` and `site-nav` with `#x_btn` both give
 * `b_id_site-nav_x_btn`, and the two rules would style each other's elements.
 * Comparing the readable names is exact and covers the hash too.
 *
 * The check reads each component's stylesheet once, on the main thread, from
 * the list `listComponents` builds: a component's `#id` rules are the same on
 * every page, so it runs once per component list, not per page or instance.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  collectDeclaredIds,
  rewriteIdReferencesInCss,
} from "./id-references.ts";
import {
  cssIdSelectorNames,
  cssIdSelectorOffset,
  readableIdSelectorClassName,
} from "./styles.ts";
import type { ComponentList } from "./types.ts";

/** One `#id` rule and the component it is in. */
export interface GeneratedIdClassOrigin {
  component: string;
  idName: string;
  /** The component's markup file, as `listComponents` read it. */
  fileName: string;
}

/** Two different (component, id) pairs that generate one class. */
export interface GeneratedIdClassCollision {
  /** The readable generated class both pairs produce. */
  className: string;
  first: GeneratedIdClassOrigin;
  second: GeneratedIdClassOrigin;
}

/** Where an `#id` rule is, for the error message. */
export interface GeneratedIdClassLocation {
  filePath: string;
  line?: number;
  column?: number;
}

/**
 * True when every generated class of `component` carries its instance id
 * (`b_id_<name>__<instanceId>_<id>`), so it never generates the shared name.
 * That happens when the stylesheet references one of the component's own ids
 * with `url(#id)` (scoped per instance by the id pass), as in `javascript.ts`.
 */
const usesPerInstanceCss = (css: string, fileContent: string): boolean => {
  if (!BascikConfig.scoping?.attributes?.id || !/url\(/i.test(css))
    return false;
  const declared = collectDeclaredIds(fileContent);
  if (declared.size === 0) return false;
  return (
    rewriteIdReferencesInCss(css, (id) =>
      declared.has(id) ? `${id}\u0000` : null,
    ) !== css
  );
};

/**
 * Every pair of components whose `#id` rules generate the same class, in
 * component name order. A component that names the same id in several rules, or a
 * component used on many pages, is one origin: only a different
 * (component, id) pair is a collision.
 */
export const findGeneratedIdClassCollisions = (
  components: ComponentList,
): GeneratedIdClassCollision[] => {
  const scoping = BascikConfig.scoping;
  // No class pass, no generated classes; without deduplication every class
  // carries the instance id, so no shared name is generated.
  if (scoping?.attributes?.class === false || scoping?.deduplicateCss === false)
    return [];
  const origins = new Map<string, GeneratedIdClassOrigin>();
  const collisions: GeneratedIdClassCollision[] = [];
  // Sorted, so the first of a pair is the same on every file system.
  const entries = Object.entries(components).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [component, entry] of entries) {
    const css = entry.cssFileContent;
    if (!css || !entry.fileContent || !entry.fileName) continue;
    const idNames = cssIdSelectorNames(css);
    if (idNames.length === 0) continue;
    if (usesPerInstanceCss(css, entry.fileContent)) continue;
    for (const idName of idNames) {
      const className = readableIdSelectorClassName(component, idName);
      const origin = { component, idName, fileName: entry.fileName };
      const existing = origins.get(className);
      if (!existing) origins.set(className, origin);
      else if (existing.component !== component)
        collisions.push({ className, first: existing, second: origin });
    }
  }
  return collisions;
};

const displayPath = (filePath: string, cwd: string): string => {
  const absolute = resolve(cwd, filePath);
  const rel = relative(cwd, absolute);
  return (rel && !rel.startsWith("..") ? rel : absolute).replace(/\\/g, "/");
};

const lineAndColumn = (
  text: string,
  offset: number,
): { line: number; column: number } => {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    const code = text.charCodeAt(i);
    // CRLF counts once: the CR starts the break, the LF ends it.
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
};

/**
 * The index of `tag` (`<` and lowercase ASCII, such as `</style`) at or after `from` in `html`, in any ASCII case,
 * or -1. Compared in place: a lowercased copy of `html` can be longer than it ("İ" becomes two characters), so an
 * index found there points past the text it names.
 */
const indexOfTag = (html: string, tag: string, from: number): number => {
  for (
    let at = html.indexOf("<", from);
    at !== -1;
    at = html.indexOf("<", at + 1)
  ) {
    let k = 1;
    for (; k < tag.length; k++) {
      const code = html.charCodeAt(at + k);
      const wanted = tag.charCodeAt(k);
      // A lowercase letter also matches its uppercase; anything else only itself.
      if (
        code !== wanted &&
        !(wanted >= 97 && wanted <= 122 && code === wanted - 32)
      )
        break;
    }
    if (k === tag.length) return at;
  }
  return -1;
};

/** The offset of the first `#id` rule naming `idName` inside a `<style>` element of `html`, or -1. */
const styleElementOffset = (html: string, idName: string): number => {
  let from = 0;
  for (;;) {
    const open = indexOfTag(html, "<style", from);
    if (open === -1) return -1;
    const contentStart = html.indexOf(">", open);
    if (contentStart === -1) return -1;
    const close = indexOfTag(html, "</style", contentStart);
    const contentEnd = close === -1 ? html.length : close;
    const offset = cssIdSelectorOffset(
      html.slice(contentStart + 1, contentEnd),
      idName,
    );
    if (offset !== -1) return contentStart + 1 + offset;
    if (close === -1) return -1;
    from = close + 1;
  }
};

/**
 * Where the `#id` rule of `origin` is: the paired `.css` file first, then a
 * `<style>` element of the markup file. A rule from an `@import`ed stylesheet
 * is reported at the component's own file, without a line.
 */
export const locateGeneratedIdClassOrigin = async (
  origin: GeneratedIdClassOrigin,
  cwd = process.cwd(),
): Promise<GeneratedIdClassLocation> => {
  const markupPath = resolve(cwd, origin.fileName);
  const cssPath = markupPath.replace(/\.html$/i, ".css");
  const candidates: Array<{ path: string; find: (text: string) => number }> =
    [];
  if (cssPath !== markupPath && existsSync(cssPath))
    candidates.push({
      path: cssPath,
      find: (text) => cssIdSelectorOffset(text, origin.idName),
    });
  candidates.push({
    path: markupPath,
    find: (text) => styleElementOffset(text, origin.idName),
  });
  for (const { path, find } of candidates) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const offset = find(text);
    if (offset !== -1)
      return {
        filePath: displayPath(path, cwd),
        ...lineAndColumn(text, offset),
      };
  }
  return { filePath: displayPath(origin.fileName, cwd) };
};

const formatLocation = (location: GeneratedIdClassLocation): string =>
  location.line === undefined
    ? location.filePath
    : `${location.filePath}:${location.line}:${location.column}`;

/** One collision and where both of its rules are. */
export interface LocatedGeneratedIdClassCollision extends GeneratedIdClassCollision {
  firstLocation: GeneratedIdClassLocation;
  secondLocation: GeneratedIdClassLocation;
}

/**
 * Two components' `#id` rules generate one class. Thrown by `listComponents`,
 * so a build, the dev server (through its error overlay) and `bascik --check`
 * all stop on it with the same message.
 */
export class GeneratedIdClassCollisionError extends Error {
  readonly collisions: LocatedGeneratedIdClassCollision[];

  constructor(collisions: LocatedGeneratedIdClassCollision[]) {
    super(collisions.map(formatGeneratedIdClassCollision).join("\n\n"));
    this.collisions = collisions;
  }
}

/**
 * The message for one collision, in the shape of the duplicate tag error.
 * `b_id_A_a` equals `b_id_B_b` with `A` shorter only when `B` is `A_X` and
 * `a` is `X_b`, so the shorter component's id and the longer component's
 * name each hold the underscore: the fix renames one of those.
 */
export const formatGeneratedIdClassCollision = ({
  className,
  first,
  second,
  firstLocation,
  secondLocation,
}: LocatedGeneratedIdClassCollision): string => {
  const [short, long] =
    first.component.length <= second.component.length
      ? [first, second]
      : [second, first];
  return (
    `error: <${first.component}> #${first.idName} and <${second.component}> #${second.idName} both generate the class ${className}\n` +
    `  ${formatLocation(firstLocation)}  #${first.idName} in <${first.component}>\n` +
    `  ${formatLocation(secondLocation)}  #${second.idName} in <${second.component}>\n` +
    `  An #id rule becomes the class b_id_<component>_<id>, so an underscore in a component\n` +
    `  name or an id lets two pairs spell the same class, and each rule would style the other\n` +
    `  component's element (with minify.identifiers too, since the hash is of this name).\n` +
    `  Rename #${short.idName} in <${short.component}> (for example #${short.idName.replace(/_/g, "-")}),\n` +
    `  or rename <${long.component}> with hyphens (for example ${long.component.replace(/_/g, "-")}.html).`
  );
};

/**
 * Throw a `GeneratedIdClassCollisionError` naming every collision in
 * `components`, with the file and line of each rule. Does nothing (and reads
 * no file) when there is none.
 */
export const assertNoGeneratedIdClassCollisions = async (
  components: ComponentList,
  cwd = process.cwd(),
): Promise<void> => {
  const collisions = findGeneratedIdClassCollisions(components);
  if (collisions.length === 0) return;
  const located = await Promise.all(
    collisions.map(async (collision) => ({
      ...collision,
      firstLocation: await locateGeneratedIdClassOrigin(collision.first, cwd),
      secondLocation: await locateGeneratedIdClassOrigin(collision.second, cwd),
    })),
  );
  throw new GeneratedIdClassCollisionError(located);
};
