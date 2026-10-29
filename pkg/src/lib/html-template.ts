// ─────────────────────────────────────────────────────────────────────────────
// @bascik/bascik/html: plain functions that return safe HTML
//
// `html` is a tagged template with contextual escaping. The first call from
// a template site reads its static parts with a small tokenizer (the WHATWG
// states that matter for a hole) and records where each hole lands: text, a
// quoted attribute, a URL, a JSON script. Places escaping cannot make safe
// (an event handler, a <script> body, an unquoted value, a tag name, ...)
// are refused with a located HtmlError on every call.
//
// Divergence policy: escaped text is inert in data, RCDATA, non-code raw
// text and quoted attributes, so the tokenizer only has to be exact about
// code (script, style, on*, style=, URL schemes), comments and tag and
// attribute structure. Wherever it cannot follow the browser it refuses; it
// never guesses safe.
//
// Portable: the only import is ./url-safety.ts (no imports of its own), so
// the module runs on Node 22.18+, in a Cloudflare Worker and in a browser.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLOCKED_URL,
  IMAGE_TARGETS,
  escapeHtml,
  isEventHandlerName,
  isImageDataUrl,
  isSafeUrl,
  isSafeUrlValue,
  isScriptScheme,
  normalizeUrl,
  srcsetUrls,
  urlSlot,
  type UrlSlot,
} from "./url-safety.ts";

const HTML: unique symbol = Symbol.for("bascik.html") as never;
/** Set on an html value whose static text has a <script> or <style> with < in it (see FOREIGN_UNSAFE). */
const FOREIGN: unique symbol = Symbol.for(
  "bascik.html.foreign-unsafe",
) as never;
const JSON_TEXT: unique symbol = Symbol.for("bascik.json") as never;

/** HTML that `html` or `raw` produced: inserted as is when nested, a string everywhere else. */
export interface SafeHtml {
  readonly [HTML]: string;
  toString(): string;
  valueOf(): string;
  toJSON(): string;
}

/** JSON text from `json(value)`: safe as the only content of a JSON <script>. */
export interface JsonText {
  readonly [JSON_TEXT]: string;
  toString(): string;
  valueOf(): string;
  toJSON(): string;
}

class Html {
  declare readonly [HTML]: string;
  declare readonly [FOREIGN]?: true;
  constructor(text: string, foreignUnsafe = false) {
    (this as { [HTML]: string })[HTML] = text;
    if (foreignUnsafe) (this as { [FOREIGN]?: true })[FOREIGN] = true;
    Object.freeze(this);
  }
  toString(): string {
    return this[HTML];
  }
  valueOf(): string {
    return this[HTML];
  }
  toJSON(): string {
    return this[HTML];
  }
  [Symbol.toPrimitive](): string {
    return this[HTML];
  }
}

class Json {
  declare readonly [JSON_TEXT]: string;
  constructor(text: string) {
    (this as { [JSON_TEXT]: string })[JSON_TEXT] = text;
    Object.freeze(this);
  }
  toString(): string {
    return this[JSON_TEXT];
  }
  valueOf(): string {
    return this[JSON_TEXT];
  }
  toJSON(): string {
    return this[JSON_TEXT];
  }
  [Symbol.toPrimitive](): string {
    return this[JSON_TEXT];
  }
}

/** Whether `value` came from `html` or `raw` (in this copy of the module or another). */
export const isHtml = (value: unknown): value is SafeHtml =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<symbol, unknown>)[HTML] === "string";

const isJson = (value: unknown): value is JsonText =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<symbol, unknown>)[JSON_TEXT] === "string";

const isThenable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export type HtmlErrorCode =
  | "unquoted-attribute"
  | "event-handler"
  | "style-attribute"
  | "script-body"
  | "style-body"
  | "tag-name"
  | "attribute-name"
  | "comment"
  | "srcdoc"
  | "meta-http-equiv"
  | "svg-animation-attribute"
  | "url-scheme-split"
  | "script-url"
  | "script-comment-ambiguous"
  | "unterminated"
  | "promise"
  | "markup-in-attribute"
  | "array-in-attribute"
  | "markup-in-text-only"
  | "json-script-value"
  | "foreign-content"
  | "unconvertible-value"
  | "array-depth"
  | "raw-text-end";

/** Thrown where a value cannot be made safe: the code, the hole (1-based; 0 for the whole template) and an excerpt. */
export class HtmlError extends Error {
  readonly code: HtmlErrorCode;
  readonly hole: number;
  readonly template: string;
  constructor(
    code: HtmlErrorCode,
    hole: number,
    template: string,
    message: string,
  ) {
    super(message);
    this.name = "HtmlError";
    this.code = code;
    this.hole = hole;
    this.template = template;
  }
}

// ─── Excerpts and messages ──────────────────────────────────────────────────

const MARK = "${…}";
const EXCERPT = 80;

/** The static text with each hole shown as ${…}, cut to about 80 characters around `hole`. */
const excerpt = (strings: readonly string[], hole: number): string => {
  const parts = strings.map((part) => part.replace(/\s*\n\s*/g, " "));
  const whole = parts.join(MARK);
  if (whole.length <= EXCERPT) return whole;
  let at = 0;
  for (let i = 0; i < hole && i < parts.length; i++)
    at += parts[i].length + (i > 0 ? MARK.length : 0);
  const start = Math.max(0, Math.min(at - EXCERPT / 2, whole.length - EXCERPT));
  const end = Math.min(whole.length, start + EXCERPT);
  return (
    (start > 0 ? "…" : "") +
    whole.slice(start, end) +
    (end < whole.length ? "…" : "")
  );
};

const holeError = (
  strings: readonly string[],
  code: HtmlErrorCode,
  hole: number,
  reason: string,
): HtmlError => {
  const template = excerpt(strings, hole);
  return new HtmlError(
    code,
    hole,
    template,
    `html: hole ${hole} in html\`${template}\` ${reason}`,
  );
};

const FRAGMENT_RULE =
  "An html`...` fragment must end outside any tag, comment, <script>, <style>, <textarea>, <title>, <svg> or <math>, so it can be nested safely.";

