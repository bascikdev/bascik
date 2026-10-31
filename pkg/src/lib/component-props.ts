import { createContentShield, shieldElementContents } from "./shielding.ts";
import {
  createAttributeValueScanner,
  scanWholeAttributes,
  startTagLength,
  type AttributeValueScanner,
} from "./component-attribute-scan.ts";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import { createMatchingCloseFinder } from "./component-tags.ts";
import {
  createAttributeScanner,
  createMarkerWalk,
  createWordNameOpenTagScanner,
  isRegexWhitespace,
  openTagsOf,
  replaceSpans,
  wordTagNameEnd as tagNameEnd,
} from "./element-content-scan.ts";
import { findCommentEnd } from "./html-scanner.ts";
import {
  ANIMATION_VALUES,
  BLOCKED_URL,
  BLOCKED_URL_REASONS,
  SVG_ANIMATIONS,
  blockedUrlKind,
  escapeHtml,
  isEventHandlerName,
  isSafeUrl,
  urlVerdict,
} from "./url-safety.ts";

/**
 * `html.replace(/<([a-zA-Z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi, replace)`
 * in linear time (`createWordNameOpenTagScanner`).
 */
const replaceOpenTags = (
  html: string,
  replace: (openingTag: string) => string,
): string =>
  replaceSpans(html, openTagsOf(createWordNameOpenTagScanner(html)), replace);

const decodePropEntities = (value: string): string =>
  value.replace(
    /&(amp|lt|gt|quot|#39|#x27);/gi,
    (_match, entity: string) =>
      ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        "#x27": "'",
      })[entity.toLowerCase()] ?? _match,
  );

// ─────────────────────────────────────────────────────────────────────────────
// Binding sinks (prompt 157 security audit)
//
// A prop value is whatever the usage tag carries: at request time, a value a
// server script escaped from visitor input. Entity escaping keeps it inside
// its attribute, but a few attributes give the browser a meaning to run:
// a URL with a script scheme, an event handler, an `srcdoc` document, or CSS
// that fetches. The same rules apply at build time, so a page and a script
// that write the same usage get the same markup.
// ─────────────────────────────────────────────────────────────────────────────

export { BLOCKED_URL };

/**
 * CSS with its escapes decoded (`\\75 rl` is `url`) and tabs and newlines
 * removed (the URL parser drops them), so a check sees what the browser
 * runs.
 */
const decodeCss = (css: string): string =>
  css
    .replace(
      /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g,
      (_m, hex?: string, char?: string) => {
        if (hex === undefined) return char === "\n" ? "" : (char ?? "");
        const code = Number.parseInt(hex, 16);
        return code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
          ? "\ufffd"
          : String.fromCodePoint(code);
      },
    )
    .replace(/[\t\n\r\f]/g, "");

/**
 * CSS that runs script or pulls in more CSS, in a style value after
 * `decodeCss`: `expression()`, legacy `behavior` (and `-ms-behavior`) and
 * `-moz-binding`, `@import`, and a script scheme anywhere. `behavior` is the
 * property itself, not the end of another name: `scroll-behavior` and
 * `overscroll-behavior` are ordinary CSS. A `url()` to an image on any site
 * is kept: CSP `img-src` governs where pictures load from.
 */
const UNSAFE_CSS =
  /expression\s*\(|(?<![\w-])(?:-ms-)?behavior\s*:|-moz-binding|@import|(?:java|vb|live)script\s*:|mocha\s*:/i;

/** Functions whose quoted strings are image URLs (`-webkit-` prefixed too). */
const IMAGE_FUNCTION = /(?:image-set|image|cross-fade)\s*\(/gi;

/**
 * Every URL in decoded CSS: each `url()` argument, and each quoted string
 * inside `image-set()`, `image()` or `cross-fade()`, the places a bare
 * string is a URL in a declaration. Any other string (`content: 'x'`, a
 * custom property such as `--caption: 'Data: Q3 sales'`) is text. One pass:
 * each function's arguments are skipped once read.
 */
const cssUrls = (css: string): string[] => {
  const urls: string[] = [];
  const pattern = /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))/gi;
  for (const match of css.matchAll(pattern))
    urls.push(match[1] ?? match[2] ?? match[3] ?? "");
  IMAGE_FUNCTION.lastIndex = 0;
  while (IMAGE_FUNCTION.exec(css) !== null) {
    let index = IMAGE_FUNCTION.lastIndex;
    let depth = 1;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === '"' || char === "'") {
        const close = css.indexOf(char, index + 1);
        const end = close === -1 ? css.length : close;
        urls.push(css.slice(index + 1, end));
        index = end + 1;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") depth--;
      index++;
    }
    IMAGE_FUNCTION.lastIndex = index;
  }
  return urls;
};

