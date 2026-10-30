// Not formatted by Prettier (see .prettierignore): Prettier rewrites
// html`...` templates as HTML (closing tags, quotes, whitespace), and these
// cases test the exact template text.
/**
 * @bascik/bascik/html attack suite (Collin 2026-10-28: safety helpers in core,
 * plain functions, no magic).
 *
 * `html` reads the static parts of a tagged template to learn where each
 * hole lands, escapes for that place, and refuses (a located HtmlError) the
 * places escaping cannot make safe. Every case asserts the SAFE outcome. The
 * differential block at the end renders each allowed context with hostile
 * values and parses the result with parse5 (a spec parser): the element and
 * attribute structure must be the same as with a harmless value, so a value
 * is only ever text or one attribute value.
 */
import { describe, expect, it, vi } from "vitest";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import {
  esc,
  html,
  HtmlError,
  isHtml,
  json,
  raw,
  safeUrl,
  type SafeHtml,
} from "../html.ts";

const s = (value: SafeHtml): string => String(value);

/** The HtmlError (or TypeError) a call throws. */
const thrown = (fn: () => unknown): Error & Partial<HtmlError> => {
  try {
    fn();
  } catch (error) {
    return error as Error & Partial<HtmlError>;
  }
  throw new Error("expected the call to throw");
};

// ─── Values in text ─────────────────────────────────────────────────────────

