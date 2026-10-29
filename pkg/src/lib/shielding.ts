import {
  isScannableElementName,
  replaceSpans,
  scanElementContents,
  scanOpeningTags,
  scanPatternElementContents,
} from "./element-content-scan.ts";

// A global counter plus source collision checks keep generated tokens outside user input.
const SHIELD_TOKEN_PATTERN = /\x00BASCIK_SHIELD_(\d+)\x00/g;
let nextShieldToken = 0;

/**
 * Test-only instrumentation for the operation-count guard in
 * shielding.test.ts: how many full HTML tag scans shieldPreservedAttribute
 * ran and how many values were hidden. Never read on production paths.
 */
export const __shieldStatsForTests = {
  tagScans: 0,
  hiddenValues: 0,
  reset(): void {
    this.tagScans = 0;
    this.hiddenValues = 0;
  },
};

export const createContentShield = (
  source: string,
): {
  hide: (value: string) => string;
  restore: (value: string) => string;
} => {
  const values = new Map<string, string>();
  const ownedTokens = new Set<string>();
  // Scan the source once: most inputs contain no token prefix, so per-token
  // collision checks would rescan the whole source on every hide.
  const sourceMayCollide = source.includes("\x00BASCIK_SHIELD_");

  const hide = (value: string): string => {
    __shieldStatsForTests.hiddenValues++;
    let token: string;
    do {
      token = `\x00BASCIK_SHIELD_${nextShieldToken++}\x00`;
    } while ((sourceMayCollide && source.includes(token)) || values.has(token));
    values.set(token, value);
    ownedTokens.add(token);
    return token;
  };

  const restore = (value: string): string => {
    let result = value;
    let replaced = true;
    while (replaced) {
      replaced = false;
      result = result.replace(SHIELD_TOKEN_PATTERN, (token) => {
        if (!ownedTokens.has(token)) return token;
        const preserved = values.get(token);
        if (preserved === undefined) return token;
        replaced = true;
        ownedTokens.delete(token);
        values.delete(token);
        return preserved;
      });
    }
    return result;
  };

  return { hide, restore };
};

export const shieldElementContents = (
  html: string,
  tags: string[],
): { html: string; restore: (value: string) => string } => {
  if (tags.length === 0) return { html, restore: (value) => value };
  const shield = createContentShield(html);
  let result = html;
  for (const tag of tags)
    result = replaceElementContents(result, tag, false, shield.hide);
  return { html: result, restore: shield.restore };
};

const PRESERVABLE_ATTRIBUTES = new Set(["id", "name", "class"]);

/**
 * Each comment and opening or closing tag, as
 * `/<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g`
 * finds them, in linear time (`scanOpeningTags`).
 */
const htmlTags = (html: string): Array<{ start: number; end: number }> =>
  scanOpeningTags(html, { closingTags: true, comments: true }).map(
    ([start, end]) => ({ start, end }),
  );
const PRESERVE_DIRECTIVE_PROBE = /data-bascik-preserve/i;

/**
 * Translate one preserve entry into a tag-name fragment for a RegExp. Exact
 * names escape every metacharacter (today's behavior). A `*` entry splits on
 * `*`, escapes each segment, and joins with `[a-zA-Z0-9-]*`, so `vendor-*`
 * becomes `vendor-[a-zA-Z0-9-]*`. Consecutive `*` behave as one.
 */
const tagNameFragment = (entry: string): string => {
  if (!entry.includes("*")) {
    return entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return entry
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-zA-Z0-9-]*");
};

type TagContentPatterns = {
  probe: RegExp | null;
  shield: RegExp;
  mask: RegExp;
  /**
   * For `scanPatternElementContents`: the name followed by a boundary, and
   * the two closers. Null when the entry holds `>` or a quote, which the
   * attribute scan would read as part of the tag.
   */
  name: RegExp | null;
  shieldCloser: RegExp;
  maskCloser: RegExp;
};

// Cached per lowercase tag/pattern entry; RegExp /i matches ASCII tag names identically to toLowerCase().
const TAG_CONTENT_PATTERN_CACHE = new Map<string, TagContentPatterns>();

