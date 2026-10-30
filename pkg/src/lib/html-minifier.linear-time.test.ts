import { describe, it, expect } from "vitest";
import { minifyHtml, extractScriptTags } from "./html-minifier.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";

describe("extractScriptTags", () => {
  it(
    "stays linear on many comment openers without a close",
    () => {
      for (const unit of ["<!--", "<!---->"])
        expectLinearTime(
          (n) => `<p>a</p>${unit.repeat(n)}`,
          50_000,
          minifyHtml,
          { label: unit },
        );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "stays fast on many scripts, including many inside unclosed tags",
    () => {
      const scripts = (n: number) => "<p>x</p><script>a()</script>".repeat(n);
      const inUnclosedTags = (n: number) =>
        "<p x <script>a()</script>".repeat(n);
      const afterLongOpeners = (n: number) =>
        ("<" + "a".repeat(100) + "<script>a()</script>").repeat(n);
      expect(extractScriptTags(scripts(20_000)).split("\n")).toHaveLength(
        20_000,
      );
      expect(extractScriptTags(inUnclosedTags(20_000))).toBe("");
      expectLinearTime(scripts, 20_000, extractScriptTags, {
        label: "scripts",
      });
      expectLinearTime(inUnclosedTags, 20_000, extractScriptTags, {
        label: "scripts inside unclosed tags",
      });
      expectLinearTime(afterLongOpeners, 10_000, minifyHtml, {
        label: "scripts after long openers",
      });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("minifyHtml", () => {
  it(
    "keeps the space across a table's comment stand-ins in linear time",
    () => {
      for (const unit of [" <!-- c -->", "<!-- c --> <b>b</b>"])
        expectLinearTime(
          (n) => `<table><tr><td><b>a</b>${unit.repeat(n)} <b>z</b>`,
          20_000,
          minifyHtml,
          { label: unit },
        );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
