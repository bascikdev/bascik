import {
  findModuleSpecifiers,
  scanJavaScript,
  type Token,
} from "./module-specifiers.js";
import {
  HAND_WRITTEN_ESCAPER_RULE,
  findHandWrittenEscapers,
} from "./hand-written-escaper.js";
import {
  HTML_MODULE,
  callOf,
  findBindings,
  findBindingRanges,
  findHtmlImports,
  findTemplateLiterals,
  htmlExportOf,
  htmlTagNames,
  isExempt,
  isMessageArgument,
  isPatternArgument,
  isEscapedJson,
  newNameMemo,
  looksLikeMarkup,
  parseImportSpecifier,
  markupInCode,
  markdownFences,
  scanTemplateHtml,
  REGEX_AFTER_KEYWORD,
  skipRegexLiteral,
  type ExemptContext,
  type HoleContext,
  type TemplateHole,
  type TemplateLiteral,
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
  /**
   * "module" only: the module runs per request (an API route, or a module a
   * server script, stream script or API route imports), so every sink rule
   * applies as in a server script.
   */
  requestTime?: boolean;
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
    opts.directive === "server" ||
    opts.directive === "stream" ||
    (opts.directive === "module" && opts.requestTime === true);

  // server-script-bascik-import
  // An ESM import whose specifier is exactly @bascik/bascik or starts with @bascik/bascik/
  // Build scripts may import build tooling, so this is for server and stream only.
  const moduleSpecifiers =
    opts.directive === "server" || opts.directive === "stream"
      ? findModuleSpecifiers(body)
      : [];
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
      if (escaper.xmlName) {
        diagnostics.push({
          code: HAND_WRITTEN_ESCAPER_RULE,
          message: `${escaper.name}() looks like an XML escaper: it turns & and < into entities. If it escapes XML on purpose (a feed, a sitemap, an SVG file), say so in a comment above it. If its output goes into an HTML page, use html\`...\` or esc() from @bascik/bascik/html.`,
          severity: "warning",
          start: escaper.start,
          end: escaper.end,
          ...(escaper.delegate ? { escaper: escaper.delegate } : {}),
        });
        continue;
      }
      const subject =
        escaper.kind === "map"
          ? `${escaper.name} maps & and < to HTML entities, the core of a hand-written HTML escaper.`
          : escaper.defaultExport
            ? "The default export is a hand-written HTML escaper: it turns & and < into entities."
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
    memo: newNameMemo(),
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
  const projectNames = projectImportNames(body);
  const literals = findTemplateLiterals(body);
  const literalAt = new Map(literals.map((l) => [l.start, l]));
  const errorClasses = classesBefore(body);
  // Which literals are markup the code writes, read once: the markup
  // rule, local helpers and XML nesting all ask.
  const markupLikeOf = literals.map((literal) => {
    const isHtml = literal.tag !== null && ctx.htmlTags.includes(literal.tag);
    // SQL, URLs and plain text: `WHERE id = ${id}` is not an attribute.
    // Build-time code also holds CLI text and generated TypeScript, so it
    // needs an element name, an end tag or an attribute.
    return (
      isHtml ||
      (requestTime
        ? looksLikeMarkup(literal.parts)
        : markupInCode(literal.parts))
    );
  });
  const { tokens } = scanJavaScript(body);
  // Build-time lint and CLI code passes messages that name elements to its
  // own reporting functions: finding(..., `<${t.tag} data-testid="..."> is
  // a part of ...`). At request time such a function may write a page.
  const messageCalls = requestTime
    ? new Set<number>()
    : messageCallArguments(tokens, literals);
  const markupOf = literals.map((literal, k) => {
    // String.raw and common-tags style tags join their values as they are.
    const plainTag = literal.tag !== null && PLAIN_STRING_TAGS.has(literal.tag);
    return (
      !opts.hasSrcAttribute &&
      (literal.tag === null || plainTag) &&
      markupLikeOf[k] &&
      !FILE_LINE_MESSAGE.test(literal.parts.slice(0, 4).join("\u0000")) &&
      !messageCalls.has(literal.start) &&
      !isMessageArgument(body, literal.start) &&
      !isPatternArgument(body, literal.start) &&
      !errorSuperArgument(body, literal.start, errorClasses)
    );
  });
  // Literals are in source order, outer before nested, so the literal
  // whose hole holds this one is on a stack of the ones still open.
  const literalStarts = literals.map((l) => l.start);
  const markupCount = [0];
  for (const m of markupOf)
    markupCount.push(markupCount[markupCount.length - 1] + (m ? 1 : 0));
  /** Whether a markup literal starts between `from` and `to`. */
  const markupWithin = (from: number, to: number): boolean =>
    markupCount[firstAtOrAfter(literalStarts, to)] -
      markupCount[firstAtOrAfter(literalStarts, from)] >
    0;
  // What may hold markup built as a string: wrapping a template whose hole
  // holds one in html would escape it, so the page would show its tags.
  const functions = localFunctions(body, tokens);
  const markupSources = markupSourceStarts(
    body,
    tokens,
    literals.filter((_, k) => markupOf[k]).map((l) => l.start),
  );
  /** Whether a markup literal (a template or a quoted string) starts between `from` and `to`. */
  const sourceWithin = (from: number, to: number): boolean =>
    firstAtOrAfter(markupSources, to) > firstAtOrAfter(markupSources, from);
  const producers = markupProducers(
    tokens,
    functions,
    findBindingRanges(body),
    sourceWithin,
    projectNames,
  );
  // Local functions that build a markup string: a hole that calls one
  // holds markup, which wrapping the template in html would escape.
  const localHelpers = new Set<string>();
  for (const fn of functions)
    if (producers.names.has(fn.name)) localHelpers.add(fn.name);
  /** The first name in `from`..`to` that may hold markup, or undefined. */
  const producerWithin = (from: number, to: number): string | undefined => {
    const k = firstAtOrAfter(producers.starts, from);
    return k < producers.starts.length && producers.starts[k] < to
      ? producers.values[k]
      : undefined;
  };
  /**
   * Why wrapping this template in html would escape what a hole holds:
   * a hole that may hold markup built as a string, or one escaped with
   * esc() or a listed escaper already. Undefined when every hole is plain
   * data.
   */
  const withholdReason = (
    literal: TemplateLiteral,
    contexts: readonly HoleContext[],
    fenced: ReadonlySet<number> | undefined,
  ): { hole: number; shown: string; text: string } | undefined => {
    for (const hole of literal.holes) {
      if (contexts[hole.index - 1].kind === "comment") continue;
      if (fenced?.has(hole.index)) continue;
      const shown = `${quoteHole(hole.expr)} (hole ${hole.index})`;
      const callee = callOf(hole.expr);
      const at = { hole: hole.index, shown };
      if (
        callee !== undefined &&
        (htmlExportOf(callee, imports) === "esc" ||
          ctx.escapeFunctions.includes(callee))
      )
        return {
          ...at,
          text: `is escaped already, and html would escape it again. Wrap the template in html\`...\` from @bascik/bascik/html and pass that value as it is, without ${callee}().`,
        };
      if (sourceWithin(hole.start + 2, hole.end - 1))
        return {
          ...at,
          text: `builds markup as a string, which html would escape, so the page would show its tags as text. Build that markup with html\`...\` first, since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
        };
      const name = producerWithin(hole.start + 2, hole.end - 1);
      if (name !== undefined)
        return {
          ...at,
          text: `reads ${name}, which may hold markup built as a string in this file; html would escape it, so the page would show its tags as text. Build that markup with html\`...\` first (raw() for fixed markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
        };
    }
    return undefined;
  };
  const markupStrings = markupStringNames(body);
  const helperMemo = new Map<string, string | undefined>();
  const localHelperMemo = new Map<string, string | undefined>();
  const builtMemo = new Map<string, boolean>();
  /** A hole that holds markup already built as a string: joined, a nested template, or a name bound to one. */
  const holdsBuiltMarkup = (hole: TemplateHole): boolean => {
    if (isJoined(hole.expr, joined)) return true;
    if (markupWithin(hole.start + 1, hole.end)) return true;
    const name = hole.expr.trim();
    if (!/^[\w$]+$/.test(name)) return false;
    let known = builtMemo.get(name);
    if (known === undefined) {
      known = (ctx.bindings.get(name) ?? []).some((value) =>
        /^\s*`/.test(value),
      );
      builtMemo.set(name, known);
    }
    return known;
  };
  const xmlOf: boolean[] = [];
  const open: number[] = [];
  /**
   * The untagged template a hole holds whole (`${`<li>${x}</li>`}`), found
   * by offset: its holes are checked as its own, so the outer hole is fine
   * exactly when the inner template has none. Read this way, templates
   * nested deep in each other's holes are not each rescanned as text.
   */
  const wholeTemplateIn = (hole: TemplateHole): TemplateLiteral | undefined => {
    let k = hole.start + 2;
    while (k < hole.end && /\s/.test(body[k])) k++;
    const inner = literalAt.get(k);
    if (!inner || inner.tag !== null) return undefined;
    let j = inner.end;
    while (j < hole.end - 1 && /\s/.test(body[j])) j++;
    return j === hole.end - 1 && body[j] === "}" ? inner : undefined;
  };
  for (let k = 0; k < literals.length; k++) {
    const literal = literals[k];
    const isHtml = literal.tag !== null && ctx.htmlTags.includes(literal.tag);
    const markupLike = markupLikeOf[k];
    const plainTag = literal.tag !== null && PLAIN_STRING_TAGS.has(literal.tag);
    const markup = markupOf[k];
    while (
      open.length > 0 &&
      literals[open[open.length - 1]].end <= literal.start
    )
      open.pop();
    const parent = open.length > 0 ? open[open.length - 1] : -1;
    open.push(k);
    const pending: ServerScriptDiagnostic[] = [];
    // An XML document or fragment (a sitemap, an RSS or Atom feed), or a
    // template nested in one's holes: html builds HTML, so it gets esc()
    // advice and no fix.
    const xml =
      markup &&
      (XML_TEMPLATE.test(literal.parts[0]) || (parent !== -1 && xmlOf[parent]));
    xmlOf[k] = xml;
    // Where each hole lands, read once for the whole template.
    const scanned = scanTemplateHtml(literal.parts);
    // The fix puts html before the backtick, so a tagged template and one
    // where html would throw (a tag name, an attribute name, a comment) get
    // no fix.
    const throwsAt = scanned.throwsAt;
    let fixable = markup && !plainTag && !xml && throwsAt === -1;
    // Markdown with fenced blocks: a hole in a fence is text the Markdown
    // renderer escapes, and html would escape the fence's code as well.
    const fences =
      markup && !requestTime ? markdownFences(literal.parts) : undefined;
    if (fences?.hasFence) fixable = false;
    const reason = fixable
      ? withholdReason(literal, scanned.holes, fences?.fencedHoles)
      : undefined;
    if (reason !== undefined) fixable = false;
    for (const hole of literal.holes) {
      const context = scanned.holes[hole.index - 1];
      const inner = wholeTemplateIn(hole);
      const holeIsExempt = (): boolean =>
        inner !== undefined
          ? inner.holes.length === 0
          : isExempt(hole.expr, ctx);
      const shown = quoteHole(hole.expr);
      // A placeholder inside a <!-- --> comment within the literal is skipped.
      if (context.kind === "comment") continue;
      if (fences?.fencedHoles.has(hole.index)) continue;
      // A name set to a markup string in this file (`icon = '<svg>...'`,
      // `shape: '<path ... />'`): wrapping would escape it, fine or not.
      const markupString =
        !isHtml && !xml && markup
          ? markupStringIn(hole.expr, markupStrings)
          : undefined;
      if (markupString !== undefined) fixable = false;
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

      // JSON.stringify(...).replace(/</g, "\\u003c") in a JSON script can
      // never close it: the safe JSON-LD pattern.
      if (
        sink === "server-script-sink-inline-script" &&
        context.kind === "raw" &&
        context.jsonScript &&
        isEscapedJson(hole.expr, ctx)
      )
        continue;

      if (context.kind === "name") {
        // A tag or attribute name: html throws here, so wrapping cannot
        // help. Build-time names are the site's own (`<h${level}>`,
        // `<th${attributes}>`); a request value here is an injection.
        fixable = false;
        if (requestTime && markup && !holeIsExempt())
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `This markup template (line ${lineOf(literal.start)}) puts ${shown} (hole ${hole.index}) where a tag or attribute name goes. html\`...\` throws there and escaping cannot make it safe: choose between fixed names in code (for example level === 1 ? "h1" : "h2").`,
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
          !holeIsExempt()
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

      const exempt = holeIsExempt();
      if (markup && !exempt) {
        const escaper =
          inner === undefined ? handEscaper(hole.expr) : undefined;
        if (xml) {
          // Any entity escaper is right for XML text and quoted values.
          if (escaper !== undefined) continue;
          // Markup built already (a joined list of <item>s, a nested
          // template, a name bound to one): its own templates are checked
          // as XML, and escaping it again would show its tags as text.
          if (holdsBuiltMarkup(hole)) continue;
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `This XML template (line ${lineOf(literal.start)}) interpolates ${shown} (hole ${hole.index}) without escaping. html\`...\` builds HTML, not XML, so escape the value with esc() from @bascik/bascik/html (its entities are valid XML too), or with an XML escaper that has a comment saying it is for XML.`,
            severity: "warning",
            ...at,
          });
          continue;
        }
        const head = `This markup template (line ${lineOf(literal.start)}) interpolates ${shown} (hole ${hole.index}) without html.`;
        // The quick fix would escape twice: the escaper's output, or the
        // markup in a joined string, would show as text.
        if (
          escaper !== undefined ||
          (inner === undefined && isJoined(hole.expr, joined))
        )
          fixable = false;
        // A project helper may return a markup string (a card, a list),
        // which html would escape: the page would show its tags as text.
        const helper =
          escaper === undefined && inner === undefined
            ? projectHelperIn(hole.expr, projectNames, ctx.bindings, helperMemo)
            : undefined;
        if (helper !== undefined) {
          fixable = false;
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `${head} ${helper}() comes from a project module: if it returns markup as a string, wrapping this template in html would show its tags as text. Build that function's markup with html\`...\` first, since html inserts an html value as it is, then wrap this template.`,
            severity: "warning",
            ...at,
          });
          continue;
        }
        const localHelper =
          escaper === undefined && inner === undefined
            ? projectHelperIn(
                hole.expr,
                localHelpers,
                ctx.bindings,
                localHelperMemo,
              )
            : undefined;
        if (localHelper !== undefined) {
          fixable = false;
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `${head} ${localHelper}() builds markup as a string in this file, so wrapping this template in html would show its tags as text. Build that function's markup with html\`...\` first, since html inserts an html value as it is, then wrap this template.`,
            severity: "warning",
            ...at,
          });
          continue;
        }
        if (markupString !== undefined) {
          pending.push({
            code: UNESCAPED_MARKUP_RULE,
            message: `${head} ${markupString} is set to a markup string in this file, so wrapping this template in html would show its tags as text. Make that value an html\`...\` value first (raw() for fixed markup), since html inserts an html value as it is, then wrap this template.`,
            severity: "warning",
            ...at,
          });
          continue;
        }
        // html would throw on this template, so the advice is esc().
        const throwsReason =
          throwsAt > 0
            ? `hole ${throwsAt} sits where html throws`
            : throwsAt === 0
              ? "it ends inside a tag"
              : undefined;
        let message: string;
        if (fences?.hasFence && escaper === undefined)
          message = `${head} The template also holds a Markdown code fence, whose code html would escape as well, so build the markup outside the fence with html\`...\` from @bascik/bascik/html, or escape the value with esc() from the same module.`;
        else if (throwsReason !== undefined)
          message =
            escaper !== undefined
              ? `${head} ${escaper.name}() looks like a hand-written escaper. html\`...\` cannot build this template as it is (${throwsReason}), so call esc() from @bascik/bascik/html in its place, or list ${escaper.name}() in diagnostics.escapeFunctions if it is a trusted escaper.`
              : `${head} html\`...\` cannot build this template as it is (${throwsReason}), so escape the value with esc() from @bascik/bascik/html.`;
        else
          message =
            escaper !== undefined
              ? `${head} ${escaper.name}() looks like a hand-written escaper, and html escapes too, so wrapping this template in html would show &amp;lt; on the page. Wrap it in html\`...\` and pass the value as it is: \${${escaper.args}}. If ${escaper.name}() is a trusted escaper, list it in diagnostics.escapeFunctions.`
              : inner === undefined && isJoined(hole.expr, joined)
                ? `${head} It joins markup into one string, which html would escape, so wrapping only this template would show the inner tags as text. Wrap the inner templates in html\`...\`, drop .join(""), and pass the array; then wrap this template in html\`...\` from @bascik/bascik/html.`
                : reason === undefined
                  ? `${head} Wrap the template in html\`...\` from @bascik/bascik/html, which escapes each value for where it lands.`
                  : reason.hole === hole.index
                    ? `${head} It ${reason.text}`
                    : `${head} Wrapping this template in html is not offered as a fix: ${reason.shown} ${reason.text}`;
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

      // Text: a request value with no escaping call around it (info). A
      // whole inner template's own holes are checked as its own.
      if (inner !== undefined) continue;
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

