/**
 * scanTemplateHtml's URL scheme rule against html itself: for each URL
 * attribute template, the scanner says html throws exactly when html
 * (pkg/src/lib/html-template.ts) throws, at the same hole. (Any hole in an
 * SVG animation element counts as a throw, more than html refuses, so
 * those are left out.)
 */
import { describe, expect, it } from "vitest";
import { scanTemplateHtml } from "./server-script-templates.js";

// A computed specifier keeps pkg's source out of this package's build.
const HTML_TEMPLATE = new URL(
  "../../pkg/src/lib/html-template.ts",
  import.meta.url,
).href;
const { html } = (await import(HTML_TEMPLATE)) as {
  html: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
};

/** The 1-based hole html throws on for these static parts, or -1. */
const htmlThrowsAt = (parts: string[]): number => {
  const strings = Object.assign([...parts], { raw: [...parts] });
  try {
    html(
      strings as unknown as TemplateStringsArray,
      ...parts.slice(1).map(() => "x"),
    );
    return -1;
  } catch (error) {
    const match = /hole (\d+)/.exec(String(error));
    return match === null ? 0 : Number(match[1]);
  }
};

const PREFIXES = [
  "",
  " ",
  "/p/",
  "java",
  "javascript:",
  "data:text/html,",
  "data:image/png;base64,",
  "https://milk.test/",
  "mailto:",
  "?q=",
  "#",
  "&",
  "a&b/",
  "1:",
];
const MIDDLES = ["", "/", ":", "://", ":8080/", "&amp;x", ".html", "?q", "#t"];

describe("scanTemplateHtml: html's URL scheme rule", () => {
  const cases: [string, string[]][] = [];
  for (const attr of ["a href", "img src", "a ping", "img srcset", "a title"])
    for (const prefix of PREFIXES)
      for (const middle of MIDDLES) {
        const [tag, name] = attr.split(" ");
        const open = `<${tag} ${name}="${prefix}`;
        cases.push([`${open}\${a}${middle}\${b}">`, [open, middle, '">']]);
        cases.push([`${open}\${a}${middle}">`, [open, `${middle}">`]]);
      }
  for (const parts of [
    ['<img alt="" srcset="', " 1x, java", ' 2x">'],
    ['<img alt="" srcset="/a.png 1x, ', '/b 2x">'],
    ['<object data="', "", '"></object>'],
  ])
    cases.push([parts.join("${x}"), parts]);

  it.each(cases)("%s", (_shown, parts) => {
    expect(scanTemplateHtml(parts).throwsAt).toBe(htmlThrowsAt(parts));
  });
});