describe("html: values in text", () => {
  it("entity-escapes a string", () => {
    expect(s(html`<p>${`<b>&"'</b>`}</p>`)).toBe(
      "<p>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</p>",
    );
  });

  it("renders numbers, bigints and true as text, and null, undefined and false as nothing", () => {
    expect(s(html`<p>${42}|${-1.5}|${10n}|${true}</p>`)).toBe(
      "<p>42|-1.5|10|true</p>",
    );
    expect(s(html`<p>${null}|${undefined}|${false}</p>`)).toBe("<p>||</p>");
  });

  it("0 and the empty string are values, not nothing", () => {
    expect(s(html`<p>${0}|${""}</p>`)).toBe("<p>0|</p>");
  });

  it("inserts a nested html value as it is", () => {
    const inner = html`<b>${"<i>"}</b>`;
    expect(s(html`<p>${inner}</p>`)).toBe("<p><b>&lt;i&gt;</b></p>");
  });

  it("inserts an array of html values with no separator, so .map works without join", () => {
    const items = ["a<", "b&"];
    expect(
      s(
        html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`,
      ),
    ).toBe("<ul><li>a&lt;</li><li>b&amp;</li></ul>");
  });

  it("flattens nested arrays and escapes strings inside them", () => {
    expect(s(html`<p>${[["<a>", [html`<br>`]], 1, null, false]}</p>`)).toBe(
      "<p>&lt;a&gt;<br>1</p>",
    );
  });

  it("stringifies other objects and escapes the result (a Date, an object with toString)", () => {
    const date = new Date(0);
    expect(s(html`<p>${date}</p>`)).toBe(
      `<p>${String(date).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
    );
    expect(s(html`<p>${{ toString: () => "<x>" }}</p>`)).toBe(
      "<p>&lt;x&gt;</p>",
    );
  });

  it("a value inside a component tag and in <template> is text", () => {
    expect(
      s(html`<product-card>${"<img src=x onerror=alert(1)>"}</product-card>`),
    ).toBe("<product-card>&lt;img src=x onerror=alert(1)&gt;</product-card>");
    expect(s(html`<template>${"<script>"}</template>`)).toBe(
      "<template>&lt;script&gt;</template>",
    );
  });

  it("refuses a Promise with a located error (forgot to await)", () => {
    const error = thrown(
      () =>
        html`<p>${"ok"}</p><p>${Promise.resolve("x")}</p>`,
    );
    expect(error).toBeInstanceOf(HtmlError);
    expect(error).toMatchObject({ code: "promise", hole: 2 });
    expect(error.message).toBe(
      "html: hole 2 in html`<p>${…}</p><p>${…}</p>` received a Promise. Await the value before putting it in the template.",
    );
  });

  it("refuses a thenable too", () => {
    const thenable = { then: (resolve: (v: string) => void) => resolve("x") };
    expect(thrown(() => html`<p>${thenable}</p>`)).toMatchObject({
      code: "promise",
      hole: 1,
    });
  });

  it("escapes json() output in text (it is a string there)", () => {
    expect(s(html`<p>${json({ a: "<" })}</p>`)).toBe(
      `<p>{&quot;a&quot;:&quot;\\u003c&quot;}</p>`,
    );
  });

  it("U+2028, U+2029, NUL and astral characters pass through as text", () => {
    expect(s(html`<p>${"\u2028\u2029\u0000😀"}</p>`)).toBe(
      "<p>\u2028\u2029\u0000😀</p>",
    );
  });

  it("deep nesting (1000 levels) renders without a stack overflow", () => {
    let node = html`<i>leaf</i>`;
    for (let i = 0; i < 1000; i++) node = html`<b>${node}</b>`;
    expect(s(node).length).toBe("<i>leaf</i>".length + 1000 * 7);
  });
});

describe("html: RCDATA and non-code raw text", () => {
  it("escapes text in <textarea> and <title> so it cannot end them", () => {
    expect(
      s(html`<textarea>${"</textarea><script>x</script>"}</textarea>`),
    ).toBe(
      "<textarea>&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea>",
    );
    expect(s(html`<title>${"</title><script>"}</title>`)).toBe(
      "<title>&lt;/title&gt;&lt;script&gt;</title>",
    );
  });

  it("refuses an html value in <title> or <textarea>: they hold text only", () => {
    const error = thrown(() => html`<title>${html`<b>x</b>`}</title>`);
    expect(error).toMatchObject({ code: "markup-in-text-only", hole: 1 });
    expect(error.message).toBe(
      "html: hole 1 in html`<title>${…}</title>` received an html`...` or raw() value, but <title> holds text only. Pass a string.",
    );
    expect(
      thrown(() => html`<textarea>${[html`<b>x</b>`]}</textarea>`),
    ).toMatchObject({
      code: "markup-in-text-only",
    });
  });

  it("escapes text in <noscript>, <xmp>, <iframe>, <noembed> and <noframes>", () => {
    const v = "</noscript><img src=x onerror=alert(1)>";
    expect(s(html`<noscript>${v}</noscript>`)).toBe(
      "<noscript>&lt;/noscript&gt;&lt;img src=x onerror=alert(1)&gt;</noscript>",
    );
    expect(s(html`<xmp>${"</xmp><b>"}</xmp>`)).toBe(
      "<xmp>&lt;/xmp&gt;&lt;b&gt;</xmp>",
    );
    expect(s(html`<iframe>${"</iframe><b>"}</iframe>`)).toBe(
      "<iframe>&lt;/iframe&gt;&lt;b&gt;</iframe>",
    );
  });

  it("a <title> inside <svg> is an ordinary element (foreign content), so html in it is fine", () => {
    expect(s(html`<svg><title>${"<"}</title></svg>`)).toBe(
      "<svg><title>&lt;</title></svg>",
    );
  });
});

// ─── Values in attributes ───────────────────────────────────────────────────

describe("html: values in quoted attributes", () => {
  it("escapes in double and single quotes, so the value never ends the attribute", () => {
    const v = `x" onmouseover="alert(1)' onfocus='alert(2)`;
    expect(s(html`<a title="${v}">`)).toBe(
      `<a title="x&quot; onmouseover=&quot;alert(1)&#39; onfocus=&#39;alert(2)">`,
    );
    expect(s(html`<a title='${v}'>`)).toBe(
      `<a title='x&quot; onmouseover=&quot;alert(1)&#39; onfocus=&#39;alert(2)'>`,
    );
  });

  it("escapes data-bascik-prop-* holes once (Bascik decodes props once)", () => {
    expect(
      s(
        html`<product-card data-bascik-prop-name="${`<img src=x onerror=alert(1)>`}"></product-card>`,
      ),
    ).toBe(
      `<product-card data-bascik-prop-name="&lt;img src=x onerror=alert(1)&gt;"></product-card>`,
    );
  });

  it("allows several holes and static text in one attribute", () => {
    expect(s(html`<div class="card ${"a"} ${"b<"}">`)).toBe(
      `<div class="card a b&lt;">`,
    );
  });

  it("null, undefined and false render as an empty value", () => {
    expect(s(html`<div class="${null}${undefined}${false}">`)).toBe(
      `<div class="">`,
    );
  });

  it("an attribute named on-something that is not a handler takes a value (onboarding-step)", () => {
    expect(
      s(html`<div data-onclick="${"x"}" onboarding-step="${"y"}">`),
    ).toBe(`<div data-onclick="x" onboarding-step="y">`);
  });

  it("json() in an attribute is escaped like any string", () => {
    expect(s(html`<div data-state="${json({ q: `"'<` })}">`)).toBe(
      `<div data-state="{&quot;q&quot;:&quot;\\&quot;&#39;\\u003c&quot;}">`,
    );
  });

  it("refuses an html value in an attribute", () => {
    const error = thrown(
      () =>
        html`<a
          href="/"
          title="${"t"}"
          class="${"c"}"
          data-x="${html`<b></b>`}"
        ></a>`,
    );
    expect(error).toMatchObject({ code: "markup-in-attribute", hole: 3 });
    expect(error.message).toContain(
      "(the data-x attribute) received an html`...` or raw() value. An attribute holds text; pass a string, which html escapes.",
    );
  });

  it("refuses an array in an attribute and says to join it", () => {
    const error = thrown(() => html`<div class="${["a", "b"]}">`);
    expect(error).toMatchObject({ code: "array-in-attribute", hole: 1 });
    expect(error.message).toBe(
      'html: hole 1 in html`<div class="${…}">` (the class attribute) received an array. An attribute holds one text value; join it in code, for example ${classes.join(" ")}.',
    );
  });

  it("refuses a Promise in an attribute", () => {
    expect(
      thrown(() => html`<div class="${Promise.resolve("a")}"></div>`),
    ).toMatchObject({
      code: "promise",
      hole: 1,
    });
  });

  it("finds the context after a > inside an earlier quoted value", () => {
    expect(s(html`<a title="a>b" class="${"<"}">${"<"}</a>`)).toBe(
      `<a title="a>b" class="&lt;">&lt;</a>`,
    );
  });
});

describe("html: URL attributes (the shared url-safety rule)", () => {
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
    "data:image/svg+xml,<svg onload=alert(1)>",
  ])("a hole at the start of href replaces %j with about:invalid", (url) => {
    expect(s(html`<a href="${url}">x</a>`)).toBe(
      `<a href="about:invalid">x</a>`,
    );
  });

  it.each([
    ["a", "href"],
    ["a", "xlink:href"],
    ["img", "src"],
    ["form", "action"],
    ["button", "formaction"],
    ["video", "poster"],
    ["iframe", "src"],
    ["script", "src"],
    ["embed", "src"],
    ["base", "href"],
    ["link", "href"],
    ["object", "data"],
    ["blockquote", "cite"],
    ["body", "background"],
  ])(
    "<%s %s> blocks script URLs and keeps a third-party https URL",
    (tag, attr) => {
      const make = (v: string): string => {
        switch (`${tag} ${attr}`) {
          case "a href":
            return s(html`<a href="${v}"></a>`);
          case "a xlink:href":
            return s(html`<a xlink:href="${v}"></a>`);
          case "img src":
            return s(html`<img src="${v}" />`);
          case "form action":
            return s(html`<form action="${v}"></form>`);
          case "button formaction":
            return s(html`<button formaction="${v}"></button>`);
          case "video poster":
            return s(html`<video poster="${v}"></video>`);
          case "iframe src":
            return s(html`<iframe src="${v}"></iframe>`);
          case "script src":
            return s(html`<script src="${v}"></script>`);
          case "embed src":
            return s(html`<embed src="${v}" />`);
          case "base href":
            return s(html`<base href="${v}" />`);
          case "link href":
            return s(html`<link rel="stylesheet" href="${v}" />`);
          case "object data":
            return s(html`<object data="${v}"></object>`);
          case "blockquote cite":
            return s(html`<blockquote cite="${v}"></blockquote>`);
          default:
            return s(html`<body background="${v}"></body>`);
        }
      };
      expect(make("javascript:alert(1)")).toContain(`${attr}="about:invalid"`);
      expect(make("https://cdn.example.net/x?a=1&b=2")).toContain(
        `${attr}="https://cdn.example.net/x?a=1&amp;b=2"`,
      );
    },
  );

  it("escapes a kept URL so it cannot end the attribute", () => {
    expect(s(html`<a href="${`/x" onclick="alert(1)`}">`)).toBe(
      `<a href="/x&quot; onclick=&quot;alert(1)">`,
    );
  });

  it("an entity-spelled scheme in a value stays text (escaped once, never decoded to a scheme)", () => {
    expect(s(html`<a href="${"&#106;avascript:alert(1)"}">`)).toBe(
      `<a href="&amp;#106;avascript:alert(1)">`,
    );
  });

  it("image slots keep data:image/*; a link does not", () => {
    const png = "data:image/png;base64,AAAA";
    expect(s(html`<img src="${png}">`)).toBe(`<img src="${png}">`);
    expect(s(html`<video poster="${png}"></video>`)).toBe(
      `<video poster="${png}"></video>`,
    );
    expect(s(html`<a href="${png}">`)).toBe(`<a href="about:invalid">`);
  });

  it("checks srcset and imagesrcset candidate by candidate", () => {
    expect(s(html`<img srcset="${"/a.png 1x, /b.png 2x"}">`)).toBe(
      `<img srcset="/a.png 1x, /b.png 2x">`,
    );
    expect(s(html`<img srcset="${"/a.png 1x, javascript:x 2x"}">`)).toBe(
      `<img srcset="about:invalid">`,
    );
    expect(s(html`<img srcset="/a.png 1x, ${"javascript:x"} 2x">`)).toBe(
      `<img srcset="/a.png 1x, about:invalid 2x">`,
    );
    expect(
      s(
        html`<link rel="preload" as="image" imagesrcset="${"data:text/html,x 1x"}">`,
      ),
    ).toBe(`<link rel="preload" as="image" imagesrcset="about:invalid">`);
  });

  it("checks every URL in ping", () => {
    expect(s(html`<a href="/" ping="${"/p javascript:x"}">`)).toBe(
      `<a href="/" ping="about:invalid">`,
    );
    expect(s(html`<a href="/" ping="${"/p https://t.example/q"}">`)).toBe(
      `<a href="/" ping="/p https://t.example/q">`,
    );
  });

  it("checks SVG animation values entry by entry", () => {
    expect(
      s(
        html`<svg><a><set attributeName="href" to="${"javascript:alert(1)"}"/></a></svg>`,
      ),
    ).toBe(`<svg><a><set attributeName="href" to="about:invalid"/></a></svg>`);
    expect(
      s(
        html`<svg><animate attributeName="href" values="${"#a;java\tscript:x"}"/></svg>`,
      ),
    ).toBe(`<svg><animate attributeName="href" values="about:invalid"/></svg>`);
    expect(
      s(html`<svg><animate attributeName="opacity" values="${"0;1"}"/></svg>`),
    ).toBe(`<svg><animate attributeName="opacity" values="0;1"/></svg>`);
  });

  it("after a static prefix that settles the scheme, a hole is an ordinary attribute hole", () => {
    expect(s(html`<a href="/u/${"javascript:alert(1)"}">`)).toBe(
      `<a href="/u/javascript:alert(1)">`,
    );
    expect(s(html`<a href="https://example.com/${"a&b"}">`)).toBe(
      `<a href="https://example.com/a&amp;b">`,
    );
    expect(s(html`<a href="?q=${`"><x`}">`)).toBe(
      `<a href="?q=&quot;&gt;&lt;x">`,
    );
    expect(s(html`<a href="#${"x"}">`)).toBe(`<a href="#x">`);
    expect(s(html`<a href="mailto:${"a@example.com"}">`)).toBe(
      `<a href="mailto:a@example.com">`,
    );
  });

  it("a hole at the URL start may be followed by static text that starts the path", () => {
    expect(s(html`<a href="${"https://example.com"}/docs">`)).toBe(
      `<a href="https://example.com/docs">`,
    );
    expect(s(html`<a href="${"javascript:x"}/docs">`)).toBe(
      `<a href="about:invalid/docs">`,
    );
  });

  it("a URL attribute name is matched case-insensitively", () => {
    expect(s(html`<a HREF="${"javascript:x"}">`)).toBe(
      `<a HREF="about:invalid">`,
    );
  });

  it("data is a URL only on <object>", () => {
    expect(s(html`<div data="${"javascript:x"}">`)).toBe(
      `<div data="javascript:x">`,
    );
  });
});

describe('html: <script type="application/json"> with json()', () => {
  it("accepts json() as the only content and inserts it as is", () => {
    const data = { q: "</script><script>alert(1)</script>", n: 1 };
    const out = s(
      html`<script type="application/json" id="d">${json(data)}</script>`,
    );
    expect(out).toBe(
      `<script type="application/json" id="d">{"q":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e","n":1}</script>`,
    );
    expect(out).not.toMatch(/<\/script>.*<\/script>/s);
  });

  it("accepts surrounding whitespace and application/ld+json", () => {
    expect(
      s(
        html`<script type="application/ld+json">
          ${json({ "@type": "Thing" })}
        </script>`,
      ),
    ).toContain(`{"@type":"Thing"}`);
  });

  it("refuses a plain string there: only json(value) may fill it", () => {
    const error = thrown(
      () =>
        html`<script type="application/json">${"{}"}</script>`,
    );
    expect(error).toMatchObject({ code: "json-script-value", hole: 1 });
    expect(error.message).toBe(
      'html: hole 1 in html`<script type="application/json">${…}</script>` received a string. Only json(value) can fill this script, so the data cannot end it early.',
    );
  });

  it("refuses json() inside a script of another type or with other content", () => {
    expect(
      thrown(
        () =>
          html`<script>
            var d = ${json(1)};
          </script>`,
      ),
    ).toMatchObject({
      code: "script-body",
      hole: 1,
    });
    expect(
      thrown(
        () =>
          html`<script type="application/json">
            {"a": ${json(1)}}
          </script>`,
      ),
    ).toMatchObject({ code: "script-body", hole: 1 });
  });

  it("a type written by a hole is not a static JSON type", () => {
    expect(
      thrown(
        () =>
          html`<script type="${"application/json"}">
            ${json(1)}
          </script>`,
      ),
    ).toMatchObject({ code: "script-body", hole: 2 });
  });
});

// ─── Refusals ───────────────────────────────────────────────────────────────

const x = "value";

/** [name, template call, code, hole] for every position escaping cannot make safe. */
const REFUSALS: [string, () => unknown, string, number][] = [
  ["unquoted value", () => html`<a class=${x}></a>`, "unquoted-attribute", 1],
  [
    "unquoted value after text",
    () => html`<a class=a${x}>`,
    "unquoted-attribute",
    1,
  ],
  ["unquoted href", () => html`<a href=${x}></a>`, "unquoted-attribute", 1],
  [
    "unquoted after spaces around =",
    () => html`<a class = ${x}>`,
    "unquoted-attribute",
    1,
  ],
  ["onclick", () => html`<button onclick="${x}"></button>`, "event-handler", 1],
  [
    "ONERROR uppercase, single quotes",
    () => html`<img src="/a.png" ONERROR='${x}'>`,
    "event-handler",
    1,
  ],
  [
    "onclick with static prefix",
    () => html`<a onclick="go('${x}')"></a>`,
    "event-handler",
    1,
  ],
  ["svg onload", () => html`<svg onload="${x}"></svg>`, "event-handler", 1],
  [
    "style attribute",
    () => html`<div style="color: ${x}"></div>`,
    "style-attribute",
    1,
  ],
  ["srcdoc", () => html`<iframe srcdoc="${x}"></iframe>`, "srcdoc", 1],
  [
    "meta http-equiv value",
    () => html`<meta http-equiv="${x}" />`,
    "meta-http-equiv",
    1,
  ],
  [
    "meta content with http-equiv before",
    () => html`<meta http-equiv="refresh" content="${x}" />`,
    "meta-http-equiv",
    1,
  ],
  [
    "meta content with http-equiv after",
    () => html`<meta content="${x}" http-equiv="refresh" />`,
    "meta-http-equiv",
    1,
  ],
  [
    "svg attributeName",
    () => html`<svg><set attributeName="${x}" to="1" /></svg>`,
    "svg-animation-attribute",
    1,
  ],
  [
    "svg attributeType",
    () => html`<svg><animate attributeType="${x}" /></svg>`,
    "svg-animation-attribute",
    1,
  ],
  [
    "svg animation of an event handler",
    () => html`<svg><set attributeName="onclick" to="${x}" /></svg>`,
    "event-handler",
    1,
  ],
  [
    "script body",
    () =>
      html`<script>
        ${x};
      </script>`,
    "script-body",
    1,
  ],
  [
    "script body inside a string",
    () =>
      html`<script type="module">
        const a = "${x}";
      </script>`,
    "script-body",
    1,
  ],
  [
    "svg script body",
    () =>
      html`<svg>
        <script>
          ${x};
        </script>
      </svg>`,
    "script-body",
    1,
  ],
  [
    "SCRIPT uppercase",
    () => html`<SCRIPT>${x};</SCRIPT>`,
    "script-body",
    1,
  ],
  [
    "style body",
    () =>
      html`<style>
        .a {
          color: ${x};
        }
      </style>`,
    "style-body",
    1,
  ],
  ["tag name", () => html`<${x}></${x}>`, "tag-name", 1],
  ["end tag name", () => html`<p></${x}>`, "tag-name", 1],
  ["tag name continued", () => html`<h${x}></h${x}>`, "tag-name", 1],
  ["attribute name", () => html`<input ${x} />`, "attribute-name", 1],
  [
    "attribute name after an attribute",
    () => html`<a href="/" ${x}></a>`,
    "attribute-name",
    1,
  ],
  [
    "attribute name continued",
    () => html`<a data-${x}="1"></a>`,
    "attribute-name",
    1,
  ],
  [
    "after an attribute name",
    () => html`<input disabled ${x} />`,
    "attribute-name",
    1,
  ],
  ["comment", () => html`<!-- ${x} -->`, "comment", 1],
  [
    "comment after markup",
    () =>
      html`<p>a</p>
        <!-- note: ${x} -->`,
    "comment",
    1,
  ],
  ["doctype", () => html`<!DOCTYPE ${x}>`, "comment", 1],
  ["bogus comment <?", () => html`<?xml ${x} ?>`, "comment", 1],
  ["bogus comment <!x", () => html`<!x ${x}>`, "comment", 1],
  ["CDATA", () => html`<svg><![CDATA[${x}]]></svg>`, "comment", 1],
  [
    "scheme split: java",
    () => html`<a href="java${x}"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: leading space then java",
    () => html`<a href=" java${x}"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: entity",
    () => html`<a href="&#106;${x}"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: host then port",
    () => html`<a href="${x}:8080/"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: two holes",
    () => html`<a href="${x}${x}"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: & before path",
    () => html`<a href="${x}&amp;y"></a>`,
    "url-scheme-split",
    1,
  ],
  [
    "scheme split: srcset candidate",
    () => html`<img srcset="/a.png 1x, java${x} 2x" />`,
    "url-scheme-split",
    1,
  ],
  [
    "static javascript: URL",
    () => html`<a href="javascript:${x}"></a>`,
    "script-url",
    1,
  ],
  [
    "static JavaScript: with tab",
    () => html`<a href="Java	Script:void(${x})"></a>`,
    "script-url",
    1,
  ],
  [
    "static vbscript:",
    () => html`<a href="vbscript:${x}"></a>`,
    "script-url",
    1,
  ],
  [
    "static data: URL",
    () => html`<iframe src="data:text/html,${x}"></iframe>`,
    "script-url",
    1,
  ],
  [
    "script whose text contains <!--",
    () =>
      html`<script>
          if (a <!--b) {}
        </script>
        <p>${x}</p>`,
    "script-comment-ambiguous",
    1,
  ],
];

describe("html: positions escaping cannot make safe are refused", () => {
  it.each(REFUSALS)("%s", (_name, call, code, hole) => {
    const error = thrown(call);
    expect(error).toBeInstanceOf(HtmlError);
    expect(error.name).toBe("HtmlError");
    expect(error).toMatchObject({ code, hole });
    expect(error.message).toMatch(new RegExp(`^html: hole ${hole} in html\``));
    expect(error.template).toContain("${…}");
  });

  it("refuses on every call, whatever the values, with a fresh error each time", () => {
    const call = (v: unknown) => html`<a class=${v}></a>`;
    const first = thrown(() => call("a"));
    const second = thrown(() => call(null));
    expect(first).toMatchObject({ code: "unquoted-attribute" });
    expect(second).toMatchObject({ code: "unquoted-attribute" });
    expect(second).not.toBe(first);
  });

  it.each([
    [
      "unquoted-attribute",
      () => html`<a href="/" class=${x}>`,
      'html: hole 1 in html`<a href="/" class=${…}>` is an unquoted attribute value (class). A space in the value would start a new attribute. Quote it: class="${…}".',
    ],
    [
      "event-handler",
      () => html`<button onclick="${x}">`,
      'html: hole 1 in html`<button onclick="${…}">` is inside the onclick attribute. An event handler\'s value is JavaScript, which escaping cannot make safe. Put the value in a data-* attribute and read it from a component script.',
    ],
    [
      "style-attribute",
      () => html`<div style="${x}">`,
      'html: hole 1 in html`<div style="${…}">` is inside a style attribute. CSS can load URLs and change the page, and escaping does not make it safe. Choose between fixed classes in code, or put the value in a data-* attribute.',
    ],
    [
      "script-body",
      () => html`<script>${x}</script>`,
      'html: hole 1 in html`<script>${…}</script>` is inside a <script> element. Escaping HTML does not make JavaScript safe. Put the value in a data-* attribute, or in <script type="application/json">${json(value)}</script>.',
    ],
    [
      "style-body",
      () => html`<style>${x}</style>`,
      "html: hole 1 in html`<style>${…}</style>` is inside a <style> element. Escaping HTML does not make CSS safe. Choose between fixed classes in code.",
    ],
    [
      "tag-name",
      () => html`<${x}>`,
      "html: hole 1 in html`<${…}>` is a tag name. A value never chooses which element to write. Choose between fixed html`...` fragments in code.",
    ],
    [
      "attribute-name",
      () => html`<input ${x}>`,
      "html: hole 1 in html`<input ${…}>` is where an attribute name goes, inside <input>. A value never chooses which attributes an element has. Write the attribute in the template with a quoted value, or choose between fixed html`...` fragments in code.",
    ],
    [
      "comment",
      () => html`<!-- ${x} -->`,
      "html: hole 1 in html`<!-- ${…} -->` is inside an HTML comment (or a <!...> declaration). Move the value out of the comment.",
    ],
    [
      "srcdoc",
      () => html`<iframe srcdoc="${x}">`,
      'html: hole 1 in html`<iframe srcdoc="${…}">` is inside srcdoc, an HTML document that runs with the page\'s origin. Set src to a URL instead.',
    ],
    [
      "meta-http-equiv",
      () => html`<meta http-equiv="refresh" content="${x}">`,
      'html: hole 1 in html`<meta http-equiv="refresh" content="${…}">` is a <meta http-equiv> value, which acts on the page (a redirect, a policy). Write it in the template.',
    ],
    [
      "svg-animation-attribute",
      () => html`<set attributeName="${x}">`,
      'html: hole 1 in html`<set attributeName="${…}">` chooses which attribute an SVG animation sets. Write attributeName in the template.',
    ],
    [
      "url-scheme-split",
      () => html`<a href="java${x}">`,
      'html: hole 1 in html`<a href="java${…}">` continues the URL\'s scheme from the template text "java", so the value could complete javascript:. Start the attribute with the value (href="${…}"), or write the scheme and the first / in the template (href="https://example.com/${…}").',
    ],
    [
      "script-url",
      () => html`<a href="javascript:${x}">`,
      'html: hole 1 in html`<a href="javascript:${…}">` is inside a javascript: URL, which runs as script. Use a real URL and handle the click in a component script.',
    ],
  ])(
    "%s: the message names the template, the hole, why, and the fix",
    (_code, call, message) => {
      expect(thrown(call).message).toBe(message);
    },
  );

  it("the excerpt is cut to about 80 characters around the hole in a long template", () => {
    const error = thrown(
      () =>
        html`<main>
          ${"a".repeat(1)}
          <section class="${"b"}">
            <p>
              ${"lorem ipsum dolor sit amet ".repeat(1)} lorem ipsum dolor sit
              amet lorem ipsum dolor sit amet
            </p>
            <button onclick="${x}">go</button>
          </section>
        </main>`,
    );
    expect(error).toMatchObject({ code: "event-handler", hole: 4 });
    expect(error.template!.length).toBeLessThanOrEqual(100);
    expect(error.template).toContain('onclick="${…}"');
  });
});

describe("html: a template must end outside every open context (hole 0)", () => {
  it.each([
    ["inside an attribute quote", () => html`<a href="${x}`],
    ["inside a tag", () => html`<p class="a"`],
    ["inside a comment", () => html`<p>${x}</p><!-- open`],
    ["inside <script>", () => html`<script>`],
    ["inside <style>", () => html`<p>${x}</p><style>`],
    ["inside <textarea>", () => html`<textarea>${x}`],
    ["inside <title>", () => html`<title>${x}`],
    ["inside a declaration", () => html`<p>${x}</p><!DOCTYPE`],
  ])("%s", (_name, call) => {
    const error = thrown(call);
    expect(error).toMatchObject({ code: "unterminated", hole: 0 });
    expect(error.message).toMatch(/^html: the template html`/);
    expect(error.message).toContain(
      "An html`...` fragment must end outside any tag, comment, <script>, <style>, <textarea>, <title>, <svg> or <math>, so it can be nested safely.",
    );
  });

  it("names the attribute and element for an open quote", () => {
    expect(thrown(() => html`<a href="${x}`).message).toBe(
      'html: the template html`<a href="${…}` ends inside the href attribute of <a> (the quote is not closed). An html`...` fragment must end outside any tag, comment, <script>, <style>, <textarea>, <title>, <svg> or <math>, so it can be nested safely.',
    );
  });

  it("an unclosed ordinary element is fine: only the tokenizer state must be back in data", () => {
    expect(s(html`<div><p>${x}`)).toBe("<div><p>value");
  });
});

describe("html: the tokenizer follows the browser where it matters", () => {
  it("a comment closed by --!> or the abrupt <!--> / <!---> forms ends it", () => {
    expect(s(html`<!-- a --!><p>${"<"}</p>`)).toBe("<!-- a --!><p>&lt;</p>");
    expect(s(html`<!--><p>${"<"}</p>`)).toBe("<!--><p>&lt;</p>");
    expect(s(html`<!---><p>${"<"}</p>`)).toBe("<!---><p>&lt;</p>");
  });

  it("text after a closed script, style, textarea and title is data again", () => {
    expect(
      s(
        html`<script>var a = 1;</script><p>${"<"}</p>`,
      ),
    ).toBe("<script>var a = 1;</script><p>&lt;</p>");
    expect(
      s(
        html`<style>.a{}</style><p>${"<"}</p>`,
      ),
    ).toBe("<style>.a{}</style><p>&lt;</p>");
    expect(
      s(
        html`<textarea></textarea><p class="${"x"}"></p>`,
      ),
    ).toBe(`<textarea></textarea><p class="x"></p>`);
  });

  it("a </script inside a script string does not end it early for the tokenizer: a later hole is still in the script", () => {
    expect(
      thrown(
        () =>
          html`<script>var s = "</script"; ${x};</script>`,
      ),
    ).toMatchObject({ code: "script-body" });
  });

  it("a > inside a quoted attribute value does not end the tag", () => {
    expect(thrown(() => html`<a title=">" onclick="${x}"></a>`)).toMatchObject({
      code: "event-handler",
    });
  });

  it("an attribute name with a hole after = and newline is still an attribute value context", () => {
    expect(s(html`<a
      title="${"<"}">`)).toContain(`title="&lt;"`);
  });

  it("a hole in text that looks like a tag start is text (the < is escaped)", () => {
    expect(s(html`<p>a < ${"<b>"}</p>`)).toBe("<p>a < &lt;b&gt;</p>");
  });

  it("<plaintext> runs to the end, so any hole after it is text", () => {
    expect(s(html`<plaintext>${"</plaintext><b>"}`)).toBe(
      "<plaintext>&lt;/plaintext&gt;&lt;b&gt;",
    );
  });
});

// ─── The returned value ─────────────────────────────────────────────────────

describe("SafeHtml: the value html and raw return", () => {
  const value = html`<p>${"a&b"}</p>`;
  const text = "<p>a&amp;b</p>";

  it("stringifies to the HTML everywhere a string is expected", async () => {
    expect(String(value)).toBe(text);
    expect(`${value}`).toBe(text);
    expect(value + "").toBe(text);
    expect(value.toString()).toBe(text);
    expect(value.valueOf()).toBe(text);
    expect(JSON.stringify({ value })).toBe(JSON.stringify({ value: text }));
    await expect(new Response(String(value)).text()).resolves.toBe(text);
  });

  it("is a frozen object recognized by isHtml, not a string or a String object", () => {
    expect(typeof value).toBe("object");
    expect(value).not.toBeInstanceOf(String);
    expect(Object.isFrozen(value)).toBe(true);
    expect(isHtml(value)).toBe(true);
    expect(isHtml(text)).toBe(false);
    expect(isHtml(new String(text))).toBe(false);
    expect(isHtml(null)).toBe(false);
  });

  it("carries the registered symbol, so another copy of the module recognizes it", () => {
    expect(
      (value as unknown as Record<symbol, unknown>)[Symbol.for("bascik.html")],
    ).toBe(text);
  });

  it("data cannot forge it: JSON, URLSearchParams, headers and structuredClone carry no symbol keys", () => {
    const fromJson = JSON.parse(
      `{"bascik.html":"<script>alert(1)</script>","Symbol(bascik.html)":"<script>"}`,
    );
    expect(isHtml(fromJson)).toBe(false);
    expect(s(html`<p>${fromJson}</p>`)).toBe("<p>[object Object]</p>");
    const cloned = structuredClone({ ...value });
    expect(isHtml(cloned)).toBe(false);
    const params = Object.fromEntries(
      new URLSearchParams("bascik.html=%3Cscript%3E"),
    );
    expect(isHtml(params)).toBe(false);
  });

  it("fragments from two copies of the module (a monorepo duplicate, a Worker bundle) interoperate", async () => {
    const first = await import("../html.ts");
    vi.resetModules();
    const second = await import("../html.ts");
    expect(second.html).not.toBe(first.html);
    expect(String(first.html`<p>${second.html`<b>${"<"}</b>`}</p>`)).toBe(
      "<p><b>&lt;</b></p>",
    );
    expect(second.isHtml(first.raw("<i>x</i>"))).toBe(true);
    expect(
      String(
        second.html`<script type="application/json">${first.json({ a: 1 })}</script>`,
      ),
    ).toBe(`<script type="application/json">{"a":1}</script>`);
  });
});

describe("html: misuse", () => {
  it("called as a function, not a tag", () => {
    const message =
      "html is a tagged template: write html`<p>${value}</p>`, not html(...). To insert trusted markup, use raw(value).";
    const call = html as unknown as (...args: unknown[]) => unknown;
    expect(() => call("<p>x</p>")).toThrow(TypeError);
    expect(() => call("<p>x</p>")).toThrow(message);
    expect(() => call(["<p>x</p>"])).toThrow(message);
    expect(() => call()).toThrow(message);
  });

  describe("an object that cannot become text (a JSON or query-string field)", () => {
    const objects: [string, unknown][] = [
      ["toString is a string", JSON.parse('{"toString":"x"}')],
      ["null prototype", Object.create(null)],
      ["toString and valueOf are not functions", { toString: 1, valueOf: 2 }],
    ];
    const reason =
      "received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError). Data from JSON or a query string can hold an object where a string was expected: check that the value is a string before you use it.";

    it.each(objects)("%s: located HtmlError in text, attribute, URL and <title>", (_name, value) => {
      for (const [build, excerpt] of [
        [() => html`<p>${value}</p>`, "<p>${…}</p>"],
        [() => html`<p title="${value}"></p>`, '<p title="${…}"></p>'],
        [() => html`<a href="${value}">x</a>`, '<a href="${…}">x</a>'],
        [() => html`<img srcset="${value}">`, '<img srcset="${…}">'],
        [() => html`<title>${value}</title>`, "<title>${…}</title>"],
        [() => html`<ul>${["a", value]}</ul>`, "<ul>${…}</ul>"],
      ] as const) {
        const error = thrown(build);
        expect(error).toBeInstanceOf(HtmlError);
        expect(error.code).toBe("unconvertible-value");
        expect(error.hole).toBe(1);
        expect(error.message).toBe(`html: hole 1 in html\`${excerpt}\` ${reason}`);
        expect(error.cause).toBeInstanceOf(TypeError);
      }
    });

    it.each(objects)("%s: esc throws a TypeError that says what to do", (_name, value) => {
      const error = thrown(() => esc(value));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe(
        "esc() received an object that cannot be converted to text (its toString or valueOf is missing, or threw a TypeError). Check that the value is a string before you use it.",
      );
    });

    it("an author's toString that throws something else is not rewritten", () => {
      const boom = new RangeError("boom");
      const value = {
        toString() {
          throw boom;
        },
      };
      expect(thrown(() => html`<p>${value}</p>`)).toBe(boom);
      expect(thrown(() => esc(value))).toBe(boom);
    });
  });

  describe("arrays nested too deep, or containing themselves", () => {
    const reason =
      "received an array nested more than 1000 levels deep, or an array that contains itself. Flatten the data in code before you put it in the template.";
    const nest = (depth: number): unknown => {
      let value: unknown = "x";
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };

    it("renders 1000 levels", () => {
      expect(s(html`<ul>${nest(1000)}</ul>`)).toBe("<ul>x</ul>");
    });

    it.each([
      ["1001 levels", () => nest(1001)],
      ["20000 levels from JSON", () => JSON.parse(`${"[".repeat(20000)}"x"${"]".repeat(20000)}`)],
      ["a cycle", () => {
        const c: unknown[] = ["x"];
        c.push(c);
        return c;
      }],
    ])("%s: located HtmlError, not a RangeError", (_name, make) => {
      const value = make();
      for (const build of [
        () => html`<ul>${value}</ul>`,
        () => html`<title>${value}</title>`,
        () => html`<svg>${value}</svg>`,
      ]) {
        const error = thrown(build);
        expect(error).toBeInstanceOf(HtmlError);
        expect(error.code).toBe("array-depth");
        expect(error.hole).toBe(1);
        expect(error.message).toMatch(/^html: hole 1 in html`<\w+>\$\{…\}<\/\w+>` /);
        expect(error.message.endsWith(reason)).toBe(true);
      }
    });
  });

  it("concatenating fragments with + makes a plain string (documented: keep html at every level)", () => {
    // @ts-expect-error SafeHtml is not a string type, so TypeScript flags +; at run time + still stringifies both.
    const joined = html`<b>a</b>` + html`<b>b</b>`;
    expect(typeof joined).toBe("string");
    expect(s(html`<p>${joined}</p>`)).toBe(
      "<p>&lt;b&gt;a&lt;/b&gt;&lt;b&gt;b&lt;/b&gt;</p>",
    );
  });
});

// ─── raw, esc, safeUrl, json ────────────────────────────────────────────────

describe("raw(value)", () => {
  it("marks trusted HTML, inserted as is", () => {
    const cms = "<p>Sanitized <em>CMS</em> body</p>";
    expect(s(html`<article>${raw(cms)}</article>`)).toBe(
      `<article>${cms}</article>`,
    );
    expect(isHtml(raw(cms))).toBe(true);
  });

  it("null and undefined are empty, numbers are text, an html value is returned unchanged", () => {
    expect(s(raw(null))).toBe("");
    expect(s(raw(undefined))).toBe("");
    expect(s(raw(5))).toBe("5");
    const fragment = html`<b>x</b>`;
    expect(raw(fragment)).toBe(fragment);
  });

  it("refuses to be used as a tag", () => {
    const tag = raw as unknown as (
      s: TemplateStringsArray,
      ...v: unknown[]
    ) => unknown;
    expect(() => tag`<p>${x}</p>`).toThrow(TypeError);
    expect(() => tag`<p>${x}</p>`).toThrow(
      "raw() takes a string of trusted HTML, not a template. Use html`...` for templates.",
    );
  });

  it("refuses an array or a plain object", () => {
    const call = raw as unknown as (v: unknown) => unknown;
    expect(() => call(["<b>a</b>"])).toThrow(
      "raw() takes one string of trusted HTML; received an array. Map each item to html`...` or raw(item).",
    );
    expect(() => call({ html: "<b>" })).toThrow(TypeError);
  });

  it("refuses a Promise", () => {
    const call = raw as unknown as (v: unknown) => unknown;
    expect(() => call(Promise.resolve("<b>"))).toThrow(
      "raw() received a Promise. Await the value first.",
    );
  });

  it("a raw value in an attribute is refused like any html value", () => {
    expect(thrown(() => html`<a title="${raw("<b>")}"></a>`)).toMatchObject({
      code: "markup-in-attribute",
    });
  });
});

describe("esc(value)", () => {
  it("escapes for text and quoted attributes", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("returns a plain string; null, undefined and false are empty; numbers are text", () => {
    expect(typeof esc("x")).toBe("string");
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(false)).toBe("");
    expect(esc(0)).toBe("0");
  });

  it("inside html escapes twice (documented; the lint reports it)", () => {
    expect(s(html`<p>${esc("<")}</p>`)).toBe("<p>&amp;lt;</p>");
  });
});

describe("safeUrl(value, options?)", () => {
  it("returns a safe URL unchanged and blocks script URLs", () => {
    expect(safeUrl("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(safeUrl("/docs")).toBe("/docs");
    expect(safeUrl("javascript:alert(1)")).toBe("about:invalid");
    expect(safeUrl(" java\tscript:alert(1)")).toBe("about:invalid");
    expect(safeUrl("data:text/html,x")).toBe("about:invalid");
  });

  it("never escapes (html or esc does that)", () => {
    expect(safeUrl(`/a?x="<y>"&z`)).toBe(`/a?x="<y>"&z`);
  });

  it("non-strings are about:invalid", () => {
    expect(safeUrl(null)).toBe("about:invalid");
    expect(safeUrl(undefined)).toBe("about:invalid");
    expect(safeUrl({})).toBe("about:invalid");
  });

  it("a string second argument is the base, and the result is resolved against it", () => {
    expect(safeUrl("../b?q=1", "https://example.com/a/c")).toBe(
      "https://example.com/b?q=1",
    );
    expect(safeUrl("/x", { base: new URL("https://example.com/y") })).toBe(
      "https://example.com/x",
    );
    expect(safeUrl("javascript:x", "https://example.com/")).toBe(
      "about:invalid",
    );
  });

  it("image: true keeps data:image/*", () => {
    expect(safeUrl("data:image/png;base64,AAAA", { image: true })).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(safeUrl("data:image/png;base64,AAAA")).toBe("about:invalid");
  });

  describe("origins", () => {
    const origins = ["https://cdn.example.com", "https://img.example.com:8443"];

    it("keeps a URL on a listed origin and a same-site relative path", () => {
      expect(safeUrl("https://cdn.example.com/lib.js", { origins })).toBe(
        "https://cdn.example.com/lib.js",
      );
      expect(safeUrl("https://img.example.com:8443/a.png", { origins })).toBe(
        "https://img.example.com:8443/a.png",
      );
      expect(safeUrl("/js/app.js", { origins })).toBe("/js/app.js");
      expect(safeUrl("js/app.js", { origins })).toBe("js/app.js");
    });

    it("blocks another origin, another scheme or port, and look-alike hosts", () => {
      for (const url of [
        "https://evil.example/x.js",
        "http://cdn.example.com/x.js",
        "https://img.example.com/a.png",
        "https://cdn.example.com.evil.example/x.js",
        "https://cdn.example.com@evil.example/x.js",
        "//evil.example/x.js",
        "/\\evil.example/x.js",
        "\\\\evil.example/x.js",
      ])
        expect(safeUrl(url, { origins }), url).toBe("about:invalid");
    });

    it("a protocol-relative URL on a listed origin passes only with a base", () => {
      expect(safeUrl("//cdn.example.com/x.js", { origins })).toBe(
        "about:invalid",
      );
      expect(
        safeUrl("//cdn.example.com/x.js", {
          origins,
          base: "https://site.example/",
        }),
      ).toBe("https://cdn.example.com/x.js");
    });

    it("a relative path with a base must resolve to the base's origin or a listed one", () => {
      expect(safeUrl("/x", { origins, base: "https://site.example/" })).toBe(
        "https://site.example/x",
      );
    });

    it("refuses an entry that is not an origin, naming it", () => {
      expect(() =>
        safeUrl("/x", { origins: ["https://ok.example", "cdn.example.com"] }),
      ).toThrow(
        'safeUrl: origins[1] "cdn.example.com" is not an origin. Write it as https://cdn.example.com.',
      );
      expect(() =>
        safeUrl("/x", { origins: ["https://cdn.example.com/path"] }),
      ).toThrow(TypeError);
      expect(() =>
        safeUrl("/x", {
          origins: "https://cdn.example.com" as unknown as string[],
        }),
      ).toThrow(
        "safeUrl: origins must be an array of origins such as https://cdn.example.com.",
      );
    });
  });
});

describe("json(value)", () => {
  it("escapes <, >, &, U+2028 and U+2029 and still parses to the same value", () => {
    const value = { s: "</script><!--&\u2028\u2029", n: [1, 2] };
    const text = String(json(value));
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(text).toContain("\\u003c/script\\u003e");
    expect(text).toContain("\\u0026");
    expect(text).toContain("\\u2028");
    expect(JSON.parse(text)).toEqual(value);
  });

  it("undefined becomes null", () => {
    expect(String(json(undefined))).toBe("null");
  });

  it("lets JSON.stringify errors through (cycles, BigInt)", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => json(cycle)).toThrow(TypeError);
    expect(() => json(1n)).toThrow(TypeError);
  });

  it("is not html: isHtml is false", () => {
    expect(isHtml(json(1))).toBe(false);
  });
});

// ─── Differential: parse5 sees the same structure for any value ─────────────

type Node =
  DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.ParentNode;

/** Attributes the browser follows as a URL (a script URL in title or a prop is inert text). */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "data",
  "xlink:href",
]);

