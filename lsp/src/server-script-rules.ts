import {
  findModuleSpecifiers,
  scanJavaScript,
  type Token,
} from "./module-specifiers.js";
import { holdsMarkupCharacter, plainHoleChecker } from "./plain-holes.js";
import { stringTypedFlow } from "./string-typed-flow.js";
import {
  HAND_WRITTEN_ESCAPER_RULE,
  findHandWrittenEscapers,
} from "./hand-written-escaper.js";
import { maskCommentsAndStrings } from "./api-rules.js";
import { escapeRegExp } from "./analyzer.js";
import {
  HTML_MODULE,
  boundTo,
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

/** A server or stream script whose default export returns a Response. */
export const RETURNS_RESPONSE_RULE = "server-script-returns-response";

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

  // server-script-returns-response: the API-route habit, refused at request
  // time. Only a server or stream script's own body: a module is read for its
  // markup, and a build script may return what it likes.
  if (
    !opts.hasSrcAttribute &&
    (opts.directive === "server" || opts.directive === "stream")
  )
    for (const { start, end } of findReturnedResponses(body))
      diagnostics.push({
        code: RETURNS_RESPONSE_RULE,
        message: `This data-bascik-${opts.directive} script returns a Response, which Bascik refuses when the page is requested: the script's return value is spliced into the page as markup. Return a string or an html\`...\` value from @bascik/bascik/html. A Response belongs in an API route (src/api/).`,
        severity: "warning",
        start,
        end,
      });

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
  const htmlTags = htmlTagNames(imports);
  const literals = findTemplateLiterals(body);
  // Every Part C diagnostic is on a template's hole. In build-time code
  // one needs markup, a `<` in the template's text, or an html tag, so a
  // script without either is done here, before the costlier passes.
  if (
    !requestTime &&
    !literals.some(
      (l) =>
        (l.tag !== null && htmlTags.includes(l.tag)) ||
        l.parts.some((part) => part.includes("<")),
    )
  )
    return diagnostics;
  // Read once: the exemption checks and markupProducers both use them.
  const bindingRanges = findBindingRanges(body);
  const ctx: ExemptContext = {
    imports,
    htmlTags,
    escapeFunctions: [...(opts.escapeFunctions ?? []), ...xmlEscapers],
    bindings: findBindings(body, bindingRanges),
    memo: newNameMemo(),
  };
  /**
   * The callee when a hole is one call `accept` takes (`json(x)`), or a
   * name every value of which is (`const body = json(x)`), or undefined.
   */
  const boundCallee = (
    expr: string,
    question: string,
    accept: (callee: string) => boolean,
  ): string | undefined =>
    boundTo(expr, ctx, question, (e) => {
      const callee = callOf(e);
      return callee !== undefined && accept(callee) ? callee : undefined;
    });
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
  // In a module, what other modules can call (exported functions, classes
  // and objects) may be passed markup by any caller: its parameters count
  // as possibly markup, unless typed number, bigint or boolean. A directive
  // script's own default export is called by Bascik, not by other modules.
  const externalParams = new Map<string, ReachableOwner[]>();
  if (opts.directive === "module") {
    for (const [name, owners] of exportReachableParameters(body, tokens))
      externalParams.set(name, [...owners]);
    // Callbacks, methods and functions passed on or returned: their
    // callers are out of sight too. An exported owner's label is kept.
    for (const [name, owners] of unseenCallerParameters(body, tokens)) {
      const list = externalParams.get(name) ?? [];
      const known = new Set(list.map((o) => o.at));
      for (const owner of owners) if (!known.has(owner.at)) list.push(owner);
      externalParams.set(name, list);
    }
    // In source order, for reachableOwnerAt's binary search.
    for (const list of externalParams.values())
      list.sort((x, y) => x.at - y.at);
  }
  const producers = markupProducers(
    tokens,
    functions,
    bindingRanges,
    sourceWithin,
    projectNames,
    (name) =>
      htmlExportOf(name, imports) !== undefined ||
      ctx.escapeFunctions.includes(name),
    externalParams,
  );
  // Local functions that build a markup string: a hole that calls one
  // holds markup, which wrapping the template in html would escape.
  const localHelpers = new Set<string>();
  for (const fn of functions)
    if (producers.markupNames.has(fn.name)) localHelpers.add(fn.name);
  /** The first call in `from`..`to` whose result this file cannot see into. */
  const opaqueWithin = (from: number, to: number): string | undefined => {
    const k = firstAtOrAfter(producers.opaqueStarts, from);
    return k < producers.opaqueStarts.length && producers.opaqueStarts[k] < to
      ? producers.opaqueValues[k]
      : undefined;
  };
  // Untagged templates whose text holds & or <, which html would escape.
  const characterCount = [0];
  for (const l of literals)
    characterCount.push(
      characterCount[characterCount.length - 1] +
        (l.tag === null && l.parts.some(holdsMarkupCharacter) ? 1 : 0),
    );
  // Untagged templates with holes, which turn an html value in them into text.
  const plainTemplateCount = [0];
  for (const l of literals)
    plainTemplateCount.push(
      plainTemplateCount[plainTemplateCount.length - 1] +
        ((l.tag === null || PLAIN_STRING_TAGS.has(l.tag)) && l.holes.length > 0
          ? 1
          : 0),
    );
  // The allowlist: a hole keeps the fix only when it is provably plain data.
  const unprovenIn = plainHoleChecker(body, tokens, {
    requestTime,
    functions,
    holes: literals.flatMap((l) =>
      l.holes.map((h) => [h.start + 2, h.end - 1] as const),
    ),
    markupWithin: sourceWithin,
    markupCharacterTextWithin: (from, to) =>
      characterCount[firstAtOrAfter(literalStarts, to)] -
        characterCount[firstAtOrAfter(literalStarts, from)] >
      0,
    plainTemplateWithin: (from, to) =>
      plainTemplateCount[firstAtOrAfter(literalStarts, to)] -
        plainTemplateCount[firstAtOrAfter(literalStarts, from)] >
      0,
    isHtmlValue: (name) => {
      const exported = htmlExportOf(name, imports);
      return (
        exported === "html" ||
        exported === "raw" ||
        exported === "safeUrl" ||
        exported === "json"
      );
    },
    htmlTags: ctx.htmlTags,
    templateEndAt: (start) => literalAt.get(start)?.end,
  });
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
      const callee = boundCallee(
        hole.expr,
        "escaper",
        (c) =>
          htmlExportOf(c, imports) === "esc" || ctx.escapeFunctions.includes(c),
      );
      const at = { hole: hole.index, shown };
      if (callee !== undefined)
        return {
          ...at,
          text: `is escaped already, and html would escape it again. Wrap the template in html\`...\` from @bascik/bascik/html and pass that value as it is, without ${callee}().`,
        };
      if (sourceWithin(hole.start + 2, hole.end - 1))
        return {
          ...at,
          text: `builds markup as a string, which html would escape, so the page would show its tags as text. Build that markup with html\`...\` first, since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
        };
      const opaque = opaqueWithin(hole.start + 2, hole.end - 1);
      if (opaque !== undefined)
        return {
          ...at,
          text:
            opaque === ENV_READ
              ? `reads ${ENV_READ}, an environment variable this file cannot see into; if it is markup, html would escape it, so the page would show its tags as text. Make that value an html\`...\` value (raw() for trusted markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`
              : `calls ${opaque}(), whose result this file cannot see into (a callback, a package function, a file or a response); if it is markup, html would escape it, so the page would show its tags as text. Make that value an html\`...\` value (raw() for trusted markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
        };
      const name = producerWithin(hole.start + 2, hole.end - 1);
      if (name !== undefined) {
        const seed = producers.fromSeed.get(name);
        if (seed !== undefined && seed !== name)
          return {
            ...at,
            text: `reads ${name}, which is taken from ${callerClause(seed, reachableOwnerAt(externalParams, seed, hole.start))}, which html would escape, so the page would show its tags as text. Build the callers' markup with html\`...\` (raw() for fixed markup) and pass html values, since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
          };
        const owner = reachableOwnerAt(externalParams, name, hole.start);
        return {
          ...at,
          text:
            owner !== undefined
              ? `reads ${callerClause(name, owner)}, which html would escape, so the page would show its tags as text. Build the callers' markup with html\`...\` (raw() for fixed markup) and pass html values, since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`
              : !producers.names.has(name)
                ? `reads ${name}, imported from a project module, which may hold markup as a string; html would escape it, so the page would show its tags as text. Make that value an html\`...\` value in its module (raw() for fixed markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`
                : producers.markupNames.has(name)
                  ? `reads ${name}, which may hold markup built as a string in this file; html would escape it, so the page would show its tags as text. Build that markup with html\`...\` first (raw() for fixed markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`
                  : `reads ${name}, which holds what this file cannot see into (a callback, a package function, a file, a response or an environment variable); if it is markup, html would escape it, so the page would show its tags as text. Make that value an html\`...\` value (raw() for trusted markup), since html inserts an html value as it is, then wrap this template in html\`...\` from @bascik/bascik/html.`,
        };
      }
    }
    // Then the allowlist: every hole must be provably plain data.
    for (const hole of literal.holes) {
      if (contexts[hole.index - 1].kind === "comment") continue;
      if (fenced?.has(hole.index)) continue;
      if (isHtmlHole(hole.expr)) continue;
      const unproven = unprovenIn(hole.start + 2, hole.end - 1);
      if (unproven !== undefined)
        return {
          hole: hole.index,
          shown: `${quoteHole(hole.expr)} (hole ${hole.index})`,
          text: `reads ${unproven.what}, ${unproven.why}, so Bascik ${UNPROVEN_TEXT}`,
        };
    }
    return undefined;
  };
  /** A hole that is an html value: html inserts it as it is, so wrapping keeps it. */
  const isHtmlHole = (expr: string): boolean => {
    const e = expr.trim();
    const callee = callOf(e);
    if (callee !== undefined) {
      const exported = htmlExportOf(callee, imports);
      if (
        exported === "html" ||
        exported === "raw" ||
        exported === "safeUrl" ||
        exported === "json"
      )
        return true;
    }
    return ctx.htmlTags.some(
      (tag) =>
        e.startsWith(`${tag}\``) ||
        new RegExp(`=>\\s*${escapeRegExp(tag)}\``).test(e),
    );
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
  const stringTypedAt = stringTypedFlow(body, tokens);
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
    // A value typed string (`): string`, `const x: string =`, `as string`):
    // as an html value it would fail type checking, so no fix.
    const typedAs =
      fixable && literal.tag === null && parent === -1
        ? stringTypedAt(literal.start, literal.end)
        : undefined;
    if (typedAs !== undefined) fixable = false;
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
          // <script type="application/json">${json(value)}</script> is
          // html's own form, also through a name bound to json(value).
          const isJsonScript = context.kind === "raw" && context.jsonScript;
          if (
            isJsonScript &&
            boundCallee(
              hole.expr,
              "json",
              (c) => htmlExportOf(c, imports) === "json",
            ) !== undefined
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
        if (
          sink === null &&
          boundCallee(
            hole.expr,
            "esc",
            (c) => htmlExportOf(c, imports) === "esc",
          ) !== undefined
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
                : typedAs !== undefined
                  ? `${head} Wrapping this template in html is not offered as a fix: its value goes where the code declares \`: ${typedAs}\`, and html makes a SafeHtml value, so type checking would fail. Change that type to SafeHtml (import type { SafeHtml } from "@bascik/bascik/html"), then wrap the template in html\`...\` from @bascik/bascik/html yourself.`
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
        // safeUrl() in the hole, or in every value of a name it reads.
        const importsSafeUrl = [...ctx.imports.named.values()].includes(
          "safeUrl",
        );
        const checked =
          boundTo(hole.expr, ctx, "safeUrl", (e) => {
            const callee = callOf(e);
            return (importsSafeUrl &&
              /\bsafeUrl\s*\(|\.safeUrl\s*\(/.test(e)) ||
              (callee !== undefined &&
                htmlExportOf(callee, imports) === "safeUrl")
              ? "safeUrl"
              : undefined;
          }) !== undefined;
        if (!checked)
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
  // Each `import` is read forward to its `from` by hand: a single regular expression with a bounded clause before
  // `\s+from` backtracks quadratically on a long clause.
  const from = /\s+from\s*["'](?:\.\.?\/|@\/)/g;
  for (const m of body.matchAll(/\bimport\s+(?!type\s)/g)) {
    const start = m.index + m[0].length;
    from.lastIndex = start;
    const end = from.exec(body);
    if (!end) break;
    const clause = body.slice(start, end.index);
    if (clause.length === 0 || clause.length > 1000 || /[;'"`]/.test(clause))
      continue;
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

/** A function defined in a script: its name, the span of its code, and its parameters' names by position. */
interface LocalFunction {
  name: string;
  start: number;
  end: number;
  params: string[][];
  /** The body's first offset: its `{`, or an arrow's expression. */
  body: number;
  /** An arrow whose body is an expression. */
  expression: boolean;
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
): LocalFunction[] {
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
    /** The parameter list's `(`, or the lone parameter of `x => ...`, as a token index. */
    params: number;
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
  /**
   * For `const|let|var NAME: Type =` at NAME (`k`), the `=` token's index,
   * the annotation's brackets skipped; -1 otherwise. Read for at most 200
   * tokens, so the pass stays linear.
   */
  const typedBindingEquals = (k: number): number => {
    if (
      !punct(k + 1, ":") ||
      !(word(k - 1, "const") || word(k - 1, "let") || word(k - 1, "var"))
    )
      return -1;
    let angle = 0;
    for (let j = k + 2; j < n && j <= k + 200; j++) {
      if (tokens[j].type !== "punctuation") continue;
      const v = tokens[j].value;
      if (v === "(" || v === "[" || v === "{") {
        if (partner[j] === -1) return -1;
        j = partner[j];
      } else if (v === "<") angle++;
      else if (v === ">") angle = Math.max(0, angle - 1);
      else if (v === "=") {
        if (punct(j + 1, ">")) j++;
        else if (punct(j + 1, "=")) return -1;
        else if (angle === 0) return j;
      } else if (v === ";" || v === ")" || v === "]" || v === "}") return -1;
    }
    return -1;
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
          params: k + 2,
        });
      continue;
    }
    if (!word(k)) continue;
    // NAME = ..., NAME: Type = ..., NAME: ... (a property), or a method
    // NAME(...) {.
    const typedEq = typedBindingEquals(k);
    const isBinding =
      (punct(k + 1, "=") && !punct(k + 2, "=") && !punct(k + 2, ">")) ||
      typedEq !== -1;
    const isProperty =
      punct(k + 1, ":") && (punct(k - 1, "{") || punct(k - 1, ","));
    if (isBinding || isProperty) {
      let v = typedEq !== -1 ? typedEq + 1 : k + 2;
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
            params: paren,
          });
      } else if (punct(v, "(") && partner[v] !== -1) {
        const b = bodyAfter(partner[v], true);
        if (b)
          found.push({
            name: tokens[k].value,
            nameAt: k,
            body: b.at,
            arrow: true,
            params: v,
          });
      } else if (word(v) && punct(v + 1, "=") && punct(v + 2, ">"))
        found.push({
          name: tokens[k].value,
          nameAt: k,
          body: v + 3,
          arrow: true,
          params: v,
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
          params: k + 1,
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
  /**
   * Each parameter's names, by position: `a`, `a = 1` and `...a` give a;
   * a pattern (`{ icon, t }`) gives every name in it before its type or
   * default. Types after `:` are left out.
   */
  const parameterNames = (at: number): string[][] => {
    if (!punct(at, "(")) return word(at) ? [[tokens[at].value]] : [];
    const close = partner[at];
    const params: string[][] = [];
    let current: string[] = [];
    let skipping = false;
    for (let j = at + 1; j < close; j++) {
      const t = tokens[j];
      if (t.type === "punctuation") {
        if (t.value === ",") {
          params.push(current);
          current = [];
          skipping = false;
        } else if (t.value === ":" || t.value === "=") skipping = true;
        else if (t.value === "{" || t.value === "[" || t.value === "(") {
          if (skipping) j = partner[j] === -1 ? close : partner[j];
          // A pattern: the names in it, keys (followed by `:`) left out.
          else if (t.value !== "(")
            for (let q = j + 1; q < partner[j]; q++)
              if (
                tokens[q].type === "identifier" &&
                !punct(q + 1, ":") &&
                !punct(q - 1, ".")
              )
                current.push(tokens[q].value);
          if (!skipping && partner[j] !== -1) j = partner[j];
        }
      } else if (t.type === "identifier" && !skipping) {
        if (
          !METHOD_MODIFIERS.has(t.value) ||
          punct(j + 1, ",") ||
          punct(j + 1, ":") ||
          punct(j + 1, ")")
        )
          current.push(t.value);
      }
    }
    if (current.length > 0 || params.length > 0) params.push(current);
    return params;
  };
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
    const expression = !punct(f.body, "{");
    return {
      name: f.name,
      start,
      end,
      params: parameterNames(f.params),
      body: f.body < n ? tokens[f.body].start : body.length,
      expression,
    };
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
 * addWarning(), ctx.report(), logger.warn(), unless it starts with a tag
 * and holds an end tag (writeReport("r.html", `<html>...</html>`) saves a
 * page). The innermost open bracket
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
    // A whole document or element (`<html>...</html>`) is markup a
    // report writer saves, not a message that names a tag.
    if (
      /^\s*</.test(literal.parts[0]) &&
      literal.parts.some((p) => p.includes("</"))
    )
      continue;
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

/** Parameter types that cannot hold markup: number, bigint, boolean and unions of them. */
const PLAIN_PARAMETER_TYPE =
  /^\s*\|?\s*(?:number|bigint|boolean|true|false)(?:\s*\|\s*(?:number|bigint|boolean|true|false))*\s*$/;

/** Words before a class member's or parameter's name that are not its name. */
const MEMBER_MODIFIERS = new Set([
  "async",
  "static",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "override",
  "readonly",
  "abstract",
  "declare",
  "accessor",
]);

/**
 * The names of the parameter list at token `at` (a `(`, or the lone
 * parameter of `x => ...`) that may hold markup: every name, patterns and
 * rest parameters included, except those whose declared type is number,
 * bigint or boolean (or a union of those). `partner` maps each bracket to
 * its partner.
 */
function possiblyMarkupParameters(
  body: string,
  tokens: readonly Token[],
  partner: Int32Array,
  at: number,
): string[] {
  const n = tokens.length;
  const punct = (k: number, v: string): boolean =>
    k >= 0 &&
    k < n &&
    tokens[k].type === "punctuation" &&
    tokens[k].value === v;
  const word = (k: number): boolean =>
    k >= 0 && k < n && tokens[k].type === "identifier";
  if (!punct(at, "(")) {
    return word(at) ? [tokens[at].value] : [];
  }
  const close = partner[at];
  if (close === -1) return [];
  const out: string[] = [];
  let names: string[] = [];
  let typeFrom = -1;
  let typeTo = -1;
  const finish = (): void => {
    const type =
      typeFrom !== -1 && typeTo >= typeFrom
        ? body.slice(tokens[typeFrom].start, tokens[typeTo].end)
        : undefined;
    if (type === undefined || !PLAIN_PARAMETER_TYPE.test(type))
      for (const name of names) if (name !== "this") out.push(name);
    names = [];
    typeFrom = typeTo = -1;
  };
  // 0: the name or pattern, 1: the type, 2: the default value.
  let part = 0;
  for (let j = at + 1; j < close; j++) {
    const t = tokens[j];
    if (t.type === "punctuation") {
      if (t.value === ",") {
        finish();
        part = 0;
        continue;
      }
      if (part === 0 && t.value === ":") {
        part = 1;
        continue;
      }
      if (part !== 2 && t.value === "=" && !punct(j + 1, ">")) {
        part = 2;
        continue;
      }
      if (t.value === "(" || t.value === "[" || t.value === "{") {
        const end = partner[j] === -1 ? close : partner[j];
        if (part === 0)
          for (let q = j + 1; q < end; q++)
            if (
              tokens[q].type === "identifier" &&
              !punct(q + 1, ":") &&
              !punct(q - 1, ".")
            )
              names.push(tokens[q].value);
        if (part === 1) {
          if (typeFrom === -1) typeFrom = j;
          typeTo = end;
        }
        j = end;
        continue;
      }
    }
    if (part === 0 && t.type === "identifier") {
      if (
        !MEMBER_MODIFIERS.has(t.value) ||
        punct(j + 1, ",") ||
        punct(j + 1, ":") ||
        punct(j + 1, "?") ||
        punct(j + 1, "=") ||
        j + 1 === close
      )
        names.push(t.value);
    } else if (part === 1 && !(t.type === "punctuation" && t.value === "?")) {
      if (typeFrom === -1) typeFrom = j;
      typeTo = j;
    }
  }
  finish();
  return out;
}

/** How a message names the function a parameter belongs to. */
function ownerLabel(path: string): string {
  if (path === "default") return "the default export";
  const constructor = /^(.*)\.constructor$/.exec(path);
  if (constructor)
    return `new ${ownerLabel(constructor[1]).replace(/\(\)$/, "")}()`;
  if (path.startsWith("default."))
    return `the default export's ${path.slice(8)}()`;
  return `${path}()`;
}

/**
 * A function whose parameter list starts at `at` (a source offset), as a
 * message names it. `exported`: other modules can call it; `unseen`: a
 * callback, a method, or a function passed on or returned as a value, whose
 * callers this file cannot all see; `this` and `arguments`: what those
 * read, which callers fill.
 */
interface ReachableOwner {
  at: number;
  label: string;
  kind: "exported" | "unseen" | "this" | "arguments";
}

/** The owner of a parameter named `name` read at `offset`: the nearest function before it with such a parameter. */
function reachableOwnerAt(
  owners: ReadonlyMap<string, readonly ReachableOwner[]>,
  name: string,
  offset: number,
): ReachableOwner | undefined {
  // Each list is sorted by `at`, so a binary search finds it.
  const list = owners.get(name);
  if (list === undefined || list.length === 0) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  if (list[0].at > offset) return list[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].at <= offset) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
}

/** How a message says where a parameter's value comes from and why html may escape it. */
function callerClause(name: string, owner: ReachableOwner | undefined): string {
  switch (owner?.kind) {
    case "this":
      return "this, whose fields a constructor or method may have filled from a caller's arguments: the value may be markup from a caller";
    case "arguments":
      return "arguments, which holds what the function's callers pass: the value may be markup from a caller";
    case "unseen":
      return `${name}, a parameter of ${owner.label}, whose callers this file cannot all see (a callback, a method, or a function passed on or returned): the value may be markup from a caller`;
    default:
      return `${name}, a parameter of ${owner?.label ?? "a function"}, which other modules can call: the value may be markup from a caller`;
  }
}

/**
 * The parameters of everything this module lets other modules call, each
 * with the functions it belongs to and how a message names them: exported functions (named, or a
 * default export named or anonymous), every method and constructor of an
 * exported class, the methods and function members of an exported object
 * (nested objects too), local functions exported by name or named in an
 * exported object, and the same through module.exports and exports.x.
 * Another module may pass any of them markup, so they count as possibly
 * markup, except a parameter whose declared type is number, bigint or
 * boolean (or a union of those). Each declaration is read once, so the
 * pass stays linear in the tokens.
 */
export function exportReachableParameters(
  body: string,
  tokens: readonly Token[] = scanJavaScript(body).tokens,
): Map<string, ReachableOwner[]> {
  const out = new Map<string, ReachableOwner[]>();
  const n = tokens.length;
  /** Records that `name` is a parameter of the function whose list starts at token `at`. */
  const own = (name: string, at: number, label: string): void => {
    const list = out.get(name) ?? [];
    list.push({ at: tokens[at].start, label, kind: "exported" });
    out.set(name, list);
  };
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
  /** After `const|let|var NAME` at `k`: the token after its `=`, past a type annotation; -1 when there is none. */
  const initializerAfter = (k: number): number => {
    let j = k + 1;
    if (!punct(j, ":")) return punct(j, "=") && !punct(j + 1, "=") ? j + 1 : -1;
    for (let angle = 0; j < n && j <= k + 200; j++) {
      if (tokens[j].type !== "punctuation") continue;
      const v = tokens[j].value;
      if (v === "(" || v === "[" || v === "{") {
        if (partner[j] === -1) return -1;
        j = partner[j];
      } else if (v === "<") angle++;
      else if (v === ">") angle = Math.max(0, angle - 1);
      else if (v === "=" && !punct(j - 1, "=")) {
        if (punct(j + 1, ">")) j++;
        else if (punct(j + 1, "=")) return -1;
        else if (angle === 0) return j + 1;
      } else if (v === ";" || v === ")" || v === "]" || v === "}") return -1;
    }
    return -1;
  };
  // Where each name is declared: function NAME, class NAME, NAME = value.
  const declarations = new Map<string, number[]>();
  const declare = (name: string, at: number): void => {
    const list = declarations.get(name) ?? [];
    list.push(at);
    declarations.set(name, list);
  };
  for (let k = 0; k + 1 < n; k++) {
    if ((word(k, "function") || word(k, "class")) && word(k + 1))
      declare(tokens[k + 1].value, k);
    else if (
      (word(k - 1, "const") || word(k - 1, "let") || word(k - 1, "var")) &&
      word(k)
    ) {
      const v = initializerAfter(k);
      if (v !== -1 && v < n) declare(tokens[k].value, v);
    }
  }
  /** Records the parameters of the list at `at` (a `(`, or the lone parameter of `x => ...`). */
  const addParameters = (at: number, path: string): void => {
    const label = ownerLabel(path);
    for (const name of possiblyMarkupParameters(body, tokens, partner, at))
      own(name, at, label);
  };
  const visited = new Set<number>();
  /** The members of the class or object whose `{` is at `open`. */
  const members = (open: number, base: string, isClass: boolean): void => {
    const close = partner[open];
    if (close === -1) return;
    for (let j = open + 1; j < close; j++) {
      const t = tokens[j];
      if (
        t.type === "punctuation" &&
        (t.value === "(" || t.value === "[" || t.value === "{")
      ) {
        // A method: KEY(...) {, its key an identifier, a string or [computed].
        if (t.value === "(" && partner[j] !== -1) {
          const k = j - 1;
          const keyed =
            (word(k) || tokens[k]?.type === "string" || punct(k, "]")) &&
            !punct(k - 1, ".");
          const after = partner[j] + 1;
          if (
            keyed &&
            (punct(after, "{") || punct(after, ":")) &&
            !(word(k) && CONTROL_WORDS.has(tokens[k].value))
          ) {
            const key =
              tokens[k].type === "punctuation" ? "[computed]" : tokens[k].value;
            addParameters(j, `${base}.${key}`);
          }
        }
        if (partner[j] !== -1) j = partner[j];
        continue;
      }
      // KEY: value (objects) and KEY = value (class fields).
      const valueSign = isClass
        ? punct(j, "=") &&
          !punct(j + 1, "=") &&
          !punct(j + 1, ">") &&
          !punct(j - 1, "=") &&
          !punct(j - 1, "!") &&
          !punct(j - 1, "<") &&
          !punct(j - 1, ">")
        : punct(j, ":");
      if (valueSign) {
        let k = j - 1;
        if (isClass) {
          // Back past a type annotation to the field's name.
          while (
            k > open &&
            k > j - 64 &&
            !(
              (word(k) || tokens[k].type === "string") &&
              (punct(k - 1, ";") ||
                punct(k - 1, "}") ||
                punct(k - 1, "{") ||
                punct(k + 1, ":") ||
                punct(k + 1, "?") ||
                punct(k + 1, "!") ||
                punct(k + 1, "="))
            )
          )
            k--;
        }
        const key = k > open && k > j - 64 ? tokens[k].value : "[computed]";
        collect(j + 1, `${base}.${key}`);
        continue;
      }
      if (!isClass && word(j)) {
        // { page } and { ...parts }: a local name, read like its declaration.
        if (
          (punct(j - 1, "{") || punct(j - 1, ",") || punct(j - 1, ".")) &&
          (punct(j + 1, ",") || j + 1 === close)
        )
          resolve(tokens[j].value, `${base}.${tokens[j].value}`);
      }
    }
  };
  /** A local name another module can reach: what its declarations hold. */
  const resolved = new Set<string>();
  const resolve = (name: string, path: string): void => {
    // Each name once: its declarations are the same whoever names it.
    if (resolved.has(name)) return;
    resolved.add(name);
    for (const at of declarations.get(name) ?? []) collect(at, path);
  };
  // Values still to read, as a queue, so a long alias chain cannot
  // overflow the call stack.
  const work: { at: number; path: string }[] = [];
  /** Queues the value that starts at token `v`, which another module can reach as `path`. */
  const collect = (v: number, path: string): void => {
    if (v < 0 || v >= n || visited.has(v)) return;
    visited.add(v);
    work.push({ at: v, path });
  };
  /** Reads one queued value. */
  const read = (v: number, path: string): void => {
    // A token in a template's hole is not the value itself.
    if (v > 0 && body.slice(tokens[v - 1].end, tokens[v].start).includes("`"))
      return;
    let k = v;
    while (word(k, "async")) k++;
    if (word(k, "function")) {
      let j = k + 1;
      if (punct(j, "*")) j++;
      if (word(j)) j++;
      if (punct(j, "(")) addParameters(j, path);
      return;
    }
    if (word(k, "class")) {
      let j = k + 1;
      if (word(j) && !word(j, "extends")) j++;
      for (; j < n && j <= k + 400 && !punct(j, "{"); j++) {
        if (punct(j, ";") || punct(j, "}")) return;
        if ((punct(j, "(") || punct(j, "[")) && partner[j] !== -1)
          j = partner[j];
      }
      if (punct(j, "{")) members(j, path, true);
      return;
    }
    if (punct(k, "(") && partner[k] !== -1) {
      // An arrow's parameter list, past a short return type.
      for (let j = partner[k] + 1; j < n && j <= partner[k] + 24; j++) {
        if (punct(j, "=") && punct(j + 1, ">")) {
          addParameters(k, path);
          return;
        }
        if (punct(j, ";") || punct(j, "{") || punct(j, ",") || punct(j, ")"))
          break;
      }
      return;
    }
    if (word(k) && punct(k + 1, "=") && punct(k + 2, ">")) {
      addParameters(k, path);
      return;
    }
    if (punct(k, "{")) {
      members(k, path, false);
      return;
    }
    // A name: export default frame, export const lib = lg.
    if (
      word(k) &&
      !punct(k + 1, "(") &&
      !punct(k + 1, ".") &&
      !punct(k + 1, "[")
    )
      resolve(tokens[k].value, path);
  };
  for (let k = 0; k < n; k++) {
    if (word(k, "export") && !punct(k - 1, ".")) {
      let j = k + 1;
      if (word(j, "default")) {
        let f = j + 1;
        while (word(f, "async")) f++;
        // export default function name / class name: messages name it.
        const named =
          (word(f, "function") || word(f, "class")) &&
          word(f + 1) &&
          !word(f + 1, "extends")
            ? tokens[f + 1].value
            : undefined;
        collect(j + 1, named ?? "default");
        continue;
      }
      if (punct(j, "=")) {
        collect(j + 1, "default");
        continue;
      }
      while (word(j, "declare") || word(j, "abstract")) j++;
      let f = j;
      while (word(f, "async")) f++;
      if ((word(f, "function") || word(f, "class")) && word(f + 1)) {
        collect(j, tokens[f + 1].value);
        continue;
      }
      if (
        (word(j, "const") || word(j, "let") || word(j, "var")) &&
        word(j + 1)
      ) {
        const v = initializerAfter(j + 1);
        if (v !== -1) collect(v, tokens[j + 1].value);
        continue;
      }
      if (punct(j, "{") && partner[j] !== -1) {
        const close = partner[j];
        if (word(close + 1, "from")) continue;
        for (let q = j + 1; q < close; q++) {
          if (!word(q) || word(q, "type") || word(q, "as")) continue;
          if (!(punct(q - 1, "{") || punct(q - 1, ",") || word(q - 1, "type")))
            continue;
          const exported =
            word(q + 1, "as") && word(q + 2)
              ? tokens[q + 2].value
              : tokens[q].value;
          resolve(tokens[q].value, exported);
        }
      }
      continue;
    }
    // module.exports = ..., module.exports.page = ..., exports.page = ...
    if (word(k, "exports") && !punct(k - 1, ".")) {
      if (
        punct(k + 1, ".") &&
        word(k + 2) &&
        punct(k + 3, "=") &&
        !punct(k + 4, "=")
      )
        collect(k + 4, tokens[k + 2].value);
      continue;
    }
    if (
      word(k, "module") &&
      !punct(k - 1, ".") &&
      punct(k + 1, ".") &&
      word(k + 2, "exports")
    ) {
      if (punct(k + 3, "=") && !punct(k + 4, "=")) collect(k + 4, "default");
      else if (
        punct(k + 3, ".") &&
        word(k + 4) &&
        punct(k + 5, "=") &&
        !punct(k + 6, "=")
      )
        collect(k + 6, tokens[k + 4].value);
    }
  }
  for (let w = 0; w < work.length; w++) read(work[w].at, work[w].path);
  return out;
}

/**
 * The parameters in a module whose callers this file cannot all see, with
 * the functions they belong to: every callback and function expression,
 * every method and constructor, generators, and named functions that are
 * exported or used as a value (returned, passed, stored, wrapped) rather
 * than only called by name. A local function declared with `function` or
 * bound to a `const`, `let` or `var`, and only ever called by name, is left
 * out: its parameters hold what those calls pass, which markupProducers
 * follows. Types count as for exported functions: a number, bigint or
 * boolean parameter is plain data. `this` and `arguments` are included as
 * well, since callers fill them. One pass over the tokens, each lookback
 * bounded, so the pass stays linear.
 */
export function unseenCallerParameters(
  body: string,
  tokens: readonly Token[] = scanJavaScript(body).tokens,
): Map<string, ReachableOwner[]> {
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
  const partner = new Int32Array(n).fill(-1);
  // The innermost bracket each token is in.
  const enclosing = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = tokens[k];
    if (stack.length > 0) enclosing[k] = stack[stack.length - 1];
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
  const declarationKeyword = (k: number): boolean =>
    word(k, "const") || word(k, "let") || word(k, "var");
  // Names used other than as a direct call or their own declaration: a
  // function named this way may be called where this file cannot see.
  const usedAsValue = new Set<string>();
  for (let k = 0; k < n; k++) {
    if (!word(k) || punct(k - 1, ".") || punct(k - 1, "#")) continue;
    const name = tokens[k].value;
    // A key: { name: value }.
    if (punct(k + 1, ":") && (punct(k - 1, "{") || punct(k - 1, ","))) continue;
    const isFunctionName =
      word(k - 1, "function") || (punct(k - 1, "*") && word(k - 2, "function"));
    if (isFunctionName || declarationKeyword(k - 1)) {
      let b = isFunctionName ? (word(k - 1) ? k - 2 : k - 3) : k - 2;
      while (word(b, "async")) b--;
      if (word(b, "export") || word(b, "default")) usedAsValue.add(name);
      continue;
    }
    if (!punct(k + 1, "(")) usedAsValue.add(name);
  }
  /** Before a function head ending at token `j`: the `NAME` of `const|let|var NAME =`, if any. */
  const boundName = (j: number): string | undefined => {
    while (word(j, "async")) j--;
    if (!punct(j, "=") || punct(j - 1, "=")) return undefined;
    if (word(j - 1) && declarationKeyword(j - 2)) return tokens[j - 1].value;
    // const NAME: Type = ...: back past the annotation.
    for (let q = j - 1; q >= 0 && q > j - 64; q--) {
      if (
        (punct(q, ")") || punct(q, "]") || punct(q, "}")) &&
        partner[q] !== -1
      )
        q = partner[q];
      else if (punct(q, ":"))
        return word(q - 1) && declarationKeyword(q - 2)
          ? tokens[q - 1].value
          : undefined;
      else if (
        punct(q, ";") ||
        punct(q, "{") ||
        (punct(q, "=") && !punct(q + 1, ">"))
      )
        break;
    }
    return undefined;
  };
  /**
   * Whether the parameter list whose head ends at token `head` is a
   * function type in an annotation, not a function: `const f: (s: string)
   * => string`, `(): (s: string) => string`, `(render: () => string)`.
   */
  const inAnnotation = (head: number): boolean => {
    if (!punct(head, ":")) return false;
    if (punct(head - 1, ")")) return true;
    let name = head - 1;
    if (punct(name, "?")) name--;
    if (!word(name)) return false;
    if (declarationKeyword(name - 1)) return true;
    return (
      (punct(name - 1, "(") || punct(name - 1, ",")) &&
      enclosing[head] !== -1 &&
      punct(enclosing[head], "(")
    );
  };
  /** The token before a parameter list at `k`, past type parameters (`<T>`). */
  const beforeHead = (k: number): number => {
    let j = k - 1;
    if (!punct(j, ">")) return j;
    for (let depth = 0; j >= 0 && j >= k - 64; j--) {
      if (punct(j, ">")) depth++;
      else if (punct(j, "<") && --depth === 0) return j - 1;
    }
    return k - 1;
  };
  /** After a parameter list's `)` at `close`: the token past a return type (`: string`, `: { a: string }`). */
  const pastReturnType = (close: number): number => {
    let j = close + 1;
    if (!punct(j, ":")) return j;
    for (j++; j < n && j <= close + 64; j++) {
      if (punct(j, "=") && punct(j + 1, ">")) return j;
      if (punct(j, "{") && !punct(j - 1, ":") && !punct(j - 1, "|")) return j;
      if ((punct(j, "(") || punct(j, "[") || punct(j, "{")) && partner[j] > j)
        j = partner[j];
      else if (punct(j, ";") || punct(j, ",") || punct(j, ")")) return j;
    }
    return j;
  };
  const isArrow = (j: number): boolean => punct(j, "=") && punct(j + 1, ">");
  const out = new Map<string, ReachableOwner[]>();
  const add = (at: number, label: string): void => {
    for (const name of possiblyMarkupParameters(body, tokens, partner, at)) {
      const list = out.get(name) ?? [];
      list.push({ at: tokens[at].start, label, kind: "unseen" });
      out.set(name, list);
    }
  };
  /** Whether a function bound or declared as `name` is only ever called by name. */
  const onlyCalled = (name: string | undefined): boolean =>
    name !== undefined && !usedAsValue.has(name);
  /** The parameter lists of `function` heads, read with their head. */
  const functionLists = new Set<number>();
  for (let k = 0; k < n; k++) {
    if (word(k, "function") && !punct(k - 1, ".")) {
      let j = k + 1;
      if (punct(j, "*")) j++;
      const generator = j > k + 1;
      const name = word(j) ? tokens[j++].value : undefined;
      if (punct(j, "<"))
        for (let depth = 0, q = j; q < n && q <= j + 64; q++) {
          if (punct(q, "<")) depth++;
          else if (punct(q, ">") && --depth === 0) {
            j = q + 1;
            break;
          }
        }
      if (!punct(j, "(")) continue;
      functionLists.add(j);
      const bound = boundName(k - 1);
      let b = k - 1;
      while (word(b, "async")) b--;
      const statement =
        b < 0 || punct(b, ";") || punct(b, "{") || punct(b, "}");
      const owner = bound ?? (statement ? name : undefined);
      if (!generator && onlyCalled(owner)) continue;
      add(j, (owner ?? name) ? `${owner ?? name}()` : "a callback");
      continue;
    }
    if (punct(k, "(") && partner[k] > k && !functionLists.has(k)) {
      const after = pastReturnType(partner[k]);
      const head = beforeHead(k);
      if (isArrow(after)) {
        if (inAnnotation(head)) continue;
        const bound = boundName(head);
        if (onlyCalled(bound)) continue;
        add(k, bound ? `${bound}()` : "a callback");
        continue;
      }
      // A method: KEY(...) {, its key a name, a string, #name or [computed].
      if (
        punct(after, "{") &&
        ((word(head) && !CONTROL_WORDS.has(tokens[head].value)) ||
          tokens[head]?.type === "string" ||
          punct(head, "]")) &&
        !punct(head - 1, ".")
      ) {
        add(k, word(head) ? `${tokens[head].value}()` : "a method");
        continue;
      }
      continue;
    }
    if (word(k) && isArrow(k + 1) && !punct(k - 1, ".")) {
      const bound = boundName(k - 1);
      if (onlyCalled(bound)) continue;
      add(k, bound ? `${bound}()` : "a callback");
    }
  }
  out.set("this", [{ at: 0, label: "this", kind: "this" }]);
  out.set("arguments", [{ at: 0, label: "arguments", kind: "arguments" }]);
  return out;
}

/** Globals that return plain data, and syntax that looks like a call. */
const PLAIN_CALLEES = new Set(
  "String Number Boolean BigInt Symbol Array Object Date RegExp Map Set WeakMap WeakSet Promise Error TypeError RangeError URL URLSearchParams parseInt parseFloat isNaN isFinite encodeURIComponent encodeURI decodeURIComponent decodeURI structuredClone setTimeout clearTimeout setInterval clearInterval queueMicrotask require import super if for while switch catch with function return typeof void delete await yield new async in of instanceof case do else".split(
    " ",
  ),
);

/** How an environment variable read (`process.env.NAME`) is named among the opaque values. */
const ENV_READ = "process.env";

/** An environment variable whose name says it holds markup: FOOTER_MARKUP, BANNER_HTML, ANALYTICS_SNIPPET. */
const MARKUP_ENV =
  /markup|html|svg|snippet|partial|fragment|banner|footer|header|template|embed/i;

/** Calls that read a file or a response: what they return may be markup. */
const READER_METHODS = new Set(["readFileSync", "readFile", "text"]);

/**
 * A callee whose name says it returns markup: marked(), md.render(),
 * DOMPurify.sanitize(), hljs.highlight(), renderToString(). Other package
 * and global functions (slugify(), format()) are taken to return text.
 */
const MARKUP_CALLEE =
  /render|markdown|marked|markup|html|sanitize|highlight|svg/i;

/** What markupProducers found. */
interface MarkupProducers {
  /** Names that may hold markup: built as a string here, or a value this file cannot see into. */
  names: Set<string>;
  /** The names among them that hold markup built as a string in this file. */
  markupNames: Set<string>;
  /** Identifiers that read one of `names`, ascending, with their names. */
  starts: number[];
  values: string[];
  /** Calls whose result this file cannot see into (`render()`, `marked()`, `fs.readFileSync()`), ascending. */
  opaqueStarts: number[];
  opaqueValues: string[];
  /**
   * Names that hold markup only through a seed (a parameter other modules
   * fill), not through markup built in this file, each with that seed.
   */
  fromSeed: Map<string, string>;
}

/**
 * The names that may hold or return markup built as a string: a local
 * function, a binding (`let out = ""; out += \`<li>...\``), an array
 * filled with .push() or .unshift(), or a parameter of a local function
 * that a call in this file passes such a value, whose code holds a markup
 * literal, calls a project import, or reads another such name. A region
 * that calls a function this file cannot see into and that may return
 * markup (a callback parameter, a function named for markup such as
 * marked() or md.render(), a file read or a response's text()) may hold
 * markup too. Names
 * are merged across scopes, so a name that holds markup anywhere counts
 * everywhere: the fix is withheld when unsure. Each identifier counts for
 * the innermost region around it, and a region counts for the ones around
 * it, so the pass stays linear in the tokens.
 */
function markupProducers(
  tokens: readonly Token[],
  functions: readonly LocalFunction[],
  bindings: readonly { name: string; from: number; end: number }[],
  sourceWithin: (from: number, to: number) => boolean,
  projectNames: ReadonlySet<string>,
  isTrustedCallee: (name: string) => boolean,
  seeds: ReadonlyMap<string, unknown> = new Map(),
): MarkupProducers {
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
  const opens: number[] = [];
  const partner = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    if (tokens[k].type !== "punctuation") continue;
    const v = tokens[k].value;
    if (v === "(" || v === "[" || v === "{") opens.push(k);
    else if ((v === ")" || v === "]" || v === "}") && opens.length > 0)
      partner[opens.pop()!] = k;
  }
  /**
   * Each top-level argument of the call whose `(` is at `open`, as source
   * offsets between its separators (a template argument has no token of
   * its own, only its holes do).
   */
  const argumentsOf = (open: number): [number, number][] => {
    const close = partner[open];
    const spans: [number, number][] = [];
    let from = tokens[open].end;
    for (let j = open + 1; j <= close; j++) {
      if (j === close || isPunct(j, ",")) {
        spans.push([from, tokens[j].start]);
        from = tokens[j].end;
      } else if (partner[j] !== -1) j = partner[j];
    }
    return spans;
  };
  // for (const NAME of VALUE) and for (const [k, v] in VALUE): each name
  // holds what VALUE holds.
  for (let k = 0; k + 3 < n; k++) {
    if (
      !(tokens[k].type === "identifier" && tokens[k].value === "for") ||
      !isPunct(k + 1, "(") ||
      partner[k + 1] === -1 ||
      !(
        tokens[k + 2].type === "identifier" &&
        /^(?:const|let|var)$/.test(tokens[k + 2].value)
      )
    )
      continue;
    const close = partner[k + 1];
    let j = k + 3;
    const names: string[] = [];
    if (isPunct(j, "[") || isPunct(j, "{")) {
      const end = partner[j];
      if (end === -1 || end >= close) continue;
      for (let q = j + 1; q < end; q++)
        if (
          tokens[q].type === "identifier" &&
          !isPunct(q + 1, ":") &&
          !isPunct(q - 1, ".")
        )
          names.push(tokens[q].value);
      j = end + 1;
    } else if (tokens[j].type === "identifier") names.push(tokens[j++].value);
    if (
      j >= close ||
      tokens[j].type !== "identifier" ||
      (tokens[j].value !== "of" && tokens[j].value !== "in")
    )
      continue;
    for (const name of names)
      regions.push({
        name,
        start: tokens[j].end,
        end: tokens[close].start,
      });
  }
  const paramsOf = new Map<string, string[][]>();
  for (const fn of functions)
    if (fn.params.length > 0) {
      const list = paramsOf.get(fn.name) ?? [];
      fn.params.forEach(
        (names, i) => (list[i] = [...(list[i] ?? []), ...names]),
      );
      paramsOf.set(fn.name, list);
    }
  const localNames = new Set(functions.map((f) => f.name));
  /** Every local function's parameter names: a call of one runs a callback. */
  const parameters = new Set(functions.flatMap((f) => f.params.flat()));
  const opaqueStarts: number[] = [];
  const opaqueValues: string[] = [];
  for (let k = 0; k + 1 < n; k++) {
    // process.env.FOOTER_HTML: an environment variable named for markup.
    // Others (SITE_URL, NAME) are taken to hold text, as package functions
    // not named for markup are.
    if (
      tokens[k].type === "identifier" &&
      tokens[k].value === "process" &&
      !isPunct(k - 1, ".") &&
      isPunct(k + 1, ".") &&
      k + 4 < n &&
      tokens[k + 2].value === "env" &&
      (isPunct(k + 3, ".") || isPunct(k + 3, "[")) &&
      MARKUP_ENV.test(tokens[k + 4].value)
    ) {
      opaqueStarts.push(tokens[k].start);
      opaqueValues.push(ENV_READ);
      continue;
    }
    if (tokens[k].type !== "identifier" || !isPunct(k + 1, "(")) continue;
    if (partner[k + 1] === -1) continue;
    const name = tokens[k].value;
    const after = partner[k + 1] + 1;
    // A definition, not a call: function name(...) {, a method name(...) {.
    const before = k > 0 ? tokens[k - 1] : undefined;
    if (
      (before?.type === "identifier" &&
        (before.value === "function" || METHOD_MODIFIERS.has(before.value))) ||
      isPunct(after, "{") ||
      (isPunct(after, ":") &&
        (before === undefined ||
          isPunct(k - 1, "{") ||
          isPunct(k - 1, "}") ||
          isPunct(k - 1, ";") ||
          isPunct(k - 1, ",")))
    )
      continue;
    if (isPunct(k - 1, ".")) {
      // fs.readFileSync(...), res.text(): a file or a response; md.render().
      if (READER_METHODS.has(name) || MARKUP_CALLEE.test(name)) {
        opaqueStarts.push(tokens[k].start);
        opaqueValues.push(name);
      }
      // NAME.push(...) and NAME.unshift(...): the arguments fill NAME.
      if (
        (name === "push" || name === "unshift") &&
        k >= 2 &&
        tokens[k - 2].type === "identifier" &&
        !isPunct(k - 3, ".")
      )
        regions.push({
          name: tokens[k - 2].value,
          start: tokens[k + 1].start,
          end: tokens[partner[k + 1]].end,
        });
      continue;
    }
    if (
      k > 0 &&
      tokens[k - 1].type === "identifier" &&
      tokens[k - 1].value === "new"
    )
      continue;
    // A local function's parameters hold what its callers pass them.
    const params = paramsOf.get(name);
    if (params)
      argumentsOf(k + 1).forEach(([start, end], i) => {
        for (const param of params[i] ?? [])
          regions.push({ name: param, start, end });
      });
    if (
      !localNames.has(name) &&
      !projectNames.has(name) &&
      !PLAIN_CALLEES.has(name) &&
      !isTrustedCallee(name) &&
      (parameters.has(name) ||
        MARKUP_CALLEE.test(name) ||
        (READER_METHODS.has(name) && name !== "text"))
    ) {
      opaqueStarts.push(tokens[k].start);
      opaqueValues.push(name);
    }
  }
  regions.sort((x, y) => x.start - y.start || y.end - x.end);

  const names = new Set<string>();
  const markupNames = new Set<string>();
  const usedBy = new Map<string, Set<string>>();
  const queue: string[] = [];
  const markupQueue: string[] = [];
  const mark = (name: string): void => {
    if (names.has(name)) return;
    names.add(name);
    queue.push(name);
  };
  const markMarkup = (name: string): void => {
    mark(name);
    if (markupNames.has(name)) return;
    markupNames.add(name);
    markupQueue.push(name);
  };
  const edge = (from: string, to: string): void => {
    if (from === to) return;
    let set = usedBy.get(from);
    if (!set) usedBy.set(from, (set = new Set()));
    set.add(to);
  };
  const opaqueAt = new Set(opaqueStarts);
  const stack: { name: string; end: number }[] = [];
  let r = 0;
  for (let k = 0; k <= n; k++) {
    const at = k < n ? tokens[k].start : Infinity;
    while (r < regions.length && regions[r].start <= at) {
      const region = regions[r++];
      while (stack.length > 0 && stack[stack.length - 1].end <= region.start)
        stack.pop();
      if (sourceWithin(region.start, region.end)) markMarkup(region.name);
      if (stack.length > 0) edge(region.name, stack[stack.length - 1].name);
      stack.push(region);
    }
    if (k === n) break;
    while (stack.length > 0 && stack[stack.length - 1].end <= at) stack.pop();
    if (stack.length === 0) continue;
    const owner = stack[stack.length - 1].name;
    if (opaqueAt.has(at)) mark(owner);
    if (!reads(k)) continue;
    const value = tokens[k].value;
    // A project import that is called or passed on may return markup.
    if (projectNames.has(value)) markMarkup(owner);
    else edge(value, owner);
  }
  while (markupQueue.length > 0)
    for (const next of usedBy.get(markupQueue.pop()!) ?? []) markMarkup(next);
  // Seeds last, so a name they alone reach is known to hold a caller's
  // value rather than markup built in this file.
  const fromSeed = new Map<string, string>();
  for (const seed of seeds.keys()) {
    if (markupNames.has(seed)) continue;
    markMarkup(seed);
    fromSeed.set(seed, seed);
    while (markupQueue.length > 0) {
      const from = markupQueue.pop()!;
      for (const next of usedBy.get(from) ?? [])
        if (!markupNames.has(next)) {
          fromSeed.set(next, seed);
          markMarkup(next);
        }
    }
  }
  while (queue.length > 0)
    for (const next of usedBy.get(queue.pop()!) ?? []) mark(next);

  const starts: number[] = [];
  const values: string[] = [];
  // A project import read as a value (ICON_OK, icons.ok) may hold markup
  // built as a string in its module; one that is called is a project
  // helper, which projectHelperIn reports.
  for (let k = 0; k < n; k++)
    if (
      reads(k) &&
      (names.has(tokens[k].value) ||
        (projectNames.has(tokens[k].value) && !isPunct(k + 1, "(")))
    ) {
      starts.push(tokens[k].start);
      values.push(tokens[k].value);
    }
  return {
    names,
    markupNames,
    starts,
    values,
    opaqueStarts,
    opaqueValues,
    fromSeed,
  };
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

/** How a withheld fix explains the allowlist. */
const UNPROVEN_TEXT =
  "cannot prove it is plain text. The fix is offered only when every hole is a literal with no & or < in its value, request data, an environment variable, a date, a Math result, a number, bigint or boolean parameter of a local function only called by name, an html value, or a const or local helper built only from those. If the value is text, wrap the template in html`...` from @bascik/bascik/html yourself; if it is markup, make it an html`...` value first (raw() for trusted markup).";

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

/** Keywords whose `(...)` is followed by a block, not a function body. */
const BLOCK_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "case",
]);

/**
 * A returned Response, matched where `skipResponsePrefix` stops: `new
 * Response(` or `Response.json(` / `.redirect(` / `.error(`. Group 1 is what
 * gets marked. The prefix is skipped by a loop rather than a leading
 * `(?:\(|\bawait\b|\s)*`, which CodeQL reports as a polynomial regex (alert
 * 207).
 */
const RESPONSE_VALUE =
  /(new\s+Response|Response\s*\.\s*(?:json|redirect|error))\s*\(/y;

const isRegexWordChar = (char: string | undefined): boolean =>
  char !== undefined && /\w/.test(char);

/**
 * Past the parentheses, whole-word `await`s and whitespace at `i`: what may
 * come between `return` (or an arrow) and the Response it returns.
 */
function skipResponsePrefix(code: string, i: number): number {
  for (;;) {
    if (code[i] === "(" || (i < code.length && isSpace(code[i]))) i++;
    else if (
      code.startsWith("await", i) &&
      !isRegexWordChar(code[i - 1]) &&
      !isRegexWordChar(code[i + 5])
    )
      i += 5;
    else return i;
  }
}

type FunctionBody = { block: number } | { expression: number };

function skipSpace(code: string, i: number): number {
  while (i < code.length && isSpace(code[i])) i++;
  return i;
}

function wordAt(code: string, i: number): string {
  let end = i;
  while (end < code.length && isWordChar(code[end])) end++;
  return code.slice(i, end);
}

/** The word just before `i` (past whitespace), or "" when none. */
function wordBefore(code: string, i: number): string {
  let end = i;
  while (end > 0 && isSpace(code[end - 1])) end--;
  let start = end;
  while (start > 0 && isWordChar(code[start - 1])) start--;
  return code.slice(start, end);
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closeParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The body of the function that starts at `i` in masked code: a function
 * declaration or expression, or an arrow function. A TypeScript return type
 * is skipped. Anything else (a call such as `withAuth(...)`, a class) is not
 * read, so the rule stays quiet.
 */
function functionBodyAt(code: string, i: number): FunctionBody | undefined {
  i = skipSpace(code, i);
  if (wordAt(code, i) === "async") i = skipSpace(code, i + 5);
  let isArrow = true;
  if (wordAt(code, i) === "function") {
    isArrow = false;
    i = skipSpace(code, i + 8);
    if (code[i] === "*") i = skipSpace(code, i + 1);
    i = skipSpace(code, i + wordAt(code, i).length);
  }
  if (code[i] === "(") {
    const close = closeParen(code, i);
    if (close < 0) return undefined;
    i = close + 1;
  } else if (isArrow && wordAt(code, i).length > 0) {
    i += wordAt(code, i).length;
  } else return undefined;
  if (!isArrow) {
    const open = code.indexOf("{", i);
    return open < 0 ? undefined : { block: open };
  }
  const arrow = code.indexOf("=>", i);
  // Only a return type may sit between the parameters and the arrow.
  if (
    arrow < 0 ||
    (code.slice(i, arrow).trim() !== "" && code[skipSpace(code, i)] !== ":")
  )
    return undefined;
  const body = skipSpace(code, arrow + 2);
  return code[body] === "{" ? { block: body } : { expression: body };
}

/** The body of the function a name is declared as, if it is one. */
function declaredFunctionBody(
  code: string,
  name: string,
): FunctionBody | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  const escaped = name.replace(/\$/g, () => "\\$");
  const declared = new RegExp(
    `\\b(?:async\\s+)?function\\s*\\*?\\s*${escaped}(?![\\w$])|\\b(?:const|let|var)\\s+${escaped}(?![\\w$])[^=;]*=(?![=>])`,
  ).exec(code);
  if (declared === null) return undefined;
  return declared[0].endsWith("=")
    ? functionBodyAt(code, declared.index + declared[0].length)
    : functionBodyAt(code, declared.index);
}

/** The default export's function body, from `export default` or `export { name as default }`. */
function defaultExportBody(code: string): FunctionBody | undefined {
  const exported = /\bexport\s+default\b/.exec(code);
  if (exported !== null) {
    const at = skipSpace(code, exported.index + exported[0].length);
    const word = wordAt(code, at);
    const afterWord = skipSpace(code, at + word.length);
    if (
      word.length > 0 &&
      word !== "async" &&
      word !== "function" &&
      code.slice(afterWord, afterWord + 2) !== "=>"
    )
      // `export default withAuth(...)` is a call: what it returns is not read.
      return code[afterWord] === "(" || code[afterWord] === "."
        ? undefined
        : declaredFunctionBody(code, word);
    return functionBodyAt(code, at);
  }
  for (const clause of code.matchAll(/\bexport\s*\{([^{}]*)\}/g)) {
    for (const spec of clause[1].split(",")) {
      const named = /^\s*([\w$]+)\s+as\s+default\s*$/.exec(spec);
      if (named !== null) return declaredFunctionBody(code, named[1]);
    }
  }
  return undefined;
}

/**
 * Each `new Response(...)` or `Response.json(...)` (`.redirect`, `.error`)
 * the default export returns, as offsets into `body`. Comments and strings are
 * masked first, so the words in either never count, and a `return` inside a
 * nested function (a helper, a callback, a method) belongs to that function.
 * One pass over the default export's body.
 */
export function findReturnedResponses(
  body: string,
): { start: number; end: number }[] {
  const code = maskCommentsAndStrings(body);
  const fn = defaultExportBody(code);
  if (fn === undefined) return [];
  const found: { start: number; end: number }[] = [];
  const responseAt = (at: number): void => {
    RESPONSE_VALUE.lastIndex = skipResponsePrefix(code, at);
    const m = RESPONSE_VALUE.exec(code);
    if (m === null) return;
    found.push({ start: m.index, end: m.index + m[1].length });
  };
  if ("expression" in fn) {
    responseAt(fn.expression);
    return found;
  }
  // true for a `{` that opens a function body, false for a block or object.
  const frames: boolean[] = [];
  let functionDepth = 0;
  const parenWords: string[] = [];
  let lastClose = { at: -1, word: "" };
  // Set when `: Type` follows a `)`, so `function f(): T {` still reads as a function.
  let annotatedClose: { at: number; word: string } | undefined;
  for (let i = fn.block + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "(") parenWords.push(wordBefore(code, i));
    else if (c === ")") {
      lastClose = { at: i, word: parenWords.pop() ?? "" };
      annotatedClose = undefined;
    } else if (c === ":") {
      if (
        wordBefore(code, i) === "" &&
        code[skipSpaceBackIn(code, i) - 1] === ")"
      )
        annotatedClose = lastClose;
    } else if (c === ";" || (c === "=" && code[i + 1] !== ">")) {
      annotatedClose = undefined;
    } else if (c === "{") {
      // A function body follows `=>`, or the `)` of a parameter list (with
      // or without a return type), but not the `)` of `if (...)` and the like.
      const prev = skipSpaceBackIn(code, i);
      const close = prev - 1 === lastClose.at ? lastClose : annotatedClose;
      const isFunction =
        (code[prev - 1] === ">" && code[prev - 2] === "=") ||
        (close !== undefined && !BLOCK_KEYWORDS.has(close.word));
      annotatedClose = undefined;
      frames.push(isFunction);
      if (isFunction) functionDepth++;
    } else if (c === "}") {
      if (frames.length === 0) break;
      if (frames.pop()) functionDepth--;
    } else if (
      functionDepth === 0 &&
      c === "r" &&
      code.startsWith("return", i) &&
      !isWordChar(code[i - 1] ?? "") &&
      !isWordChar(code[i + 6] ?? "")
    ) {
      // `return` then a line break returns undefined (automatic semicolon insertion).
      let j = i + 6;
      while (code[j] === " " || code[j] === "\t") j++;
      if (code[j] !== "\n" && code[j] !== "\r") responseAt(j);
      i += 5;
    }
  }
  return found;
}

function skipSpaceBackIn(code: string, end: number): number {
  while (end > 0 && isSpace(code[end - 1])) end--;
  return end;
}
