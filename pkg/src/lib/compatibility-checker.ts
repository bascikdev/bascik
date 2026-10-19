import compatibilityRulesData from "./compatibility-rules.json" with { type: "json" };

export interface CompatibilityPattern {
  id: string;
  kind: "css" | "js";
  severity?: "error" | "warning";
  regex: RegExp;
  message: string;
  suggestion: string;
}

export interface CompatibilityMatch {
  rule: CompatibilityPattern;
  index: number;
  length: number;
}

interface CompatibilityRuleDefinition {
  id: string;
  kind: "css" | "js";
  severity?: "error" | "warning";
  pattern: string;
  flags?: string;
  message: string;
  suggestion: string;
}

export const compatibilityRules: CompatibilityPattern[] = (
  compatibilityRulesData as CompatibilityRuleDefinition[]
).map((rule) => ({
  ...rule,
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  regex: new RegExp(rule.pattern, rule.flags),
}));

export interface DiagnosticIgnoreRange {
  startLine: number;
  endLine: number;
  rules?: Set<string>;
}

export function parseIgnoreDirectives(text: string): DiagnosticIgnoreRange[] {
  const lines = text.split("\n");
  const ranges: DiagnosticIgnoreRange[] = [];
  let disableStart: number | null = null;
  let disabledRules: Set<string> | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const ignoreMatch =
      /<!--\s*bascik-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*-->/.exec(
        line,
      ) ||
      /\/\*\s*bascik-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*\*\//.exec(
        line,
      ) ||
      /\/\/\s*bascik-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?/.exec(line);

    if (ignoreMatch) {
      const rules = ignoreMatch[1]
        ? new Set(ignoreMatch[1].split(",").map((r) => r.trim().toLowerCase()))
        : undefined;
      ranges.push({
        startLine: lineIndex,
        endLine: Math.min(lineIndex + 1, lines.length - 1),
        rules,
      });
    }

    const disableMatch =
      /<!--\s*bascik-disable(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*-->/.exec(
        line,
      ) ||
      /\/\*\s*bascik-disable(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*\*\//.exec(
        line,
      ) ||
      /\/\/\s*bascik-disable(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?/.exec(line);

    if (disableMatch && disableStart === null) {
      disableStart = lineIndex;
      disabledRules = disableMatch[1]
        ? new Set(disableMatch[1].split(",").map((r) => r.trim().toLowerCase()))
        : undefined;
    }

    const enableMatch =
      /<!--\s*bascik-enable\s*-->/.exec(line) ||
      /\/\*\s*bascik-enable\s*\*\//.exec(line) ||
      /\/\/\s*bascik-enable\b/.exec(line);

    if (enableMatch && disableStart !== null) {
      ranges.push({
        startLine: disableStart,
        endLine: lineIndex,
        rules: disabledRules,
      });
      disableStart = null;
      disabledRules = undefined;
    }
  }

  if (disableStart !== null) {
    ranges.push({
      startLine: disableStart,
      endLine: Math.max(0, lines.length - 1),
      rules: disabledRules,
    });
  }

  return ranges;
}

export function isDiagnosticIgnored(
  lineZeroBased: number,
  ruleId: string | undefined,
  ranges: DiagnosticIgnoreRange[],
): boolean {
  for (const range of ranges) {
    if (lineZeroBased >= range.startLine && lineZeroBased <= range.endLine) {
      if (!range.rules || range.rules.size === 0) return true;
      if (ruleId && range.rules.has(ruleId.toLowerCase())) return true;
    }
  }
  return false;
}

const getZeroBasedLineAt = (text: string, offset: number): number => {
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
};

/** End of the quoted string that opens at `start`, past its closing quote, or -1 when it never closes. */
function closeQuoted(text: string, start: number, quote: string): number {
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === quote) return j + 1;
  }
  return -1;
}

/**
 * End of a CSS `url(` whose contents start at `from`, past its `)`, or -1 when it never closes. Quotes inside it
 * hide a `)`. `deadEnds` remembers each (offset, inside-quote) state a failed scan passed through: the scan is
 * deterministic, so any later scan reaching one of them fails too, and each state is walked at most once.
 */