/**
 * `security.blockScriptUrls` and `security.blockCodeBindings`, as the build
 * recorded them (the component manifest carries them to request time). Off
 * means the value is bound as written, with no warning; it is still escaped
 * for where it lands, so it stays one attribute value or one element's text.
 */
export interface BindingPolicy {
  /** Script URLs such as `javascript:` in a bound URL attribute become `about:invalid`. */
  blockScriptUrls: boolean;
  /** Event handlers, srcdoc, meta http-equiv, SVG animation targets, unsafe styles and script/style receivers are refused. */
  blockCodeBindings: boolean;
}

/** Both protections on: the behavior with no `security` config. */
export const DEFAULT_BINDING_POLICY: Readonly<BindingPolicy> = Object.freeze({
  blockScriptUrls: true,
  blockCodeBindings: true,
});

/** What `injectPropAttributes` does with one bound value. */
type BindingVerdict =
  | { kind: "bind"; value: string; blocked?: keyof typeof BLOCKED_URL_REASONS }
  | { kind: "refuse"; reason: string };

/** The context of a binding: the element and the attributes it already has. */
interface BindingContext {
  tagName: string;
  /** Lowercased name to raw value, for the authored attributes. */
  attrs: ReadonlyMap<string, string>;
}

const EVENT_HANDLER_REASON =
  "an event handler's value is code, so a prop is never bound to one. Bind a data-* attribute and read it from a component script";

/**
 * Decide how a bound value may reach `targetName` on its element:
 *
 * - an event handler (`on` and letters) or `srcdoc` is never bound: its
 *   value is code or a document, which no escaping makes safe; nor is a
 *   `<meta http-equiv>` value, or which attribute an SVG animation sets;
 * - a URL target keeps any URL but a script URL such as `javascript:` or
 *   a `data:` URL, which becomes `about:invalid`; an image slot
 *   also keeps a `data:image/*` URL; a list (`srcset`, `ping`) or an SVG
 *   animation's values are checked entry by entry;
 * - a URL the page runs or applies (`<script src>`, `<base href>`, a
 *   stylesheet `<link href>`) takes any http(s) URL, as browsers allow:
 *   protecting what a site loads is CSP's job (see /security);
 * - a `style` value that runs script or imports CSS is not bound.
 *
 * Every other target binds the value as it is. The value is escaped by the
 * caller either way, so the attribute never ends early.
 */
const bindingVerdict = (
  context: BindingContext,
  targetName: string,
  value: string,
  policy: BindingPolicy,
): BindingVerdict => {
  const tag = context.tagName.toLowerCase();
  const target = targetName.toLowerCase();
  if (!policy.blockCodeBindings) {
    if (!policy.blockScriptUrls) return { kind: "bind", value };
    return urlVerdict(tag, target, value) === "blocked"
      ? {
          kind: "bind",
          value: BLOCKED_URL,
          blocked: blockedUrlKind(tag, target, value),
        }
      : { kind: "bind", value };
  }
  if (isEventHandlerName(target))
    return { kind: "refuse", reason: EVENT_HANDLER_REASON };
  if (target === "srcdoc")
    return {
      kind: "refuse",
      reason:
        "an srcdoc value is an HTML document that runs with the page's origin, so a prop is never bound to one. Bind src to a URL instead",
    };
  if (
    tag === "meta" &&
    (target === "http-equiv" ||
      (target === "content" && context.attrs.has("http-equiv")))
  )
    return {
      kind: "refuse",
      reason:
        "a <meta http-equiv> value acts on the page (a redirect, a policy), so a prop is never bound to one",
    };
  if (SVG_ANIMATIONS.has(tag)) {
    if (target === "attributename" || target === "attributetype")
      return {
        kind: "refuse",
        reason:
          "a prop never chooses which attribute an SVG animation sets. Write attributeName in the template",
      };
    if (ANIMATION_VALUES.has(target)) {
      const animated = (context.attrs.get("attributename") ?? "").toLowerCase();
      if (isEventHandlerName(animated.trim()))
        return { kind: "refuse", reason: EVENT_HANDLER_REASON };
    }
  }
  if (policy.blockScriptUrls && urlVerdict(tag, target, value) === "blocked")
    return {
      kind: "bind",
      value: BLOCKED_URL,
      blocked: blockedUrlKind(tag, target, value),
    };
  if (target === "style") {
    const css = decodeCss(value);
    if (
      UNSAFE_CSS.test(css) ||
      !cssUrls(css).every((url) => isSafeUrl(url, true))
    )
      return {
        kind: "refuse",
        reason:
          "the value runs script or imports CSS (expression(), behavior, -moz-binding, @import, or a script URL such as javascript: or a non-image data: URL), which a prop bound to style may not do. Bind a data-* attribute and style it from a scoped class",
      };
  }
  return { kind: "bind", value };
};

