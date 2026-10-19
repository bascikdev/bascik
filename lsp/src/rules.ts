import compatibilityRulesData from "./compatibility-rules.json" with { type: "json" };

export type CompatibilityPattern = {
  id: string;
  kind: "css" | "js";
  severity?: "error" | "warning";
  regex: RegExp;
  message: string;
  suggestion: string;
};

type CompatibilityRuleDefinition = {
  id: string;
  kind: "css" | "js";
  severity?: "error" | "warning";
  pattern: string;
  flags?: string;
  message: string;
  suggestion: string;
};

const compatibilityRules: CompatibilityPattern[] = (
  compatibilityRulesData as CompatibilityRuleDefinition[]
).map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, rule.flags),
}));

export interface CompatibilityMatch {
  rule: CompatibilityPattern;
  /** Offset of the match in the text that was scanned. */
  index: number;
  length: number;
}

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
  const quotes = kind === "css" ? `"'` : `"'\``;
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

/**
 * Every place a scoping-compatibility rule matches, outside comments. Strings are kept, because `"[id]"` in a
 * string is data, but a selector in a comment is not code. Offsets still match `text`, so a caller can turn them
 * into positions.
 *
 * This is the same matching `@bascik/bascik` does when it compiles a component (`compatibility-checker.ts`).
 * The two packages cannot import each other, so both carry the matcher and a monorepo test keeps them agreeing.
 */
export function findCompatibilityMatches(
  text: string,
  kind: "css" | "js",
): CompatibilityMatch[] {
  const scannable = maskComments(text, kind);
  const matches: CompatibilityMatch[] = [];
  for (const rule of compatibilityRules) {
    if (rule.kind !== kind) continue;
    const regex = new RegExp(
      rule.regex.source,
      rule.regex.flags.includes("g")
        ? rule.regex.flags
        : `${rule.regex.flags}g`,
    );
    let match: RegExpExecArray | null;
    while ((match = regex.exec(scannable)) !== null) {
      // Some patterns allow leading whitespace (`(^|,)\s*\[`), which can reach back over blank lines. Start the
      // match at the first visible character, so a squiggle lands where the problem is.
      const leading = Math.max(match[0].search(/\S/), 0);
      matches.push({
        rule,
        index: match.index + leading,
        length: Math.max(match[0].length - leading, 1),
      });
      // A pattern that can match nothing would otherwise never advance.
      if (match[0].length === 0) regex.lastIndex++;
    }
  }
  return matches;
}

export function matchCompatibilityRules(
  text: string,
  kind: "css" | "js",
): CompatibilityPattern[] {
  return compatibilityRules.filter((rule) => {
    if (rule.kind !== kind) {
      return false;
    }

    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    return regex.test(text);
  });
}