function closeUrl(text: string, from: number, deadEnds: Uint8Array): number {
  const visited: number[] = [];
  let quote = 0; // 0 outside quotes, 1 inside "...", 2 inside '...'
  for (let j = from; ; j++) {
    const cell = j * 3 + quote;
    if (j >= text.length || deadEnds[cell]) {
      for (const v of visited) deadEnds[v] = 1;
      return -1;
    }
    visited.push(cell);
    const c = text[j];
    if (quote === 0) {
      if (c === ")") return j + 1;
      if (c === '"') quote = 1;
      else if (c === "'") quote = 2;
    } else if (c === (quote === 1 ? '"' : "'")) {
      quote = 0;
    }
  }
}

/**
 * Blanks out comments, keeping every offset and line break, and keeps strings (and in CSS, `url(...)`) as they
 * are, because a selector in a string is data but one in a comment is not code. An unclosed quote, comment, or
 * `url(` is left as plain text.
 *
 * A scanner, not one regex: with a regex, every unclosed quote or comment rescans the rest of the file, which is
 * quadratic on text an editor sends mid-edit. Here an unclosed one is remembered, so the scan stays linear. If a
 * quote of one kind never closes, no later quote of that kind does either (the failed scan stepped over each one
 * as an escaped character and was in step from there), and the same holds for `/*`.
 */
export function maskComments(text: string, kind: "css" | "js"): string {
  const quotes = kind === "css" ? "\"'" : "\"'`";
  const unclosedQuotes = new Set<string>();
  let unclosedBlockComment = false;
  let urlDeadEnds: Uint8Array | undefined;
  let masked = "";
  let copiedTo = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let end = -1;
    let isComment = false;
    if (quotes.includes(c)) {
      if (!unclosedQuotes.has(c)) {
        end = closeQuoted(text, i, c);
        if (end < 0) unclosedQuotes.add(c);
      }
    } else if (c === "/" && text[i + 1] === "/" && kind === "js") {
      end = text.indexOf("\n", i + 2);
      if (end < 0) end = text.length;
      isComment = true;
    } else if (c === "/" && text[i + 1] === "*") {
      if (!unclosedBlockComment) {
        const close = text.indexOf("*/", i + 2);
        if (close < 0) unclosedBlockComment = true;
        else {
          end = close + 2;
          isComment = true;
        }
      }
    } else if (kind === "css" && c === "u" && text.startsWith("url(", i)) {
      urlDeadEnds ??= new Uint8Array((text.length + 1) * 3);
      end = closeUrl(text, i + 4, urlDeadEnds);
    }
    if (end < 0) {
      i++;
      continue;
    }
    if (isComment) {
      masked +=
        text.slice(copiedTo, i) + text.slice(i, end).replace(/[^\n]/g, " ");
      copiedTo = end;
    }
    i = end;
  }
  return copiedTo === 0 ? text : masked + text.slice(copiedTo);
}

export function findCompatibilityMatches(
  text: string,
  kind: "css" | "js",
): CompatibilityMatch[] {
  const ignoreRanges = parseIgnoreDirectives(text);
  const scannable = maskComments(text, kind);
  const matches: CompatibilityMatch[] = [];
  for (const rule of compatibilityRules) {
    if (rule.kind !== kind) continue;
    const flags = rule.regex.flags.includes("g")
      ? rule.regex.flags
      : `${rule.regex.flags}g`;
    const regex = new RegExp(rule.regex.source, flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(scannable)) !== null) {
      if (
        ignoreRanges.length > 0 &&
        isDiagnosticIgnored(
          getZeroBasedLineAt(text, m.index),
          rule.id,
          ignoreRanges,
        )
      ) {
        if (!regex.global) break;
        continue;
      }
      matches.push({
        rule,
        index: m.index,
        length: m[0].length || 1,
      });
      if (!regex.global) break;
    }
  }
  return matches;
}
