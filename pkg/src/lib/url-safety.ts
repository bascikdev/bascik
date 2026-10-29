// ─────────────────────────────────────────────────────────────────────────────
// The one URL rule
//
// `html` from @bascik/bascik/html and the request-time binding check in
// component-props.ts both decide with this module, so a URL a template
// refuses is a URL a bound prop refuses. It has no imports, so the Worker
// and a browser bundle can take it anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/** The value a refused URL gets, as in Closure's safe-URL convention. */
export const BLOCKED_URL = "about:invalid";

/**
 * Schemes a URL may never use: each runs script where a browser follows it
 * (`data:` documents too). Every other scheme (http, mailto, tel, sms,
 * webcal, geo, an app's own, ...) and a relative URL are kept.
 */
const SCRIPT_URL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "vbscript",
  "livescript",
  "mocha",
  "data",
]);

/** Attribute names whose whole value is one URL the browser follows or fetches. */
export const URL_TARGETS: ReadonlySet<string> = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "codebase",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "manifest",
  "icon",
]);

/** `<tag attribute>` pairs that are one URL although the name alone is not. */
const URL_PAIRS: ReadonlySet<string> = new Set(["object data"]);

/**
 * `<tag target>` pairs that only ever show a picture, where a raster or SVG
 * `data:image/*` URL (a placeholder, a blur-up) cannot run anything.
 */
export const IMAGE_TARGETS: ReadonlySet<string> = new Set([
  "img src",
  "img srcset",
  "source srcset",
  "video poster",
  "input src",
  "link imagesrcset",
]);

/** SVG elements that write `to`, `from`, `by` or `values` into another attribute. */
export const SVG_ANIMATIONS: ReadonlySet<string> = new Set([
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
]);
export const ANIMATION_VALUES: ReadonlySet<string> = new Set([
  "to",
  "from",
  "by",
  "values",
]);

/**
 * A URL the way the URL parser reads it: leading and trailing C0 controls
 * and spaces dropped, and every tab, line feed and carriage return removed,
 * so `" java\tscript:"` reads `javascript:`.
 */
export const normalizeUrl = (url: string): string => {
  // Index scans, not a trim regex: /[\u0000- ]+$/ retries at every position
  // of a run of spaces or controls that is not at the end, which is
  // quadratic on a visitor value such as "a" + " ".repeat(n) + "a".
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start++;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
  const trimmed =
    start === 0 && end === url.length ? url : url.slice(start, end);
  return trimmed.replace(/[\t\n\r]/g, "");
};

/** The scheme the URL parser reads from `url`, lowercased, or null for a relative URL. */
export const urlScheme = (url: string): string | null =>
  /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalizeUrl(url))?.[1].toLowerCase() ??
  null;

/** A `data:` URL whose type is an image, which only an image slot may keep. */
export const isImageDataUrl = (url: string): boolean =>
  /^data:image\/[a-z0-9.+-]+[;,]/i.test(normalizeUrl(url));

/** Whether `scheme` (lowercased, no colon) runs script. */
export const isScriptScheme = (scheme: string): boolean =>
  SCRIPT_URL_SCHEMES.has(scheme);

/** Whether `url` cannot run script where it lands (`image`: an image slot). */
export const isSafeUrl = (url: string, image = false): boolean => {
  const scheme = urlScheme(url);
  if (scheme === null || !SCRIPT_URL_SCHEMES.has(scheme)) return true;
  return image && scheme === "data" && isImageDataUrl(url);
};

/**
 * The URLs of a `srcset` value, split the way the browser splits one: a
 * URL is a run of non-whitespace (commas inside it belong to it, a trailing
 * comma ends the candidate), then descriptors up to a comma outside
 * parentheses.
 */
export const srcsetUrls = (value: string): string[] => {
  const urls: string[] = [];
  let index = 0;
  const isSpace = (c: string): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
  while (index < value.length) {
    while (
      index < value.length &&
      (isSpace(value[index]) || value[index] === ",")
    )
      index++;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !isSpace(value[index])) index++;
    const url = value.slice(start, index);
    if (url.endsWith(",")) {
      // An index scan, not /,+$/, which is quadratic on a comma run inside
      // the URL ("a" + ",".repeat(n) + "b,").
      let end = url.length;
      while (end > 0 && url.charCodeAt(end - 1) === 44) end--;
      urls.push(url.slice(0, end));
      continue;
    }
    urls.push(url);
    let depth = 0;
    while (index < value.length) {
      const c = value[index];
      if (c === "(") depth++;
      else if (c === ")" && depth > 0) depth--;
      else if (c === "," && depth === 0) break;
      index++;
    }
  }
  return urls;
};

/** An event handler's name: `on` and letters only (`onboarding-step` is not one). */
export const isEventHandlerName = (name: string): boolean =>
  /^on[a-z]+$/.test(name);

/** How a URL-bearing attribute holds its URLs. */
export type UrlSlot = "url" | "srcset" | "ping" | "animation" | null;

