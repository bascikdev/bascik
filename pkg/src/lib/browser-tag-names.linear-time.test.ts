/**
 * Tag names end where a browser ends them (2026-10-29). The HTML tokenizer
 * reads a tag name until tag whitespace (`\t\n\f\r `), `/` or `>`, so
 * `<style-guide>` is an ordinary custom element, not a stylesheet, and
 * `<my-card.foo>` and `<my-card</p>` are the tags `my-card.foo` and
 * `my-card<`, not `my-card`.
 *
 * The compiler used to match a raw-text opener by word boundary (so
 * `<style-guide>` hid every component tag after it up to a later `</style>`)
 * and a component name as the longest name ending at any character outside
 * `[\w:-]`, or at a `:` (so `<my-card.foo>`, `<my-card</p>` and `<my-card:x>`
 * were expanded as `my-card`). Neither spelling is documented as a feature.
 *
 * Each case is checked against parse5, a spec-compliant parser: the compiler
 * expands a component exactly where the browser builds that element.
 */
import { describe, expect, it } from "vitest";
import {
  maskRawTextContent,
  maskRawTextContentWithClosure,
} from "./component-masking.ts";
import {
  createMatchingCloseFinder,
  getFirstComponent,
  replaceTag,
} from "./component-tags.ts";
import { __cspRegexFallbackForTests } from "./csp-hashes.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
  repeatTo,
} from "./linear-time.test-helper.ts";
import type { ComponentList } from "./types.ts";

const list = {
  "my-card": { fileContent: "<div>CARD</div>" },
  a: { fileContent: "A" },
  "a:b": { fileContent: "AB" },
} as unknown as ComponentList;

/** Every component usage the compiler finds, `[start, name]`, as the expansion loop searches. */
const compilerUsages = (html: string): Array<[number, string]> => {
  const masked = maskRawTextContent(html);
  const found: Array<[number, string]> = [];
  for (let from = 0; ;) {
    const usage = getFirstComponent(html, list, masked, from);
    if (usage.name === undefined || usage.index === undefined) return found;
    found.push([usage.index, usage.name]);
    from = usage.index + 1;
  }
};

const SIZE = 200_000;

describe("the browser tag-name rule keeps every scan linear", () => {
  const hostile: Array<[string, (size: number) => string]> = [
    ["<style-a repeated", (size) => repeatTo("<style-a", size)],
    [
      "<style-guide> repeated before a </style>",
      (size) => `${repeatTo("<style-guide>", size)}</style>`,
    ],
    ["<script-x '> repeated", (size) => repeatTo("<script-x '>", size)],
    ["<textarea. repeated", (size) => repeatTo("<textarea.", size)],
    ["<my-card. repeated", (size) => repeatTo("<my-card.", size)],
    [
      "<my-card: repeated before a >",
      (size) => `${repeatTo("<my-card:", size)}>`,
    ],
    ["<a:b:a:b repeated", (size) => `<${repeatTo("a:b:", size)}>`],
    ["<my-card</p> repeated", (size) => repeatTo("<my-card</p>", size)],
  ];

  it.each(hostile)(
    "masks and searches %s in linear time",
    (_label, input) => {
      expect(maskRawTextContent(input(SIZE))).toHaveLength(input(SIZE).length);
      expectLinearTime(input, SIZE, maskRawTextContentWithClosure, {
        label: "mask",
      });
      expectLinearTime(input, SIZE, compilerUsages, { label: "usages" });
      expectLinearTime(
        input,
        SIZE,
        (html) => replaceTag(html, "my-card", "X"),
        { label: "replaceTag" },
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("the tag-boundary rules keep every scan linear", () => {
  const hostile: Array<[string, (size: number) => string]> = [
    [
      `<p title="<script>"> repeated before a </script>`,
      (size) => `${repeatTo(`<p title="<script>">`, size)}</script>`,
    ],
    [
      "<p<style> repeated before a </style>",
      (size) => `${repeatTo("<p<style>", size)}</style>`,
    ],
    [
      "<style></style  repeated with no >",
      (size) => `<style>${repeatTo("</style ", size)}`,
    ],
    [
      "<script></script/ repeated with no >",
      (size) => `<script>${repeatTo("</script/", size)}`,
    ],
    [
      "<my-card></my-card  repeated with no >",
      (size) => `<my-card>${repeatTo("</my-card ", size)}`,
    ],
    ["<!x repeated", (size) => repeatTo("<!x", size)],
    ["</ <my-card repeated", (size) => `${repeatTo("</ <my-card", size)}>`],
    ["<?<my-card> repeated", (size) => repeatTo("<?<my-card>", size)],
  ];

  it.each(hostile)(
    "masks and searches %s in linear time",
    (_label, input) => {
      expect(maskRawTextContent(input(SIZE))).toHaveLength(input(SIZE).length);
      expectLinearTime(input, SIZE, maskRawTextContentWithClosure, {
        label: "mask",
      });
      expectLinearTime(input, SIZE, compilerUsages, { label: "usages" });
      expectLinearTime(
        input,
        SIZE,
        (html) => replaceTag(html, "my-card", "X"),
        { label: "replaceTag" },
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "pairs every usage with a close that has attributes in linear time",
    () => {
      const input = (size: number) => repeatTo("<my-card>a</my-card x>", size);
      expectLinearTime(input, SIZE, (html) => {
        const find = createMatchingCloseFinder(html, html);
        let closes = 0;
        for (
          let at = html.indexOf("<my-card>");
          at !== -1;
          at = html.indexOf("<my-card>", at + 1)
        )
          if (find("my-card", at + 9) !== -1) closes++;
        return closes;
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
