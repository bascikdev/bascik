import { findModuleSpecifiers } from "./module-specifiers.js";
import {
  HAND_WRITTEN_ESCAPER_RULE,
  findHandWrittenEscapers,
} from "./hand-written-escaper.js";
import {
  HTML_MODULE,
  callOf,
  findBindings,
  findHtmlImports,
  findTemplateLiterals,
  htmlExportOf,
  htmlTagNames,
  isExempt,
  isMessageArgument,
  looksLikeMarkup,
  scanTemplateHtml,
  type ExemptContext,
  type HoleContext,
} from "./server-script-templates.js";

export interface ServerScriptDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  start: number;
  end: number;
  /**
   * server-script-unescaped-markup only: the offset of the template's
   * opening backtick, and whether wrapping it in html`...` is a safe fix
   * (no hole sits where html would throw).
   */
  template?: { start: number; fixable: boolean };
  /**
   * hand-written-html-escaper only, when the escaper is one `return` (or an
   * arrow's expression) with one plain parameter: the body to replace with
   * a call to esc(), and that parameter.
   */
  escaper?: { start: number; end: number; param: string; block: boolean };
}

export interface AnalyzeOptions {
  hasSrcAttribute: boolean;
  /**
   * The script's directive, or "module" for a .ts or .js file that runs in
   * Node: a directive script's src= file, a module one imports, or an API
   * route. server and stream run per request; the rest run at build time
   * (or are imported by code that does).
   */
  directive: "server" | "stream" | "build" | "routes" | "module";
  /** A project's own escapers, trusted like esc() (bascik.ext.json diagnostics.escapeFunctions). */
  escapeFunctions?: readonly string[];
  /** Added to body line numbers so messages name the file line (the body's first line is line 1 + lineOffset). */
  lineOffset?: number;
}

export const UNESCAPED_MARKUP_RULE = "server-script-unescaped-markup";

/** Tags that join their values into a string as they are, like no tag at all. */
const PLAIN_STRING_TAGS = new Set([
  "String.raw",
  "dedent",
  "outdent",
  "stripIndent",
  "stripIndents",
  "oneLine",
  "oneLineTrim",
  "codeBlock",
]);

const HTML_THROWS: Record<string, string> = {
  "server-script-sink-event-handler":
    "html`...` throws here: an event handler's value is JavaScript. Put the value in a data-* attribute and read it from a component script.",
  "server-script-sink-inline-script":
    'html`...` throws here: a <script> body is JavaScript, which escaping cannot make safe. Put the value in a data-* attribute, or in <script type="application/json">${json(value)}</script>.',
  "server-script-sink-style":
    "html`...` throws here: CSS is not made safe by escaping. Choose between fixed classes in code, or put the value in a data-* attribute.",
  "server-script-sink-unquoted-attribute":
    'html`...` throws here: an unquoted attribute value ends at a space. Quote it: attr="${...}".',
};

// Keywords after which a `/` starts a regex literal rather than a division.
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);
const LONGEST_KEYWORD = 10; // "instanceof"

// Characters after which an operand, so a regex, follows.
const OPERAND_FOLLOWS = new Set("(,=:[!&|?{};+-*%<>~^");

// The same set String.prototype.trimEnd removes.
const isSpace = (char: string): boolean => /\s/.test(char);
const isWordChar = (char: string): boolean => /[\w$]/.test(char);

// Index just past the last non-whitespace character before `end`.
function skipSpaceBack(chars: readonly string[], end: number): number {
  while (end > 0 && isSpace(chars[end - 1])) end--;
  return end;
}

const isSpreadBefore = (chars: readonly string[], end: number): boolean =>
  end >= 3 &&
  chars[end - 1] === "." &&
  chars[end - 2] === "." &&
  chars[end - 3] === ".";

