import { describe, expect, it } from "vitest";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import { maskElementContents, shieldElementContents } from "./shielding.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
  repeatTo,
} from "./linear-time.test-helper.ts";

// Since request-time component rendering, server and stream output (which can
// echo user input such as `?q=`) is masked on every request, so masking time
// must stay linear in the input: a super-linear masker is a per-request
// denial of service. The old `(<tag(?:\b(?:[^>"']|"[^"]*"|'[^']*')*)?>)
// ([\s\S]*?)(<\/tag\s*>)` regex scanned to the end of the input from every
// opener with no closer, and from every opener with an unclosed quote.
// Measured on it at 100k characters: `<script '` and `<script x` repeated
// took about 2.5 s to mask or shield, and `<script>` repeated about 0.3 s
// (four times that at the 200k used here). Each check times the input and a
// quarter of it and requires the time to grow linearly
// (linear-time.test-helper.ts): a fixed bound flaked on CI under coverage.

const SIZE = 200_000;

// Openers that never find a closer, for every raw-text tag in mixed case: a
// complete opener, one cut off before `>`, one with an unclosed quote of each
// kind, and one whose quoted value hides the `>`.
const worstCases = ["script", "style", "textarea"].flatMap((tag) =>
  [tag, tag.toUpperCase(), tag[0].toUpperCase() + tag.slice(1)].flatMap(
    (name) => [
      `<${name}>`,
      `<${name} x`,
      `<${name} '`,
      `<${name} "`,
      `<${name} a="1>`,
      `<${name} a='>' `,
      `<${name}></${name}`,
      // Not tag white space: an end tag of another name, as the browser reads it.
      `<${name}></${name}\u000b>`,
    ],
  ),
);

describe("raw-text masking time on hostile input", () => {
  it.each(worstCases)(
    "maskRawTextContent masks %j repeated to 200k characters in linear time",
    (unit) => {
      const html = repeatTo(unit, SIZE);
      expect(maskRawTextContent(html)).toHaveLength(html.length);
      expectLinearTime(
        (size) => repeatTo(unit, size),
        SIZE,
        maskRawTextContent,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each(worstCases)(
    "maskRawTextContentWithClosure masks %j repeated in linear time and reports it open",
    (unit) => {
      expect(maskRawTextContentWithClosure(repeatTo(unit, SIZE)).closed).toBe(
        false,
      );
      expectLinearTime(
        (size) => repeatTo(unit, size),
        SIZE,
        maskRawTextContentWithClosure,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each(worstCases)(
    "maskElementContents and shieldElementContents scan %j repeated in linear time",
    (unit) => {
      const html = repeatTo(unit, SIZE);
      const input = (size: number) => repeatTo(unit, size);
      const tags = ["script", "style", "textarea"];
      expect(maskElementContents(html, tags)).toHaveLength(html.length);
      const shielded = shieldElementContents(html, tags);
      expect(shielded.restore(shielded.html)).toBe(html);
      expectLinearTime(input, SIZE, (h) => maskElementContents(h, tags), {
        label: "mask",
      });
      expectLinearTime(input, SIZE, (h) => shieldElementContents(h, tags), {
        label: "shield",
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it.each(['"', "'"])(
    "reads a %s-quoted value full of comment openers in linear time",
    (quote) => {
      // Each `<!--` asks whether it is inside a tag; the scan used to search
      // again for the far closing quote from every one of them (about 0.55 s
      // at 400k characters and 2.3 s at 800k).
      const RUN = 1_000_000;
      const closed = (size: number) =>
        `<p title=${quote}${repeatTo("<!--", size)}${quote}><!-- c --></p>`;
      const open = (size: number) =>
        `<p title=${quote}${repeatTo("<!--", size)}`;
      expect(maskRawTextContent(closed(RUN))).toBe(
        closed(RUN).replace("<!-- c -->", "<!--   -->"),
      );
      expect(maskRawTextContentWithClosure(open(RUN))).toEqual({
        masked: open(RUN),
        closed: false,
      });
      expectLinearTime(closed, RUN, maskRawTextContent, { label: "closed" });
      expectLinearTime(open, RUN, maskRawTextContentWithClosure, {
        label: "open",
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "still masks a complete element after a long run of openers with no closer",
    () => {
      const html = (size: number) =>
        `${repeatTo("<script '", size)}'><my-card></my-card></script><my-card>`;
      // Quotes pair up in order. With an odd number of openers the first
      // one's attributes run to the `>` after the last quote and its content
      // to the `</script>`. With an even number the first one's quotes never
      // close, so it opens nothing, and every later opener is inside its tag
      // (`isInsideTag`: a quote before any `=` is part of an attribute name),
      // so nothing is masked. A browser reads the quotes as name characters
      // and ends the first opener at the first `>`; the opener's attribute
      // part follows the regex, which reads a quote anywhere.
      const odd = "<script '".repeat(5555);
      expect(maskRawTextContent(`${odd}'><my-card></my-card></script>`)).toBe(
        `${odd}'>${" ".repeat("<my-card></my-card>".length)}</script>`,
      );
      const even = `${"<script '".repeat(5554)}'><my-card></my-card></script>`;
      expect(maskRawTextContent(even)).toBe(even);
      expect(maskRawTextContent(html(50_000))).toHaveLength(
        html(50_000).length,
      );
      // The time per character settles only past a few hundred thousand
      // characters: at 50k (a quarter of 12.5k, 0.2 ms a run) this read 5.2
      // to 6.7 with nothing else running, at 200k 2.8 to 3.3, and at 800k it
      // reads 3.9 to 4.1.
      expectLinearTime(html, 800_000, maskRawTextContent);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("comments and raw text are resolved in document order, as the tokenizer does", () => {
  it(
    "masks hostile runs of script escapes in linear time",
    () => {
      for (const input of [
        (size: number) =>
          `${repeatTo("<script><!--<script>", size / 2)}${repeatTo("</script><script>", size / 2)}`,
        (size: number) => repeatTo("<script x<!--", size),
        (size: number) => repeatTo("<script><!--", size),
        (size: number) =>
          `${repeatTo("<script><!--<script>", size / 2)}${repeatTo("-->", size / 2)}`,
        (size: number) => `<!--${repeatTo("<script>", size)}`,
        (size: number) => repeatTo("<style><!--</style ", size),
      ]) {
        const html = input(SIZE);
        const label = html.slice(0, 40);
        expect(maskRawTextContentWithClosure(html).masked, label).toHaveLength(
          html.length,
        );
        expectLinearTime(input, SIZE, maskRawTextContentWithClosure, { label });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