/** Every element (namespace:tag) and its attribute names, in document order, plus script texts. */
const structure = (markup: string): string[] => {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if ("tagName" in node) {
      out.push(`${node.tagName}[${node.attrs.map((a) => a.name).join(",")}]`);
      for (const attr of node.attrs) {
        const normalized = attr.value
          .replace(/^[\u0000- ]+/, "")
          .replace(/[\t\n\r]/g, "")
          .toLowerCase();
        if (
          URL_ATTRIBUTES.has(attr.name) &&
          /^(?:javascript|vbscript|livescript|mocha):/.test(normalized)
        )
          out.push(`SCRIPT-URL ${attr.name}`);
      }
      if (node.tagName === "script")
        out.push(
          `script-text:${node.childNodes.map((c) => ("value" in c ? c.value : "")).join("").length > 0}`,
        );
    }
    if ("content" in node && node.content) walk(node.content as Node);
    if ("childNodes" in node)
      for (const child of node.childNodes) walk(child as Node);
  };
  walk(
    parse(
      `<!DOCTYPE html><html><head></head><body>${markup}</body></html>`,
    ) as unknown as Node,
  );
  return out;
};

const PAYLOADS = [
  `<img src=x onerror=alert(1)>`,
  `"><script>alert(1)</script>`,
  `'><svg onload=alert(1)>`,
  `</textarea><img src=x onerror=alert(1)>`,
  `</title><img src=x onerror=alert(1)>`,
  `--><img src=x onerror=alert(1)>`,
  `]]><img src=x onerror=alert(1)>`,
  `javascript:alert(1)`,
  ` \tJaVa\nScRiPt:alert(1)`,
  `&#106;avascript:alert(1)`,
  `&quot; onfocus=&quot;alert(1)`,
  `<product-card data-bascik-prop-name=x><img src=x onerror=alert(1)></product-card>`,
  `<script type="text/bascik-server" data-bascik-job="00000000000000000000000000000000:0"></script>`,
  "\u2028\u2029`${x}",
  `<!--`,
  `<plaintext>`,
];

