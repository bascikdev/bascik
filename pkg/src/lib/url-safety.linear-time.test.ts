/**
 * The ONE URL rule (prompt 157 safety helpers): `html` from
 * @bascik/bascik/html and the request-time binding check both decide with
 * url-safety.ts, so a URL a template refuses is a URL a bound prop refuses.
 * The module is portable (no imports at all) because the Worker bundles it
 * through both paths.
 */
import { describe, expect, it } from "vitest";
import {
  isSafeUrl,
  normalizeUrl,
  srcsetUrls,
  urlScheme,
  urlVerdict,
} from "./url-safety.ts";
import { html, safeUrl } from "../html.ts";
import { injectPropAttributes } from "./component-props.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
  repeatTo,
} from "./linear-time.test-helper.ts";

// ─── Hostile URL lengths stay linear ────────────────────────────────────────
//
// normalizeUrl once trimmed with /^[\u0000- ]+|[\u0000- ]+$/g. The trailing
// alternative is tried at every position of a run of spaces or C0 controls
// that is not at the end, and each try scans to the run's end, so
// "a" + " ".repeat(n) + "a" took quadratic time: about 30 s for a 100 KB
// href hole. A visitor value reaches it through every html URL hole,
// safeUrl, and the request-time component binding check.

/** The trim the regex did, kept here as the reference the scans must match. */
const regexNormalizeUrl = (url: string): string =>
  url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");

const URL_SIZE = 200_000;
const spaceRun = (n: number): string => `a${" ".repeat(n)}a`;
const controlRun = (n: number): string => `a${"\u0001".repeat(n)}a`;
const mixedRun = (n: number): string =>
  `a${repeatTo(" \t\u0001\n\r\u0000", n)}a`;
const commaRun = (n: number): string => `a${",".repeat(n)}b,`;

describe("URL checks take linear time on hostile values", () => {
  for (const [shape, input] of [
    ["a space run", spaceRun],
    ["a C0 control run", controlRun],
    ["a mixed space, tab and C0 run", mixedRun],
  ] as const) {
    it(
      `normalizeUrl, urlScheme and isSafeUrl on ${shape}`,
      () => {
        expect(normalizeUrl(input(8))).toBe(regexNormalizeUrl(input(8)));
        expectLinearTime(input, URL_SIZE, normalizeUrl);
        expectLinearTime(input, URL_SIZE, urlScheme);
        expectLinearTime(input, URL_SIZE, (url) => isSafeUrl(url, true));
        expectLinearTime(input, URL_SIZE, (url) =>
          urlVerdict("img", "srcset", url),
        );
        expectLinearTime(input, URL_SIZE, (url) =>
          urlVerdict("a", "ping", url),
        );
        expectLinearTime(input, URL_SIZE, (url) =>
          urlVerdict("set", "to", url),
        );
      },
      LINEAR_TIME_TIMEOUT_MS,
    );

    it(
      `html URL holes and safeUrl on ${shape}`,
      () => {
        expect(String(html`<a href="${input(3)}">x</a>`)).toBe(
          `<a href="${input(3)}">x</a>`,
        );
        expectLinearTime(input, URL_SIZE, (v) => html`<a href="${v}">x</a>`);
        expectLinearTime(input, URL_SIZE, (v) => html`<img srcset="${v}" />`);
        expectLinearTime(input, URL_SIZE, (v) => html`<a ping="${v}">x</a>`);
        expectLinearTime(
          input,
          URL_SIZE,
          (v) => html`<svg><set attributeName="href" to="${v}" /></svg>`,
        );
        expectLinearTime(input, URL_SIZE, (v) => safeUrl(v));
        expectLinearTime(input, URL_SIZE, (v) =>
          safeUrl(v, { origins: ["https://cdn.example.com"] }),
        );
      },
      LINEAR_TIME_TIMEOUT_MS,
    );
  }

  it(
    "srcset splitting on a URL with a long comma run before its trailing comma",
    () => {
      expect(srcsetUrls(commaRun(3))).toEqual(["a,,,b"]);
      expectLinearTime(commaRun, URL_SIZE, srcsetUrls);
      expectLinearTime(commaRun, URL_SIZE, (v) => html`<img srcset="${v}" />`);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "the request-time binding check on a bound URL or style prop",
    () => {
      // These run at memory speed: at 200k characters the quarter size fit a
      // CI runner's L2 cache and the full size did not, which read as a
      // growth of 9.3. Both sizes here are past L2.
      const BINDING_SIZE = 4_000_000;
      const bind = (template: string) => (value: string) =>
        injectPropAttributes(template, { next: value }, undefined, () => {});
      const link = bind('<a data-bascik-attr-href="next">x</a>');
      const styled = bind('<div data-bascik-attr-style="next"></div>');
      expect(link(spaceRun(3))).toBe(`<a href="${spaceRun(3)}">x</a>`);
      expectLinearTime(spaceRun, BINDING_SIZE, link);
      expectLinearTime(controlRun, BINDING_SIZE, link);
      const cssUrl = (n: number): string => `background:url(${spaceRun(n)})`;
      expectLinearTime(cssUrl, BINDING_SIZE, styled);
      expectLinearTime(
        (n) => `background:url("${controlRun(n)}")`,
        BINDING_SIZE,
        styled,
      );
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