/** Raw-text elements whose content a prop receiver never replaces. */
const UNFILLABLE_RECEIVERS = new Set(["script", "style"]);

/**
 * A prop value for a `<script>` or `<style>` body, which is raw text: the
 * browser never decodes entities there, so the value goes in as written.
 * Only what would end the element early is changed: `</script` (or
 * `</style`) becomes `<\/script`, which a JS or CSS string reads as the same
 * text, and in a script `<!--` becomes `<\!--`, so it cannot start the
 * escaped state in which `<script` nests.
 */
const rawTextPropValue = (tagName: string, value: string): string =>
  tagName.toLowerCase() === "script"
    ? value.replace(/<(\/script|!--)/gi, "<\\$1")
    : value.replace(/<(\/style)/gi, "<\\$1");

/**
 * Extract data-bascik-prop-* attributes from a component usage tag string.
 * e.g. '<my-comp data-bascik-prop-title="Hello">' → { title: "Hello" }
 * `warn` receives the authoring diagnostics (a request host routes them to
 * its own log, prompt 157).
 */
export const extractProps = (
  componentContent: string | undefined,
  warn: (message: string) => void = console.warn,
): Record<string, string> => {
  const props: Record<string, string> = {};
  if (!componentContent || !/data-bascik-prop-/i.test(componentContent))
    return props;
  // The start tag, read as the browser reads it: a quote inside an unquoted
  // value (`title=it's`) does not start a quoted one.
  if (!/^<[a-zA-Z]/.test(componentContent)) return props;
  const openingTagLength = startTagLength(componentContent);
  if (openingTagLength === -1) return props;
  const openingTag = componentContent.slice(0, openingTagLength);
  // Only whole attribute names count. A token that looks like a prop marker
  // inside another attribute's quoted value (e.g. a doc reference in
  // `title="see data-bascik-prop-x"`) is text, never a prop.
  const propRegexpPrefix = /^data-bascik-prop-/i;
  for (const attr of scanWholeAttributes(openingTag)) {
    const propMatch = propRegexpPrefix.exec(attr.name);
    if (!propMatch) continue;
    const propName = attr.name.slice(propMatch[0].length);
    if (!/^[\w-]+$/.test(propName)) continue;
    // A valueless marker is a template receiver, not a provided value; it
    // contributes no prop (matching the pre-scanner extraction which required
    // an `= value`).
    if (attr.valueStart === -1) continue;
    const rawVal = openingTag.slice(attr.valueStart, attr.valueEnd);
    const isQuoted =
      openingTag[attr.valueStart - 1] === '"' ||
      openingTag[attr.valueStart - 1] === "'";
    if (isQuoted) {
      const followingCharacter = openingTag[attr.valueEnd + 1];
      if (followingCharacter && !/[\s/>]/.test(followingCharacter)) {
        warn(
          `Ignoring malformed data-bascik-prop-${propName}: the value contains an unescaped delimiting quote. Use &quot; or &#39; for quotes inside prop values.`,
        );
        continue;
      }
      props[propName] = decodePropEntities(rawVal);
    } else {
      // Unquoted value: everything up to whitespace or `>`, as the browser
      // reads it (`href=/a?b=c`). A trailing `/` belongs to the self-closing
      // syntax of a component usage, so drop it.
      const cleanUnquoted = rawVal.endsWith("/") ? rawVal.slice(0, -1) : rawVal;
      props[propName] = decodePropEntities(cleanUnquoted);
    }
  }
  return props;
};