const CONTEXTS: [string, (v: string) => SafeHtml][] = [
  ["text", (v) => html`<p>${v}</p>`],
  ["text in a component tag", (v) => html`<product-card>${v}</product-card>`],
  ["textarea", (v) => html`<textarea>${v}</textarea>`],
  ["title", (v) => html`<title>${v}</title>`],
  ["noscript", (v) => html`<noscript>${v}</noscript>`],
  ["double-quoted attribute", (v) => html`<a title="${v}">x</a>`],
  ["single-quoted attribute", (v) => html`<a title='${v}'>x</a>`],
  [
    "prop",
    (v) => html`<product-card data-bascik-prop-name="${v}"></product-card>`,
  ],
  ["href", (v) => html`<a href="${v}">x</a>`],
  ["href after a path", (v) => html`<a href="/search?q=${v}">x</a>`],
  ["img src", (v) => html`<img src="${v}" />`],
  ["srcset", (v) => html`<img srcset="${v} 1x" />`],
  ["script src", (v) => html`<script src="${v}"></script>`],
  [
    "json script",
    (v) =>
      html`<script type="application/json">
        ${json({ v })}
      </script>`,
  ],
  ["svg text", (v) => html`<svg><text>${v}</text></svg>`],
  [
    "array of fragments",
    (v) =>
      html`<ul>
        ${[v, v].map((i) => html`<li>${i}</li>`)}
      </ul>`,
  ],
];

describe("differential: a value never changes the parsed structure", () => {
  it.each(CONTEXTS)("%s", (_name, render) => {
    const baseline = structure(String(render("harmless")));
    const findings: string[] = [];
    for (const payload of PAYLOADS) {
      const got = structure(String(render(payload)));
      if (JSON.stringify(got) !== JSON.stringify(baseline))
        findings.push(
          `${JSON.stringify(payload)}:\n  want ${baseline.join(" ")}\n  got  ${got.join(" ")}`,
        );
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