// A `/` starts a regex literal when nothing before it can end an expression.
// Without this, a quote inside /"/g would open a string that swallows the
// `export default` after it.
//
// It reads only the text just before the `/`, walking back over whitespace
// and at most one keyword. End-anchored patterns over everything scanned so
// far cost a pass over the whole prefix for every `/` (as does indexing a
// string built with +=, which V8 flattens on each read), which made a large
// minified script quadratic. `cleaned` is a character array, and each walk
// back stops at the previous token, so the whole scan stays linear.
function regexCanStart(cleaned: readonly string[]): boolean {
  const end = skipSpaceBack(cleaned, cleaned.length);
  if (end === 0) return true;
  // `...` is a spread, which an operand follows; a single `.` (or `?.`) is a
  // property access, handled with the keyword check below.
  if (OPERAND_FOLLOWS.has(cleaned[end - 1])) return true;
  if (isSpreadBefore(cleaned, end)) return true;
  let start = end;
  while (
    start > 0 &&
    end - start <= LONGEST_KEYWORD &&
    isWordChar(cleaned[start - 1])
  )
    start--;
  // A longer word, or one that continues past the bound, is no keyword.
  if (start > 0 && isWordChar(cleaned[start - 1])) return false;
  if (!REGEX_AFTER_KEYWORD.has(cleaned.slice(start, end).join("")))
    return false;
  // `values.of` or `values?.in` is a property name that ends an expression,
  // so a `/` after it is division. A spread before a keyword (`...await`) is
  // not a property access.
  const beforeKeyword = skipSpaceBack(cleaned, start);
  return (
    beforeKeyword === 0 ||
    cleaned[beforeKeyword - 1] !== "." ||
    isSpreadBefore(cleaned, beforeKeyword)
  );
}

function skipRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length && source[i] !== "\n") {
    if (source[i] === "\\") i += 2;
    else if (inClass) {
      if (source[i] === "]") inClass = false;
      i++;
    } else if (source[i] === "[") {
      inClass = true;
      i++;
    } else if (source[i] === "/") {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    } else i++;
  }
  return i;
}

function hasDefaultExport(source: string): boolean {
  const chars: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      chars.push(" ");
    } else if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i = Math.min(i + 2, source.length);
      chars.push(" ");
    } else if (source[i] === "/" && regexCanStart(chars)) {
      i = skipRegexLiteral(source, i);
      chars.push(" ", "0", " ");
    } else if (source[i] === '"' || source[i] === "'") {
      const q = source[i];
      i++;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === q) {
          i++;
          break;
        } else i++;
      }
      // A string is a value: a `/` after it is division, so keep a value token
      // in its place rather than leaving the preceding `=` or `(` exposed.
      chars.push(" ", "0", " ");
    } else if (source[i] === "`") {
      i++;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i] === "`" && depth === 0) {
          i++;
          break;
        } else if (source[i] === "$" && source[i + 1] === "{") {
          depth++;
          i += 2;
        } else if (source[i] === "}" && depth > 0) {
          depth--;
          i++;
        } else i++;
      }
      // Same as a string: a template literal is a value.
      chars.push(" ", "0", " ");
    } else {
      chars.push(source[i]);
      i++;
    }
  }

  const cleaned = chars.join("");
  if (/\bexport\s+default\b/.test(cleaned)) return true;
  if (/\bexport\s*\*\s*as\s+default\b/.test(cleaned)) return true;
  const exportClauseMatch = /\bexport\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = exportClauseMatch.exec(cleaned)) !== null) {
    const specifiers = match[1].split(",");
    for (const spec of specifiers) {
      const trimmed = spec.trim();
      if (trimmed === "default") return true;
      if (/\bas\s+default\s*$/.test(trimmed)) return true;
    }
  }
  return false;
}

