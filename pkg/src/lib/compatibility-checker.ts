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
      /<!--\s*bascik-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*-->/.exec(line) ||
      /\/\*\s*bascik-ignore(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*\*\//.exec(line) ||
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
      /<!--\s*bascik-disable(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*-->/.exec(line) ||
      /\/\*\s*bascik-disable(?:\s+([\w-]+(?:\s*,\s*[\w-]+)*))?\s*\*\//.exec(line) ||
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

export function findCompatibilityMatches(
  text: string,
  kind: "css" | "js",
): CompatibilityMatch[] {
  const ignoreRanges = parseIgnoreDirectives(text);
  const scannable =
    kind === "css"
      ? text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\))|\/\*[\s\S]*?\*\//g,
          (m, stringOrUrl?: string) => (stringOrUrl ? stringOrUrl : m.replace(/[^\n]/g, " ")),
        )
      : text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
          (m, str?: string) => (str ? str : m.replace(/[^\n]/g, " ")),
        );
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
        isDiagnosticIgnored(getZeroBasedLineAt(text, m.index), rule.id, ignoreRanges)
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