const REASONS = {
  "event-handler": (name: string) =>
    `is inside the ${name} attribute. An event handler's value is JavaScript, which escaping cannot make safe. Put the value in a data-* attribute and read it from a component script.`,
  "style-attribute": () =>
    "is inside a style attribute. CSS can load URLs and change the page, and escaping does not make it safe. Choose between fixed classes in code, or put the value in a data-* attribute.",
  "script-body": () =>
    'is inside a <script> element. Escaping HTML does not make JavaScript safe. Put the value in a data-* attribute, or in <script type="application/json">${json(value)}</script>.',
  "style-body": () =>
    "is inside a <style> element. Escaping HTML does not make CSS safe. Choose between fixed classes in code.",
  "tag-name": () =>
    "is a tag name. A value never chooses which element to write. Choose between fixed html`...` fragments in code.",
  "attribute-name": (tag: string) =>
    `is where an attribute name goes, inside <${tag}>. A value never chooses which attributes an element has. Write the attribute in the template with a quoted value, or choose between fixed html\`...\` fragments in code.`,
  comment: () =>
    "is inside an HTML comment (or a <!...> declaration). Move the value out of the comment.",
  srcdoc: () =>
    "is inside srcdoc, an HTML document that runs with the page's origin. Set src to a URL instead.",
  "meta-http-equiv": () =>
    "is a <meta http-equiv> value, which acts on the page (a redirect, a policy). Write it in the template.",
  "svg-animation-attribute": (name: string) =>
    `chooses which attribute an SVG animation sets. Write ${name} in the template.`,
  "foreign-content": () =>
    "received an html`...` value with a <script> or <style> whose text contains <, inside <svg> or <math>. There the browser reads that text as markup, so the element can end somewhere else. Move the fragment out of the <svg> or <math>, or remove < from its script or style.",
  "raw-text-end": (tag: string) =>
    `received an html\`...\` or raw() value that contains </${tag}, which ends the <${tag}> early. The browser would read the rest of the value as markup that html did not check, so its holes could land in an href or an event handler. Remove </${tag} from the value, or put the value outside the <${tag}>.`,
  "unquoted-attribute": (name: string) =>
    `is an unquoted attribute value (${name}). A space in the value would start a new attribute. Quote it: ${name}="${MARK}".`,
} as const;

// ─── The tokenizer ──────────────────────────────────────────────────────────

/** Where a hole lands, decided once per template site. */
type Hole =
  | {
      k: "text";
      foreign?: boolean;
      /** The raw-text element (<xmp>, <iframe>, <noscript>, ...) the hole is in. */
      raw?: string;
    }
  | { k: "rcdata"; tag: string }
  | { k: "attr"; name: string }
  | { k: "url"; name: string; image: boolean }
  | {
      k: "list";
      name: string;
      slot: Exclude<UrlSlot, "url" | null>;
      image: boolean;
      /** The attribute's parts: static strings and hole indices. */
      group: (string | number)[];
    }
  | { k: "json" };

interface Refusal {
  code: HtmlErrorCode;
  hole: number;
  reason: string;
}

interface Compiled {
  holes: Hole[];
  refusal?: Refusal;
  /** The template has a <script> or <style> read as HTML whose static text contains <. */
  foreignUnsafe: boolean;
  /** The static parts, cooked (raw where cooking failed). */
  parts: readonly string[];
}

const enum S {
  Data,
  TagOpen,
  EndTagOpen,
  TagName,
  BeforeAttrName,
  AttrName,
  AfterAttrName,
  BeforeAttrValue,
  AttrValueDq,
  AttrValueSq,
  AttrValueUq,
  AfterAttrValueQuoted,
  SelfClosing,
  Comment,
  Bogus,
  Text,
  Plaintext,
}

interface Attr {
  name: string;
  /** Static text and hole indices of a quoted value. */
  parts: (string | number)[];
  holes: number;
}

const RAW_CODE = new Set(["script", "style"]);
const RAW_TEXT = new Set(["xmp", "iframe", "noembed", "noframes", "noscript"]);
const RCDATA = new Set(["textarea", "title"]);
/** Where the content of a foreign element is HTML (lowercased names). */
const INTEGRATION_POINTS = new Set(
  "foreignobject desc title mi mo mn ms mtext annotation-xml".split(" "),
);
/** Start tags that leave foreign content (the tree builder's breakout list). */
const BREAKOUT = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strike strong sub sup table tt u ul var font".split(
    " ",
  ),
);
/** HTML elements with no end tag. */
const VOID = new Set(
  "area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr".split(
    " ",
  ),
);
const JSON_TYPES = new Set(["application/json", "application/ld+json"]);
const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
/**
 * ASCII-only lowercase, as the HTML tokenizer folds names. String#toLowerCase
 * maps U+0130 to two characters and U+212A to "k", which would move indices
 * and match names the browser does not.
 */
const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) | 32));
const ANIMATION_NAMES: Readonly<Record<string, string>> = {
  attributename: "attributeName",
  attributetype: "attributeType",
};
const SVG_ANIMATION_TAGS = new Set([
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
]);
const LIST_BOUNDARY: Readonly<Record<string, RegExp>> = {
  srcset: /[\t\n\f\r ,]/,
  ping: /[\t\n\f\r ]/,
  animation: /;/,
};

/**
 * How the static text before a URL hole settles the scheme: `start` (the
 * hole begins the URL), `settled` (a / ? # or a safe scheme came first),
 * `script` (a script scheme), or `split` (the text could continue into a
 * scheme the value completes).
 */
const prefixVerdict = (
  prefix: string,
  image: boolean,
): "start" | "settled" | "script" | "split" => {
  const text = normalizeUrl(prefix);
  if (text === "") return "start";
  const match = /[/?#:&]/.exec(text);
  if (match === null || match[0] === "&") return "split";
  if (match[0] !== ":") return "settled";
  const scheme = text.slice(0, match.index);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) return "settled";
  if (!isScriptScheme(scheme.toLowerCase())) return "settled";
  return image && isImageDataUrl(text) ? "settled" : "script";
};

/**
 * Readings of the static text where parsers differ. MARKUP_BODIES reads the
 * bodies of <title>, <textarea>, <noscript>, <xmp>, <iframe>, <noembed>,
 * <noframes> and <plaintext> as markup (scripting off, <select>, or nested
 * in <svg>).
 * FOREIGN_AS_HTML reads those and <script>/<style>/<plaintext> inside <svg>
 * or <math> as HTML (an HTML integration point such as <foreignObject>).
 */
const MARKUP_BODIES = 1;
const FOREIGN_AS_HTML = 2;