export function analyzeServerScriptSource(
  body: string,
  opts: AnalyzeOptions,
): ServerScriptDiagnostic[] {
  const diagnostics: ServerScriptDiagnostic[] = [];

  // Rule 2: server-script-missing-default-export
  if (
    body.trim().length > 0 &&
    !opts.hasSrcAttribute &&
    opts.directive !== "module"
  ) {
    if (!hasDefaultExport(body)) {
      const match = /\S+/.exec(body);
      const start = match ? match.index : 0;
      const end = match ? match.index + match[0].length : 0;
      let message: string;
      if (opts.directive === "build") {
        message =
          "A data-bascik-build script must `export default` a function returning a string. Expected: export default async function() { ... }";
      } else if (opts.directive === "routes") {
        message =
          "A data-bascik-routes script must `export default` a function returning an array. Expected: export default async function() { ... }";
      } else {
        message = `A data-bascik-${opts.directive} script must \`export default\` a function \`(request, context, { signal })\`. Bascik loads it as an ES module and calls the default export on each request.`;
      }
      diagnostics.push({
        code: "server-script-missing-default-export",
        message,
        severity: "error",
        start,
        end,
      });
    }
  }

  // Request-time scripts get every rule. Build-time code (build and routes
  // scripts, and the modules scripts import) gets the markup rules too:
  // their output is a page, and a title with & or < breaks it whoever wrote
  // the value. See the sink notes in the template loop.
  const requestTime =
    opts.directive === "server" || opts.directive === "stream";

  // server-script-bascik-import
  // An ESM import whose specifier is exactly @bascik/bascik or starts with @bascik/bascik/
  // Build scripts may import build tooling, so this is for server and stream only.
  const moduleSpecifiers = requestTime ? findModuleSpecifiers(body) : [];
  for (const { start, end, value } of moduleSpecifiers) {
    if (value === HTML_MODULE) continue;
    if (value === "@bascik/bascik" || value.startsWith("@bascik/bascik/")) {
      diagnostics.push({
        code: "server-script-bascik-import",
        message:
          "Only @bascik/bascik/html is meant for server and stream scripts. The rest of @bascik/bascik is build tooling.",
        severity: "error",
        start,
        end,
      });
    }
  }

  // Escapers a comment says are for XML: trusted in this script's holes.
  const xmlEscapers: string[] = [];
  if (!opts.hasSrcAttribute)
    for (const escaper of findHandWrittenEscapers(body, xmlEscapers)) {
      const subject =
        escaper.kind === "map"
          ? `${escaper.name} maps & and < to HTML entities, the core of a hand-written HTML escaper.`
          : `${escaper.name}() is a hand-written HTML escaper: it turns & and < into entities.`;
      diagnostics.push({
        code: HAND_WRITTEN_ESCAPER_RULE,
        message: `${subject} Build markup with html\`...\` from @bascik/bascik/html, which escapes each value for where it lands, or call esc() from the same module for a plain string. If it escapes XML on purpose, say so in a comment above it.`,
        severity: "warning",
        start: escaper.start,
        end: escaper.end,
        ...(escaper.delegate ? { escaper: escaper.delegate } : {}),
      });
    }

  // Part C: sink rules and server-script-unescaped-markup, per template hole.
  const imports = findHtmlImports(body);
  const ctx: ExemptContext = {
    imports,
    htmlTags: htmlTagNames(imports),
    escapeFunctions: [...(opts.escapeFunctions ?? []), ...xmlEscapers],
    bindings: findBindings(body),
  };
  const lineStarts = [0];
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1))
    lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1 + (opts.lineOffset ?? 0);
  };

  const joined = joinedNames(body);
  for (const literal of findTemplateLiterals(body)) {
    const isHtml = literal.tag !== null && ctx.htmlTags.includes(literal.tag);
    // SQL, URLs and plain text: `WHERE id = ${id}` is not an attribute.
    const markupLike = isHtml || looksLikeMarkup(literal.parts);
    // String.raw and common-tags style tags join their values as they are.
    const plainTag = literal.tag !== null && PLAIN_STRING_TAGS.has(literal.tag);
    const markup =
      !opts.hasSrcAttribute &&
      (literal.tag === null || plainTag) &&
      markupLike &&
      !isMessageArgument(body, literal.start);
    const pending: ServerScriptDiagnostic[] = [];
    // Where each hole lands, read once for the whole template.
    const scanned = scanTemplateHtml(literal.parts);
    // The fix puts html before the backtick, so a tagged template and one
    // where html would throw (a tag name, an attribute name, a comment) get
    // no fix.
    const throwsAt = scanned.throwsAt;
    let fixable = markup && !plainTag && throwsAt === -1;
    for (const hole of literal.holes) {
      const context = scanned.holes[hole.index - 1];
      // A placeholder inside a <!-- --> comment within the literal is skipped.
      if (context.kind === "comment") continue;
      // A fragment that has opened no tag yet (` href="${u}"`) is read the
      // old way, over a bounded stretch of text before the hole.
      const found =
        context.kind === "text" && !context.sawTag
          ? sinkOf(
              body.slice(
                Math.max(literal.start + 1, hole.start - FRAGMENT_WINDOW),
                hole.start,
              ),
            )
          : sinkOfContext(context);
      const sink =
        !markupLike && found === "server-script-sink-unquoted-attribute"
          ? null
          : found;
      const at = { start: hole.start, end: hole.end };
      const inAttribute = context.kind === "value";

      if (isHtml) {
        if (sink === "server-script-sink-inline-script") {
          // <script type="application/json">${json(value)}</script> is html's own form.
          const callee = callOf(hole.expr);
          const isJsonScript = context.kind === "raw" && context.jsonScript;
          if (
            isJsonScript &&
            callee !== undefined &&
            htmlExportOf(callee, imports) === "json"
          )
            continue;
        }
        if (sink !== null && sink in HTML_THROWS) {
          diagnostics.push({
            code: sink,
            message: HTML_THROWS[sink],
            severity: "error",
            ...at,
          });
          continue;
        }
        const callee = callOf(hole.expr);
        if (
          callee !== undefined &&
          htmlExportOf(callee, imports) === "esc" &&
          sink === null
        )
          diagnostics.push({
            code: "html-escaped-twice",
            message:
              "esc() inside html`...` escapes twice, so the page shows &amp;lt;. Pass the value as it is: html escapes it.",
            severity: "info",
            ...at,
          });
        if (sink === null && !inAttribute && isJoined(hole.expr, joined))
          diagnostics.push({
            code: JOINED_RULE,
            message:
              'This hole joins its items into one string, which html escapes, so the page shows &lt;li&gt; as text. Pass the array without .join(""): html inserts each html`...` item as it is.',
            severity: "warning",
            ...at,
          });
        continue;
      }

      if (context.kind === "name") {
        // A tag or attribute name: html throws here, so wrapping cannot
        // help. Build-time names are the site's own (`<h${level}>`,
        // `<th${attributes}>`); a request value here is an injection.
        fixable = false;
        if (requestTime && markup && !isExempt(hole.expr, ctx))
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `This markup template (line ${lineOf(literal.start)}) puts \${${hole.expr.trim()}} (hole ${hole.index}) where a tag or attribute name goes. html\`...\` throws there and escaping cannot make it safe: choose between fixed names in code (for example level === 1 ? "h1" : "h2").`,
            severity: "warning",
            ...at,
          });
        continue;
      }

      if (
        sink !== null &&
        sink !== "server-script-sink-url-attribute" &&
        !requestTime
      ) {
        // Build time: html would throw here, so no fix, and no
        // unescaped-markup report either (wrapping would not help). An
        // unquoted value or a <script> body breaks on a space or a
        // </script> in the value, whoever wrote it, so those warn unless the
        // value is exempt. An event handler or style value is the site's
        // own at build time (a CSS custom property from data is common), so
        // those are request-time warnings only.
        fixable = false;
        if (
          markup &&
          (sink === "server-script-sink-unquoted-attribute" ||
            sink === "server-script-sink-inline-script") &&
          !isExempt(hole.expr, ctx)
        )
          diagnostics.push({
            code: sink,
            message: SINK_MESSAGES[sink],
            severity: "warning",
            ...at,
          });
        continue;
      }

      if (sink !== null && sink !== "server-script-sink-url-attribute") {
        fixable = false;
        diagnostics.push({
          code: sink,
          message: SINK_MESSAGES[sink],
          severity: "warning",
          ...at,
        });
        continue;
      }

      const exempt = isExempt(hole.expr, ctx);
      if (markup && !exempt) {
        const head = `This markup template (line ${lineOf(literal.start)}) interpolates \${${hole.expr.trim()}} (hole ${hole.index}) without html.`;
        const escaper = handEscaper(hole.expr);
        // The quick fix would escape twice: the escaper's output, or the
        // markup in a joined string, would show as text.
        if (escaper !== undefined || isJoined(hole.expr, joined))
          fixable = false;
        // html would throw on this template, so the advice is esc().
        const throwsReason =
          throwsAt > 0
            ? `hole ${throwsAt} sits where html throws`
            : throwsAt === 0
              ? "it ends inside a tag"
              : undefined;
        let message: string;
        if (throwsReason !== undefined)
          message =
            escaper !== undefined
              ? `${head} ${escaper.name}() looks like a hand-written escaper. html\`...\` cannot build this template as it is (${throwsReason}), so call esc() from @bascik/bascik/html in its place, or list ${escaper.name}() in diagnostics.escapeFunctions if it is a trusted escaper.`
              : `${head} html\`...\` cannot build this template as it is (${throwsReason}), so escape the value with esc() from @bascik/bascik/html.`;
        else
          message =
            escaper !== undefined
              ? `${head} ${escaper.name}() looks like a hand-written escaper, and html escapes too, so wrapping this template in html would show &amp;lt; on the page. Wrap it in html\`...\` and pass the value as it is: \${${escaper.args}}. If ${escaper.name}() is a trusted escaper, list it in diagnostics.escapeFunctions.`
              : `${head} Wrap the template in html\`...\` from @bascik/bascik/html, which escapes each value for where it lands.`;
        pending.push({
          code: UNESCAPED_MARKUP_RULE,
          message,
          severity: "warning",
          ...at,
        });
        continue;
      }

      // A checked value in a URL attribute and request values in text are
      // request-time concerns: build-time values are the site's own.
      if (!requestTime) continue;

      if (sink === "server-script-sink-url-attribute") {
        const callee = callOf(hole.expr);
        const checked =
          /\bsafeUrl\s*\(|\.safeUrl\s*\(/.test(hole.expr) &&
          [...ctx.imports.named.values()].includes("safeUrl");
        if (
          !checked &&
          !(callee && htmlExportOf(callee, imports) === "safeUrl")
        )
          diagnostics.push({
            code: sink,
            message: SINK_MESSAGES[sink],
            severity: "warning",
            ...at,
          });
        continue;
      }

      // Text: a request value with no escaping call around it (info).
      const trimmedExpr = hole.expr.trim();
      const referencesRequestData =
        trimmedExpr.includes("request.") ||
        trimmedExpr.includes("context.") ||
        trimmedExpr.includes("searchParams") ||
        trimmedExpr.includes(".headers.get(") ||
        trimmedExpr.includes("URL(request.url)");
      // Direct request/context access like `request.headers.get(...)` or
      // `new URL(...)` reads request data; it is not an escaping wrapper.
      const isEscapingCall =
        /^[A-Za-z_$][\w$]*\s*\(/.test(trimmedExpr) &&
        !trimmedExpr.startsWith("request.") &&
        !trimmedExpr.startsWith("context.") &&
        !trimmedExpr.startsWith("new URL(");
      if (!isEscapingCall && referencesRequestData && !exempt && markupLike)
        diagnostics.push({
          code: "server-script-sink-text-unescaped",
          message:
            "Untrusted request value interpolated without escaping. Build the markup with html`...` from @bascik/bascik/html, or wrap the value in esc().",
          severity: "info",
          ...at,
        });
    }
    for (const diagnostic of pending)
      diagnostics.push({
        ...diagnostic,
        template: { start: literal.start, fixable },
      });
  }

  return diagnostics;
}