/**
 * Where an attribute goes in an opening tag: before the whitespace, optional
 * `/` and `>` that end it (what `/\s*\/?>$/` matched), or -1 when the tag
 * does not end in `>`. A scan back from the end: the regex retried from every
 * position of a whitespace run, quadratic in a visitor value's run of spaces
 * that an earlier binding had already put in the tag.
 */
const closeOfTagIndex = (tag: string): number => {
  let at = tag.length - 1;
  if (at < 0 || tag.charCodeAt(at) !== 0x3e) return -1;
  if (at > 0 && tag.charCodeAt(at - 1) === 0x2f) at--;
  while (at > 0 && isRegexWhitespace(tag.charCodeAt(at - 1))) at--;
  return at;
};

/**
 * Fill `data-bascik-attr-<target>="<prop>"` bindings with the prop values.
 * `rewriteValue` sees each bound value with its target attribute's name
 * before escaping: a request-time renderer injects after scoping and maps id
 * references per target through the scoped id names (prompt 157).
 */
export const injectPropAttributes = (
  fileContent: string | undefined,
  props: Record<string, string>,
  rewriteValue?: (targetName: string, value: string) => string,
  warn: (message: string) => void = console.warn,
  policy: BindingPolicy = DEFAULT_BINDING_POLICY,
): string => {
  if (!fileContent) return "";
  if (!fileContent.includes("data-bascik-attr-")) return fileContent;

  const propsLowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(props)) {
    propsLowerMap.set(k.toLowerCase(), v);
  }

  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? hideComments(fileContent, commentShield.hide)
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);

  const rewritten = replaceOpenTags(rawShield.html, (openingTag: string) => {
    if (!openingTag.includes("data-bascik-attr-")) return openingTag;
    // Whole attribute names only: a token that looks like a directive inside
    // another attribute's quoted value is text, never a directive.
    const directives: Array<{
      start: number;
      end: number;
      targetName: string;
      rawPropName?: string;
    }> = [];
    for (const attr of scanWholeAttributes(openingTag)) {
      const match = /^data-bascik-attr-(.*)$/i.exec(attr.name);
      if (!match) continue;
      const targetName = match[1];
      const rawPropName =
        attr.valueStart !== -1
          ? openingTag.slice(attr.valueStart - 1, attr.valueEnd + 1)
          : undefined;
      let start = attr.start;
      if (start > 0 && /\s/.test(openingTag[start - 1])) start--;
      directives.push({
        start,
        end: attr.end,
        targetName,
        rawPropName,
      });
    }

    // Own keys only, as for slots: a binding to `toString` or `valueOf`
    // must not read Object.prototype's member.
    const lookupProp = (propName: string): string | undefined =>
      Object.hasOwn(props, propName)
        ? props[propName]
        : propsLowerMap.get(propName.toLowerCase());

    // The element and its authored attributes, read once and only when a
    // bound prop is present.
    let context: BindingContext | undefined;
    const bindingContext = (): BindingContext => {
      if (context) return context;
      const attrs = new Map<string, string>();
      for (const attr of scanWholeAttributes(openingTag)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("data-bascik-") || attrs.has(name)) continue;
        attrs.set(
          name,
          attr.valueStart === -1
            ? ""
            : openingTag.slice(attr.valueStart, attr.valueEnd),
        );
      }
      // A value another binding on this tag gives (`rel`, `attributeName`,
      // `http-equiv`) counts as written: the checks must see it.
      for (const { targetName, rawPropName } of directives) {
        const name = rawPropName?.slice(1, -1);
        const value = name === undefined ? undefined : lookupProp(name);
        if (value !== undefined) attrs.set(targetName.toLowerCase(), value);
      }
      context = {
        tagName: /^<([a-zA-Z][\w:-]*)/.exec(openingTag)?.[1] ?? "",
        attrs,
      };
      return context;
    };

    let result = openingTag;
    for (let index = directives.length - 1; index >= 0; index--) {
      const directive = directives[index];
      result = result.slice(0, directive.start) + result.slice(directive.end);
    }

    for (const { targetName, rawPropName } of directives) {
      const isQuoted =
        rawPropName?.startsWith('"') || rawPropName?.startsWith("'");
      const propName = isQuoted ? rawPropName?.slice(1, -1) : undefined;
      if (
        !/^[a-zA-Z_:][\w:.-]*$/.test(targetName) ||
        !propName ||
        !/^[a-zA-Z0-9_-]+$/.test(propName)
      ) {
        warn(
          `Ignoring malformed data-bascik-attr-${targetName}: expected a quoted prop name.`,
        );
        continue;
      }

      const propValue = lookupProp(propName);
      if (propValue === undefined) continue;
      const verdict = bindingVerdict(
        bindingContext(),
        targetName,
        rewriteValue ? rewriteValue(targetName, propValue) : propValue,
        policy,
      );
      if (verdict.kind === "refuse") {
        warn(
          `Ignoring data-bascik-attr-${targetName}="${propName}": ${verdict.reason}.`,
        );
        continue;
      }
      if (verdict.blocked)
        warn(
          `data-bascik-attr-${targetName}="${propName}" received ${BLOCKED_URL_REASONS[verdict.blocked]}, so ${targetName} is set to ${BLOCKED_URL}.`,
        );
      const attribute = ` ${targetName}="${escapeHtml(verdict.value)}"`;
      // Whole-name conflict check: the target may already exist, but a
      // "target-looking" token inside another attribute's quoted value is
      // text and must not count as the target.
      const existing = scanWholeAttributes(result).find(
        (attr) => attr.name.toLowerCase() === targetName.toLowerCase(),
      );
      if (existing) {
        warn(
          `Attribute binding conflict: attribute "${targetName}" already exists; prop "${propName}" wins.`,
        );
        result =
          result.slice(0, existing.start) +
          attribute.slice(1) +
          result.slice(existing.end);
      } else {
        const at = closeOfTagIndex(result);
        if (at !== -1)
          result = result.slice(0, at) + attribute + result.slice(at);
      }
    }

    return result;
  });
  return commentShield.restore(rawShield.restore(rewritten));
};