interface Pass {
  holes: Hole[];
  refusal?: Refusal;
  foreignUnsafe: boolean;
  /** A raw-text or RCDATA body was read as text: MARKUP_BODIES differs. */
  rawBodies: boolean;
  /** A text-body element sat in foreign content: FOREIGN_AS_HTML differs. */
  foreignText: boolean;
}

const compile = (strings: readonly string[], mode = 0): Pass => {
  const holes: Hole[] = new Array(strings.length - 1);
  let refusal: Refusal | undefined;
  const refuse = (code: HtmlErrorCode, hole: number, reason: string): void => {
    if (refusal === undefined || hole < refusal.hole)
      refusal = { code, hole, reason };
  };

  let state: S = S.Data;
  let tagName = "";
  let isEnd = false;
  let attrs: Attr[] = [];
  let attr: Attr | null = null;
  /** Holes inside the open tag's attribute values, finalized at its >. */
  let tagHoles: { hole: number; attr: Attr }[] = [];
  /** The element whose text we are in (Text state), lowercased. */
  let textTag = "";
  let textMode: "code" | "raw" | "rcdata" = "raw";
  let textBody: (string | number)[] = [];
  let jsonScript = false;
  /**
   * Elements open since the outermost <svg> or <math>, innermost last, with
   * whether each may be an HTML element (inside an integration point such as
   * <foreignObject> or <mtext>, or a tag that leaves foreign content).
   * `roots` counts the <svg> and <math> entries: foreign content when > 0.
   */
  const open: { tag: string; html: boolean }[] = [];
  let roots = 0;
  /** An open <script> or <style> in foreign content, whose body is markup. */
  let foreignCode: { tag: string; depth: number; count: number } | null = null;
  let rawBodies = false;
  let foreignText = false;
  let foreignUnsafe = false;
  let ambiguous: string | null = null;
  let cdata = false;
  let commentEnd = "";

  const startAttr = (name: string): void => {
    attr = { name, parts: [], holes: 0 };
    attrs.push(attr);
  };

  const finalizeAttr = (a: Attr, tag: string): void => {
    if (a.holes === 0) return;
    const name = a.name;
    const indices = a.parts.filter((p): p is number => typeof p === "number");
    const all = (code: HtmlErrorCode, reason: string): void => {
      for (const i of indices) refuse(code, i + 1, reason);
    };
    if (isEventHandlerName(name))
      return all("event-handler", REASONS["event-handler"](name));
    if (name === "style")
      return all("style-attribute", REASONS["style-attribute"]());
    if (name === "srcdoc") return all("srcdoc", REASONS.srcdoc());
    if (
      tag === "meta" &&
      (name === "http-equiv" ||
        (name === "content" && attrs.some((x) => x.name === "http-equiv")))
    )
      return all("meta-http-equiv", REASONS["meta-http-equiv"]());
    if (SVG_ANIMATION_TAGS.has(tag)) {
      if (name in ANIMATION_NAMES)
        return all(
          "svg-animation-attribute",
          REASONS["svg-animation-attribute"](ANIMATION_NAMES[name]),
        );
      const target = attrs.find((x) => x.name === "attributename");
      const animated =
        target === undefined
          ? ""
          : asciiLower(
              target.parts
                .filter((p) => typeof p === "string")
                .join("")
                .trim(),
            );
      if (
        (name === "to" ||
          name === "from" ||
          name === "by" ||
          name === "values") &&
        isEventHandlerName(animated)
      )
        return all("event-handler", REASONS["event-handler"](animated));
    }
    const slot = urlSlot(tag, name);
    const image = IMAGE_TARGETS.has(`${tag} ${name}`);
    if (slot === null) {
      for (const i of indices) holes[i] = { k: "attr", name };
      return;
    }
    if (slot === "url") return finalizeUrl(a, image);
    finalizeList(a, slot, image);
  };

  const splitReason = (name: string, prefix: string): string =>
    `continues the URL's scheme from the template text "${prefix.trim()}", so the value could complete javascript:. Start the attribute with the value (${name}="${MARK}"), or write the scheme and the first / in the template (${name}="https://example.com/${MARK}").`;
  const scriptUrlReason = (prefix: string): string =>
    `is inside a ${(/^[^:]*/.exec(normalizeUrl(prefix))?.[0] ?? "").toLowerCase()}: URL, which runs as script. Use a real URL and handle the click in a component script.`;

  /** One URL: the scheme rule from the design (see prefixVerdict). */
  const finalizeUrl = (a: Attr, image: boolean): void => {
    const { name, parts } = a;
    const first = parts.findIndex((p) => typeof p === "number");
    const prefix = parts
      .slice(0, first)
      .filter((p) => typeof p === "string")
      .join("");
    const verdict = prefixVerdict(prefix, image);
    const rest = parts.slice(first) as (string | number)[];
    const indices = rest.filter((p): p is number => typeof p === "number");
    if (verdict === "split") {
      for (const i of indices)
        refuse("url-scheme-split", i + 1, splitReason(name, prefix));
      return;
    }
    if (verdict === "script") {
      for (const i of indices)
        refuse("script-url", i + 1, scriptUrlReason(prefix));
      return;
    }
    if (verdict === "settled") {
      for (const i of indices) holes[i] = { k: "attr", name };
      return;
    }
    // The first hole starts the URL: its value is checked. The text after
    // it must end the scheme (reach / ? #) before a : or &, or end the value.
    const start = rest[0] as number;
    holes[start] = { k: "url", name, image };
    let after = "";
    let index = 1;
    while (index < rest.length && typeof rest[index] === "string")
      after += rest[index++] as string;
    const nextHole = index < rest.length;
    const match = /[/?#:&]/.exec(after);
    const settled = match !== null && match[0] !== ":" && match[0] !== "&";
    const ok = settled || (!nextHole && match === null);
    if (!ok) {
      refuse(
        "url-scheme-split",
        start + 1,
        after === ""
          ? `is followed directly by another hole in the ${name} URL, so together the values could form a scheme such as javascript:. Build the URL in code (for example with safeUrl) and use one hole: ${name}="${MARK}".`
          : `is followed by the template text "${after}" before the URL's first /, ? or #, so together they could form a scheme such as javascript:. Build the URL in code (for example with safeUrl) and use one hole: ${name}="${MARK}".`,
      );
      return;
    }
    for (const p of rest.slice(1))
      if (typeof p === "number") holes[p] = { k: "attr", name };
  };

  /** A URL list (srcset, ping, SVG animation values): each entry's static prefix, then the whole value at render time. */
  const finalizeList = (
    a: Attr,
    slot: Exclude<UrlSlot, "url" | null>,
    image: boolean,
  ): void => {
    const boundary = LIST_BOUNDARY[slot];
    let token = "";
    let failed = false;
    for (const p of a.parts) {
      if (typeof p === "string") {
        for (const c of p) token = boundary.test(c) ? "" : token + c;
        continue;
      }
      const verdict = prefixVerdict(token, image);
      if (verdict === "split") {
        failed = true;
        refuse("url-scheme-split", p + 1, splitReason(a.name, token));
      } else if (verdict === "script") {
        failed = true;
        refuse("script-url", p + 1, scriptUrlReason(token));
      }
      token += "\u0000";
    }
    if (failed) return;
    const hole: Hole = { k: "list", name: a.name, slot, image, group: a.parts };
    for (const p of a.parts) if (typeof p === "number") holes[p] = hole;
  };

  const innermostRoot = (): string => {
    for (let at = open.length - 1; at >= 0; at--)
      if (open[at].tag === "svg" || open[at].tag === "math")
        return open[at].tag;
    return "svg";
  };

  /** A start tag inside foreign content: track it for the end-tag rule. */
  const openElement = (tag: string, selfClosing: boolean): void => {
    const parent = open[open.length - 1];
    const html =
      parent.html || INTEGRATION_POINTS.has(parent.tag) || BREAKOUT.has(tag);
    if (html ? VOID.has(tag) : selfClosing) return;
    open.push({ tag, html });
  };

  /**
   * An end tag inside foreign content, as the tree builder reads it ("any
   * other end tag" in foreign content): walking down from the current node
   * through foreign elements, the first one with the tag's name closes, with
   * everything above it. On reaching an element that may be HTML, the HTML
   * rules apply, where an end tag closes only an HTML element of that name
   * and an </svg> or </math> is ignored. Closing only the current node there
   * is conservative: a missed close keeps html in foreign content, which is
   * the stricter reading.
   */
  const closeElement = (tag: string): void => {
    for (let at = open.length - 1; at >= 0; at--) {
      const entry = open[at];
      if (entry.tag === tag && (!entry.html || at === open.length - 1)) {
        for (let k = open.length - 1; k >= at; k--) {
          const t = open[k].tag;
          if (!open[k].html && (t === "svg" || t === "math")) roots--;
        }
        open.length = at;
        return;
      }
      if (entry.html) return;
    }
  };

  const emitTag = (selfClosing: boolean): void => {
    const tag = tagName;
    if (!isEnd) for (const a of attrs) finalizeAttr(a, tag);
    else
      for (const h of tagHoles)
        holes[h.hole] = { k: "attr", name: h.attr.name };
    state = S.Data;
    if (isEnd) {
      if (roots > 0) closeElement(tag);
      if (foreignCode !== null) {
        if (tag === foreignCode.tag && --foreignCode.count === 0)
          foreignCode = null;
        else if (roots < foreignCode.depth) foreignCode = null;
      }
      return;
    }
    if (tag === "svg" || tag === "math") {
      if (!selfClosing) {
        open.push({ tag, html: false });
        roots++;
      }
      return;
    }
    if (roots > 0) openElement(tag, selfClosing);
    const textElement =
      RAW_CODE.has(tag) ||
      RAW_TEXT.has(tag) ||
      RCDATA.has(tag) ||
      tag === "plaintext";
    if (roots > 0 && !(mode & FOREIGN_AS_HTML)) {
      // Foreign content: every body is markup. A <script> or <style> body
      // still runs, so holes until its end tag are refused.
      if (textElement) foreignText = true;
      if (selfClosing) return;
      if (RAW_CODE.has(tag)) {
        if (foreignCode === null) foreignCode = { tag, depth: roots, count: 1 };
        else if (foreignCode.tag === tag) foreignCode.count++;
      }
      return;
    }
    if (roots > 0 && selfClosing) return;
    if (RAW_CODE.has(tag)) {
      textMode = "code";
      const type = attrs.find((x) => x.name === "type");
      jsonScript =
        tag === "script" &&
        type !== undefined &&
        type.holes === 0 &&
        JSON_TYPES.has(asciiLower(type.parts.join("") as string).trim());
    } else if (tag === "plaintext") {
      // Older parsers ignore <plaintext> inside <select>, and a fragment
      // nested in <svg> or <math> reads it as markup: the rest is also read
      // as markup (MARKUP_BODIES), so its refusals and URL checks count.
      if (mode & MARKUP_BODIES) return;
      rawBodies = true;
      state = S.Plaintext;
      return;
    } else if (RCDATA.has(tag) || RAW_TEXT.has(tag)) {
      if (mode & MARKUP_BODIES) return;
      rawBodies = true;
      textMode = RCDATA.has(tag) ? "rcdata" : "raw";
    } else return;
    textTag = tag;
    textBody = [];
    state = S.Text;
  };

  /** The element's end: settle the holes in a script, style or text element. */
  const endText = (): void => {
    const body = textBody;
    const indices = body.filter((p): p is number => typeof p === "number");
    if (textMode === "code") {
      const text = body.filter((p) => typeof p === "string").join("");
      if (text.includes("<!--")) ambiguous = textTag;
      // Nested in <svg> or <math>, this body would be read as markup.
      if (text.includes("<")) foreignUnsafe = true;
      const onlyJson =
        jsonScript &&
        indices.length === 1 &&
        body.every((p) => typeof p === "number" || p.trim() === "");
      if (onlyJson) holes[indices[0]] = { k: "json" };
      else
        for (const i of indices)
          refuse(
            textTag === "style" ? "style-body" : "script-body",
            i + 1,
            textTag === "style"
              ? REASONS["style-body"]()
              : REASONS["script-body"](),
          );
    }
    state = S.Data;
  };

  const scanText = (part: string, from: number): number => {
    // Find </tag followed by whitespace, / or > (case-insensitive).
    const lower = asciiLower(part);
    const needle = `</${textTag}`;
    let at = lower.indexOf(needle, from);
    while (at !== -1) {
      const next = part[at + needle.length];
      if (next === undefined || isSpace(next) || next === "/" || next === ">")
        break;
      at = lower.indexOf(needle, at + 1);
    }
    // `</tag` cut by the end of the part: the closing name is incomplete.
    if (at === -1 || part[at + needle.length] === undefined) {
      textBody.push(part.slice(from));
      return part.length;
    }
    textBody.push(part.slice(from, at));
    endText();
    // The end tag itself: continue in the end-tag name state.
    tagName = textTag;
    isEnd = true;
    attrs = [];
    tagHoles = [];
    state = S.TagName;
    return at + needle.length;
  };

  for (let p = 0; p < strings.length; p++) {
    const part = strings[p];
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      switch (state as S) {
        case S.Data:
          if (c === "<") {
            state = S.TagOpen;
            tagName = "";
          }
          i++;
          break;
        case S.TagOpen:
          if (isAlpha(c)) {
            tagName = "";
            isEnd = false;
            attrs = [];
            tagHoles = [];
            state = S.TagName;
          } else if (c === "/") {
            state = S.EndTagOpen;
            i++;
          } else if (c === "!") {
            const rest = part.slice(i + 1);
            if (rest.startsWith("--")) {
              // <!--> and <!---> close at once.
              if (rest.startsWith("-->")) i += 4;
              else if (rest.startsWith("--->")) i += 5;
              else {
                state = S.Comment;
                commentEnd = "-->";
                i += 3;
              }
              if (state !== S.Comment) state = S.Data;
            } else if (/^\[CDATA\[/i.test(rest)) {
              cdata = true;
              state = S.Comment;
              commentEnd = roots > 0 ? "]]>" : ">";
              i += 8;
            } else {
              state = S.Bogus;
              i++;
            }
          } else if (c === "?") {
            state = S.Bogus;
            i++;
          } else state = S.Data;
          break;
        case S.EndTagOpen:
          if (isAlpha(c)) {
            tagName = "";
            isEnd = true;
            attrs = [];
            tagHoles = [];
            state = S.TagName;
          } else if (c === ">") {
            state = S.Data;
            i++;
          } else state = S.Bogus;
          break;
        case S.TagName:
          if (isSpace(c)) state = S.BeforeAttrName;
          else if (c === "/") state = S.SelfClosing;
          else if (c === ">") emitTag(false);
          else tagName += asciiLower(c);
          i++;
          break;
        case S.BeforeAttrName:
          if (isSpace(c)) i++;
          else if (c === "/" || c === ">") state = S.AfterAttrName;
          else {
            startAttr(c === "=" ? "=" : "");
            if (c === "=") i++;
            state = S.AttrName;
          }
          break;
        case S.AttrName:
          if (isSpace(c)) state = S.AfterAttrName;
          else if (c === "/") state = S.SelfClosing;
          else if (c === ">") emitTag(false);
          else if (c === "=") state = S.BeforeAttrValue;
          else attr!.name += asciiLower(c);
          i++;
          break;
        case S.AfterAttrName:
          if (isSpace(c)) i++;
          else if (c === "/") {
            state = S.SelfClosing;
            i++;
          } else if (c === "=") {
            state = S.BeforeAttrValue;
            i++;
          } else if (c === ">") {
            emitTag(false);
            i++;
          } else {
            startAttr("");
            state = S.AttrName;
          }
          break;
        case S.BeforeAttrValue:
          if (isSpace(c)) i++;
          else if (c === '"') {
            state = S.AttrValueDq;
            i++;
          } else if (c === "'") {
            state = S.AttrValueSq;
            i++;
          } else if (c === ">") {
            emitTag(false);
            i++;
          } else state = S.AttrValueUq;
          break;
        case S.AttrValueDq:
        case S.AttrValueSq: {
          const quote = state === S.AttrValueDq ? '"' : "'";
          const end = part.indexOf(quote, i);
          const text = part.slice(i, end === -1 ? part.length : end);
          if (text) attr!.parts.push(text);
          if (end === -1) i = part.length;
          else {
            state = S.AfterAttrValueQuoted;
            i = end + 1;
          }
          break;
        }
        case S.AttrValueUq:
          if (isSpace(c)) state = S.BeforeAttrName;
          else if (c === ">") emitTag(false);
          else {
            // Keep the static text: attributeName=onclick and
            // type=application/json are read like their quoted forms.
            const parts = attr!.parts;
            const last = parts.length - 1;
            if (last >= 0 && typeof parts[last] === "string")
              parts[last] = (parts[last] as string) + c;
            else parts.push(c);
          }
          i++;
          break;
        case S.AfterAttrValueQuoted:
          if (isSpace(c)) {
            state = S.BeforeAttrName;
            i++;
          } else if (c === "/") {
            state = S.SelfClosing;
            i++;
          } else if (c === ">") {
            emitTag(false);
            i++;
          } else state = S.BeforeAttrName;
          break;
        case S.SelfClosing:
          if (c === ">") {
            emitTag(true);
            i++;
          } else state = S.BeforeAttrName;
          break;
        case S.Comment: {
          if (commentEnd === "-->") {
            const a = part.indexOf("-->", i);
            const b = part.indexOf("--!>", i);
            const end = a === -1 ? b : b === -1 ? a : Math.min(a, b);
            if (end === -1) i = part.length;
            else {
              i = end + (end === b && (a === -1 || b < a) ? 4 : 3);
              state = S.Data;
            }
          } else {
            const end = part.indexOf(commentEnd, i);
            if (end === -1) i = part.length;
            else {
              i = end + commentEnd.length;
              state = S.Data;
            }
          }
          break;
        }
        case S.Bogus: {
          const end = part.indexOf(">", i);
          if (end === -1) i = part.length;
          else {
            i = end + 1;
            state = S.Data;
          }
          break;
        }
        case S.Text:
          i = scanText(part, i);
          break;
        case S.Plaintext:
          i = part.length;
          break;
      }
    }
    if (p === strings.length - 1) break;

    // The hole after this part.
    const hole = p;
    const n = p + 1;
    if (
      (state as S) !== S.Data &&
      (state as S) !== S.Plaintext &&
      (state as S) !== S.Text
    )
      holes[hole] = { k: "text" };
    // emitTag sets foreignCode; TypeScript cannot see that from here.
    const openCode = foreignCode as { tag: string } | null;
    if (openCode !== null)
      refuse(
        openCode.tag === "style" ? "style-body" : "script-body",
        n,
        openCode.tag === "style"
          ? REASONS["style-body"]()
          : REASONS["script-body"](),
      );
    if ((ambiguous !== null || cdata) && (state as S) !== S.Comment) {
      if (cdata) refuse("comment", n, REASONS.comment());
      else
        refuse(
          "script-comment-ambiguous",
          n,
          `follows a <${ambiguous}> whose text contains <!--, which changes where the browser ends the ${ambiguous === "style" ? "style" : "script"}, so html cannot tell where hole ${n} lands. Remove <!-- from the ${ambiguous === "style" ? "style" : "script"}.`,
        );
    }
    switch (state as S) {
      case S.Data:
      case S.Plaintext:
        holes[hole] = roots > 0 ? { k: "text", foreign: true } : { k: "text" };
        break;
      case S.Text:
        textBody.push(hole);
        holes[hole] =
          (textMode as string) === "rcdata"
            ? { k: "rcdata", tag: textTag }
            : (textMode as string) === "raw"
              ? { k: "text", raw: textTag }
              : { k: "text" };
        break;
      case S.TagOpen:
      case S.EndTagOpen:
      case S.TagName:
        refuse("tag-name", n, REASONS["tag-name"]());
        break;
      case S.BeforeAttrName:
      case S.AttrName:
      case S.AfterAttrName:
      case S.AfterAttrValueQuoted:
      case S.SelfClosing:
        refuse("attribute-name", n, REASONS["attribute-name"](tagName));
        break;
      case S.BeforeAttrValue:
      case S.AttrValueUq:
        refuse(
          "unquoted-attribute",
          n,
          REASONS["unquoted-attribute"](attr!.name),
        );
        break;
      case S.AttrValueDq:
      case S.AttrValueSq:
        attr!.parts.push(hole);
        attr!.holes++;
        tagHoles.push({ hole, attr: attr! });
        holes[hole] = { k: "attr", name: attr!.name };
        break;
      case S.Comment:
      case S.Bogus:
        refuse("comment", n, REASONS.comment());
        break;
    }
  }

  if (refusal === undefined) {
    let where: string | null = null;
    switch (state as S) {
      case S.Data:
        if (roots > 0) {
          const root = innermostRoot();
          where = `inside <${root}> (the </${root}> end tag is missing)`;
        }
        break;
      case S.Plaintext:
        break;
      case S.AttrValueDq:
      case S.AttrValueSq:
        where = `inside the ${attr!.name} attribute of <${tagName}> (the quote is not closed)`;
        break;
      case S.Comment:
      case S.Bogus:
        where = "inside a comment or <!...> declaration (it is not closed)";
        break;
      case S.Text:
        where = `inside <${textTag}> (the </${textTag}> end tag is missing)`;
        break;
      default:
        where = tagName
          ? `inside the <${isEnd ? "/" : ""}${tagName}> tag (the > is missing)`
          : "inside a tag (the > is missing)";
    }
    if (where !== null)
      refusal = {
        code: "unterminated",
        hole: 0,
        reason: `ends ${where}. ${FRAGMENT_RULE}`,
      };
    else if (ambiguous !== null)
      refusal = {
        code: "script-comment-ambiguous",
        hole: 0,
        reason: `has a <${ambiguous}> whose text contains <!--, which changes where the browser ends it, so the fragment cannot be nested safely. Remove <!-- from the ${ambiguous}.`,
      };
  }
  return { holes, refusal, foreignUnsafe, rawBodies, foreignText };
};

/** How strict a hole's rendering is: the merged reading keeps the strictest. */
const RANK: Readonly<Record<Hole["k"], number>> = {
  json: 0,
  text: 1,
  rcdata: 2,
  attr: 3,
  url: 4,
  list: 4,
};

/**
 * Compile every reading the static text needs (see MARKUP_BODIES) and keep,
 * for each hole, the strictest: a refusal in any reading refuses, and a hole
 * that is a URL in one reading is URL-checked in all of them.
 */
const compileAll = (strings: readonly string[]): Omit<Compiled, "parts"> => {
  const passes: Pass[] = [];
  const queued = new Set([0]);
  const queue = [0];
  while (queue.length > 0) {
    const mode = queue.shift()!;
    const pass = compile(strings, mode);
    passes.push(pass);
    for (const next of [
      pass.rawBodies ? mode | MARKUP_BODIES : mode,
      pass.foreignText ? mode | FOREIGN_AS_HTML : mode,
    ])
      if (!queued.has(next)) {
        queued.add(next);
        queue.push(next);
      }
  }
  const [first] = passes;
  if (passes.length === 1)
    return {
      holes: first.holes,
      refusal: first.refusal,
      foreignUnsafe: first.foreignUnsafe,
    };
  let refusal: Refusal | undefined;
  const order = (r: Refusal): number => (r.hole === 0 ? Infinity : r.hole);
  for (const pass of passes)
    if (
      pass.refusal !== undefined &&
      (refusal === undefined || order(pass.refusal) < order(refusal))
    )
      refusal = pass.refusal;
  const holes = first.holes.map((hole, i) => {
    let best = hole;
    let foreign = false;
    let rawTag: string | undefined;
    for (const pass of passes) {
      const other = pass.holes[i];
      if (other === undefined) continue;
      if (other.k === "text" && other.foreign) foreign = true;
      if (other.k === "text" && other.raw !== undefined) rawTag = other.raw;
      if (best === undefined || RANK[other.k] > RANK[best.k]) best = other;
    }
    if (best?.k !== "text" || (!foreign && rawTag === undefined)) return best;
    const text: Hole = { k: "text" };
    if (foreign) text.foreign = true;
    if (rawTag !== undefined) text.raw = rawTag;
    return text;
  }) as Hole[];
  return {
    holes,
    refusal,
    foreignUnsafe: passes.some((pass) => pass.foreignUnsafe),
  };
};

// ─── Rendering ──────────────────────────────────────────────────────────────

const cache = new WeakMap<readonly string[], Compiled>();

const describe = (value: unknown): string =>
  isHtml(value)
    ? "an html`...` or raw() value"
    : Array.isArray(value)
      ? "an array"
      : value === null
        ? "null"
        : typeof value === "object"
          ? "an object"
          : typeof value === "undefined"
            ? "undefined"
            : `a ${typeof value}`;

/** Per-render state: one per html call, so a re-entrant call (a value's toString) has its own. */
interface RenderState {
  /** A nested html value carried FOREIGN. */
  foreign: boolean;
}

/** Arrays in a text hole nest at most this deep (a cycle reaches it too). */
const MAX_ARRAY_DEPTH = 1000;

const UNCONVERTIBLE =
  "cannot be converted to text (its toString or valueOf is missing, or threw a TypeError).";

/**
 * String(value) for a value that is not a string, html, array or Promise. An
 * object with no usable toString (a JSON or query-string field, a
 * null-prototype object) throws a TypeError there; it becomes a located
 * HtmlError. Other errors from an author's toString pass through.
 */
const textOf = (
  value: unknown,
  strings: readonly string[],
  n: number,
): string => {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return String(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const located = holeError(
      strings,
      "unconvertible-value",
      n,
      `received an object that ${UNCONVERTIBLE} Data from JSON or a query string can hold an object where a string was expected: check that the value is a string before you use it.`,
    );
    (located as { cause?: unknown }).cause = error;
    throw located;
  }
};

/**
 * Whether `text` holds `</tag` followed by whitespace, /, > or its end (where
 * what follows the value could complete it), ASCII case-insensitive: the
 * browser ends a raw-text element there, wherever the value meant it.
 */
const endsRawText = (text: string, tag: string): boolean => {
  if (!text.includes("</")) return false;
  const lower = asciiLower(text);
  const needle = `</${tag}`;
  for (
    let at = lower.indexOf(needle);
    at !== -1;
    at = lower.indexOf(needle, at + 1)
  ) {
    const next = text[at + needle.length];
    if (next === undefined || isSpace(next) || next === "/" || next === ">")
      return true;
  }
  return false;
};

const renderText = (
  value: unknown,
  strings: readonly string[],
  n: number,
  state: RenderState,
  foreign: boolean,
  /** The text-only element (<title>, <textarea>) the hole is in, if any. */
  textOnly: string | undefined,
  /** The raw-text element (<xmp>, <iframe>, <noscript>, ...) the hole is in, if any. */
  rawText: string | undefined,
  depth: number,
): string => {
  if (typeof value === "string") return escapeHtml(value);
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "object") {
    const text = (value as Record<symbol, unknown>)[HTML];
    if (typeof text === "string") {
      if (textOnly !== undefined)
        throw holeError(
          strings,
          "markup-in-text-only",
          n,
          `received an html\`...\` or raw() value, but <${textOnly}> holds text only. Pass a string.`,
        );
      if (rawText !== undefined && endsRawText(text, rawText))
        throw holeError(
          strings,
          "raw-text-end",
          n,
          REASONS["raw-text-end"](rawText),
        );
      if ((value as Record<symbol, unknown>)[FOREIGN] === true) {
        if (foreign)
          throw holeError(
            strings,
            "foreign-content",
            n,
            REASONS["foreign-content"](),
          );
        state.foreign = true;
      }
      return text;
    }
    if (Array.isArray(value)) {
      if (depth >= MAX_ARRAY_DEPTH)
        throw holeError(
          strings,
          "array-depth",
          n,
          `received an array nested more than ${MAX_ARRAY_DEPTH} levels deep, or an array that contains itself. Flatten the data in code before you put it in the template.`,
        );
      let out = "";
      for (const item of value)
        out += renderText(
          item,
          strings,
          n,
          state,
          foreign,
          textOnly,
          rawText,
          depth + 1,
        );
      return out;
    }
    if (isThenable(value))
      throw holeError(
        strings,
        "promise",
        n,
        "received a Promise. Await the value before putting it in the template.",
      );
  }
  return escapeHtml(textOf(value, strings, n));
};

/** The text of a value in an attribute, before escaping. */
const attrText = (
  value: unknown,
  name: string,
  strings: readonly string[],
  n: number,
): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || value === false) return "";
  if (typeof value === "object") {
    if (isHtml(value))
      throw holeError(
        strings,
        "markup-in-attribute",
        n,
        `(the ${name} attribute) received an html\`...\` or raw() value. An attribute holds text; pass a string, which html escapes.`,
      );
    if (Array.isArray(value))
      throw holeError(
        strings,
        "array-in-attribute",
        n,
        `(the ${name} attribute) received an array. An attribute holds one text value; join it in code, for example \${classes.join(" ")}.`,
      );
    if (isThenable(value))
      throw holeError(
        strings,
        "promise",
        n,
        "received a Promise. Await the value before putting it in the template.",
      );
  }
  return textOf(value, strings, n);
};

