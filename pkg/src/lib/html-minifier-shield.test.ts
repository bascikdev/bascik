import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { __htmlMinifierInternalsForTests } from "./html-minifier.ts";
import { createContentShield } from "./shielding.ts";

const { buildSensitiveMask, shieldSensitiveContent } = __htmlMinifierInternalsForTests;

// Reference copies of the original character-array mask and splice-based
// shield. The optimized implementations must stay byte-identical to these on
// every input, including malformed markup and overlapping ranges.
const referenceMask = (html: string): string => {
  if (!html.includes("<")) return html;
  const chars = html.split("");
  const n = chars.length;
  let lowercaseHtml: string | undefined;
  let i = 0;
  while (i < n) {
    if (chars[i] === "<" && html.startsWith("!--", i + 1)) {
      const end = html.indexOf("-->", i + 4);
      const commentEnd = end === -1 ? n : end + 3;
      for (let j = i; j < commentEnd; j++) chars[j] = " ";
      i = commentEnd;
      continue;
    }
    if (chars[i] === "<") {
      let nameStart = i + 1;
      const isClosingTag = nameStart < n && chars[nameStart] === "/";
      if (isClosingTag) nameStart++;
      let nameEnd = nameStart;
      while (nameEnd < n && /[a-zA-Z0-9-]/.test(chars[nameEnd])) nameEnd++;
      const tagName = html.slice(nameStart, nameEnd).toLowerCase();
      if (!isClosingTag && (tagName === "script" || tagName === "pre" || tagName === "textarea" || tagName === "style")) {
        let j = nameEnd;
        while (j < n && chars[j] !== ">") {
          if (chars[j] === '"' || chars[j] === "'") {
            const q = chars[j];
            j++;
            while (j < n && chars[j] !== q) j++;
          }
          j++;
        }
        const bodyStart = j < n ? j + 1 : n;
        const closeTag = `</${tagName}`;
        lowercaseHtml ??= html.toLowerCase();
        const closeIdx = lowercaseHtml.indexOf(closeTag, bodyStart);
        if (closeIdx === -1) {
          i = bodyStart;
          continue;
        }
        for (let k = bodyStart; k < closeIdx; k++) chars[k] = " ";
        i = closeIdx;
        continue;
      }
    }
    i++;
  }
  return chars.join("");
};

const SCRIPT_TAG_PATTERN = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/script\s*>)/gi;