// ─────────────────────────────────────────────────────────────────────────────
// Prop injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace each comment with `hide(comment)`. A comment ends where the browser
 * ends it (`-->`, `--!>`, `<!-->`, `<!--->`, or the end of input), so a
 * marker after `--!>` is live markup and is acted on; a later `-->` must not
 * stretch the comment over it.
 */
const hideComments = (html: string, hide: (text: string) => string): string => {
  let result = "";
  let cursor = 0;
  let start = html.indexOf("<!--");
  while (start !== -1) {
    const end = findCommentEnd(html, start);
    const stop = end === -1 ? html.length : end;
    result += html.slice(cursor, start) + hide(html.slice(start, stop));
    cursor = stop;
    start = end === -1 ? -1 : html.indexOf("<!--", stop);
  }
  return result + html.slice(cursor);
};

/**
 * Text that can start or end a region `maskRawTextContent` blanks, or a
 * comment the way the HTML tokenizer ends one: `-->`, `--!>`, and the empty
 * `<!-->` and `<!--->` (both start with `<!--`). A superset is safe: a match
 * only sends a receiver down the slower, exact path.
 */
const RAW_TEXT_OR_COMMENT = /<\/?(?:script|style|textarea)\b|<!--|--!?>/i;

/** Whether `text` holds comment or raw-text syntax (see `RAW_TEXT_OR_COMMENT`). */
export const mayChangeMaskedRegions = (text: string): boolean =>
  RAW_TEXT_OR_COMMENT.test(text);

/**
 * For each prop, find elements in the component template that carry a
 * `data-bascik-prop-{name}` attribute, replace their inner content with the
 * prop value, and strip the marker attribute.
 *
 * e.g. template `<p data-bascik-prop-title></p>` + { title: "Hi" }
 *      → `<p>Hi</p>`
 */