/** Whether every URL in a list value is safe, splitting on every separator a value could carry. */
const listSafe = (
  slot: Exclude<UrlSlot, "url" | null>,
  value: string,
  image: boolean,
): boolean => {
  if (!isSafeUrl(value, image) || !isSafeUrlValue(slot, value, image))
    return false;
  if (slot !== "srcset") return true;
  for (const token of value.split(/[\t\n\f\r ,]+/))
    if (token !== "" && !isSafeUrl(token, image)) return false;
  return srcsetUrls(value).every((url) => isSafeUrl(url, image));
};

const render = (
  compiled: Compiled,
  strings: readonly string[],
  values: readonly unknown[],
  state: RenderState,
): string => {
  const holes = compiled.holes;
  let out = strings[0];
  let listOut: Map<number, string> | undefined;
  for (let i = 0; i < values.length; i++) {
    const hole = holes[i];
    const value = values[i];
    const n = i + 1;
    let text: string;
    switch (hole.k) {
      case "text":
        text = renderText(
          value,
          strings,
          n,
          state,
          hole.foreign === true,
          undefined,
          hole.raw,
          0,
        );
        break;
      case "rcdata":
        text = renderText(
          value,
          strings,
          n,
          state,
          false,
          hole.tag,
          undefined,
          0,
        );
        break;
      case "attr":
        text = escapeHtml(attrText(value, hole.name, strings, n));
        break;
      case "url": {
        const url = attrText(value, hole.name, strings, n);
        text = isSafeUrl(url, hole.image) ? escapeHtml(url) : BLOCKED_URL;
        break;
      }
      case "list": {
        const done = listOut?.get(i);
        if (done !== undefined) {
          text = done;
          break;
        }
        // Render the whole attribute once: each value, then the assembled list.
        listOut ??= new Map();
        const own = new Map<number, string>();
        let assembled = "";
        for (const p of hole.group) {
          if (typeof p === "string") {
            assembled += p;
            continue;
          }
          const raw = attrText(values[p], hole.name, strings, p + 1);
          const safe = listSafe(hole.slot, raw, hole.image);
          own.set(p, safe ? raw : BLOCKED_URL);
          assembled += safe ? raw : BLOCKED_URL;
        }
        const whole = isSafeUrlValue(hole.slot, assembled, hole.image);
        for (const [index, raw] of own)
          listOut.set(index, whole ? escapeHtml(raw) : BLOCKED_URL);
        text = listOut.get(i)!;
        break;
      }
      case "json":
        if (isJson(value)) {
          text = value[JSON_TEXT];
          break;
        }
        throw holeError(
          strings,
          "json-script-value",
          n,
          `received ${describe(value)}. Only json(value) can fill this script, so the data cannot end it early.`,
        );
    }
    out += text + strings[n];
  }
  return out;
};