const referenceShield = (htmlString: string): {
  html: string;
  restore: (value: string) => string;
  overlapped: boolean;
} => {
  const shield = createContentShield(htmlString);
  const masked = referenceMask(htmlString);
  let html = htmlString;
  const ranges: Array<{ start: number; end: number }> = [];
  let scriptMatch: RegExpExecArray | null;
  const scriptRe = new RegExp(SCRIPT_TAG_PATTERN.source, "gi");
  while ((scriptMatch = scriptRe.exec(masked)) !== null) {
    const bodyStart = scriptMatch.index + scriptMatch[1].length;
    const bodyEnd = bodyStart + scriptMatch[2].length;
    ranges.push({ start: bodyStart, end: bodyEnd });
  }
  const rawTextTagRe = /<(pre|textarea|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let rawTextMatch: RegExpExecArray | null;
  while ((rawTextMatch = rawTextTagRe.exec(masked)) !== null) {
    const tagName = rawTextMatch[1];
    // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "gi");
    closeRe.lastIndex = rawTextTagRe.lastIndex;
    const closeMatch = closeRe.exec(masked);
    if (!closeMatch) continue;
    ranges.push({ start: rawTextMatch.index, end: closeMatch.index + closeMatch[0].length });
    rawTextTagRe.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  ranges.sort((a, b) => b.start - a.start);
  // Overlapping ranges made the splice loop cut through a token it had just
  // inserted, so the reference output is only meaningful without overlaps.
  const overlapped = ranges.some((range, index) => index > 0 && range.end > ranges[index - 1].start);
  for (const { start, end } of ranges) {
    html = html.slice(0, start) + shield.hide(html.slice(start, end)) + html.slice(end);
  }
  return { html, restore: shield.restore, overlapped };
};

// Shield tokens come from a global counter, so two runs never share numbers.
// Rank them by number: both implementations hide the same values in the same
// order, so equal ranks mean equal token assignment.
const normalizeTokens = (html: string): string => {
  const numbers = [...html.matchAll(/\x00BASCIK_SHIELD_(\d+)\x00/g)].map((match) => Number(match[1]));
  const ranks = new Map([...new Set(numbers)].sort((a, b) => a - b).map((value, rank) => [value, rank]));
  return html.replace(/\x00BASCIK_SHIELD_(\d+)\x00/g, (_token, value: string) => `<T${ranks.get(Number(value))}>`);
};

const fragment = fc.constantFrom(
  "<script>",
  "</script>",
  "<SCRIPT type=module>",
  "</script >",
  "<script data-bascik-server>",
  '<script type="application/ld+json">',
  "<pre>",
  "</pre>",
  "</prex>",
  "<pre class='a>b'>",
  '<pre title="x',
  "<textarea>",
  "</TEXTAREA>",
  "<style>",
  "</style>",
  "<!--",
  "-->",
  "<!-->",
  "<!<!--x-->--",
  "<div>",
  "</div>",
  "<p",
  "<",
  ">",
  "/",
  '"',
  "'",
  "a",
  " ",
  "\n",
  "é",
  "ま",
  "\u0130",
  "$1",
  "$&",
);

const htmlArb = fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join(""));

describe("html-minifier shielding parity", () => {
  it("builds the same sensitive mask as the character-array reference", () => {
    fc.assert(
      fc.property(htmlArb, (html) => {
        expect(buildSensitiveMask(html)).toBe(referenceMask(html));
      }),
      { numRuns: 2000 },
    );
  });

  it("shields the same ranges with the same token order as the splice reference", () => {
    fc.assert(
      fc.property(htmlArb, (html) => {
        const actual = shieldSensitiveContent(html);
        expect(actual.restore(actual.html)).toBe(html);
        const expected = referenceShield(html);
        if (expected.overlapped) return;
        expect(normalizeTokens(actual.html)).toBe(normalizeTokens(expected.html));
      }),
      { numRuns: 2000 },
    );
  });

  it("matches the reference when U+0130 shifts lowercase offsets before a raw-text close tag", () => {
    const html = "<p>\u0130\u0130</p><script>a</script><pre> x </pre>";
    expect(buildSensitiveMask(html)).toBe(referenceMask(html));
    const shifted = "\u0130<script>abc</script>";
    expect(buildSensitiveMask(shifted)).toBe(referenceMask(shifted));
  });

  it("shields the enclosing raw-text range once when it contains a script range", () => {
    // The mask closes <pre> at `</prex` while the range scan closes it at the
    // later `</pre>`, so the <pre> range contains the script body range.
    const html = "<pre>a</prex><script>x</script></pre><p>after</p>";
    expect(referenceShield(html).overlapped).toBe(true);
    const actual = shieldSensitiveContent(html);
    expect(normalizeTokens(actual.html)).toBe("<T0><p>after</p>");
    expect(actual.restore(actual.html)).toBe(html);
  });

  it("matches the reference on a page with many shielded ranges", () => {
    const block = "<p>text</p><pre> code\n  more </pre><script>run()</script><!-- c --><style>.a{}</style>";
    const html = block.repeat(400);
    expect(buildSensitiveMask(html)).toBe(referenceMask(html));
    const actual = shieldSensitiveContent(html);
    const expected = referenceShield(html);
    expect(normalizeTokens(actual.html)).toBe(normalizeTokens(expected.html));
    expect(actual.restore(actual.html)).toBe(html);
  });
});

describe("createContentShield collision checks", () => {
  it("skips a token that already appears in the source", () => {
    const probe = createContentShield("").hide("probe");
    const next = Number(/\d+/.exec(probe)![0]) + 1;
    const colliding = `\x00BASCIK_SHIELD_${next}\x00`;
    const shield = createContentShield(`before ${colliding} after`);
    const token = shield.hide("value");
    expect(token).not.toBe(colliding);
    expect(token).toBe(`\x00BASCIK_SHIELD_${next + 1}\x00`);
    expect(shield.restore(`${colliding}${token}`)).toBe(`${colliding}value`);
  });

  it("does not skip numbers when the source contains no shield token", () => {
    const probe = createContentShield("").hide("probe");
    const next = Number(/\d+/.exec(probe)![0]) + 1;
    const shield = createContentShield("plain \x00BASCIK_SHIELD_ text");
    expect(shield.hide("a")).toBe(`\x00BASCIK_SHIELD_${next}\x00`);
    expect(shield.hide("b")).toBe(`\x00BASCIK_SHIELD_${next + 1}\x00`);
  });
});