export const injectProps = (
  fileContent: string | undefined,
  props: Record<string, string>,
  warn: (message: string) => void = console.warn,
  policy: BindingPolicy = DEFAULT_BINDING_POLICY,
): string => {
  if (!fileContent) return "";
  // With no lowercase marker, an empty props object returns early, and without any marker nothing changes.
  if (
    !fileContent.includes("data-bascik-prop-") &&
    (Object.keys(props).length === 0 || !/data-bascik-prop-/i.test(fileContent))
  )
    return fileContent;
  const commentShield = createContentShield(fileContent);
  const withoutComments = fileContent.includes("<!--")
    ? hideComments(fileContent, commentShield.hide)
    : fileContent;
  const rawShield = shieldElementContents(withoutComments, [
    "script",
    "style",
    "textarea",
  ]);
  let result = rawShield.html;
  const resultLower = result.toLowerCase();
  Object.entries(props).forEach(([propName, propValue]) => {
    if (!resultLower.includes(propName.toLowerCase())) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(propName)) return;
    const attrName = `data-bascik-prop-${propName}`;
    const escapedPropValue = escapeHtml(propValue);
    // Scan whole opening tags and act only on whole attribute names, so a
    // marker token inside another attribute's quoted value is never confused
    // with a receiver.
    // Filled receivers are collected and joined once per prop, not spliced
    // into the growing string one by one (quadratic in a template that
    // repeats a receiver). The masked text and the close finder are computed
    // once per pass and shared: the receivers come in document order, and
    // what precedes a receiver only changes by whole replaced elements, so
    // they agree with a fresh scan of the spliced string. A replaced element
    // that held raw-text or comment syntax keeps that agreement when the text
    // before it and its removed content are both closed (every script, style,
    // textarea and comment in them ends inside them); otherwise the pass
    // materializes and rescans from there, as a splice per receiver did.
    // `closedThrough` is how far the source is known closed (-1: not), so
    // each character is checked for closure once per pass.
    let source = result;
    // Rebuilt whenever `source` is.
    let openTags = createWordNameOpenTagScanner(source);
    // Built on the first receiver: most templates name a prop on few tags.
    let masked: string | null = null;
    let finder: ((tagName: string, contentStart: number) => number) | null =
      null;
    // The close finder decides what is inside an attribute value from the
    // whole text before a close tag, removed content included. `stateScan`
    // reads the same masked text, so a receiver whose removed content leaves
    // the scanner in another state than its escaped value would (a quote
    // that closes a value opened before it, in malformed markup) is caught
    // and rescanned, as a fresh scan of the spliced string would see it.
    let stateScan: AttributeValueScanner | null = null;
    const maskedSource = (): string => (masked ??= maskRawTextContent(source));
    const findClose = (tagName: string, contentStart: number): number =>
      (finder ??= createMatchingCloseFinder(source, maskedSource()))(
        tagName,
        contentStart,
      );
    const scanStateAt = (index: number) => {
      stateScan ??= createAttributeValueScanner(maskedSource());
      stateScan.isInsideValue(index);
      return stateScan.checkpoint();
    };
    // A tag that does not contain the marker's text cannot carry it as an
    // attribute name; only a tag that does is scanned attribute by attribute.
    // Unicode folding, so the prefilter passes every tag the lowercased
    // name test below accepts (U+212A KELVIN SIGN lowercases to "k").
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const mayCarryMarker = new RegExp(attrName, "iu");
    let closedThrough = 0;
    let parts: string[] = [];
    let cursor = 0;
    let searchIndex = 0;
    while (searchIndex < source.length) {
      const openFound = openTags.next(searchIndex);
      if (!openFound) break;
      const openMatch = { index: openFound.start };
      const openTag = source.slice(openFound.start, openFound.end);
      const tagName = source.slice(openFound.start + 1, openFound.chainStart);
      if (!mayCarryMarker.test(openTag)) {
        searchIndex = openMatch.index + openTag.length;
        continue;
      }
      const receiverAttr = scanWholeAttributes(openTag).find(
        (attr) =>
          attr.name.toLowerCase() === attrName.toLowerCase() &&
          attr.valueStart === -1 &&
          // A self-closing marker (`data-bascik-prop-x/>`) is not a receiver.
          (/[\s>]/.test(openTag[attr.nameEnd] ?? "") ||
            attr.nameEnd >= openTag.length),
      );
      if (!receiverAttr) {
        searchIndex = openMatch.index + openTag.length;
        continue;
      }
      // A script or style body is code: entity escaping cannot keep a value
      // from running there. The receiver stays unfilled (its marker is
      // stripped below) and the element keeps the template's own text.
      // With security.blockCodeBindings off, it is filled as written (see
      // `rawTextPropValue`): only a sequence that would end the element early
      // is changed.
      if (
        policy.blockCodeBindings &&
        UNFILLABLE_RECEIVERS.has(tagName.toLowerCase())
      ) {
        warn(
          `Ignoring data-bascik-prop-${propName} on a <${tagName.toLowerCase()}>: a prop is never written into script or style text. ` +
            `Bind it to a data-* attribute instead (data-bascik-attr-data-${propName}="${propName}") and read it from the element's dataset.`,
        );
        searchIndex = openMatch.index + openTag.length;
        continue;
      }
      const contentStart = openMatch.index + openTag.length;
      const closeIndex = findClose(tagName, contentStart);
      if (closeIndex === -1) {
        searchIndex = contentStart;
        continue;
      }
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "iy");
      closeRe.lastIndex = closeIndex;
      const closeTag = closeRe.exec(source)?.[0];
      if (!closeTag) {
        searchIndex = contentStart;
        continue;
      }
      // Remove the receiver attribute from the opening tag.
      let attrStart = receiverAttr.start;
      if (attrStart > 0 && /\s/.test(openTag[attrStart - 1])) attrStart--;
      const newOpenTag =
        openTag.slice(0, attrStart) + openTag.slice(receiverAttr.end);
      const filled = UNFILLABLE_RECEIVERS.has(tagName.toLowerCase())
        ? rawTextPropValue(tagName, propValue)
        : escapedPropValue;
      const replacement = `${newOpenTag}${filled}${closeTag}`;
      const endIndex = closeIndex + closeTag.length;
      parts.push(source.slice(cursor, openMatch.index), replacement);
      cursor = endIndex;
      searchIndex = endIndex;
      const rawText = mayChangeMaskedRegions(
        source.slice(contentStart, closeIndex),
      );
      let prefixClosed = false;
      let contentClosed = !rawText;
      if (rawText && closedThrough >= 0 && closedThrough <= contentStart) {
        prefixClosed = maskRawTextContentWithClosure(
          source.slice(closedThrough, contentStart),
        ).closed;
        contentClosed =
          prefixClosed &&
          maskRawTextContentWithClosure(source.slice(contentStart, closeIndex))
            .closed;
      }
      if (contentClosed) {
        // The escaped value holds no `<`, quote or `>`, so in text state it
        // leaves the scanner where it found it; in any other state, or when
        // the removed content ends in another state, compare exactly.
        const before = scanStateAt(contentStart);
        const after = scanStateAt(closeIndex);
        let agrees = before.state === "text" && after.state === "text";
        if (!agrees) {
          const valueScan = createAttributeValueScanner(escapedPropValue, {
            cursor: 0,
            state: before.state,
            quote: before.quote,
          });
          valueScan.isInsideValue(escapedPropValue.length);
          const spliced = valueScan.checkpoint();
          agrees =
            spliced.state === after.state && spliced.quote === after.quote;
        }
        if (agrees) {
          if (rawText) closedThrough = closeIndex;
          continue;
        }
      }
      // The removed content could open or close a masked region, or change
      // what is inside an attribute value, past it: rescan the spliced
      // string, as a splice per receiver did.
      parts.push(source.slice(cursor));
      const spliced = parts.join("");
      searchIndex = spliced.length - (source.length - endIndex);
      source = spliced;
      openTags = createWordNameOpenTagScanner(source);
      masked = null;
      finder = null;
      stateScan = null;
      // The text before the receiver is unchanged. When it was checked
      // closed here, its escaped value and close tag are closed too; without
      // raw-text syntax in the removed content, what was known closed stays.
      if (rawText) closedThrough = prefixClosed ? searchIndex : -1;
      parts = [];
      cursor = 0;
    }
    if (cursor > 0) {
      parts.push(source.slice(cursor));
      result = parts.join("");
    } else {
      result = source;
    }
  });
  // Strip any remaining data-bascik-prop-* markers whose prop was not provided.
  // Only strip markers that are whole attribute names WITHOUT a value (prop
  // receivers, e.g. `data-bascik-prop-label` followed by whitespace or `>`).
  // Markers with a value (e.g. `data-bascik-prop-label="featured"`) are child
  // component prop declarations and must be preserved so nested components
  // receive their props.  A token that only appears inside prose or inside
  // another attribute's quoted value is text, never a marker.
  const stripped = stripUnfilledPropMarkers(result);
  return commentShield.restore(rawShield.restore(stripped));
};