const NOT_TAGGED =
  "html is a tagged template: write html`<p>${value}</p>`, not html(...). To insert trusted markup, use raw(value).";

/**
 * Safe HTML from a template: each value is escaped for where it lands, and
 * places escaping cannot make safe throw an HtmlError.
 */
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml => {
  if (
    !Array.isArray(strings) ||
    !Array.isArray((strings as { raw?: unknown }).raw)
  )
    throw new TypeError(NOT_TAGGED);
  let compiled = cache.get(strings);
  if (compiled === undefined) {
    // A cooked part is undefined after an invalid escape; its raw text stands in.
    const parts = strings.map((part, i) => part ?? strings.raw[i]);
    compiled = { ...compileAll(parts), parts };
    cache.set(strings, compiled);
  }
  const texts = compiled.parts;
  const { refusal, foreignUnsafe } = compiled;
  if (refusal !== undefined) {
    if (refusal.hole === 0) {
      const template = excerpt(texts, 0);
      throw new HtmlError(
        refusal.code,
        0,
        template,
        `html: the template html\`${template}\` ${refusal.reason}`,
      );
    }
    throw holeError(texts, refusal.code, refusal.hole, refusal.reason);
  }
  const state: RenderState = { foreign: false };
  const text = render(compiled, texts, values, state);
  return new Html(text, foreignUnsafe || state.foreign) as unknown as SafeHtml;
};