/** A .join() of html values inside html: the joined string is escaped. */
export const JOINED_RULE = "html-joined-string";

/**
 * A hole that is one call to a function named like an escaper (escape,
 * escapeHtml, sanitize, encodeEntities, utils.esc) that is not trusted.
 * encodeURI and encodeURIComponent encode URLs, not markup.
 */
function handEscaper(expr: string): { name: string; args: string } | undefined {
  const callee = callOf(expr);
  if (callee === undefined) return undefined;
  const last = callee.slice(callee.lastIndexOf(".") + 1);
  if (/^encodeURI(?:Component)?$/.test(last)) return undefined;
  if (
    !/^(?:esc|escape|sanitize|sanitise|encode)/i.test(last) &&
    !/(?:Escape|Sanitize|Sanitise|Entities)/.test(last)
  )
    return undefined;
  const e = expr.trim();
  return { name: callee, args: e.slice(e.indexOf("(") + 1, -1).trim() };
}

/** Names bound (up to the next ;) to a value that ends in .join(...). */
function joinedNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(
    /\b(?:const|let|var)\s+([\w$]+)\s*=(?![=>])/g,
  )) {
    const from = (m.index ?? 0) + m[0].length;
    const semicolon = body.indexOf(";", from);
    // A bounded look: a declaration with no ; is cut at 500 characters.
    const end =
      semicolon === -1 || semicolon - from > 500 ? from + 500 : semicolon;
    if (/\.join\s*\([^()]*\)\s*$/.test(body.slice(from, end))) names.add(m[1]);
  }
  return names;
}