/**
 * The spans to remove from one opening tag: its valueless
 * `data-bascik-prop-*` markers (prop receivers nobody filled), each with the
 * whitespace before it.
 */
const unfilledMarkerSpans = (
  openTag: string,
): Array<{ start: number; end: number }> => {
  const removals: Array<{ start: number; end: number }> = [];
  // Most tags carry no marker: skip the attribute scan for them.
  if (!/data-bascik-prop-/i.test(openTag)) return removals;
  for (const attr of scanWholeAttributes(openTag)) {
    if (!/^data-bascik-prop-[\w-]+$/i.test(attr.name)) continue;
    // Keep markers that carry a value: they are child component prop
    // declarations that must reach the nested component.
    if (attr.valueStart !== -1) continue;
    // A marker on a self-closing tag (`data-bascik-prop-x/>`) is left as
    // authored, matching the old receiver boundary.
    if (
      !/[\s>]/.test(openTag[attr.nameEnd] ?? "") &&
      attr.nameEnd < openTag.length
    )
      continue;
    let start = attr.start;
    if (start > 0 && /\s/.test(openTag[start - 1])) start--;
    removals.push({ start, end: attr.end });
  }
  return removals;
};

/**
 * Each call returns the first match at or after `from` (calls in increasing
 * order) of `<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*[\s>])` (flags
 * `gi`), in linear time. The greedy attribute chain backs off to the last
 * position it can stop at that holds whitespace or `>`: the `>` it reaches,
 * or else the last whitespace outside the quoted strings it walked
 * (`createMarkerWalk` over the whitespace positions, found once).
 */
