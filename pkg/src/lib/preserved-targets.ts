/**
 * Finds component CSS and client-script selectors that can only target elements Bascik keeps unscoped.
 *
 * `scoping.preserve` tags (and everything inside them) and `data-bascik-preserve` elements (and their
 * descendants) keep their literal `class` and `id`, while Bascik still renames the component's selectors: a
 * class `.inline` becomes a per-component class, an id `#snippet` and a tag `code` become generated classes
 * that only scoped elements receive. A selector naming a class, id, or tag that only preserved elements carry
 * therefore never matches, and a client-script class query Bascik rewrites finds nothing.
 *
 * Shared byte-for-byte by the compiler (`pkg/src/lib/preserved-targets.ts`) and the language server
 * (`lsp/src/preserved-targets.ts`); a test keeps the copies identical. No imports, so either package can hold
 * it. Every scan is a single forward pass with `indexOf` jumps, so unclosed quotes, comments, or tags stay
 * linear.
 */

/** What only preserved elements carry: a selector naming one of these never matches after scoping. */
export interface PreservedTargets {
  classes: ReadonlySet<string>;
  ids: ReadonlySet<string>;
  /** Lowercase tag names. */
  tags: ReadonlySet<string>;
}

export interface PreservedTargetMatch {
  /** Offset of the selector part (`.inline`, `#snippet`, `code`) in the scanned text. */
  index: number;
  length: number;
  /** The class, id, or tag name, without its `.` or `#`. */
  target: string;
  kind: "class" | "id" | "tag";
  message: string;
  suggestion: string;
}

const ID = 1;
const CLASS = 2;
const NAME = 4;
const ALL = ID | CLASS | NAME;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const WILDCARD_TAG = /^[a-zA-Z*][a-zA-Z0-9*-]*$/;
const ATTRIBUTE =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Matchers for the valid `scoping.preserve` entries: exact tag names, or `*` patterns such as `vendor-*`. */
const preserveMatchers = (preserve: readonly string[]): RegExp[] =>
  preserve
    .map((entry) => String(entry).trim())
    .filter(
      (entry) =>
        TAG_NAME.test(entry) ||
        (entry.includes("*") && WILDCARD_TAG.test(entry)),
    )
    .map(
      (entry) =>
        // Every regex metacharacter is escaped (the filter above already
        // keeps the entries to tag-name characters), then `*` opens a run.
        new RegExp(
          `^${entry
            .toLowerCase()
            .replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")
            .replace(/\\\*/g, "[a-z0-9-]*")}$`,
        ),
    );

