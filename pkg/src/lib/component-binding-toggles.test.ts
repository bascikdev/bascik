/**
 * `security.blockScriptUrls` and `security.blockCodeBindings` at the binding
 * functions (inventory items 1-10). On (the default) is today's behavior,
 * pinned in component-binding-sinks.test.ts. Off means "the code you wrote
 * is the code that ships": the value is bound as written, with no warning,
 * and still escaped for where it lands, so it stays one attribute value or
 * one element's text. The two switches are independent.
 */
import { describe, expect, it } from "vitest";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import * as props from "./component-props.ts";
import {
  BLOCKED_URL,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";
import { mergeAttributesOntoRoot } from "./component-inheritance.ts";

interface Policy {
  blockScriptUrls: boolean;
  blockCodeBindings: boolean;
}
const ON: Policy = { blockScriptUrls: true, blockCodeBindings: true };
const URLS_OFF: Policy = { blockScriptUrls: false, blockCodeBindings: true };
const CODE_OFF: Policy = { blockScriptUrls: true, blockCodeBindings: false };
const BOTH_OFF: Policy = { blockScriptUrls: false, blockCodeBindings: false };

// The new trailing policy parameter, typed loosely so this file compiles
// against today's signatures and fails on behavior, not on types.
const injectAttrs = injectPropAttributes as unknown as (
  template: string,
  values: Record<string, string>,
  rewrite: undefined,
  warn: (m: string) => void,
  policy?: Policy,
) => string;
const injectText = injectProps as unknown as (
  template: string,
  values: Record<string, string>,
  warn: (m: string) => void,
  policy?: Policy,
) => string;
const inheritOnto = mergeAttributesOntoRoot as unknown as (
  html: string,
  attrs: Record<string, string>,
  warn: (m: string) => void,
  usageTag: string,
  policy?: Policy,
) => string;

const bind = (template: string, value: string, policy?: Policy) => {
  const warnings: string[] = [];
  const html = injectAttrs(
    template,
    { u: value },
    undefined,
    (m) => warnings.push(m),
    policy,
  );
  return { html, warnings };
};
const fill = (template: string, value: string, policy?: Policy) => {
  const warnings: string[] = [];
  const html = injectText(
    template,
    { v: value },
    (m) => warnings.push(m),
    policy,
  );
  return { html, warnings };
};
const inherit = (
  root: string,
  attrs: Record<string, string>,
  policy?: Policy,
) => {
  const warnings: string[] = [];
  const html = inheritOnto(
    root,
    attrs,
    (m) => warnings.push(m),
    "x-embed",
    policy,
  );
  return { html, warnings };
};

type Element = DefaultTreeAdapterTypes.Element;
const elements = (html: string): Element[] => {
  const out: Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of node.childNodes)
      if ("tagName" in child) {
        out.push(child);
        visit(child);
        if (child.tagName === "template")
          visit((child as DefaultTreeAdapterTypes.Template).content);
      }
  };
  visit(parse(`<!doctype html><body>${html}`));
  return out.filter((e) => !["html", "head", "body"].includes(e.tagName));
};

describe("exports", () => {
  it("DEFAULT_BINDING_POLICY is both protections on", () => {
    expect(
      (props as unknown as { DEFAULT_BINDING_POLICY?: Policy })
        .DEFAULT_BINDING_POLICY,
    ).toEqual(ON);
  });
});

// ─── blockScriptUrls (items 1, 2, 3, 10) ────────────────────────────────────

