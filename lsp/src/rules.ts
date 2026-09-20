import compatibilityRulesData from './compatibility-rules.json' with { type: 'json' };

export type CompatibilityPattern = {
  id: string;
  kind: 'css' | 'js';
  regex: RegExp;
  message: string;
  suggestion: string;
};

type CompatibilityRuleDefinition = {
  id: string;
  kind: 'css' | 'js';
  pattern: string;
  flags?: string;
  message: string;
  suggestion: string;
};

const compatibilityRules: CompatibilityPattern[] = (compatibilityRulesData as CompatibilityRuleDefinition[]).map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, rule.flags),
}));

export function matchCompatibilityRules(text: string, kind: 'css' | 'js'): CompatibilityPattern[] {
  return compatibilityRules.filter((rule) => {
    if (rule.kind !== kind) {
      return false;
    }

    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    return regex.test(text);
  });
}
