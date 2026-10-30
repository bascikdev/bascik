// Not formatted by Prettier (see .prettierignore): Prettier rewrites
// html`...` templates as HTML, and these cases test the exact template text.
/**
 * Parser-differential attacks on @bascik/bascik/html (red-team review,
 * 2026-10-28). Each case either throws an HtmlError or renders markup that a
 * spec parser (parse5, with scripting on and off) reads without any event
 * handler, script URL or script text carrying the payload.
 */
import { describe, expect, it } from "vitest";
import { parse } from "parse5";
import { html, HtmlError, raw, type SafeHtml } from "../html.ts";

const PAYLOAD = "alert(1)";
const JS_URL = "javascript:alert(1)";

interface Node {
  nodeName: string;
  namespaceURI?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
  value?: string;
}

/** Event handlers, script URLs and script text the browser would run. */
const executable = (markup: string, scriptingEnabled: boolean): string[] => {
  const out: string[] = [];
  const walk = (n: Node): void => {
    for (const a of n.attrs ?? [])
      if (/^on/i.test(a.name)) out.push(`${n.nodeName}[${a.name}]`);
      else if (/^\s*javascript:/i.test(a.value))
        out.push(`${n.nodeName}[${a.name}]`);
    if (n.nodeName === "script") {
      const text = (n.childNodes ?? [])
        .filter((c) => c.nodeName === "#text")
        .map((c) => c.value)
        .join("");
      if (text.includes(PAYLOAD)) out.push(`script(${n.namespaceURI})`);
    }
    for (const c of n.childNodes ?? []) walk(c);
    if (n.content) walk(n.content);
  };
  walk(
    parse(`<!doctype html><body>${markup}`, {
      scriptingEnabled,
    }) as unknown as Node,
  );
  return out;
};

/** html refuses with an HtmlError, or nothing in its output can run. */
const safe = (build: () => SafeHtml): void => {
  let markup: string;
  try {
    markup = String(build());
  } catch (error) {
    expect(error).toBeInstanceOf(HtmlError);
    return;
  }
  expect(executable(markup, true)).toEqual([]);
  expect(executable(markup, false)).toEqual([]);
};