/** Whether a hole is a .join(...) call, or a name bound to one. */
function isJoined(expr: string, joined: Set<string>): boolean {
  const e = expr.trim();
  return /\.join\s*\([^()]*\)$/.test(e) || joined.has(e);
}

const SINK_MESSAGES: Record<string, string> = {
  "server-script-sink-url-attribute":
    "URL attribute. Entity escaping does not stop a `javascript:` or `data:` URL. Build the markup with html`...` from @bascik/bascik/html, which checks URLs, or pass the value through safeUrl() and esc().",
  "server-script-sink-event-handler":
    "Event handler attribute. There is no safe way to interpolate untrusted data here. Move the value to a `data-*` attribute and read it from a static client script.",
  "server-script-sink-inline-script":
    'Inline `<script>` body. Entity escaping does not apply in JavaScript context. Serialize to a `data-*` attribute or a `<script type="application/json">` filled with json(value) from @bascik/bascik/html.',
  "server-script-sink-style":
    "CSS context. Do not interpolate untrusted data into styles.",
  "server-script-sink-unquoted-attribute":
    'Unquoted attribute. A space in the value breaks out of the attribute. Quote it: `attr="${...}"`.',
};

/** How far back a fragment's hole is read when the template opens no tag. */
const FRAGMENT_WINDOW = 256;