describe("blockScriptUrls: false binds the URL as written", () => {
  it.each([
    [`<a data-bascik-attr-href="u">x</a>`, "javascript:alert(1)", "a", "href"],
    [
      `<iframe data-bascik-attr-src="u"></iframe>`,
      "data:text/html,hi",
      "iframe",
      "src",
    ],
    [
      `<form data-bascik-attr-action="u"></form>`,
      "vbscript:x",
      "form",
      "action",
    ],
    [
      `<object data-bascik-attr-data="u"></object>`,
      "data:application/pdf;base64,JVBE",
      "object",
      "data",
    ],
    [
      `<img data-bascik-attr-srcset="u">`,
      "/a.png 1x, javascript:x 2x",
      "img",
      "srcset",
    ],
    [`<a data-bascik-attr-ping="u">x</a>`, "/p1 javascript:x", "a", "ping"],
  ])("%s with %j", (template, url, tag, attr) => {
    expect(bind(template, url).html).toContain(`${attr}="${BLOCKED_URL}"`);
    const { html, warnings } = bind(template, url, URLS_OFF);
    expect(html).toContain(`${attr}="${url}"`);
    expect(html).not.toContain(BLOCKED_URL);
    expect(warnings).toEqual([]);
    const [el] = elements(html);
    expect(el.tagName).toBe(tag);
    expect(el.attrs.find((a) => a.name === attr)?.value).toBe(url);
  });

  it("an SVG animation value list is bound as written", () => {
    const template = `<svg><a><animate attributeName="href" data-bascik-attr-values="u"/></a></svg>`;
    const { html, warnings } = bind(template, "/a;javascript:x", URLS_OFF);
    expect(html).toBe(
      `<svg><a><animate attributeName="href" values="/a;javascript:x"/></a></svg>`,
    );
    expect(warnings).toEqual([]);
  });

  it("an inherited data on an <object> root is kept as written (item 10)", () => {
    const value = "data:application/pdf;base64,JVBERi0=";
    expect(
      inherit(`<object class="r"></object>`, { data: value }).html,
    ).toContain(`data="${BLOCKED_URL}"`);
    const { html, warnings } = inherit(
      `<object class="r"></object>`,
      { data: value },
      URLS_OFF,
    );
    expect(html).toContain(` data="${value}"`);
    expect(warnings).toEqual([]);
  });

  it("an inherited SVG animation value is kept as written", () => {
    const { html, warnings } = inherit(
      `<set attributeName="href">`,
      { to: "javascript:alert(1)" },
      URLS_OFF,
    );
    expect(html).toContain(` to="javascript:alert(1)"`);
    expect(warnings).toEqual([]);
  });

  it("is independent: blockCodeBindings still refuses onclick, srcdoc and style code", () => {
    expect(
      bind(`<button data-bascik-attr-onclick="u">x</button>`, "go()", URLS_OFF)
        .html,
    ).toBe(`<button>x</button>`);
    expect(
      bind(
        `<iframe data-bascik-attr-srcdoc="u"></iframe>`,
        "<b>x</b>",
        URLS_OFF,
      ).html,
    ).toBe(`<iframe></iframe>`);
    expect(
      bind(
        `<p data-bascik-attr-style="u">x</p>`,
        "width: expression(1)",
        URLS_OFF,
      ).html,
    ).toBe(`<p>x</p>`);
  });

  it("a quote and > in the URL stay inside one attribute value", () => {
    const { html } = bind(
      `<a class="k" data-bascik-attr-href="u">x</a>`,
      `javascript:a" onmouseover="b()" x=">`,
      URLS_OFF,
    );
    const [a] = elements(html);
    expect(a.attrs.map((x) => x.name).sort()).toEqual(["class", "href"]);
    expect(a.attrs.find((x) => x.name === "href")?.value).toBe(
      `javascript:a" onmouseover="b()" x=">`,
    );
  });
});

// ─── blockCodeBindings (items 4-9) ─────────────────────────────────────────

describe("blockCodeBindings: false binds code-carrying attributes as written", () => {
  it.each([
    [`<button data-bascik-attr-onclick="u">x</button>`, "go()", "onclick"],
    [`<div data-bascik-attr-ONMOUSEOVER="u">x</div>`, "hover()", "onmouseover"],
    [`<iframe data-bascik-attr-srcdoc="u"></iframe>`, "<p>hi</p>", "srcdoc"],
    [
      `<meta http-equiv="refresh" data-bascik-attr-content="u">`,
      "0;url=/next",
      "content",
    ],
    [
      `<meta content="0;url=/x" data-bascik-attr-http-equiv="u">`,
      "refresh",
      "http-equiv",
    ],
    [
      `<p data-bascik-attr-style="u">x</p>`,
      "width: expression(alert(1))",
      "style",
    ],
    [`<p data-bascik-attr-style="u">x</p>`, "@import 'x.css'", "style"],
  ])("%s with %j", (template, value, attr) => {
    const { html, warnings } = bind(template, value, CODE_OFF);
    expect(warnings).toEqual([]);
    const [el] = elements(html);
    expect(el.attrs.find((a) => a.name === attr)?.value).toBe(value);
  });

  it("a style with url(javascript:) is governed by blockCodeBindings, not blockScriptUrls", () => {
    const style = "background: url(javascript:alert(1))";
    const template = `<p data-bascik-attr-style="u">x</p>`;
    expect(bind(template, style, URLS_OFF).html).toBe(`<p>x</p>`);
    const { html, warnings } = bind(template, style, CODE_OFF);
    expect(elements(html)[0].attrs[0]).toEqual({ name: "style", value: style });
    expect(warnings).toEqual([]);
  });

  it("an SVG attributeName / attributeType binding is made", () => {
    const { html, warnings } = bind(
      `<svg><a><set data-bascik-attr-attributeName="u" to="#x"/></a></svg>`,
      "href",
      CODE_OFF,
    );
    // A bound attribute lands at the end of the tag, as every binding does.
    expect(html).toBe(`<svg><a><set to="#x" attributeName="href"/></a></svg>`);
    expect(warnings).toEqual([]);
  });

  it("a value animated into an event handler is bound", () => {
    const { html } = bind(
      `<svg><a><set attributeName="onclick" data-bascik-attr-to="u"/></a></svg>`,
      "alert(1)",
      CODE_OFF,
    );
    expect(html).toBe(
      `<svg><a><set attributeName="onclick" to="alert(1)"/></a></svg>`,
    );
  });

  it("is independent: blockScriptUrls still blocks a javascript: href", () => {
    expect(
      bind(`<a data-bascik-attr-href="u">x</a>`, "javascript:x", CODE_OFF).html,
    ).toBe(`<a href="${BLOCKED_URL}">x</a>`);
  });

  it("an onclick value with quotes and > stays one attribute (escaped for its context)", () => {
    const value = `go("a") > 1 && x='"'`;
    const { html } = bind(
      `<button class="b" data-bascik-attr-onclick="u">x</button>`,
      value,
      CODE_OFF,
    );
    const [button] = elements(html);
    expect(button.attrs.map((a) => a.name).sort()).toEqual([
      "class",
      "onclick",
    ]);
    expect(button.attrs.find((a) => a.name === "onclick")?.value).toBe(value);
  });

  it("a srcdoc value with markup stays one attribute", () => {
    const value = `"><script>alert(1)</script><p x="`;
    const { html } = bind(
      `<iframe data-bascik-attr-srcdoc="u"></iframe><i></i>`,
      value,
      CODE_OFF,
    );
    expect(elements(html).map((e) => e.tagName)).toEqual(["iframe", "i"]);
    expect(elements(html)[0].attrs).toEqual([{ name: "srcdoc", value }]);
  });
});