/** Which kind of URL slot `<tag target>` is (both lowercased), or null. */
export const urlSlot = (tag: string, target: string): UrlSlot => {
  if (URL_TARGETS.has(target) || URL_PAIRS.has(`${tag} ${target}`))
    return "url";
  if (target === "srcset" || target === "imagesrcset") return "srcset";
  if (target === "ping") return "ping";
  if (SVG_ANIMATIONS.has(tag) && ANIMATION_VALUES.has(target))
    return "animation";
  return null;
};

/** Whether every URL in a value of `slot` is safe. */
export const isSafeUrlValue = (
  slot: Exclude<UrlSlot, null>,
  value: string,
  image: boolean,
): boolean => {
  switch (slot) {
    case "url":
      return isSafeUrl(value, image);
    case "srcset":
      return srcsetUrls(value).every((url) => isSafeUrl(url, image));
    case "ping":
      return value
        .split(/[\t\n\f\r ]+/)
        .every((url) => url === "" || isSafeUrl(url));
    case "animation":
      return value.split(";").every((entry) => isSafeUrl(entry));
  }
};

/**
 * The URL verdict for `value` in `<tag target>`: `ok`, `blocked` (a script
 * URL; it becomes `about:invalid`), or `not-url` when the attribute holds no
 * URL. Any http(s) URL, on this site or another, is `ok`, as browsers allow.
 */
export const urlVerdict = (
  tag: string,
  target: string,
  value: string,
): "ok" | "blocked" | "not-url" => {
  const t = tag.toLowerCase();
  const a = target.toLowerCase();
  const slot = urlSlot(t, a);
  if (slot === null) return "not-url";
  return isSafeUrlValue(slot, value, IMAGE_TARGETS.has(`${t} ${a}`))
    ? "ok"
    : "blocked";
};

/**
 * How a warning names what was blocked: a `data:` URL by its scheme, every
 * other blocked URL as a script URL. The full scheme list lives on one docs
 * page (/security), not in messages.
 */
export const BLOCKED_URL_REASONS = {
  script: "a script URL such as javascript:",
  data: "a data: URL",
} as const;

/** Why `urlVerdict` blocked `value`: `data` only when no blocked URL in it is another scheme. */
export const blockedUrlKind = (
  tag: string,
  target: string,
  value: string,
): keyof typeof BLOCKED_URL_REASONS => {
  const t = tag.toLowerCase();
  const a = target.toLowerCase();
  const slot = urlSlot(t, a);
  const image = IMAGE_TARGETS.has(`${t} ${a}`);
  const urls =
    slot === "srcset"
      ? srcsetUrls(value)
      : slot === "ping"
        ? value.split(/[\t\n\f\r ]+/)
        : slot === "animation"
          ? value.split(";")
          : [value];
  const blocked = urls.filter(
    (url) => url !== "" && !isSafeUrl(url, image && slot !== "animation"),
  );
  return blocked.length > 0 && blocked.every((url) => urlScheme(url) === "data")
    ? "data"
    : "script";
};

/**
 * The named character references whose character is ASCII: the only ones
 * that can spell a scheme, a colon, or CSS syntax. Any other reference is
 * left as written, which a URL or CSS check reads as harmless text.
 */
const ASCII_NAMED_REFERENCES: Readonly<Record<string, string>> = {
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
  fjlig: "fj",
};

/**
 * An attribute value as written (`&#106;avascript&colon;`) decoded the way
 * the browser decodes it before the attribute acts (`javascript:`), for a
 * check to judge: numeric references with or without the semicolon, and the
 * named references whose character is ASCII. One pass, linear in the value.
 */
export const decodeAttributeEntities = (value: string): string =>
  value.includes("&")
    ? value.replace(
        /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
        (match, hex?: string, dec?: string, name?: string) => {
          if (name !== undefined)
            return Object.hasOwn(ASCII_NAMED_REFERENCES, name)
              ? ASCII_NAMED_REFERENCES[name]
              : match;
          const code =
            hex !== undefined
              ? Number.parseInt(hex, 16)
              : Number.parseInt(dec!, 10);
          return code === 0 ||
            !(code <= 0x10ffff) ||
            (code >= 0xd800 && code <= 0xdfff)
            ? "�"
            : String.fromCodePoint(code);
        },
      )
    : value;

const NEEDS_ESCAPE = /[&<>"']/;

/**
 * Entity-escape `& < > " '` for text and either quote. A clean string is
 * returned as it is.
 */
export const escapeHtml = (value: string): string => {
  const first = value.search(NEEDS_ESCAPE);
  if (first === -1) return value;
  let out = "";
  let last = 0;
  for (let i = first; i < value.length; i++) {
    let entity: string;
    switch (value.charCodeAt(i)) {
      case 38:
        entity = "&amp;";
        break;
      case 60:
        entity = "&lt;";
        break;
      case 62:
        entity = "&gt;";
        break;
      case 34:
        entity = "&quot;";
        break;
      case 39:
        entity = "&#39;";
        break;
      default:
        continue;
    }
    if (last !== i) out += value.slice(last, i);
    out += entity;
    last = i + 1;
  }
  return last === 0 ? out : out + value.slice(last);
};