const URL_ATTRIBUTE =
  /\b(?:href|src|action|formaction|poster|data|srcset|xlink:href)$/;

/** Which sink rule a hole falls under, from where it lands, or null for text and names. */
function sinkOfContext(context: HoleContext): string | null {
  if (context.kind === "value") {
    if (URL_ATTRIBUTE.test(context.attr))
      return "server-script-sink-url-attribute";
    if (/\bon[a-z]+$/.test(context.attr))
      return "server-script-sink-event-handler";
    if (/\bstyle$/.test(context.attr)) return "server-script-sink-style";
    return null;
  }
  if (context.kind === "raw") {
    if (context.tag === "script") return "server-script-sink-inline-script";
    if (context.tag === "style") return "server-script-sink-style";
    return null;
  }
  if (context.kind === "unquoted")
    return "server-script-sink-unquoted-attribute";
  return null;
}

/**
 * Which sink rule a hole after `precedingInLiteral` falls under, or null for
 * text. For a fragment that opens no tag; the caller bounds the text.
 */
function sinkOf(precedingInLiteral: string): string | null {
  // Inside a quoted URL attribute value.
  if (
    /\b(?:href|src|action|formaction|poster|data|srcset|xlink:href)\s*=\s*["'][^"']*$/i.test(
      precedingInLiteral,
    )
  )
    return "server-script-sink-url-attribute";
  // Inside a quoted on* attribute value.
  if (/\bon[a-z]+\s*=\s*["'][^"']*$/i.test(precedingInLiteral))
    return "server-script-sink-event-handler";
  // An unclosed <script> before the hole.
  if (lastOpenAfterClose(precedingInLiteral, "script"))
    return "server-script-sink-inline-script";
  // A quoted style attribute or an unclosed <style>.
  if (
    /\bstyle\s*=\s*["'][^"']*$/i.test(precedingInLiteral) ||
    lastOpenAfterClose(precedingInLiteral, "style")
  )
    return "server-script-sink-style";
  // An = with no opening quote.
  if (/\s[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*$/.test(precedingInLiteral))
    return "server-script-sink-unquoted-attribute";
  return null;
}

/** Whether the last `<name ...>` in `text` comes after its last `</name>`. */
function lastOpenAfterClose(text: string, name: string): boolean {
  const opens = [
    ...text.matchAll(
      new RegExp(
        `<${name}(?=[\\t\\n\\f\\r />])(?:[^>"']|"[^"]*"|'[^']*')*>`,
        "gi",
      ),
    ),
  ];
  if (opens.length === 0) return false;
  const closes = [
    ...text.matchAll(
      new RegExp(`<\\/${name}(?:[\\t\\n\\f\\r /][^>]*)?>`, "gi"),
    ),
  ];
  const lastOpen = opens[opens.length - 1].index ?? -1;
  const lastClose = closes.length
    ? (closes[closes.length - 1].index ?? -1)
    : -1;
  return lastOpen > lastClose;
}
