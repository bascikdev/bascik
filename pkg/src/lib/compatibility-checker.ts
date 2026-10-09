import compatibilityRulesData from "./compatibility-rules.json" with { type: "json" };

export interface CompatibilityPattern {
  id: string;
  kind: "css" | "js";
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
  pattern: string;
  flags?: string;
  message: string;
  suggestion: string;
}

export const compatibilityRules: CompatibilityPattern[] = (
  compatibilityRulesData as CompatibilityRuleDefinition[]
).map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, rule.flags),
}));

export function findCompatibilityMatches(
  text: string,
  kind: "css" | "js",
): CompatibilityMatch[] {
  const matches: CompatibilityMatch[] = [];
  for (const rule of compatibilityRules) {
    if (rule.kind !== kind) continue;
    const flags = rule.regex.flags.includes("g")
      ? rule.regex.flags
      : `${rule.regex.flags}g`;
    const regex = new RegExp(rule.regex.source, flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
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