/** Trusted HTML (sanitized CMS or Markdown output), inserted as is. Visible in code on purpose. */
export const raw = (
  value: string | number | SafeHtml | null | undefined,
): SafeHtml => {
  if (value === null || value === undefined)
    return new Html("") as unknown as SafeHtml;
  if (typeof value === "object") {
    if (isHtml(value)) return value;
    if (Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw))
      throw new TypeError(
        "raw() takes a string of trusted HTML, not a template. Use html`...` for templates.",
      );
    if (Array.isArray(value))
      throw new TypeError(
        "raw() takes one string of trusted HTML; received an array. Map each item to html`...` or raw(item).",
      );
    if (isThenable(value))
      throw new TypeError("raw() received a Promise. Await the value first.");
    throw new TypeError(
      "raw() takes one string of trusted HTML; received an object. Pass the HTML string.",
    );
  }
  return new Html(String(value)) as unknown as SafeHtml;
};

/** Entity-escape a value for text or a quoted attribute, for code that builds strings without html. */
export const esc = (value: unknown): string => {
  if (value === null || value === undefined || value === false) return "";
  if (typeof value !== "object") return escapeHtml(String(value));
  try {
    return escapeHtml(String(value));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TypeError(
      `esc() received an object that ${UNCONVERTIBLE} Check that the value is a string before you use it.`,
      { cause: error },
    );
  }
};

