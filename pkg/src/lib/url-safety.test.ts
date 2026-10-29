/**
 * The ONE URL rule (prompt 157 safety helpers): `html` from
 * @bascik/bascik/html and the request-time binding check both decide with
 * url-safety.ts, so a URL a template refuses is a URL a bound prop refuses.
 * The module is portable (no imports at all) because the Worker bundles it
 * through both paths.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BLOCKED_URL,
  escapeHtml,
  isEventHandlerName,
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

const LIB = import.meta.dirname;

describe("url-safety.ts is the one implementation", () => {
  it("has no imports, so html and the Worker can bundle it anywhere", () => {
    const source = readFileSync(resolve(LIB, "url-safety.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+["']node:/);
  });

  it("component-props.ts and html-template.ts import it instead of keeping their own scheme list", () => {
    for (const file of ["component-props.ts", "html-template.ts"]) {
      const source = readFileSync(resolve(LIB, file), "utf8");
      expect(source, file).toMatch(/from\s+["']\.\/url-safety\.ts["']/);
      expect(source, file).not.toMatch(/SCRIPT_URL_SCHEMES\s*=\s*new Set/);
      expect(source, file).not.toMatch(/"livescript"/);
    }
  });

  it("the same-site rule from bca0714e is gone: no SAME_ORIGIN_TARGETS, RUN_LINK_RELS or isSameOriginPath", () => {
    const props = readFileSync(resolve(LIB, "component-props.ts"), "utf8");
    expect(props).not.toMatch(
      /SAME_ORIGIN_TARGETS|RUN_LINK_RELS|isSameOriginPath|outside this site/,
    );
  });

  it("component-props.ts re-exports the same BLOCKED_URL", async () => {
    const props = await import("./component-props.ts");
    expect(props.BLOCKED_URL).toBe(BLOCKED_URL);
    expect(BLOCKED_URL).toBe("about:invalid");
  });
});

describe("isSafeUrl", () => {
  it.each([
    "https://example.com/a?b=c#d",
    "https://cdn.third-party.example/lib.js",
    "//cdn.example.com/x.js",
    "/relative",
    "relative/path:with-colon",
    "mailto:a@example.com",
    "tel:+15555550100",
    "#x",
    "?q=1",
    "",
    "myapp://open",
  ])("keeps %j", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " \t\u0001javascript:alert(1)",
    "java\tscr\nipt:alert(1)",
    "\u0000javascript:x",
    "vbscript:msgbox(1)",
    "livescript:x",
    "mocha:x",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml",
    "DATA:text/javascript,alert(1)",
  ])("refuses %j", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it("an image slot keeps a data:image/* URL and nothing else under data:", () => {
    expect(isSafeUrl("data:image/png;base64,AAAA", true)).toBe(true);
    expect(isSafeUrl("DATA:image/webp;base64,UklGRg==", true)).toBe(true);
    expect(isSafeUrl("data:image/png;base64,AAAA", false)).toBe(false);
    expect(isSafeUrl("data:text/html,x", true)).toBe(false);
  });
});

describe("urlVerdict(tag, target, value)", () => {
  it.each([
    ["a", "href"],
    ["a", "xlink:href"],
    ["img", "src"],
    ["form", "action"],
    ["button", "formaction"],
    ["video", "poster"],
    ["iframe", "src"],
    ["script", "src"],
    ["script", "href"],
    ["embed", "src"],
    ["base", "href"],
    ["link", "href"],
    ["object", "data"],
    ["blockquote", "cite"],
    ["html", "manifest"],
  ])(
    "<%s %s> is a URL slot: script schemes blocked, any http(s) URL kept",
    (tag, target) => {
      expect(urlVerdict(tag, target, "javascript:alert(1)")).toBe("blocked");
      expect(urlVerdict(tag, target, "data:text/html,x")).toBe("blocked");
      expect(urlVerdict(tag, target, "https://other.example/x")).toBe("ok");
      expect(urlVerdict(tag, target, "//other.example/x")).toBe("ok");
      expect(urlVerdict(tag, target, "/same/site")).toBe("ok");
    },
  );

  it("names are case-insensitive", () => {
    expect(urlVerdict("A", "HREF", "javascript:x")).toBe("blocked");
    expect(urlVerdict("OBJECT", "Data", "javascript:x")).toBe("blocked");
  });

  it("data is a URL only on <object>: data on a div is not a URL", () => {
    expect(urlVerdict("div", "data", "javascript:x")).toBe("not-url");
  });

  it("srcset and imagesrcset are checked candidate by candidate, image slots keep data:image/*", () => {
    expect(urlVerdict("img", "srcset", "/a.png 1x, /b.png 2x")).toBe("ok");
    expect(urlVerdict("img", "srcset", "/a.png 1x, javascript:x 2x")).toBe(
      "blocked",
    );
    expect(
      urlVerdict("img", "srcset", "data:image/png;base64,AAAA 1x, /b.png 2x"),
    ).toBe("ok");
    expect(
      urlVerdict("link", "imagesrcset", "/a.png 1x, data:text/html,x 2x"),
    ).toBe("blocked");
  });

  it("ping is a whitespace-separated list", () => {
    expect(urlVerdict("a", "ping", "/p1 https://t.example/p2")).toBe("ok");
    expect(urlVerdict("a", "ping", "/p1 javascript:x")).toBe("blocked");
  });

  it("SVG animation to/from/by/values are ';' lists", () => {
    for (const tag of ["set", "animate", "animateMotion", "animateTransform"]) {
      for (const target of ["to", "from", "by", "values"]) {
        expect(urlVerdict(tag, target, "#a;#b;/c")).toBe("ok");
        expect(urlVerdict(tag, target, "#a;java\tscript:x")).toBe("blocked");
      }
    }
  });

  it("other attributes are not URLs", () => {
    for (const [tag, target] of [
      ["a", "title"],
      ["div", "class"],
      ["div", "data-bascik-prop-href"],
      ["input", "value"],
    ])
      expect(urlVerdict(tag, target, "javascript:x")).toBe("not-url");
  });
});

describe("srcsetUrls", () => {
  it("splits like the browser: commas inside a URL belong to it, descriptors are dropped", () => {
    expect(srcsetUrls("/a,b.png 1x, /c.png 2x")).toEqual([
      "/a,b.png",
      "/c.png",
    ]);
    expect(srcsetUrls("/a.png,")).toEqual(["/a.png"]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters for text and either quote", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("returns the same string when nothing needs escaping (fast path)", () => {
    const clean = "Plain text 123 with no specials";
    expect(escapeHtml(clean)).toBe(clean);
  });

  it("escapes an existing entity again, so it shows as written", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("isEventHandlerName", () => {
  it("is on followed by letters only", () => {
    expect(isEventHandlerName("onclick")).toBe(true);
    expect(isEventHandlerName("onerror")).toBe(true);
    expect(isEventHandlerName("onboarding-step")).toBe(false);
    expect(isEventHandlerName("on")).toBe(false);
  });
});

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

describe("normalizeUrl matches the regex trim it replaced", () => {
  it("on random strings over C0 controls, space, tab and letters", () => {
    const alphabet = [
      "\u0000",
      "\u0001",
      "\u001f",
      " ",
      "\t",
      "\n",
      "\r",
      "\f",
      "a",
      "J",
      ":",
      "!",
      "\u007f",
      " ",
    ];
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 2 ** 32;
    };
    for (let i = 0; i < 20_000; i++) {
      const length = Math.floor(next() * 24);
      let text = "";
      for (let j = 0; j < length; j++)
        text += alphabet[Math.floor(next() * alphabet.length)];
      expect(normalizeUrl(text), JSON.stringify(text)).toBe(
        regexNormalizeUrl(text),
      );
    }
    for (const text of [
      "",
      " ",
      "\u0000",
      " \t ",
      "a",
      " a ",
      " java\tscript:x\u0000",
    ])
      expect(normalizeUrl(text)).toBe(regexNormalizeUrl(text));
  });
});

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