/**
 * The local names a script imports from its project's own modules (a
 * `./`, `../` or `@/` specifier): default, named (`a as b`) and namespace
 * imports. Type-only imports bind no value and are left out. The import
 * clause is bounded, so the scan stays linear.
 */
function projectImportNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(
    /\bimport\s+(?!type\s)([^;'"`]{1,1000}?)\s+from\s*["'](?:\.\.?\/|@\/)/g,
  )) {
    const clause = m[1];
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace)
      for (const entry of brace[1].split(",")) {
        if (/^\s*type\s/.test(entry)) continue;
        const specifier = parseImportSpecifier(entry);
        if (specifier) names.add(specifier[1]);
      }
    const rest = brace ? clause.replace(brace[0], "") : clause;
    const namespace = /\*\s*as\s+([\w$]+)/.exec(rest);
    if (namespace) names.add(namespace[1]);
    const defaultName = /^\s*([\w$]+)\s*(?:,|$)/.exec(rest);
    if (defaultName) names.add(defaultName[1]);
  }
  return names;
}

/**
 * The first project-imported function a hole calls or passes as a
 * callback (`card(p)`, `items.map(card)`; not a member, `x.card`), looking
 * one step through a name bound in the script (`const first = card(p)`),
 * or undefined.
 */
function projectHelperIn(
  expr: string,
  names: Set<string>,
  bindings: Map<string, string[]>,
  memo: Map<string, string | undefined>,
): string | undefined {
  if (names.size === 0) return undefined;
  const find = (text: string): string | undefined => {
    for (const m of text.matchAll(/(?<![\w$.])([\w$]+)(?:\.[\w$]+)*/g)) {
      if (!names.has(m[1])) continue;
      const after = text.slice(
        m.index + m[0].length,
        m.index + m[0].length + 16,
      );
      // Called (`card(p)`), or passed as a callback (`.map(card)`).
      if (/^\s*\(/.test(after)) return m[0];
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      if (/[(,]\s*$/.test(before) && /^\s*[,)]/.test(after)) return m[0];
    }
    return undefined;
  };
  const direct = find(expr);
  if (direct !== undefined) return direct;
  const name = expr.trim();
  if (!/^[\w$]+$/.test(name)) return undefined;
  // Read once per name: a name declared in many functions is not rescanned per hole.
  if (memo.has(name)) return memo.get(name);
  let found: string | undefined;
  for (const value of bindings.get(name) ?? []) {
    found = find(value);
    if (found !== undefined) break;
  }
  memo.set(name, found);
  return found;
}

/** Index of the first value in ascending `values` that is at least `at`. */
function firstAtOrAfter(values: readonly number[], at: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Each `class` keyword's offset, and whether that class extends an Error (`extends Error`, `extends errors.BuildError`). */
function classesBefore(body: string): { at: number; error: boolean }[] {
  const classes: { at: number; error: boolean }[] = [];
  for (const m of body.matchAll(
    /\bclass\b(?:\s+[\w$]+)?(?:\s+extends\s+([\w$.]+))?/g,
  ))
    classes.push({ at: m.index, error: /Error$/.test(m[1] ?? "") });
  return classes;
}

/** Whether a literal is the argument of super() in the class (the last one before it) that extends an Error. */
function errorSuperArgument(
  body: string,
  start: number,
  classes: readonly { at: number; error: boolean }[],
): boolean {
  if (!/\bsuper\s*\(\s*$/.test(body.slice(Math.max(0, start - 40), start)))
    return false;
  const k = firstAtOrAfter(
    classes.map((c) => c.at),
    start,
  );
  return k > 0 && classes[k - 1].error;
}

/**
 * Names set to a string with a tag in it, as a binding or a property
 * (`const icon = '<svg>...'`, `shape: '<path d="..." />'`).
 */
function markupStringNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(
    /(?<![\w$.])([\w$]+)\s*(?::|=(?![=>]))\s*(["'`])\s*<[a-zA-Z]/g,
  ))
    names.add(m[1]);
  return names;
}

/** The name a hole reads (`shape`, `statuses[m].shape`) when it is set to a markup string, or undefined. */
function markupStringIn(expr: string, names: Set<string>): string | undefined {
  if (names.size === 0) return undefined;
  const e = expr.trim();
  if (!/^[\w$]+(?:\??\.[\w$]+|\[[^\]\[]*\])*$/.test(e)) return undefined;
  const last = /([\w$]+)$/.exec(e);
  return last && names.has(last[1]) ? e : undefined;
}

/**
 * The functions defined in a script with the span of their code: function
 * declarations, methods, and functions or arrows bound to a name or a
 * property. An arrow with an expression body runs to the next `;` or `,`
 * at its own depth, or the bracket around it. One pass over the tokens.
 */
function localFunctions(
  body: string,
  tokens: readonly Token[] = scanJavaScript(body).tokens,
): { name: string; start: number; end: number }[] {
  const n = tokens.length;
  const punct = (k: number, v: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "punctuation" &&
    tokens[k].value === v;
  const word = (k: number, v?: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "identifier" &&
    (v === undefined || tokens[k].value === v);
  // Bracket partners, and where each expression-bodied arrow stops.
  const partner = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = tokens[k];
    if (t.type !== "punctuation") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") stack.push(k);
    else if (
      (t.value === ")" || t.value === "]" || t.value === "}") &&
      stack.length > 0
    ) {
      const o = stack.pop()!;
      partner[o] = k;
      partner[k] = o;
    }
  }
  const found: {
    name: string;
    nameAt: number;
    body: number;
    arrow: boolean;
  }[] = [];
  /** After `)` of a parameter list at `close`: the body's `{`, or the token after `=>` (arrow). */
  const bodyAfter = (
    close: number,
    arrow: boolean,
  ): { at: number; arrow: boolean } | undefined => {
    // Past a short return type: `): string {`, `): Promise<string> =>`.
    for (let k = close + 1; k < n && k <= close + 24; k++) {
      if (arrow && punct(k, "=") && punct(k + 1, ">"))
        return { at: k + 2, arrow: true };
      if (!arrow && punct(k, "{")) return { at: k, arrow: false };
      if (punct(k, ";") || punct(k, "}") || punct(k, "=")) return undefined;
    }
    return undefined;
  };
  for (let k = 0; k < n; k++) {
    if (word(k, "function") && word(k + 1) && punct(k + 2, "(")) {
      const close = partner[k + 2];
      const b = close === -1 ? undefined : bodyAfter(close, false);
      if (b)
        found.push({
          name: tokens[k + 1].value,
          nameAt: k + 1,
          body: b.at,
          arrow: false,
        });
      continue;
    }
    if (!word(k)) continue;
    // NAME = ..., NAME: ... (a property), or a method NAME(...) {.
    const isBinding =
      punct(k + 1, "=") && !punct(k + 2, "=") && !punct(k + 2, ">");
    const isProperty =
      punct(k + 1, ":") && (punct(k - 1, "{") || punct(k - 1, ","));
    if (isBinding || isProperty) {
      let v = k + 2;
      if (word(v, "async")) v++;
      if (word(v, "function")) {
        const paren = word(v + 1) ? v + 2 : v + 1;
        if (!punct(paren, "(") || partner[paren] === -1) continue;
        const b = bodyAfter(partner[paren], false);
        if (b)
          found.push({
            name: tokens[k].value,
            nameAt: k,
            body: b.at,
            arrow: false,
          });
      } else if (punct(v, "(") && partner[v] !== -1) {
        const b = bodyAfter(partner[v], true);
        if (b)
          found.push({
            name: tokens[k].value,
            nameAt: k,
            body: b.at,
            arrow: true,
          });
      } else if (word(v) && punct(v + 1, "=") && punct(v + 2, ">"))
        found.push({
          name: tokens[k].value,
          nameAt: k,
          body: v + 3,
          arrow: true,
        });
      continue;
    }
    if (
      punct(k + 1, "(") &&
      !punct(k - 1, ".") &&
      partner[k + 1] !== -1 &&
      !CONTROL_WORDS.has(tokens[k].value) &&
      (punct(k - 1, "{") ||
        punct(k - 1, "}") ||
        punct(k - 1, ";") ||
        punct(k - 1, ",") ||
        (word(k - 1) && METHOD_MODIFIERS.has(tokens[k - 1].value)))
    ) {
      const b = bodyAfter(partner[k + 1], false);
      if (b)
        found.push({
          name: tokens[k].value,
          nameAt: k,
          body: b.at,
          arrow: false,
        });
    }
  }
  // An expression body ends at the next `;` or `,` at its depth, or at the
  // bracket that closes around it: one pass with the open arrows pending
  // per depth.
  const stopOf = new Map<number, number>();
  const pendingStarts = new Set(
    found.filter((f) => f.arrow && !punct(f.body, "{")).map((f) => f.body),
  );
  const pending: number[][] = [[]];
  for (let k = 0; k < n; k++) {
    if (pendingStarts.has(k)) pending[pending.length - 1].push(k);
    const t = tokens[k];
    if (t.type !== "punctuation") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") pending.push([]);
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      if (pending.length > 1) {
        for (const s of pending.pop()!) stopOf.set(s, k);
      }
    } else if (t.value === ";" || t.value === ",") {
      for (const s of pending[pending.length - 1]) stopOf.set(s, k);
      pending[pending.length - 1] = [];
    }
  }
  return found.map((f) => {
    const start = tokens[f.nameAt].start;
    let end: number;
    if (punct(f.body, "{")) {
      const close = partner[f.body];
      end = close === -1 ? body.length : tokens[close].end;
    } else {
      const stop = stopOf.get(f.body);
      end = stop === undefined ? body.length : tokens[stop].start;
    }
    return { name: f.name, start, end };
  });
}

/**
 * A template that starts like a lint or compiler message: `${file}:${line}: `
 * or `${file}:${line}:${column}: ` (the parts joined with \u0000 for holes).
 */
const FILE_LINE_MESSAGE = /^\u0000:\u0000(?::\u0000)?:\s/;

/** Words in a callee's name that make it a reporting function. */
const MESSAGE_WORDS = new Set(
  "diagnostic diagnostics error errors fail failure finding findings info issue issues lint log logs message messages notice problem problems report warn warning warnings".split(
    " ",
  ),
);

/**
 * The template literals (by start) passed straight to a function whose
 * name has a reporting word in it, split at camelCase and `.`: finding(),
 * addWarning(), ctx.report(), logger.warn(). The innermost open bracket
 * around each literal is read in one sweep over the tokens, so a literal
 * nested in an arrow's body (`items.map((p) => \`...\`)`) belongs to that
 * call (map) and not to one further out.
 */
function messageCallArguments(
  tokens: readonly Token[],
  literals: readonly TemplateLiteral[],
): Set<number> {
  const found = new Set<number>();
  const open: number[] = [];
  let t = 0;
  for (const literal of literals) {
    for (; t < tokens.length && tokens[t].start < literal.start; t++) {
      const token = tokens[t];
      if (token.type !== "punctuation") continue;
      if (token.value === "(" || token.value === "[" || token.value === "{")
        open.push(t);
      else if (
        (token.value === ")" || token.value === "]" || token.value === "}") &&
        open.length > 0
      )
        open.pop();
    }
    const paren = open.length > 0 ? open[open.length - 1] : -1;
    if (paren < 1 || tokens[paren].value !== "(") continue;
    const callee = tokens[paren - 1];
    if (callee.type !== "identifier") continue;
    const words = callee.value
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_$]+/);
    if (words.some((w) => MESSAGE_WORDS.has(w))) found.add(literal.start);
  }
  return found;
}

/** A quoted string that holds a tag, or a lone `<` or `</` that starts one. */
const MARKUP_STRING = /<[a-zA-Z!/]|^\s*<\s*$/;

/**
 * The offsets, ascending, where markup built as a string starts: the
 * markup templates given, and each quoted string that holds a tag (`'<svg
 * class="ok"></svg>'`, `"<b>"`), messages and search patterns left out.
 */
function markupSourceStarts(
  body: string,
  tokens: readonly Token[],
  templateStarts: readonly number[],
): number[] {
  const starts = [...templateStarts];
  for (const t of tokens)
    if (
      t.type === "string" &&
      MARKUP_STRING.test(t.value) &&
      !isMessageArgument(body, t.start - 1) &&
      !isPatternArgument(body, t.start - 1)
    )
      starts.push(t.start - 1);
  return starts.sort((x, y) => x - y);
}

/**
 * The names that may hold or return markup built as a string: a local
 * function, a binding (`let out = ""; out += \`<li>...\``), or an array
 * filled with .push() or .unshift(), whose code holds a markup literal,
 * calls a project import, or reads another such name. Names are merged
 * across scopes, so a name that holds markup anywhere counts everywhere:
 * the fix is withheld when unsure. Each identifier counts for the
 * innermost region around it, and a region counts for the ones around it,
 * so the pass stays linear in the tokens.
 *
 * Returns the names, and the identifiers that read one (ascending
 * `starts` with their `values`).
 */
function markupProducers(
  tokens: readonly Token[],
  functions: readonly { name: string; start: number; end: number }[],
  bindings: readonly { name: string; from: number; end: number }[],
  sourceWithin: (from: number, to: number) => boolean,
  projectNames: ReadonlySet<string>,
): { names: Set<string>; starts: number[]; values: string[] } {
  const n = tokens.length;
  const isPunct = (k: number, v: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "punctuation" &&
    tokens[k].value === v;
  /** An identifier read as a value: not a property (`x.name`) or a key (`{ name: x }`). */
  const reads = (k: number): boolean =>
    tokens[k].type === "identifier" &&
    !isPunct(k - 1, ".") &&
    !(isPunct(k + 1, ":") && (isPunct(k - 1, "{") || isPunct(k - 1, ",")));
  const regions: { name: string; start: number; end: number }[] = [
    ...functions,
    ...bindings.map((b) => ({ name: b.name, start: b.from, end: b.end })),
  ];
  // NAME.push(...) and NAME.unshift(...): the arguments fill NAME.
  const opens: number[] = [];
  const partner = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    if (tokens[k].type !== "punctuation") continue;
    const v = tokens[k].value;
    if (v === "(" || v === "[" || v === "{") opens.push(k);
    else if ((v === ")" || v === "]" || v === "}") && opens.length > 0)
      partner[opens.pop()!] = k;
  }
  for (let k = 0; k + 3 < n; k++)
    if (
      tokens[k].type === "identifier" &&
      !isPunct(k - 1, ".") &&
      isPunct(k + 1, ".") &&
      (tokens[k + 2].value === "push" || tokens[k + 2].value === "unshift") &&
      isPunct(k + 3, "(") &&
      partner[k + 3] !== -1
    )
      regions.push({
        name: tokens[k].value,
        start: tokens[k + 3].start,
        end: tokens[partner[k + 3]].end,
      });
  regions.sort((x, y) => x.start - y.start || y.end - x.end);

  const names = new Set<string>();
  const usedBy = new Map<string, Set<string>>();
  const queue: string[] = [];
  const mark = (name: string): void => {
    if (names.has(name)) return;
    names.add(name);
    queue.push(name);
  };
  const edge = (from: string, to: string): void => {
    if (from === to) return;
    let set = usedBy.get(from);
    if (!set) usedBy.set(from, (set = new Set()));
    set.add(to);
  };
  const stack: { name: string; end: number }[] = [];
  let r = 0;
  for (let k = 0; k <= n; k++) {
    const at = k < n ? tokens[k].start : Infinity;
    while (r < regions.length && regions[r].start <= at) {
      const region = regions[r++];
      while (stack.length > 0 && stack[stack.length - 1].end <= region.start)
        stack.pop();
      if (sourceWithin(region.start, region.end)) mark(region.name);
      if (stack.length > 0) edge(region.name, stack[stack.length - 1].name);
      stack.push(region);
    }
    if (k === n) break;
    while (stack.length > 0 && stack[stack.length - 1].end <= at) stack.pop();
    if (stack.length === 0 || !reads(k)) continue;
    const value = tokens[k].value;
    const owner = stack[stack.length - 1].name;
    // A project import that is called or passed on may return markup.
    if (projectNames.has(value)) mark(owner);
    else edge(value, owner);
  }
  while (queue.length > 0)
    for (const next of usedBy.get(queue.pop()!) ?? []) mark(next);

  const starts: number[] = [];
  const values: string[] = [];
  for (let k = 0; k < n; k++)
    if (reads(k) && names.has(tokens[k].value)) {
      starts.push(tokens[k].start);
      values.push(tokens[k].value);
    }
  return { names, starts, values };
}

const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "function",
  "return",
  "typeof",
  "await",
  "new",
]);
const METHOD_MODIFIERS = new Set([
  "async",
  "static",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "override",
]);

/** A template whose first tag is an XML prolog or the root of a sitemap or a feed. */
const XML_TEMPLATE =
  /^\s*<(?:\?xml\b|(?:rss|feed|urlset|sitemapindex|sitemap|url|loc|channel|item|entry)(?=[\s/>]))/;

/** How a message quotes a hole: `${expr}`, cut short when the expression is long. */
function quoteHole(expr: string): string {
  const e = expr.trim();
  return `\${${e.length > 60 ? `${e.slice(0, 57)}...` : e}}`;
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