export interface SafeUrlOptions {
  /** Resolve the URL against this base and return the absolute URL. */
  base?: string | URL;
  /** Only URLs on these origins (and same-site relative paths) pass. */
  origins?: readonly string[];
  /** An image slot: also keep data:image/* URLs. */
  image?: boolean;
}

const originsOf = (origins: unknown): Set<string> => {
  if (!Array.isArray(origins))
    throw new TypeError(
      "safeUrl: origins must be an array of origins such as https://cdn.example.com.",
    );
  const set = new Set<string>();
  origins.forEach((entry: unknown, index) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(String(entry));
    } catch {
      parsed = null;
    }
    const text = String(entry).replace(/\/$/, "");
    if (
      parsed === null ||
      parsed.origin === "null" ||
      text.toLowerCase() !== parsed.origin.toLowerCase()
    ) {
      const suggestion =
        parsed !== null && parsed.origin !== "null"
          ? parsed.origin
          : `https://${
              String(entry)
                .replace(/^[a-z]+:\/*|^\/+/i, "")
                .split(/[/?#]/)[0]
            }`;
      throw new TypeError(
        `safeUrl: origins[${index}] ${JSON.stringify(String(entry))} is not an origin. Write it as ${suggestion}.`,
      );
    }
    set.add(parsed.origin);
  });
  return set;
};