const getTagContentPatterns = (tag: string): TagContentPatterns => {
  const entry = tag.toLowerCase();
  let cached = TAG_CONTENT_PATTERN_CACHE.get(entry);
  if (cached) return cached;
  const prefix = entry.includes("*")
    ? entry.slice(0, entry.indexOf("*"))
    : entry;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fragment = tagNameFragment(entry);
  const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
  cached = {
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    probe: prefix === "" ? null : new RegExp(`<${escapedPrefix}`, "i"),
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    shield: new RegExp(
      `(<${fragment}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${fragment}>)`,
      "gi",
    ),
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    mask: new RegExp(
      `(<${fragment}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${fragment}\\s*>)`,
      "gi",
    ),
    name: /[>"']/.test(entry)
      ? null
      : // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        new RegExp(`${fragment}(?:\\b|(?=>))`, "iy"),
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    shieldCloser: new RegExp(`<\\/${fragment}>`, "iy"),
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    maskCloser: new RegExp(`<\\/${fragment}\\s*>`, "iy"),
  };
  TAG_CONTENT_PATTERN_CACHE.set(entry, cached);
  return cached;
};

/**
 * Compile the preserve list once per call into exact names plus anchored
 * patterns. Matching is case-insensitive: callers lowercase both the entries
 * and the candidate tag names.
 */
export const compilePreservedTags = (
  tags: string[],
): { exact: Set<string>; patterns: RegExp[] } => {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  for (const tag of tags) {
    const entry = tag.toLowerCase();
    if (entry.includes("*")) {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      patterns.push(new RegExp(`^${tagNameFragment(entry)}$`));
    } else {
      exact.add(entry);
    }
  }
  return { exact, patterns };
};

const matchesPreservedTag = (
  compiled: { exact: Set<string>; patterns: RegExp[] },
  tagName: string,
): boolean =>
  compiled.exact.has(tagName) ||
  compiled.patterns.some((pattern) => pattern.test(tagName));

type PreserveFrame = {
  tagName: string;
  attributes: Set<string>;
  contentStart: number;
  shieldsContent: boolean;
};

const getPreserveTokens = (tag: string): Set<string> | null => {
  const match = tag.match(
    /\sdata-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?(?=\s|\/?>)/i,
  );
  if (!match) return null;
  const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
  // An empty value is the bare directive as DOM serializers write it.
  if (match[1] === undefined || value === "")
    return new Set(PRESERVABLE_ATTRIBUTES);
  return new Set(
    value.split(/\s+/).filter((token) => PRESERVABLE_ATTRIBUTES.has(token)),
  );
};

const identityRestore = (value: string): string => value;

/**
 * True when nothing in `html` can possibly be preserved: every path that
 * hides a value in `shieldPreservedAttribute` originates from either a
 * `data-bascik-preserve` directive (matched case-insensitively) or an element
 * whose tag name is in `preservedTags`. Absent both, the frame attribute sets
 * stay empty, no content range is recorded, and the function returns its
 * input unchanged. Checking `<tag` (not just `tag`) avoids scanning when the
 * name only appears in text or an attribute value. Case-insensitive because
 * HTML_TAG_PATTERN and the tag-name comparison lowercase the tag.
 */
const mayContainPreserved = (
  html: string,
  preservedTags: string[],
): boolean => {
  if (PRESERVE_DIRECTIVE_PROBE.test(html)) return true;
  for (const tag of preservedTags) {
    const { probe } = getTagContentPatterns(tag);
    // A pattern with a literal prefix can be cheaply ruled out; one without
    // (`*`, `*-widget`) cannot, so it forces the scan.
    if (probe === null || probe.test(html)) return true;
  }
  return false;
};

// Selective preserve extends content shielding to inherited attribute sets.
export const shieldPreservedAttribute = (
  html: string,
  attribute: "id" | "name" | "class",
  preservedTags: string[] = [],
): { html: string; restore: (value: string) => string } => {
  // Fast path (prompt 83): called three times per component instance; most
  // component markup has no preserve directive and no preserved tag, so skip
  // both full tag scans. Byte-identical to the slow path by construction.
  if (!mayContainPreserved(html, preservedTags)) {
    return { html, restore: identityRestore };
  }
  const shield = createContentShield(html);
  const compiled = compilePreservedTags(preservedTags);
  const frames: PreserveFrame[] = [];
  const contentRanges: Array<{ start: number; end: number }> = [];

  __shieldStatsForTests.tagScans++;
  for (const { start: tagStart, end: tagEnd } of htmlTags(html)) {
    const tag = html.slice(tagStart, tagEnd);
    const match = { index: tagStart };
    if (tag.startsWith("<!--")) continue;
    const closingMatch = tag.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      for (let index = frames.length - 1; index >= 0; index--) {
        if (frames[index].tagName !== tagName) continue;
        const [frame] = frames.splice(index);
        if (frame.shieldsContent) {
          contentRanges.push({ start: frame.contentStart, end: match.index });
        }
        break;
      }
      continue;
    }

    const openingMatch = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!openingMatch) continue;
    const tagName = openingMatch[1].toLowerCase();
    const inherited = frames.at(-1)?.attributes ?? new Set<string>();
    const own = getPreserveTokens(tag);
    const attributes = new Set(inherited);
    const isPreservedTag = matchesPreservedTag(compiled, tagName);
    if (isPreservedTag) {
      for (const name of PRESERVABLE_ATTRIBUTES) attributes.add(name);
    }
    if (own) {
      for (const name of own) attributes.add(name);
    }
    const shieldsContent =
      inherited.size !== PRESERVABLE_ATTRIBUTES.size &&
      (isPreservedTag || own?.size === PRESERVABLE_ATTRIBUTES.size);
    const isVoid =
      /\/\s*>$/.test(tag) ||
      /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(
        tagName,
      );
    if (!isVoid) {
      frames.push({
        tagName,
        attributes,
        contentStart: match.index + tag.length,
        shieldsContent,
      });
    }
  }

  let result = html;
  for (const range of contentRanges.sort(
    (left, right) => right.start - left.start,
  )) {
    result = `${result.slice(0, range.start)}${shield.hide(result.slice(range.start, range.end))}${result.slice(range.end)}`;
  }

  const activeFrames: Array<{ tagName: string; attributes: Set<string> }> = [];
  __shieldStatsForTests.tagScans++;
  result = replaceSpans(result, htmlTags(result), (tag) => {
    if (tag.startsWith("<!--")) return tag;
    const closingMatch = tag.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      const index = activeFrames.findLastIndex(
        (frame) => frame.tagName === tagName,
      );
      if (index >= 0) activeFrames.splice(index);
      return tag;
    }
    const openingMatch = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!openingMatch) return tag;
    const tagName = openingMatch[1].toLowerCase();
    const attributes = new Set(activeFrames.at(-1)?.attributes ?? []);
    if (matchesPreservedTag(compiled, tagName)) {
      for (const name of PRESERVABLE_ATTRIBUTES) attributes.add(name);
    }
    const own = getPreserveTokens(tag);
    if (own) {
      for (const name of own) attributes.add(name);
    }
    const isVoid =
      /\/\s*>$/.test(tag) ||
      /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(
        tagName,
      );
    if (!isVoid) activeFrames.push({ tagName, attributes });
    if (!attributes.has(attribute)) return tag;
    return shield.hide(tag);
  });

  return { html: result, restore: shield.restore };
};