const refused = (build: () => SafeHtml, code?: string): void => {
  let error: unknown;
  try {
    build();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(HtmlError);
  if (code !== undefined) expect(error).toMatchObject({ code });
};

describe("non-ASCII case folding cannot move the end of a text element", () => {
  it.each([
    ["<title> with U+0130, then onerror", () => html`<title>İstanbul</title>
<img src="x.png" onerror="${PAYLOAD}">`],
    ["<title> with U+0130, then href", () => html`<title>İstanbul</title>
<a href="${JS_URL}">home</a>`],
    ["<textarea> with U+0130, then href", () => html`<textarea>İ</textarea>
<a href="${JS_URL}">x</a>`],
    ["<script> with U+0130 in a string, then onerror", () => html`<script>const city = "İzmir";</script>
<img src="x.png" onerror="${PAYLOAD}">`],
    ["<style> with several U+0130, then href", () => html`<style>/* İİİ */</style>
<a href="${JS_URL}">x</a>`],
    ["<title> with dotless i (U+0131)", () => html`<title>Diyarbakır</title>
<img src="x.png" onerror="${PAYLOAD}">`],
    ["<title> with Kelvin sign (U+212A)", () => html`<title>K</title>
<img src="x.png" onerror="${PAYLOAD}">`],
  ])("%s", (_name, build) => safe(build));

  it("refuses the onerror hole after a Turkish <title> as an event handler", () =>
    refused(() => html`<title>İstanbul</title>
<img src="x.png" onerror="${PAYLOAD}">`, "event-handler"));

  it("blocks the script URL after a Turkish <title>", () => {
    expect(String(html`<title>İstanbul</title>
<a href="${JS_URL}">home</a>`)).toBe(`<title>İstanbul</title>
<a href="about:invalid">home</a>`);
  });

  it("still escapes a Turkish value inside <title>", () => {
    expect(String(html`<title>İ ${"</title><b>"}</title>`)).toBe(
      "<title>İ &lt;/title&gt;&lt;b&gt;</title>",
    );
  });
});

describe("raw-text bodies are also checked as markup", () => {
  it("an onerror hole inside <noscript> is refused (scripting-off parsers read it as markup)", () =>
    refused(() => html`<noscript><img src="x" onerror="${PAYLOAD}"></noscript>`, "event-handler"));

  it("an href hole inside <noscript> is URL-checked", () => {
    expect(String(html`<noscript><a href="${JS_URL}">x</a></noscript>`)).toBe(
      `<noscript><a href="about:invalid">x</a></noscript>`,
    );
  });

  it("text in <noscript>, <title> and <textarea> still renders as escaped text", () => {
    expect(String(html`<noscript><p>Hi ${"<b>"}</p></noscript>`)).toBe(
      "<noscript><p>Hi &lt;b&gt;</p></noscript>",
    );
    expect(String(html`<textarea>${"a & b"}</textarea>`)).toBe(
      "<textarea>a &amp; b</textarea>",
    );
  });

  it("<select> ignores <title> in older parsers, so the title body is markup", () =>
    safe(() => html`<select><title></select><img src="x" onerror="${PAYLOAD}"></title>`));
});

describe("raw-text bodies inside <svg> and <math>", () => {
  it("a fragment with <noscript><script> nested inside <svg>", () =>
    safe(() => html`<svg>${html`<noscript><script>${PAYLOAD}</script></noscript>`}</svg>`));

  it("a fragment with <xmp><a href> nested inside <svg>", () =>
    safe(() => html`<svg>${html`<xmp><a href="${JS_URL}">x</a></xmp>`}</svg>`));

  it("an array of such fragments nested inside <math>", () =>
    safe(() => html`<math>${[html`<xmp><a href="${JS_URL}">x</a></xmp>`]}</math>`));

  it("a fragment that leaves <svg> open is unterminated", () =>
    refused(() => html`<svg viewBox="0 0 1 1">`, "unterminated"));

  it("a fragment that leaves <svg> open, followed by <noscript><script>", () =>
    safe(() => html`${html`<svg viewBox="0 0 1 1">`}<noscript><script>${PAYLOAD}</script></noscript>`));

  it("a mismatched </math> inside <svg> does not close the <svg>", () =>
    safe(() => html`<svg></math><noscript><script>${PAYLOAD}</script></noscript></svg>`));

  it("<foreignObject> is HTML, so </xmp> inside a quoted attribute ends <xmp>", () =>
    safe(() => html`<svg><foreignObject><xmp><a title="</xmp><a href='${JS_URL}'>">x</a></xmp></foreignObject></svg>`));

  it("a closed <svg> and <math> leave nothing open", () => {
    expect(String(html`<svg><circle r="${"1"}"/></svg><math><mi>${"x"}</mi></math><p>${"<"}</p>`)).toBe(
      `<svg><circle r="1"/></svg><math><mi>x</mi></math><p>&lt;</p>`,
    );
  });
});

describe("<script> and <style> inside <svg> are markup, not raw text", () => {
  it("CDATA holding </script> inside an SVG script", () =>
    safe(() => html`<svg><script><![CDATA[/*</script>*/]]>${PAYLOAD}</script></svg>`));

  it("an attribute holding </script> inside an SVG script", () =>
    safe(() => html`<svg><script><a title="</script>"></a>${PAYLOAD}</script></svg>`));

  it("a hole in an SVG script body is refused as script", () =>
    refused(() => html`<svg><script>${PAYLOAD}</script></svg>`, "script-body"));

  it("a hole after a closed SVG script is text", () => {
    expect(String(html`<svg><script>var a = 1;</script><text>${"<"}</text></svg>`)).toBe(
      "<svg><script>var a = 1;</script><text>&lt;</text></svg>",
    );
  });

  it("a static SVG with a CDATA script and no hole after it renders", () => {
    expect(String(html`<p>${"a"}</p><svg><script><![CDATA[var a = 1 < 2;]]></script></svg>`)).toBe(
      "<p>a</p><svg><script><![CDATA[var a = 1 < 2;]]></script></svg>",
    );
  });
});

describe("html fragments with a script or style nested in <svg> or <math>", () => {
  it("refuses a fragment whose <script> text holds < inside <svg>: there it is markup", () => {
    refused(() => html`<svg>${html`<script>/*<a title="</script>"></a>*/</script><p>${PAYLOAD}</p>`}</svg>`, "foreign-content");
  });

  it("carries the refusal through an outer fragment and an array", () => {
    const inner = html`<div>${[html`<script>if (a < b) {}</script>`]}</div>`;
    refused(() => html`<math>${inner}</math>`, "foreign-content");
  });

  it("names the hole and the reason", () => {
    expect(() => html`<svg>${html`<style>a < b {}</style>`}</svg>`).toThrow(
      "html: hole 1 in html`<svg>${…}</svg>` received an html`...` value with a <script> or <style> whose text contains <, inside <svg> or <math>. There the browser reads that text as markup, so the element can end somewhere else. Move the fragment out of the <svg> or <math>, or remove < from its script or style.",
    );
  });

  it("allows the same fragment outside <svg>, and a script without < inside it", () => {
    expect(String(html`<div>${html`<script>if (a < b) {}</script>`}</div>`)).toBe(
      "<div><script>if (a < b) {}</script></div>",
    );
    expect(String(html`<svg>${html`<style>.a{fill:red}</style>`}</svg>`)).toBe(
      "<svg><style>.a{fill:red}</style></svg>",
    );
  });
});

describe("SVG animation of an event handler", () => {
  it("<set attributeName=onclick to=hole> is refused like the quoted form", () => {
    refused(() => html`<svg><set attributeName="onclick" to="${PAYLOAD}"/></svg>`, "event-handler");
    refused(() => html`<svg><set attributeName=onclick to="${PAYLOAD}"/></svg>`, "event-handler");
  });

  it("an unquoted application/json type still marks a JSON script (fails safe either way)", () => {
    refused(() => html`<script type=application/json>${PAYLOAD}</script>`, "json-script-value");
  });
});

describe("</svg> and </math> follow the tree builder's end-tag rule", () => {
  const inner = () => html`<script>/*<a title="</script>"></a>*/${PAYLOAD}</script>`;

  it("</math> does not close an <svg> inside an open HTML element (fragment hole)", () =>
    refused(() => html`<math><mtext><span><svg viewBox="0 0 10 10"><circle r="4"/></math>${inner()}`));

  it("</math> does not close an <svg> inside an open HTML element (one template)", () =>
    refused(() => html`<math><mtext><span><svg viewBox="0 0 10 10"><circle r="4"/></math><script>/*<a title="</script>"></a>*/${PAYLOAD}</script>`));

  it("</svg> is ignored while an HTML element inside <foreignObject> is open", () =>
    safe(() => html`<svg><foreignObject><p>x</svg><script>/*<a title="</script>"></a>*/${PAYLOAD}</script>`));

  it("</svg> after an unclosed SVG element still closes the <svg>", () => {
    expect(String(html`<svg><g><circle r="4"></svg><p>${"<"}</p>`)).toBe(
      `<svg><g><circle r="4"></svg><p>&lt;</p>`,
    );
  });

  it("closed HTML elements inside <foreignObject> leave the </svg> working", () => {
    expect(String(html`<svg><foreignObject><div><br><p>${"a"}</p></div></foreignObject></svg>${html`<script>a < b</script>`}`)).toBe(
      `<svg><foreignObject><div><br><p>a</p></div></foreignObject></svg><script>a < b</script>`,
    );
    expect(String(html`<math><mtext><span>x</span></mtext></math>${html`<script>a < b</script>`}`)).toBe(
      `<math><mtext><span>x</span></mtext></math><script>a < b</script>`,
    );
  });
});

describe("<plaintext> is also read as markup", () => {
  it("a fragment with <plaintext> nested in <svg> keeps its refusals", () =>
    refused(() => html`<svg width="200" height="40">${html`<plaintext><a href="${JS_URL}"><text y="20">open</text></a><img src="missing.png" ${"onerror=alert(1) x"}>`}</svg>`, "attribute-name"));

  it("a fragment with <plaintext> URL-checks its href", () => {
    expect(String(html`<plaintext><a href="${JS_URL}">x</a>`)).toBe(
      `<plaintext><a href="about:invalid">x</a>`,
    );
  });

  it("<select><plaintext> keeps refusals for parsers that ignore <plaintext> there", () => {
    refused(() => html`<select name="size"><plaintext></select><img src="x.png" ${"onerror=alert(1) x"}>`, "attribute-name");
    refused(() => html`<select><plaintext></select><script>${PAYLOAD}</script>`, "script-body");
    refused(() => html`<select name="size"><plaintext><script>${PAYLOAD}</script></select>`, "script-body");
    refused(() => html`<select><plaintext></select><a onclick="${PAYLOAD}">x</a>`, "event-handler");
    expect(String(html`<select><plaintext></select><a href="${JS_URL}">Help</a>`)).toBe(
      `<select><plaintext></select><a href="about:invalid">Help</a>`,
    );
  });

  it("text after <plaintext> still renders escaped", () => {
    expect(String(html`<plaintext>${"<b>"}`)).toBe("<plaintext>&lt;b&gt;");
  });
});

describe("the foreign-content flag is per render", () => {
  const card = (title: string) =>
    html`<script>const tpl = '<img src="';</script><p title="${title}">card</p>`;

  it("a value's toString calling html does not clear the outer flag", () => {
    class Badge {
      toString() {
        return String(html`<b>${"new"}</b>`);
      }
    }
    const outer = html`<g>${card(" onerror=document.title='XSS' a")}${new Badge()}</g>`;
    refused(() => html`<svg>${outer}</svg>`, "foreign-content");
  });

  it("a toString after the flagged fragment, then nested in <svg>", () => {
    const inner = html`<script>/*<a title="</script>"></a>*/${"window.__pwned=1"}</script>`;
    class Label {
      constructor(private t: string) {}
      toString() {
        return String(html`<span>${this.t}</span>`).replace(/<[^>]+>/g, "");
      }
    }
    const outer = html`<g>${inner}${new Label("Price")}</g>`;
    refused(() => html`<svg>${outer}</svg>`, "foreign-content");
  });

  it("an inner html call in toString does not inherit the outer flag either", () => {
    let innerValue: SafeHtml | undefined;
    class Probe {
      toString() {
        innerValue = html`<b>${"x"}</b>`;
        return "";
      }
    }
    html`<g>${html`<script>a < b</script>`}${new Probe()}</g>`;
    expect(String(html`<svg>${innerValue}</svg>`)).toBe("<svg><b>x</b></svg>");
  });
});

describe("text-only elements refuse markup at any array depth", () => {
  it.each([
    ["<textarea>", () => html`<textarea>${[[html`<b>x</b>`]]}</textarea>`],
    ["<title>", () => html`<title>${[["a", [html`<b>x</b>`]]]}</title>`],
  ])("%s", (_name, build) => refused(build, "markup-in-text-only"));

  it("nested arrays of strings still render", () => {
    expect(String(html`<title>${[["a", ["<b>"]]]}</title>`)).toBe("<title>a&lt;b&gt;</title>");
  });
});

describe("an html value nested in a raw-text element cannot end it early", () => {
  // Compiled on its own, the inner fragment's holes are in a title attribute
  // or in text. Nested in <xmp> (or another raw-text element), a </xmp inside
  // that attribute ends the element, so the browser reads the rest as markup
  // and those holes land in href or an event handler.
  const breakouts: Record<string, () => SafeHtml> = {
    xmp: () => html`<a title="</xmp><a href='${JS_URL}'>">x</a>`,
    iframe: () => html`<a title="</iframe><a href='${JS_URL}'>">x</a>`,
    noscript: () => html`<a title="</noscript><a href='${JS_URL}'>">x</a>`,
    noembed: () => html`<a title="</NoEmbed ><a href='${JS_URL}'>">x</a>`,
    noframes: () => html`<a title="</noframes/><a href='${JS_URL}'>">x</a>`,
  };
  const handlers: Record<string, () => SafeHtml> = {
    xmp: () => html`<p title="</xmp><img src=x onerror='">${'";alert(1)//'}'>`,
    iframe: () => html`<p title="</iframe><img src=x onerror='">${'";alert(1)//'}'>`,
    noscript: () => html`<p title="</noscript><img src=x onerror='">${'";alert(1)//'}'>`,
    noembed: () => html`<p title="</noembed><img src=x onerror='">${'";alert(1)//'}'>`,
    noframes: () => html`<p title="</noframes><img src=x onerror='">${'";alert(1)//'}'>`,
  };
  const breakout = (tag: string): SafeHtml => breakouts[tag]();
  const handler = (tag: string): SafeHtml => handlers[tag]();
  /** html`<tag>${value}</tag>`, one call site per tag so each is compiled once. */
  const sites = new Map<string, TemplateStringsArray>();
  const nest = (tag: string, value: unknown): SafeHtml => {
    let strings = sites.get(tag);
    if (strings === undefined) {
      const parts = [`<${tag}>`, `</${tag}>`];
      strings = Object.freeze(
        Object.assign([...parts], { raw: Object.freeze([...parts]) }),
      ) as unknown as TemplateStringsArray;
      sites.set(tag, strings);
    }
    return html(strings, value);
  };
  const tags = ["xmp", "iframe", "noscript", "noembed", "noframes"];

  it.each(tags)("<%s> with an href breakout, one value", (tag) => {
    const build = () => nest(tag, breakout(tag));
    safe(build);
    refused(build, "raw-text-end");
  });

  it.each(tags)("<%s> with an href breakout in an array", (tag) => {
    const build = () => nest(tag.toUpperCase(), ["a", [breakout(tag)]]);
    safe(build);
    refused(build, "raw-text-end");
  });

  it.each(tags)("<%s> with an event handler breakout", (tag) => {
    const build = () => nest(tag, handler(tag));
    safe(build);
    refused(build, "raw-text-end");
  });

  it.each(["</xmp>", "</xmp ", "</XMP/", "</xMp\t", "</xmp"])(
    "%j ends <xmp>",
    (end) => refused(() => html`<xmp>${raw(`a${end}`)}</xmp>`, "raw-text-end"),
  );

  it("text that only starts like the end tag is kept", () => {
    expect(String(html`<xmp>${raw("</xmpx></xm>")}</xmp>`)).toBe(
      "<xmp></xmpx></xm></xmp>",
    );
  });

  it("markup in <noscript> is still the scripting-off fallback", () => {
    expect(
      String(html`<noscript>${html`<img src="${"/a.png"}" alt="${"x"}">`}</noscript>`),
    ).toBe(`<noscript><img src="/a.png" alt="x"></noscript>`);
  });

  it("the error names the element and the hole", () => {
    expect(() => html`<xmp>${breakout("xmp")}</xmp>`).toThrow(
      /hole 1 .*<\/xmp/,
    );
  });
});