const createUnfilledMarkerTagScanner = (
  html: string,
): ((from: number) => { start: number; end: number } | null) => {
  const attributeEnd = createAttributeScanner(html);
  let lastSpace: ((from: number) => number) | null = null;
  return (from) => {
    for (
      let start = html.indexOf("<", from);
      start !== -1;
      start = html.indexOf("<", start + 1)
    ) {
      const chainStart = tagNameEnd(html, start);
      if (chainStart === -1) continue;
      const gt = attributeEnd(chainStart);
      if (gt !== -1) return { start, end: gt + 1 };
      if (lastSpace === null) {
        const spaces: number[] = [];
        for (let index = 0; index < html.length; index++)
          if (isRegexWhitespace(html.charCodeAt(index))) spaces.push(index);
        lastSpace = createMarkerWalk(html, spaces, "last");
      }
      const space = lastSpace(chainStart);
      if (space !== -1) return { start, end: space + 1 };
    }
    return null;
  };
};

const stripUnfilledPropMarkers = (html: string): string => {
  if (!/data-bascik-prop-/i.test(html)) return html;
  // Whole attribute names only: a token that merely looks like a marker inside
  // prose or another attribute's quoted value is text and is never stripped.
  let tags = createUnfilledMarkerTagScanner(html);
  // Rewritten tags are collected and joined once, not spliced into the whole
  // string one by one (quadratic in a large template with many markers).
  // Removing whole unquoted attribute names never changes how the rest of the
  // tag scans, so the rewritten tag rescans to itself; only if it still held
  // a marker does the string materialize and rescan from that tag.
  let source = html;
  let parts: string[] = [];
  let cursor = 0;
  let searchIndex = 0;
  for (let tag = tags(searchIndex); tag !== null; tag = tags(searchIndex)) {
    const openTag = source.slice(tag.start, tag.end);
    const tagStart = tag.start;
    const removals = unfilledMarkerSpans(openTag);
    if (removals.length === 0) {
      searchIndex = tagStart + openTag.length;
      continue;
    }
    // Rebuild the tag keeping only the non-removed pieces.
    let pieces = "";
    let pieceCursor = 0;
    for (const { start, end } of removals) {
      pieces += openTag.slice(pieceCursor, start);
      pieceCursor = end;
    }
    pieces += openTag.slice(pieceCursor);
    parts.push(source.slice(cursor, tagStart), pieces);
    cursor = tagStart + openTag.length;
    searchIndex = cursor;
    if (unfilledMarkerSpans(pieces).length > 0) {
      parts.push(source.slice(cursor));
      source = parts.join("");
      tags = createUnfilledMarkerTagScanner(source);
      parts = [];
      cursor = 0;
      searchIndex = tagStart;
    }
  }
  if (cursor === 0) return source;
  parts.push(source.slice(cursor));
  return parts.join("");
};
