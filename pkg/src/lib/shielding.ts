// A global counter plus source collision checks keep generated tokens outside user input.
const SHIELD_TOKEN_PATTERN = /\x00BASCIK_SHIELD_(\d+)\x00/g;
let nextShieldToken = 0;

export const createContentShield = (source: string): {
  hide: (value: string) => string;
  restore: (value: string) => string;
} => {
  const values = new Map<string, string>();
  const ownedTokens = new Set<string>();

  const hide = (value: string): string => {
    let token: string;
    do {
      token = `\x00BASCIK_SHIELD_${nextShieldToken++}\x00`;
    } while (source.includes(token) || values.has(token));
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
  for (const tag of tags) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    result = result.replace(
      new RegExp(`(<${escapedTag}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${escapedTag}>)`, "gi"),
      (_match, open: string, inner: string, close: string) =>
        `${open}${shield.hide(inner)}${close}`,
    );
  }
  return { html: result, restore: shield.restore };
};

const PRESERVABLE_ATTRIBUTES = new Set(["id", "name", "class"]);
const HTML_TAG_PATTERN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;

type PreserveFrame = {
  tagName: string;
  attributes: Set<string>;
  contentStart: number;
  shieldsContent: boolean;
};

const getPreserveTokens = (tag: string): Set<string> | null => {
  const match = tag.match(
    /\sdata-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'))?(?=\s|\/?>)/i,
  );
  if (!match) return null;
  if (match[1] === undefined) return new Set(PRESERVABLE_ATTRIBUTES);
  return new Set(
    (match[2] ?? match[3] ?? "")
      .trim()
      .split(/\s+/)
      .filter((token) => PRESERVABLE_ATTRIBUTES.has(token)),
  );
};

// Selective preserve extends content shielding to inherited attribute sets.
export const shieldPreservedAttribute = (
  html: string,
  attribute: "id" | "name" | "class",
  preservedTags: string[] = [],
): { html: string; restore: (value: string) => string } => {
  const shield = createContentShield(html);
  const preservedTagSet = new Set(preservedTags.map((tag) => tag.toLowerCase()));
  const frames: PreserveFrame[] = [];
  const contentRanges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  HTML_TAG_PATTERN.lastIndex = 0;
  while ((match = HTML_TAG_PATTERN.exec(html)) !== null) {
    const tag = match[0];
    if (tag.startsWith("<!--")) continue;
    const closingMatch = tag.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      for (let index = frames.length - 1; index >= 0; index--) {
        if (frames[index].tagName !== tagName) continue;
        const [frame] = frames.splice(index, 1);
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
    if (preservedTagSet.has(tagName)) {
      for (const name of PRESERVABLE_ATTRIBUTES) attributes.add(name);
    }
    if (own) {
      for (const name of own) attributes.add(name);
    }
    const shieldsContent =
      inherited.size !== PRESERVABLE_ATTRIBUTES.size &&
      (preservedTagSet.has(tagName) || own?.size === PRESERVABLE_ATTRIBUTES.size);
    const isVoid = /\/\s*>$/.test(tag) || /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tagName);
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
  for (const range of contentRanges.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, range.start)}${shield.hide(result.slice(range.start, range.end))}${result.slice(range.end)}`;
  }

  const activeFrames: Array<{ tagName: string; attributes: Set<string> }> = [];
  result = result.replace(HTML_TAG_PATTERN, (tag) => {
    if (tag.startsWith("<!--")) return tag;
    const closingMatch = tag.match(/^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      const index = activeFrames.findLastIndex((frame) => frame.tagName === tagName);
      if (index >= 0) activeFrames.splice(index, 1);
      return tag;
    }
    const openingMatch = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!openingMatch) return tag;
    const tagName = openingMatch[1].toLowerCase();
    const attributes = new Set(activeFrames.at(-1)?.attributes ?? []);
    if (preservedTagSet.has(tagName)) {
      for (const name of PRESERVABLE_ATTRIBUTES) attributes.add(name);
    }
    const own = getPreserveTokens(tag);
    if (own) {
      for (const name of own) attributes.add(name);
    }
    const isVoid = /\/\s*>$/.test(tag) || /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tagName);
    if (!isVoid) activeFrames.push({ tagName, attributes });
    if (!attributes.has(attribute)) return tag;
    const attributePattern = new RegExp(`(\\s${attribute}\\s*=\\s*)("[^"]*"|'[^']*')`, "i");
    return tag.replace(attributePattern, (_full, prefix: string, value: string) =>
      `${prefix}${shield.hide(value)}`,
    );
  });

  return { html: result, restore: shield.restore };
};

export const stripPreserveDirectives = (
  html: string,
  warn: (message: string) => void = console.warn,
): string => html.replace(
  /\sdata-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'))?(?=\s|\/?>)/gi,
  (_directive, quotedValue: string | undefined, doubleValue: string | undefined, singleValue: string | undefined) => {
    if (quotedValue !== undefined) {
      for (const token of (doubleValue ?? singleValue ?? "").trim().split(/\s+/).filter(Boolean)) {
        if (!PRESERVABLE_ATTRIBUTES.has(token)) {
          warn(`[bascik] warning: data-bascik-preserve ignores unknown token "${token}".`);
        }
      }
    }
    return "";
  },
);

// Scanner masks discard content and preserve offsets; they are never restored.
export const maskElementContents = (html: string, tags: string[]): string => {
  let result = html;
  for (const tag of tags) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    result = result.replace(
      new RegExp(`(<${escapedTag}(?:\\b${attributes})?>)([\\s\\S]*?)(<\\/${escapedTag}\\s*>)`, "gi"),
      (_match, open: string, inner: string, close: string) =>
        `${open}${" ".repeat(inner.length)}${close}`,
    );
  }
  return result;
};