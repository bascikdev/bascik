/**
 * `scoping.preserve` entries with `*` (`vendor-*`, `*-widget`, `a*b`,
 * `**`), fuzzed against slow reference implementations: what each element
 * scan and each preserved tag hides must be exactly what the reference
 * hides. The references are written for clarity, not speed: a glob matcher
 * that walks characters (no RegExp), the tag pattern Bascik used before its
 * linear scans, and the element-content regex the scans replace.
 *
 * A "view" shows what a shield hid: every token is replaced by «what it
 * restores to», so two views are equal exactly when the same (outermost)
 * spans were hidden, whatever the tokens are numbered.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  maskElementContents,
  shieldElementContents,
  shieldPreservedAttribute,
} from "./shielding.ts";

type Attribute = "id" | "name" | "class";
const PRESERVABLE: readonly Attribute[] = ["id", "name", "class"];

/** Whether `name` matches `glob`, where `*` is any run of `[a-zA-Z0-9-]`. Case-insensitive. */
const globMatches = (glob: string, name: string): boolean => {
  const pattern = glob.toLowerCase();
  const text = name.toLowerCase();
  const isStarChar = (char: string): boolean => /^[a-z0-9-]$/.test(char);
  // matches[i][j]: pattern from i matches text from j.
  const memo = new Map<string, boolean>();
  const from = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === pattern.length) result = j === text.length;
    else if (pattern[i] === "*")
      result =
        from(i + 1, j) ||
        (j < text.length && isStarChar(text[j]) && from(i, j + 1));
    else
      result = j < text.length && pattern[i] === text[j] && from(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return from(0, 0);
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The element-content regex for `entry`, as the scans document it. */
const contentRegex = (entry: string, closerWhitespace: boolean): RegExp => {
  const fragment = entry
    .toLowerCase()
    .split("*")
    .map(escapeRegExp)
    .join("[a-zA-Z0-9-]*");
  const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
  return new RegExp(
    `(<${fragment}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${fragment}${closerWhitespace ? "\\s*" : ""}>)`,
    "gi",
  );
};

const referenceMask = (html: string, tags: string[]): string => {
  let result = html;
  for (const tag of tags)
    result = result.replace(
      contentRegex(tag, true),
      (_match, open: string, inner: string, close: string) =>
        `${open}${" ".repeat(inner.length)}${close}`,
    );
  return result;
};

/**
 * The reference shield's view: the hidden content wrapped in «». What one
 * entry hides is out of sight for the next (an opaque placeholder, as a
 * shield token is), so a closer inside it no longer closes anything.
 */
const referenceShieldView = (html: string, tags: string[]): string => {
  const hidden: string[] = [];
  let result = html;
  for (const tag of tags)
    result = result.replace(
      contentRegex(tag, false),
      (_match, open: string, inner: string, close: string) => {
        hidden.push(inner);
        return `${open}\x01${hidden.length - 1}\x01${close}`;
      },
    );
  const expand = (value: string): string =>
    value.replace(
      /\x01(\d+)\x01/g,
      (_match, index: string) => `«${expand(hidden[Number(index)])}»`,
    );
  return expand(result);
};

const TOKEN = /\x00BASCIK_SHIELD_\d+\x00/g;

/**
 * A shield's output with each token shown as «what it restores to». A token
 * whose value holds other tokens restores them too, so only the outermost
 * hidden spans are marked; `outermost` reduces a reference view to the same.
 */
const viewOf = (html: string, restore: (value: string) => string): string =>
  html.replace(TOKEN, (token) => `«${restore(token)}»`);

const outermost = (view: string): string => {
  let depth = 0;
  let result = "";
  for (const char of view) {
    if (char === "«") {
      if (depth++ === 0) result += char;
    } else if (char === "»") {
      if (--depth === 0) result += char;
    } else result += char;
  }
  return result;
};

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
const VOID =
  /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;

const directiveTokens = (tag: string): Set<Attribute> | null => {
  const match = tag.match(
    /\sdata-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?(?=\s|\/?>)/i,
  );
  if (!match) return null;
  const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  if (match[1] === undefined || value === "") return new Set(PRESERVABLE);
  return new Set(
    value
      .split(/\s+/)
      .filter((token): token is Attribute =>
        (PRESERVABLE as readonly string[]).includes(token),
      ),
  );
};

/**
 * What `shieldPreservedAttribute` hides, by the rules it documents: an
 * element whose name matches a preserved entry, or that carries
 * `data-bascik-preserve` for all three attributes, has its content hidden
 * (unless an ancestor already preserves all three); then every opening tag
 * whose preserved set (inherited, plus its own) includes `attribute` is
 * hidden. Returns the view, with each hidden span in «».
 */
const referencePreservedView = (
  html: string,
  attribute: Attribute,
  preserved: string[],
): string => {
  const isPreservedName = (name: string): boolean =>
    preserved.some((entry) => globMatches(entry, name));
  type Frame = { name: string; attributes: Set<Attribute> };

  const openingName = (tag: string): string | null =>
    /^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag)?.[1].toLowerCase() ?? null;
  const closingName = (tag: string): string | null =>
    /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(tag)?.[1].toLowerCase() ?? null;
  const popTo = (frames: Frame[], name: string): Frame | undefined => {
    for (let i = frames.length - 1; i >= 0; i--)
      if (frames[i].name === name) return frames.splice(i)[0];
    return undefined;
  };
  const attributesFor = (frames: Frame[], tag: string, name: string) => {
    const inherited = frames.at(-1)?.attributes ?? new Set<Attribute>();
    const own = directiveTokens(tag);
    const attributes = new Set(inherited);
    if (isPreservedName(name))
      for (const each of PRESERVABLE) attributes.add(each);
    for (const each of own ?? []) attributes.add(each);
    return { inherited, own, attributes };
  };

  // Pass 1: content ranges.
  const ranges: Array<[number, number]> = [];
  const frames: Array<Frame & { contentStart: number; shields: boolean }> = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const closing = closingName(tag);
    if (closing) {
      const frame = popTo(frames, closing) as
        (typeof frames)[number] | undefined;
      if (frame?.shields) ranges.push([frame.contentStart, match.index]);
      continue;
    }
    const name = openingName(tag)!;
    const { inherited, own, attributes } = attributesFor(frames, tag, name);
    const shields =
      inherited.size !== PRESERVABLE.length &&
      (isPreservedName(name) || own?.size === PRESERVABLE.length);
    if (!/\/\s*>$/.test(tag) && !VOID.test(name))
      frames.push({
        name,
        attributes,
        contentStart: match.index + tag.length,
        shields,
      });
  }
  // Hidden content, innermost replaced last so outer ranges see the original text.
  const placeholders: string[] = [];
  let text = html;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    placeholders.push(text.slice(start, end));
    text = `${text.slice(0, start)}\x01${placeholders.length - 1}\x01${text.slice(end)}`;
  }
  // Pass 2: opening tags whose preserved set includes `attribute`.
  const active: Frame[] = [];
  text = text.replace(TAG_PATTERN, (tag) => {
    if (tag.startsWith("<!--")) return tag;
    const closing = closingName(tag);
    if (closing) {
      popTo(active, closing);
      return tag;
    }
    const name = openingName(tag)!;
    const { attributes } = attributesFor(active, tag, name);
    if (!/\/\s*>$/.test(tag) && !VOID.test(name))
      active.push({ name, attributes });
    return attributes.has(attribute) ? `«${tag}»` : tag;
  });
  const expand = (value: string): string =>
    value.replace(
      /\x01(\d+)\x01/g,
      (_m, index: string) => `«${expand(placeholders[Number(index)])}»`,
    );
  return expand(text);
};