export const stripPreserveDirectives = (
  html: string,
  warn: (message: string) => void = console.warn,
): string => {
  if (!/data-bascik-preserve/i.test(html)) return html;
  return html.replace(
    /\sdata-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?(?=\s|\/?>)/gi,
    (
      _directive,
      rawValue: string | undefined,
      doubleValue: string | undefined,
      singleValue: string | undefined,
      unquotedValue: string | undefined,
    ) => {
      if (rawValue !== undefined) {
        for (const token of (doubleValue ?? singleValue ?? unquotedValue ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)) {
          if (!PRESERVABLE_ATTRIBUTES.has(token)) {
            warn(
              `[bascik] warning: data-bascik-preserve ignores unknown token "${token}".`,
            );
          }
        }
      }
      return "";
    },
  );
};

/**
 * Replace the content of every `tag` element in `html` with
 * `replace(content)`, finding elements as `getTagContentPatterns(tag).mask`
 * (`closerWhitespace`) or `.shield` does. Exact tag names use the linear scan
 * in element-content-scan.ts, since the regex is quadratic on openers with no
 * closer or with an unclosed quote, and request-time output can carry
 * visitor text. `*` patterns (from `scoping.preserve`) and other names use
 * its pattern scan; only an entry holding `>` or a quote, which no tag name
 * does, still uses the regex.
 */
const replaceElementContents = (
  html: string,
  tag: string,
  closerWhitespace: boolean,
  replace: (content: string) => string,
): string => {
  const patterns = getTagContentPatterns(tag);
  if (patterns.probe && !patterns.probe.test(html)) return html;
  const entry = tag.toLowerCase();
  if (!isScannableElementName(entry) && patterns.name === null)
    return html.replace(
      closerWhitespace ? patterns.mask : patterns.shield,
      (_match, open: string, inner: string, close: string) =>
        `${open}${replace(inner)}${close}`,
    );
  let result = "";
  let cursor = 0;
  for (const match of isScannableElementName(entry)
    ? scanElementContents(html, entry, {
        opener: "tag-space",
        closer: closerWhitespace ? "regex-space" : "exact",
      })
    : scanPatternElementContents(
        html,
        patterns.name!,
        closerWhitespace ? patterns.maskCloser : patterns.shieldCloser,
      )) {
    result += `${html.slice(cursor, match.contentStart)}${replace(html.slice(match.contentStart, match.contentEnd))}`;
    cursor = match.contentEnd;
  }
  return cursor === 0 ? html : result + html.slice(cursor);
};

const blank = (content: string): string => " ".repeat(content.length);

// Scanner masks discard content and preserve offsets; they are never restored.
export const maskElementContents = (html: string, tags: string[]): string => {
  let result = html;
  for (const tag of tags)
    result = replaceElementContents(result, tag, true, blank);
  return result;
};
