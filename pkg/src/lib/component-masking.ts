import { maskElementContents } from "./shielding.ts";
import { __componentScanStatsForTests } from "./component-scan-stats.ts";

/**
 * Return a same-length copy of `htmlString` where HTML comments and the inner content of
 * `<script>`, `<style>`, and `<textarea>` elements are blanked out with
 * spaces. Component-tag searches run against the masked string so literal
 * tag text inside comments or raw-text elements (e.g. `<my-card>` or `<body>`
 * mentioned in a comment, JSON-LD string, or code example) is never resolved
 * as a component or structural tag.
 * Because lengths are preserved, indices found in the masked string are
 * valid in the original.
 */
export const maskRawTextContent = (htmlString: string): string => {
  const hasComments = htmlString.includes("<!--");
  const hasRawTags = /<(?:script|style|textarea)\b/i.test(htmlString);
  if (!hasComments && !hasRawTags) {
    return htmlString;
  }
  let masked = htmlString;
  if (hasComments) {
    masked = masked.replace(/<!--[\s\S]*?-->/g, (m) =>
      m.length >= 7 ? `<!--${" ".repeat(m.length - 7)}-->` : m,
    );
  }
  if (hasRawTags) {
    masked = maskElementContents(masked, ["script", "style", "textarea"]);
  }
  return masked;
};

// The passes maskRawTextContent runs, in order, each with the opener text a
// scan could start a match at. Mirrors maskElementContents for the raw tags.
const MASK_PASSES: Array<{
  match: RegExp;
  opener: RegExp;
  blank: (
    match: string,
    open?: string,
    inner?: string,
    close?: string,
  ) => string;
}> = [
  {
    match: /<!--[\s\S]*?-->/g,
    opener: /<!--/g,
    blank: (match) =>
      match.length >= 7 ? `<!--${" ".repeat(match.length - 7)}-->` : match,
  },
  ...["script", "style", "textarea"].map((tag) => ({
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    match: new RegExp(
      `(<${tag}(?:\\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)([\\s\\S]*?)(<\\/${tag}\\s*>)`,
      "gi",
    ),
    // `\b` after the name passes for any following character outside [A-Za-z0-9_].
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    opener: new RegExp(`<${tag}(?![A-Za-z0-9_])`, "gi"),
    blank: (_match: string, open?: string, inner?: string, close?: string) =>
      `${open}${" ".repeat(inner!.length)}${close}`,
  })),
];

// The end of a segment is unsafe when it could be the start of an opener that
// the following text completes (`<scr` + `ipt>`).
const PARTIAL_OPENER_AT_END =
  /<(?:!-?-?|s(?:c(?:r(?:i(?:pt?)?)?)?|t(?:y(?:le?)?)?)?|t(?:e(?:x(?:t(?:a(?:r(?:ea?)?)?)?)?)?)?)?$/i;

/**
 * Mask `htmlString` exactly like `maskRawTextContent`, and report whether the
 * string is closed: every pass ends idle, with no opener that a match attempt
 * failed on (so more text could complete it) and no partial opener at the end.
 * For a closed string `a`, `maskRawTextContent(a + b)` always equals
 * `masked + maskRawTextContent(b)`, so its mask can be reused as a prefix.
 */
export const maskRawTextContentWithClosure = (
  htmlString: string,
): { masked: string; closed: boolean } => {
  __componentScanStatsForTests.closureBytesChecked += htmlString.length;
  const hasComments = htmlString.includes("<!--");
  const hasRawTags = /<(?:script|style|textarea)\b/i.test(htmlString);
  const closedEnd = !PARTIAL_OPENER_AT_END.test(htmlString.slice(-9));
  if (!hasComments && !hasRawTags)
    return { masked: htmlString, closed: closedEnd };
  let masked = htmlString;
  let closed = closedEnd;
  MASK_PASSES.forEach((pass, index) => {
    if (index === 0 ? !hasComments : !hasRawTags) return;
    const input = masked;
    const starts: number[] = [];
    const ends: number[] = [];
    masked = input.replace(pass.match, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args[index === 0 ? 1 : 4] as number;
      starts.push(offset);
      ends.push(offset + match.length);
      return index === 0
        ? pass.blank(match)
        : pass.blank(
            match,
            args[1] as string,
            args[2] as string,
            args[3] as string,
          );
    });
    if (!closed) return;
    // Any opener outside every match is a failed attempt that more text could complete.
    let matchIndex = 0;
    pass.opener.lastIndex = 0;
    for (
      let opener = pass.opener.exec(input);
      opener !== null;
      opener = pass.opener.exec(input)
    ) {
      while (matchIndex < ends.length && ends[matchIndex] <= opener.index)
        matchIndex++;
      if (matchIndex >= starts.length || opener.index < starts[matchIndex]) {
        closed = false;
        break;
      }
      pass.opener.lastIndex = opener.index + 1;
    }
  });
  return { masked, closed };
};

/**
 * Update `masked` (the mask of `body`) after `body[start, end)` is replaced by
 * `replacement`, without re-masking the whole page. `closedThrough` is a
 * position at or before `start` whose prefix `body[0, closedThrough)` is
 * already known to be closed, or -1 when the prefix is known not to be.
 *
 * `masked` is null when any part (the prefix, the replaced text, or the
 * replacement) is not closed; the caller must then re-mask the whole page.
 * The returned `closedThrough` is `start` when the prefix is closed (the
 * prefix is unchanged by the substitution, so it stays closed for the next
 * one) and -1 when it is not, so later substitutions skip the attempt.
 * On success `closedEnd` is the end of the inserted text: everything before it
 * is closed, so a later splice at or after it can verify from there.
 */
export const spliceRawTextMask = (
  body: string,
  masked: string,
  start: number,
  end: number,
  replacement: string,
  closedThrough: number,
): { masked: string | null; closedThrough: number; closedEnd?: number } => {
  if (closedThrough < 0 || closedThrough > start)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(closedThrough, start)).closed)
    return { masked: null, closedThrough: -1 };
  if (!maskRawTextContentWithClosure(body.slice(start, end)).closed)
    return { masked: null, closedThrough: start };
  const inserted = maskRawTextContentWithClosure(replacement);
  if (!inserted.closed) return { masked: null, closedThrough: start };
  return {
    masked: masked.slice(0, start) + inserted.masked + masked.slice(end),
    closedThrough: start,
    closedEnd: start + replacement.length,
  };
};