describe("blockCodeBindings: false fills <script> and <style> prop receivers as written", () => {
  // Script and style bodies are raw text: the browser never decodes entities
  // there, so entity escaping would break every quote, < and &. Only the
  // sequences that would end the element early are changed.
  it("ordinary code with quotes, <, > and & arrives unchanged", () => {
    const code = `const cfg = {"a": 1}; if (a < b && c > d) say('hi');`;
    const { html, warnings } = fill(
      `<div><script data-bascik-prop-v>x</script></div>`,
      code,
      CODE_OFF,
    );
    expect(warnings).toEqual([]);
    expect(html).toBe(`<div><script>${code}</script></div>`);
  });

  it("ordinary CSS with quotes and > arrives unchanged", () => {
    const css = `a > b { content: "x & y"; font-family: 'A'; }`;
    const { html } = fill(
      `<div><style data-bascik-prop-v>x</style></div>`,
      css,
      CODE_OFF,
    );
    expect(html).toBe(`<div><style>${css}</style></div>`);
  });

  it.each([
    ["script", `s = "</script>";`, `s = "<\\/script>";`],
    ["script", `s = "</SCRIPT >";`, `s = "<\\/SCRIPT >";`],
    ["script", `s = "<!--<script>";`, `s = "<\\!--<script>";`],
    [
      "style",
      `a::after { content: "</style>" }`,
      `a::after { content: "<\\/style>" }`,
    ],
  ])(
    "<%s>: %s only has its closing sequence escaped",
    (tag, value, expected) => {
      const { html } = fill(
        `<div><${tag} data-bascik-prop-v>x</${tag}><i></i></div>`,
        value,
        CODE_OFF,
      );
      expect(html).toBe(`<div><${tag}>${expected}</${tag}><i></i></div>`);
      expect(elements(html).map((e) => e.tagName)).toEqual(["div", tag, "i"]);
    },
  );

  it.each([
    [`<div><script data-bascik-prop-v>var a = 1;</script></div>`, "script"],
    [`<div><style data-bascik-prop-v>.a { color: red }</style></div>`, "style"],
  ])("%s", (template, tag) => {
    const { html, warnings } = fill(template, "window.x = 1", CODE_OFF);
    expect(warnings).toEqual([]);
    expect(html).toBe(`<div><${tag}>window.x = 1</${tag}></div>`);
  });

  it("a value holding </script> cannot close the element: it stays one script", () => {
    const { html } = fill(
      `<div><script data-bascik-prop-v>x</script><i></i></div>`,
      `</script><img src=x onerror=alert(1)>`,
      CODE_OFF,
    );
    expect(html).not.toContain("</script><img");
    expect(elements(html).map((e) => e.tagName)).toEqual([
      "div",
      "script",
      "i",
    ]);
  });

  it("blockScriptUrls: false alone still refuses a <script> receiver", () => {
    const { html, warnings } = fill(
      `<div><script data-bascik-prop-v>var a = 1;</script></div>`,
      "alert(1)",
      URLS_OFF,
    );
    expect(html).toBe(`<div><script>var a = 1;</script></div>`);
    expect(warnings).toHaveLength(1);
  });
});

describe("no policy argument and both on are today's behavior", () => {
  it.each([undefined, ON])("policy %j", (policy) => {
    expect(
      bind(`<a data-bascik-attr-href="u">x</a>`, "javascript:x", policy).html,
    ).toBe(`<a href="${BLOCKED_URL}">x</a>`);
    expect(
      bind(`<button data-bascik-attr-onclick="u">x</button>`, "go()", policy)
        .html,
    ).toBe(`<button>x</button>`);
  });

  it("both off: every item binds as written, no warning", () => {
    const { html, warnings } = bind(
      `<a data-bascik-attr-href="u" data-bascik-attr-onclick="u">x</a>`,
      "javascript:x",
      BOTH_OFF,
    );
    expect(elements(html)[0].attrs).toEqual([
      { name: "href", value: "javascript:x" },
      { name: "onclick", value: "javascript:x" },
    ]);
    expect(warnings).toEqual([]);
  });
});