// ── Generators ──────────────────────────────────────────────────────────

const NAMES = [
  "vendor-box",
  "vendor-",
  "vendor",
  "Vendor-Box",
  "acme-widget",
  "widget",
  "x-vendor-y",
  "vendor-box2",
  "vendor:box",
  "a-b-c",
  "ab",
  "v",
  "div",
  "code",
];

const SEGMENTS = ["vendor", "-", "box", "widget", "a", "b", "v", "x", "code"];

/** A preserve entry with `*` at the start, end, middle or doubled, and now and then a stray quote or `>`. */
const entryArb = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...SEGMENTS) },
      { weight: 2, arbitrary: fc.constantFrom("*", "**") },
      { weight: 1, arbitrary: fc.constantFrom('"', "'", ">") },
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((parts) => parts.join(""))
  .filter((entry) => entry.includes("*"));

const attributeArb = fc.constantFrom(
  "",
  ' id="i"',
  " class='c'",
  ' name="n" class="c"',
  ' title="<vendor-box>"',
  " data-x='a>b'",
  ' data-bascik-preserve="class"',
  " data-bascik-preserve",
  ' data-bascik-preserve="id name class"',
  ' title="unclosed',
);

const fragmentArb = fc.oneof(
  fc
    .tuple(fc.constantFrom(...NAMES), attributeArb, fc.constantFrom(">", " />"))
    .map(([name, attributes, end]) => `<${name}${attributes}${end}`),
  fc
    .tuple(fc.constantFrom(...NAMES), fc.constantFrom(">", " >"))
    .map(([name, end]) => `</${name}${end}`),
  fc.constantFrom(
    "text",
    " vendor-box ",
    "<!-- <vendor-box> -->",
    "<",
    ">",
    '"',
    "'",
    "*",
  ),
);

