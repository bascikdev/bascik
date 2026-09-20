export interface DiagnosticIgnoreRange {
  startLine: number;
  endLine: number;
  rules?: Set<string>;
}

export function parseIgnoreDirectives(text: string, _languageId?: string): DiagnosticIgnoreRange[] {
  const lines = text.split('\n');
  const ranges: DiagnosticIgnoreRange[] = [];
  let disableStart: number | null = null;
  let disabledRules: Set<string> | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    // Check for single-line / next-line ignore: bascik-ignore or bascik-ignore-next-line
    // HTML: <!-- bascik-ignore [rules] -->
    // CSS/JS: /* bascik-ignore [rules] */
    // JS/TS: // bascik-ignore [rules]
    const ignoreMatch =
      /<!--\s*bascik-ignore(?:\s+([\w,-]+))?\s*-->/.exec(line) ||
      /\/\*\s*bascik-ignore(?:\s+([\w,-]+))?\s*\*\//.exec(line) ||
      /\/\/\s*bascik-ignore(?:\s+([\w,-]+))?/.exec(line);

    if (ignoreMatch) {
      const rules = ignoreMatch[1] ? new Set(ignoreMatch[1].split(',').map((r) => r.trim().toLowerCase())) : undefined;
      // Ignores the current line and the next line
      ranges.push({
        startLine: lineIndex,
        endLine: Math.min(lineIndex + 1, lines.length - 1),
        rules,
      });
    }

    // Check for block disable: bascik-disable / bascik-enable
    const disableMatch =
      /<!--\s*bascik-disable(?:\s+([\w,-]+))?\s*-->/.exec(line) ||
      /\/\*\s*bascik-disable(?:\s+([\w,-]+))?\s*\*\//.exec(line) ||
      /\/\/\s*bascik-disable(?:\s+([\w,-]+))?/.exec(line);

    if (disableMatch && disableStart === null) {
      disableStart = lineIndex;
      disabledRules = disableMatch[1] ? new Set(disableMatch[1].split(',').map((r) => r.trim().toLowerCase())) : undefined;
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
      endLine: lines.length - 1,
      rules: disabledRules,
    });
  }

  return ranges;
}

export function isDiagnosticIgnored(
  line: number,
  ruleCode: string | undefined,
  ignoreRanges: DiagnosticIgnoreRange[],
): boolean {
  for (const range of ignoreRanges) {
    if (line >= range.startLine && line <= range.endLine) {
      if (!range.rules) return true;
      if (ruleCode && range.rules.has(ruleCode.toLowerCase())) return true;
    }
  }
  return false;
}
