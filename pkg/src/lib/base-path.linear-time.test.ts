import { describe, expect, it } from "vitest";
import { composeSiteUrl, rewriteHtmlBasePaths } from "./base-path.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

describe("composeSiteUrl", () => {
  it(
    "runs in linear time when the site URL holds a long slash run",
    () => {
      // `/\/+$/` is quadratic on a slash run that does not end the string.
      const siteUrl = (slashes: number) =>
        `https://bascik.dev${"/".repeat(slashes)}x`;
      expect(composeSiteUrl(siteUrl(50_000), "/", "/a")).toBe(
        `${siteUrl(50_000)}/a`,
      );
      expectLinearTime(siteUrl, 50_000, (url) =>
        composeSiteUrl(url, "/", "/a"),
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});

describe("rewriteHtmlBasePaths time on hostile input", () => {
  // Since request-time component rendering, every expanded usage is rebased
  // on each request when base is not "/", and slot content can carry
  // visitor text. The old opening-tag and <style> regexes scanned to the end
  // of the input from every opener that could not reach a `>`: about 6 s for
  // `<a x` repeated with one quote after it at 100k characters, and 1.8 s
  // for `<style '` repeated.
  const SIZE = 200_000;

  it.each([
    ["<a x", "'"],
    ['<a "x" ', "'"],
    ['<a href="/x" ', ""],
    ["<a x", ""],
    ["<style '", ""],
    ["<style x", ""],
    ["<style>", ""],
    ["<STYLE a='>' ", ""],
    ["<style></style x", ""],
    ["<style></style ", ""],
  ])(
    "rebases %j repeated (then %j) in linear time",
    (unit, tail) => {
      const html = (size: number) =>
        `${repeatTo(unit, size)}${tail}<a href="/end">e</a>`;
      const out = rewriteHtmlBasePaths(html(SIZE), "/sub/");
      expectLinearTime(html, SIZE, (h) => rewriteHtmlBasePaths(h, "/sub/"));
      // The link after the run is found and rewritten, on its own or as part
      // of the one long tag an opener's attributes run into.
      expect(out.endsWith('<a href="/sub/end">e</a>')).toBe(true);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