const htmlArb = fc
  .array(fragmentArb, { maxLength: 14 })
  .map((parts) => parts.join(""));

const entriesArb = fc.array(entryArb, { minLength: 1, maxLength: 3 });

// ── Properties ──────────────────────────────────────────────────────────

describe("scoping.preserve `*` patterns against slow references", () => {
  it("the glob reference agrees with hand-checked cases", () => {
    expect(globMatches("vendor-*", "vendor-box")).toBe(true);
    expect(globMatches("vendor-*", "vendor-")).toBe(true);
    expect(globMatches("vendor-*", "vendor")).toBe(false);
    expect(globMatches("*-widget", "acme-widget")).toBe(true);
    expect(globMatches("v*x", "vendor-box")).toBe(true);
    expect(globMatches("**", "vendor-box")).toBe(true);
    expect(globMatches("*", "vendor:box")).toBe(false);
    expect(globMatches("vendor*box", "vendor:box")).toBe(false);
  });

  it("maskElementContents blanks exactly what the element-content regex finds", () => {
    let changed = 0;
    fc.assert(
      fc.property(htmlArb, entriesArb, (html, entries) => {
        const masked = maskElementContents(html, entries);
        expect(masked).toBe(referenceMask(html, entries));
        if (masked !== html) changed++;
      }),
      { numRuns: 500 },
    );
    // The generators reach the matching cases, not only inputs with nothing to hide.
    expect(changed).toBeGreaterThan(50);
  });

  it("shieldElementContents hides exactly what the element-content regex finds, and restores it", () => {
    fc.assert(
      fc.property(htmlArb, entriesArb, (html, entries) => {
        const shielded = shieldElementContents(html, entries);
        expect(viewOf(shielded.html, shielded.restore)).toBe(
          outermost(referenceShieldView(html, entries)),
        );
        const again = shieldElementContents(html, entries);
        expect(again.restore(again.html)).toBe(html);
      }),
      { numRuns: 500 },
    );
  });

  it("shieldPreservedAttribute hides exactly the tags and content the preserve rules name", () => {
    let hiding = 0;
    fc.assert(
      fc.property(
        htmlArb,
        entriesArb,
        fc.constantFrom(...PRESERVABLE),
        (html, entries, attribute) => {
          const shielded = shieldPreservedAttribute(html, attribute, entries);
          const view = viewOf(shielded.html, shielded.restore);
          expect(view).toBe(
            outermost(referencePreservedView(html, attribute, entries)),
          );
          if (view.includes("«")) hiding++;
          const again = shieldPreservedAttribute(html, attribute, entries);
          expect(again.restore(again.html)).toBe(html);
        },
      ),
      { numRuns: 500 },
    );
    expect(hiding).toBeGreaterThan(50);
  });
});