/**
 * `value` when it is a URL that cannot run script, else "about:invalid".
 * With `base` the result is resolved against it; with `origins` only those
 * origins (and same-site relative paths) pass. It never escapes: html or
 * esc does that.
 */
export const safeUrl = (
  value: unknown,
  options?: string | URL | SafeUrlOptions,
): string => {
  const opts: SafeUrlOptions =
    typeof options === "string" || options instanceof URL
      ? { base: options }
      : (options ?? {});
  const origins =
    opts.origins === undefined ? undefined : originsOf(opts.origins);
  const image = opts.image === true;
  const url =
    typeof value === "string"
      ? value
      : value instanceof URL
        ? value.href
        : null;
  if (url === null || !isSafeUrl(url, image)) return BLOCKED_URL;
  if (opts.base !== undefined) {
    let resolved: URL;
    let base: URL;
    try {
      base = new URL(String(opts.base));
      resolved = new URL(url, base);
    } catch {
      return BLOCKED_URL;
    }
    if (!isSafeUrl(resolved.href, image)) return BLOCKED_URL;
    if (
      origins !== undefined &&
      resolved.origin !== base.origin &&
      !origins.has(resolved.origin)
    )
      return BLOCKED_URL;
    return resolved.href;
  }
  if (origins === undefined) return url;
  const normalized = normalizeUrl(url);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    try {
      return origins.has(new URL(normalized).origin) ? url : BLOCKED_URL;
    } catch {
      return BLOCKED_URL;
    }
  }
  // No scheme: a path on this site passes; //host needs a base to resolve.
  return /^[\\/]{2}/.test(normalized) ? BLOCKED_URL : url;
};

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** JSON safe inside <script type="application/json"> (and as text or a quoted attribute in html). */
export const json = (value: unknown): JsonText => {
  const text = JSON.stringify(value ?? null) ?? "null";
  return new Json(
    text.replace(/[<>&\u2028\u2029]/g, (c) => JSON_ESCAPES[c]),
  ) as unknown as JsonText;
};
