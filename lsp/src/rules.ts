import compatibilityRulesData from './compatibility-rules.json' with { type: 'json' };

export type CompatibilityPattern = {
  id: string;
  kind: 'css' | 'js';
  severity?: 'error' | 'warning';
  regex: RegExp;
  message: string;
  suggestion: string;
};

type CompatibilityRuleDefinition = {
  id: string;
  kind: 'css' | 'js';
  severity?: 'error' | 'warning';
  pattern: string;
  flags?: string;
  message: string;
  suggestion: string;
};

const compatibilityRules: CompatibilityPattern[] = (compatibilityRulesData as CompatibilityRuleDefinition[]).map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, rule.flags),
}));

export interface CompatibilityMatch {
  rule: CompatibilityPattern;
  /** Offset of the match in the text that was scanned. */
  index: number;
  length: number;
}

/**
 * Every place a scoping-compatibility rule matches, outside comments. Strings are kept, because `"[id]"` in a
 * string is data, but a selector in a comment is not code. Offsets still match `text`, so a caller can turn them
 * into positions.
 *
 * This is the same matching `@bascik/bascik` does when it compiles a component (`compatibility-checker.ts`).
 * The two packages cannot import each other, so both carry the matcher and a monorepo test keeps them agreeing.
 */
export function findCompatibilityMatches(text: string, kind: 'css' | 'js'): CompatibilityMatch[] {
  const scannable =
    kind === 'css'
      ? text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*(?:[^)"']|"[^"]*"|'[^']*')*\s*\))|\/\*[\s\S]*?\*\//g,
          (m, stringOrUrl?: string) => (stringOrUrl ? stringOrUrl : m.replace(/[^\n]/g, ' ')),
        )
      : text.replace(
          /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
          (m, str?: string) => (str ? str : m.replace(/[^\n]/g, ' ')),
        );
  const matches: CompatibilityMatch[] = [];
  for (const rule of compatibilityRules) {
    if (rule.kind !== kind) continue;
    const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(scannable)) !== null) {
      // Some patterns allow leading whitespace (`(^|,)\s*\[`), which can reach back over blank lines. Start the
      // match at the first visible character, so a squiggle lands where the problem is.
      const leading = Math.max(match[0].search(/\S/), 0);
      matches.push({ rule, index: match.index + leading, length: Math.max(match[0].length - leading, 1) });
      // A pattern that can match nothing would otherwise never advance.
      if (match[0].length === 0) regex.lastIndex++;
    }
  }
  return matches;
}

export function matchCompatibilityRules(text: string, kind: 'css' | 'js'): CompatibilityPattern[] {
  return compatibilityRules.filter((rule) => {
    if (rule.kind !== kind) {
      return false;
    }

    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    return regex.test(text);
  });
}