/** The attributes a `data-bascik-preserve` value keeps: all of them when bare or empty. */
const directiveBits = (value: string | undefined): number => {
  const tokens = (value ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ALL;
  let bits = 0;
  for (const token of tokens) {
    if (token === "id") bits |= ID;
    else if (token === "class") bits |= CLASS;
    else if (token === "name") bits |= NAME;
  }
  return bits;
};

/** The offset just past the `>` closing a start tag that begins at `from`, honoring quotes; -1 when unclosed. */
/**
 * The index of `</name` at or after `from`, in any ASCII case, or -1. `name` is lowercase letters. Tag names are
 * compared in place, as an HTML parser compares them: a lowercased copy of the markup can be longer than it ("İ"
 * becomes two characters), so an index found there points past the real end tag.
 */
const findEndTag = (markup: string, name: string, from: number): number => {
  for (
    let at = markup.indexOf("</", from);
    at !== -1;
    at = markup.indexOf("</", at + 2)
  ) {
    let k = 0;
    while (
      k < name.length &&
      (markup.charCodeAt(at + 2 + k) | 0x20) === name.charCodeAt(k)
    )
      k++;
    if (k === name.length) return at;
  }
  return -1;
};

const startTagEnd = (markup: string, from: number): number => {
  let quote = "";
  for (let i = from; i < markup.length; i++) {
    const ch = markup[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return -1;
};

/**
 * Walks a component's markup and returns the classes, ids, and tags that appear only on preserved elements.
 * Comments and the contents of `<script>`, `<style>`, `<textarea>`, and `<title>` are skipped.
 */
export const collectPreservedTargets = (
  markup: string,
  preserve: readonly string[],
): PreservedTargets => {
  const matchers = preserveMatchers(preserve);
  const stack: { name: string; bits: number }[] = [];
  const preserved = {
    classes: new Set<string>(),
    ids: new Set<string>(),
    tags: new Set<string>(),
  };
  const scoped = {
    classes: new Set<string>(),
    ids: new Set<string>(),
    tags: new Set<string>(),
  };

  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf("<", i);
    if (lt === -1) break;
    if (markup.startsWith("<!--", lt)) {
      const end = markup.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const close = markup[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(
      markup.slice(lt + (close ? 2 : 1), lt + (close ? 2 : 1) + 128),
    );
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const end = startTagEnd(markup, lt + nameMatch[0].length + 1);
    if (end === -1) break;
    i = end;
    if (close) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const attributeText = markup.slice(
      lt + 1 + nameMatch[0].length,
      markup[end - 2] === "/" ? end - 2 : end - 1,
    );
    let classValue: string | undefined;
    let idValue: string | undefined;
    let directive: string | undefined;
    let hasDirective = false;
    for (const attribute of attributeText.matchAll(ATTRIBUTE)) {
      const attributeName = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      if (attributeName === "class") classValue ??= value ?? "";
      else if (attributeName === "id") idValue ??= value ?? "";
      else if (attributeName === "data-bascik-preserve" && !hasDirective) {
        hasDirective = true;
        directive = value;
      }
    }

    let bits = stack.length > 0 ? stack[stack.length - 1].bits : 0;
    if (matchers.some((matcher) => matcher.test(name))) bits = ALL;
    if (hasDirective) bits |= directiveBits(directive);

    const classTarget = bits & CLASS ? preserved : scoped;
    for (const className of (classValue ?? "").split(/\s+/)) {
      if (className) classTarget.classes.add(className);
    }
    if (idValue) (bits & ID ? preserved : scoped).ids.add(idValue);
    // A tag selector becomes a generated class added through the class attribute, so a preserved class is a
    // preserved tag.
    classTarget.tags.add(name);

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const rawEnd = findEndTag(markup, name, end);
      i = rawEnd === -1 ? markup.length : rawEnd;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || markup[end - 2] === "/") continue;
    stack.push({ name, bits });
  }

  const only = (a: Set<string>, b: Set<string>) =>
    new Set([...a].filter((value) => !b.has(value)));
  return {
    classes: only(preserved.classes, scoped.classes),
    ids: only(preserved.ids, scoped.ids),
    tags: only(preserved.tags, scoped.tags),
  };
};

/** Replaces comments and strings with same-length spaces (line breaks kept), so offsets stay valid. */
const maskCommentsAndStrings = (css: string): string => {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += blank(css.slice(i, stop));
      i = stop;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== "\n") {
        j += css[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, css.length);
      out += blank(css.slice(i, stop));
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
};

/**
 * Replaces bracketed runs (attribute selectors) with spaces, and parenthesized runs (pseudo-class arguments)
 * too unless `keepParentheses` is set.
 */
const maskGroups = (selector: string, keepParentheses = false): string => {
  let depth = 0;
  let out = "";
  for (const ch of selector) {
    const parenthesis = ch === "(" || ch === ")";
    if (keepParentheses && parenthesis) {
      out += depth > 0 ? " " : ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    out += depth > 0 ? " " : ch;
    if ((ch === ")" || ch === "]") && depth > 0) depth--;
  }
  return out;
};

const SELECTOR_PART = /(::?|[.#])?(-?[_a-zA-Z][\w-]*)/g;

/** Every class, id, and tag part of a style rule's selector list, with its offset in the stylesheet. */
function* selectorParts(
  css: string,
  keepParentheses = false,
): Generator<{
  index: number;
  length: number;
  kind: "class" | "id" | "tag";
  name: string;
}> {
  const masked = maskCommentsAndStrings(css);
  // Whether each open block is inside `@keyframes`, whose preludes (`from`, `50%`) are not selectors.
  const blocks: boolean[] = [];
  let preludeStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      const prelude = masked.slice(preludeStart, i);
      const trimmed = prelude.trimStart();
      if (blocks.length > 0 && blocks[blocks.length - 1]) {
        blocks.push(true);
      } else if (trimmed.startsWith("@")) {
        blocks.push(/^@(?:-[a-z]+-)?keyframes\b/i.test(trimmed));
      } else {
        blocks.push(false);
        const grouped = maskGroups(prelude, keepParentheses);
        for (const part of grouped.matchAll(SELECTOR_PART)) {
          const prefix = part[1];
          if (prefix === ":" || prefix === "::") continue;
          if (grouped[part.index + part[0].length] === "\\") continue;
          if (part.index > 0 && grouped[part.index - 1] === "\\") continue;
          yield {
            index: preludeStart + part.index,
            length: part[0].length,
            kind: prefix === "." ? "class" : prefix === "#" ? "id" : "tag",
            name: prefix ? part[2] : part[2].toLowerCase(),
          };
        }
      }
      preludeStart = i + 1;
    } else if (ch === "}") {
      blocks.pop();
      preludeStart = i + 1;
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
  }
}

const CSS_SUGGESTION =
  "Move the rule to a global stylesheet, or take the element out of scoping.preserve or its data-bascik-preserve directive.";
const JS_SUGGESTION =
  "Query the element by a data-* attribute, or take it out of scoping.preserve or its data-bascik-preserve directive.";

/**
 * The class names a component's stylesheet names, `:is()` and `:where()` arguments included: the classes
 * Bascik scopes, and so rewrites in the component's class queries.
 */
export const collectCssClasses = (css: string): Set<string> => {
  const classes = new Set<string>();
  for (const part of selectorParts(css, true)) {
    if (part.kind === "class") classes.add(part.name);
  }
  return classes;
};

/** Style-rule selector parts in `css` that name a class, id, or tag only preserved elements carry. */
export const findPreservedCssTargets = (
  css: string,
  targets: PreservedTargets,
): PreservedTargetMatch[] => {
  const matches: PreservedTargetMatch[] = [];
  for (const part of selectorParts(css)) {
    const set =
      part.kind === "class"
        ? targets.classes
        : part.kind === "id"
          ? targets.ids
          : targets.tags;
    if (!set.has(part.name)) continue;
    const written = css.slice(part.index, part.index + part.length);
    const what =
      part.kind === "tag"
        ? `every <${part.name}> here is preserved`
        : `only preserved elements carry ${part.kind === "class" ? "this class" : "this id"}`;
    matches.push({
      index: part.index,
      length: part.length,
      target: part.name,
      kind: part.kind,
      message: `"${written}" never matches: ${what}, and preserved elements keep their literal class and id while Bascik rewrites this selector to a scoped name.`,
      suggestion: CSS_SUGGESTION,
    });
  }
  return matches;
};

const DOM_QUERY =
  /\b(querySelectorAll|querySelector|closest|matches|getElementsByClassName)\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)/g;

/**
 * Class queries in client-script code that Bascik rewrites (the class is in `cssClasses`, the component's
 * stylesheet classes) but that only preserved elements carry, so the rewritten query finds nothing. Id and tag
 * queries are not rewritten, so they still work.
 */
export const findPreservedJsTargets = (
  js: string,
  targets: PreservedTargets,
  cssClasses: ReadonlySet<string>,
): PreservedTargetMatch[] => {
  const matches: PreservedTargetMatch[] = [];
  for (const query of js.matchAll(DOM_QUERY)) {
    const value = query[2] ?? query[3] ?? query[4] ?? "";
    const valueStart = query.index + query[0].length - value.length - 1;
    const parts: { offset: number; written: string; name: string }[] = [];
    if (query[1] === "getElementsByClassName") {
      for (const token of value.matchAll(/\S+/g)) {
        parts.push({ offset: token.index, written: token[0], name: token[0] });
      }
    } else {
      for (const part of maskGroups(value).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        parts.push({ offset: part.index, written: part[0], name: part[1] });
      }
    }
    for (const part of parts) {
      if (!targets.classes.has(part.name) || !cssClasses.has(part.name))
        continue;
      matches.push({
        index: valueStart + part.offset,
        length: part.written.length,
        target: part.name,
        kind: "class",
        message: `${query[1]}("${value}") finds nothing for "${part.written}": only preserved elements carry the class, and they keep it literally while Bascik rewrites this query to the scoped name.`,
        suggestion: JS_SUGGESTION,
      });
    }
  }
  return matches;
};
