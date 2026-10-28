/**
 * Prop values in sinks the browser runs (prompt 157 security audit): what
 * `injectPropAttributes`, `injectProps` and `mergeAttributesOntoRoot` keep,
 * refuse and rewrite, with the warning a page or script author sees. The
 * attacker's view of the same rules, at build and request time on both
 * hosts, is request-render-security.test.ts and the Cloudflare parity test.
 */
import { describe, expect, it, vi } from "vitest";
import { mergeAttributesOntoRoot } from "./component-inheritance.ts";
import {
  BLOCKED_URL,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";

const bind = (
  template: string,
  value: string,
): { html: string; warnings: string[] } => {
  const warnings: string[] = [];
  const html = injectPropAttributes(
    template,
    { u: value },
    undefined,
    (message) => warnings.push(message),
  );
  return { html, warnings };
};

describe("a prop bound to a URL attribute", () => {
  it.each([
    "https://example.com/a?b=c#d",
    "http://example.com",
    "HTTPS://EXAMPLE.COM",
    "mailto:someone@example.com",
    "tel:+15555550100",
    "/relative/path",
    "relative/path:with-colon",
    "./a:b",
    "//cdn.example.com/x.png",
    "#section",
    "?page=2",
    "",
    "sms:+15551234567",
    "webcal://example.com/cal.ics",
    "geo:37.78,-122.4",
    "about:blank",
    "ftp://example.com/file.txt",
    "myapp://open/item/42",
  ])("keeps %j", (url) => {
    const { html, warnings } = bind(`<a data-bascik-attr-href="u">x</a>`, url);
    expect(html).toBe(`<a href="${url.replace(/&/g, "&amp;")}">x</a>`);
    expect(warnings).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " \t\u0001javascript:alert(1)",
    "java\tscr\nipt:alert(1)",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "livescript:x",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;base64,AAAA",
    "\u0000data:text/html,x",
  ])("replaces %j with about:invalid and says so", (url) => {
    const { html, warnings } = bind(`<a data-bascik-attr-href="u">x</a>`, url);
    expect(html).toBe(`<a href="${BLOCKED_URL}">x</a>`);
    expect(warnings).toEqual([
      `data-bascik-attr-href="u" received a URL that can run script (a javascript:, vbscript: or data: URL), so href is set to about:invalid.`,
    ]);
  });

  it.each([
    ["img", "src", "data:image/webp;base64,UklGRg=="],
    ["img", "src", "data:image/png;base64,AAAA"],
    ["img", "src", "DATA:image/gif;base64,R0lGOD=="],
    ["img", "srcset", "data:image/png;base64,AAAA 1x, /b.png 2x"],
    ["source", "srcset", "data:image/avif;base64,AAAA"],
    ["img", "src", "data:image/svg+xml;base64,PHN2Zz4="],
    ["video", "poster", "data:image/jpeg;base64,/9j/"],
    ["input", "src", "data:image/png;base64,AAAA"],
  ])(
    "keeps an image data: URL on <%s %s>, which can only show a picture",
    (tag, target, url) => {
      const { html, warnings } = bind(
        `<${tag} data-bascik-attr-${target}="u">`,
        url,
      );
      expect(html).toBe(`<${tag} ${target}="${url}">`);
      expect(warnings).toEqual([]);
    },
  );

  it.each([
    ["img", "src", "data:text/html,<script>alert(1)</script>"],
    ["iframe", "src", "data:image/png;base64,AAAA"],
    ["a", "href", "data:image/png;base64,AAAA"],
    ["embed", "src", "data:image/png;base64,AAAA"],
  ])(
    "still refuses a data: URL on <%s %s> when it is not a raster image for an image slot (%j)",
    (tag, target, url) => {
      const { html } = bind(`<${tag} data-bascik-attr-${target}="u">`, url);
      expect(html).toBe(`<${tag} ${target}="${BLOCKED_URL}">`);
    },
  );

  it.each([
    ["img", "src"],
    ["iframe", "src"],
    ["frame", "src"],
    ["form", "action"],
    ["button", "formaction"],
    ["video", "poster"],
    ["object", "data"],
    ["a", "xlink:href"],
    ["blockquote", "cite"],
  ])("applies on <%s %s>", (tag, target) => {
    const { html } = bind(
      `<${tag} data-bascik-attr-${target}="u"></${tag}>`,
      "javascript:alert(1)",
    );
    expect(html).toBe(`<${tag} ${target}="${BLOCKED_URL}"></${tag}>`);
  });

  it("leaves a data attribute named `data` alone outside <object>", () => {
    const { html } = bind(
      `<my-el data-bascik-attr-data="u"></my-el>`,
      "data:x",
    );
    expect(html).toBe(`<my-el data="data:x"></my-el>`);
  });

  it("checks every srcset candidate: one script URL refuses the whole list", () => {
    expect(
      bind(
        `<img data-bascik-attr-srcset="u">`,
        "/a.png 1x, https://cdn.example.com/b.png 2x",
      ).html,
    ).toBe(`<img srcset="/a.png 1x, https://cdn.example.com/b.png 2x">`);
    expect(
      bind(`<img data-bascik-attr-srcset="u">`, "/a.png 1x, javascript:x 2x")
        .html,
    ).toBe(`<img srcset="${BLOCKED_URL}">`);
  });

  it("splits srcset the way the browser does: a comma inside a URL is part of it", () => {
    const imagekit =
      "https://ik.imagekit.io/demo/tr:w-300,h-300:rt-90/a.jpg 1x, https://ik.imagekit.io/demo/tr:w-600,h-600:rt-90/a.jpg 2x";
    expect(bind(`<img data-bascik-attr-srcset="u">`, imagekit)).toEqual({
      html: `<img srcset="${imagekit}">`,
      warnings: [],
    });
    expect(
      bind(`<img data-bascik-attr-srcset="u">`, "/a.png 1x,javascript:x 2x")
        .html,
    ).toBe(`<img srcset="${BLOCKED_URL}">`);
    // No space after the comma: one relative URL, as the browser reads it.
    expect(
      bind(`<img data-bascik-attr-srcset="u">`, "/a.png,javascript:x").html,
    ).toBe(`<img srcset="/a.png,javascript:x">`);
    expect(
      bind(
        `<img data-bascik-attr-srcset="u">`,
        "/a.png 100w, /b.png (max-width: 1px) 200w",
      ).html,
    ).toBe(`<img srcset="/a.png 100w, /b.png (max-width: 1px) 200w">`);
  });

  it("checks every ping URL (space separated)", () => {
    expect(
      bind(`<a data-bascik-attr-ping="u">x</a>`, "/p1 https://a.example/p2")
        .html,
    ).toBe(`<a ping="/p1 https://a.example/p2">x</a>`);
    expect(
      bind(`<a data-bascik-attr-ping="u">x</a>`, "/p1 javascript:x").html,
    ).toBe(`<a ping="${BLOCKED_URL}">x</a>`);
  });

  it("an entity-spelled scheme stays text the browser cannot run (decoded once, escaped once)", () => {
    const { html } = bind(
      `<a data-bascik-attr-href="u">x</a>`,
      "&#106;avascript:alert(1)",
    );
    expect(html).toBe(`<a href="&amp;#106;avascript:alert(1)">x</a>`);
  });
});

describe("a prop bound to a URL whose content runs or styles the page", () => {
  it.each([
    ["script", "src", ""],
    ["script", "href", ""],
    ["script", "xlink:href", ""],
    ["object", "data", ""],
    ["embed", "src", ""],
    ["base", "href", ""],
    ["link", "href", ` rel="stylesheet"`],
    ["link", "href", ` rel="modulepreload"`],
    ["link", "href", ` rel="import"`],
  ])("<%s %s%s> keeps a same-origin path", (tag, target, extra) => {
    for (const url of ["/js/app.js", "js/app.js", "./a.js?v=1", "#x", ""]) {
      const { html, warnings } = bind(
        `<${tag}${extra} data-bascik-attr-${target}="u">`,
        url,
      );
      expect(html).toBe(`<${tag}${extra} ${target}="${url}">`);
      expect(warnings).toEqual([]);
    }
  });

  it.each([
    ["script", "src", ""],
    ["script", "href", ""],
    ["object", "data", ""],
    ["embed", "src", ""],
    ["base", "href", ""],
    ["link", "href", ` rel="stylesheet"`],
    ["link", "href", ` rel="Preload  ModulePreload"`],
  ])("<%s %s%s> refuses another origin's URL", (tag, target, extra) => {
    for (const url of [
      "https://evil.example/x.js",
      "HTTP://evil.example/x.js",
      "//evil.example/x.js",
      " //evil.example/x.js",
      "/\\evil.example/x.js",
      "\\/evil.example/x.js",
      "\t/\t/evil.example/x.js",
      "javascript:alert(1)",
      "data:text/javascript,alert(1)",
    ]) {
      const { html, warnings } = bind(
        `<${tag}${extra} data-bascik-attr-${target}="u">`,
        url,
      );
      expect(html, url).toBe(`<${tag}${extra} ${target}="${BLOCKED_URL}">`);
      expect(warnings, url).toEqual([
        `data-bascik-attr-${target}="u" received a URL outside this site, and <${tag}> would run or apply what it loads, so ${target} is set to about:invalid. Bind a same-origin path, or write the URL in the template.`,
      ]);
    }
  });

  it("a rel or http-equiv another binding gives counts as written", () => {
    const warnings: string[] = [];
    expect(
      injectPropAttributes(
        `<link data-bascik-attr-rel="r" data-bascik-attr-href="u">`,
        { r: "stylesheet", u: "https://evil.example/x.css" },
        undefined,
        (message) => warnings.push(message),
      ),
    ).toBe(`<link rel="stylesheet" href="${BLOCKED_URL}">`);
    expect(warnings).toHaveLength(1);
  });

  it("a link that only points elsewhere (canonical, alternate, icon) keeps an absolute URL", () => {
    for (const rel of ["canonical", "alternate", "icon", "next"]) {
      expect(
        bind(
          `<link rel="${rel}" data-bascik-attr-href="u">`,
          "https://example.com/page",
        ).html,
      ).toBe(`<link rel="${rel}" href="https://example.com/page">`);
    }
  });

  it("an iframe may show another site's page (it runs in that site's origin)", () => {
    expect(
      bind(
        `<iframe data-bascik-attr-src="u"></iframe>`,
        "https://www.youtube-nocookie.com/embed/abc",
      ).html,
    ).toBe(
      `<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>`,
    );
  });
});

describe("a prop bound to an SVG animation value", () => {
  it.each(["set", "animate", "animateMotion", "animateTransform"])(
    "<%s> to, from, by and values get the URL rule, each ;-separated value checked",
    (tag) => {
      for (const target of ["to", "from", "by", "values"]) {
        const template = `<svg><a><${tag} attributeName="href" data-bascik-attr-${target}="u"/></a></svg>`;
        expect(bind(template, "javascript:alert(document.domain)").html).toBe(
          `<svg><a><${tag} attributeName="href" ${target}="${BLOCKED_URL}"/></a></svg>`,
        );
        expect(bind(template, "#a;java\tscript:alert(1)").html).toBe(
          `<svg><a><${tag} attributeName="href" ${target}="${BLOCKED_URL}"/></a></svg>`,
        );
        expect(bind(template, "#a;#b;/c").html).toBe(
          `<svg><a><${tag} attributeName="href" ${target}="#a;#b;/c"/></a></svg>`,
        );
      }
    },
  );

  it("numbers and colors still animate", () => {
    expect(
      bind(
        `<svg><rect><animate attributeName="x" data-bascik-attr-values="u"/></rect></svg>`,
        "0; 10; 0",
      ).html,
    ).toBe(
      `<svg><rect><animate attributeName="x" values="0; 10; 0"/></rect></svg>`,
    );
  });

  it("the animated attribute is never a prop's choice", () => {
    const { html, warnings } = bind(
      `<svg><a><set data-bascik-attr-attributeName="u" to="#x"/></a></svg>`,
      "href",
    );
    expect(html).toBe(`<svg><a><set to="#x"/></a></svg>`);
    expect(warnings).toEqual([
      `Ignoring data-bascik-attr-attributeName="u": a prop never chooses which attribute an SVG animation sets. Write attributeName in the template.`,
    ]);
  });

  it("a value animated into an event handler is never bound", () => {
    const { html, warnings } = bind(
      `<svg><a><set attributeName="onclick" data-bascik-attr-to="u"/></a></svg>`,
      "alert(1)",
    );
    expect(html).toBe(`<svg><a><set attributeName="onclick"/></a></svg>`);
    expect(warnings[0]).toMatch(
      /^Ignoring data-bascik-attr-to="u": an event handler/,
    );
  });
});

describe("a prop bound to a <meta http-equiv> value", () => {
  it.each([
    ["refresh", "content", "0;url=https://evil.example/"],
    ["refresh", "content", "5"],
    ["Content-Security-Policy", "content", "default-src *"],
  ])("<meta http-equiv=%j> refuses a %s binding", (equiv, target, value) => {
    const { html, warnings } = bind(
      `<meta http-equiv="${equiv}" data-bascik-attr-${target}="u">`,
      value,
    );
    expect(html).toBe(`<meta http-equiv="${equiv}">`);
    expect(warnings).toEqual([
      `Ignoring data-bascik-attr-${target}="u": a <meta http-equiv> value acts on the page (a redirect, a policy), so a prop is never bound to one.`,
    ]);
  });

  it("http-equiv itself is never bound", () => {
    const { html } = bind(
      `<meta content="0;url=/x" data-bascik-attr-http-equiv="u">`,
      "refresh",
    );
    expect(html).toBe(`<meta content="0;url=/x">`);
  });

  it("a <meta name> content binds", () => {
    expect(
      bind(`<meta name="description" data-bascik-attr-content="u">`, "Hi").html,
    ).toBe(`<meta name="description" content="Hi">`);
  });
});

describe("bindings that are never made", () => {
  it.each(["onclick", "onmouseover", "ONLOAD", "onerror"])(
    "data-bascik-attr-%s: the binding is dropped, an authored value is kept, and the author is told why",
    (target) => {
      const { html, warnings } = bind(
        `<button onclick="authored()" data-bascik-attr-${target}="u">x</button>`,
        "alert(1)",
      );
      expect(html).toBe(`<button onclick="authored()">x</button>`);
      expect(warnings).toEqual([
        `Ignoring data-bascik-attr-${target}="u": an event handler's value is code, so a prop is never bound to one. Bind a data-* attribute and read it from a component script.`,
      ]);
    },
  );

  it.each(["onboarding-step", "on-change", "on_x", "on1"])(
    "data-bascik-attr-%s binds: an event handler's name is on and letters only",
    (target) => {
      const { html, warnings } = bind(
        `<x-thing data-bascik-attr-${target}="u"></x-thing>`,
        "2",
      );
      expect(html).toBe(`<x-thing ${target}="2"></x-thing>`);
      expect(warnings).toEqual([]);
    },
  );

  it("data-bascik-attr-srcdoc: the frame gets no document from a prop", () => {
    const { html, warnings } = bind(
      `<iframe data-bascik-attr-srcdoc="u"></iframe>`,
      "<script>alert(1)</script>",
    );
    expect(html).toBe(`<iframe></iframe>`);
    expect(warnings).toEqual([
      `Ignoring data-bascik-attr-srcdoc="u": an srcdoc value is an HTML document that runs with the page's origin, so a prop is never bound to one. Bind src to a URL instead.`,
    ]);
  });

  it("a missing prop warns about nothing", () => {
    const warnings: string[] = [];
    expect(
      injectPropAttributes(
        `<button data-bascik-attr-onclick="u">x</button>`,
        {},
        undefined,
        (message) => warnings.push(message),
      ),
    ).toBe(`<button>x</button>`);
    expect(warnings).toEqual([]);
  });
});

describe("a prop bound to style", () => {
  it.each([
    "color: red",
    "--progress: 40%",
    "width: calc(100% - 2rem); background: rgb(0 0 0 / 50%)",
    "background-image: url(/img/hero.jpg)",
    "background-image: url('https://cdn.example.com/a.jpg')",
    'background: url("data:image/png;base64,AAAA") no-repeat',
    "background-image: image-set('/a.png' 1x, '/b.png' 2x)",
    "font-family: 'Noto \\5B8B', serif",
  ])("keeps %j", (style) => {
    const { html, warnings } = bind(
      `<p data-bascik-attr-style="u">x</p>`,
      style,
    );
    expect(html).toBe(
      `<p style="${style.replace(/"/g, "&quot;").replace(/'/g, "&#39;")}">x</p>`,
    );
    expect(warnings).toEqual([]);
  });

  it.each([
    "background: url(javascript:alert(1))",
    "background: URL( 'JavaScript:alert(1)' )",
    "background: url(data:text/html,x)",
    "background: url(java\tscript:x)",
    "background: u\\72l(\\6a avascript:x)",
    "background-image: image-set('javascript:x' 1x)",
    "background: -webkit-image-set(url(vbscript:x) 1x)",
    "@import 'x.css'",
    "@\\69mport 'x.css'",
    "width: expression(alert(1))",
    "width: ex\\70ression(alert(1))",
    "behavior: url(x.htc)",
    "-moz-binding: url(x.xml#a)",
  ])("refuses %j and keeps the authored style", (style) => {
    const { html, warnings } = bind(
      `<p style="color: blue" data-bascik-attr-style="u">x</p>`,
      style,
    );
    expect(html).toBe(`<p style="color: blue">x</p>`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Ignoring data-bascik-attr-style="u": the value runs script or imports CSS/,
    );
  });
});

describe("a prop receiver on a <script> or <style>", () => {
  it.each([
    [`<div><script data-bascik-prop-v>var a = 1;</script></div>`, "script"],
    [`<div><style data-bascik-prop-v>.a { color: red }</style></div>`, "style"],
    [`<svg><script data-bascik-prop-v>var a = 1;</script></svg>`, "script"],
  ])(
    "%s keeps its own text, loses its marker, and says how to pass data instead",
    (template, tag) => {
      const warn = vi.fn();
      const out = injectProps(template, { v: "alert(document.domain)" }, warn);
      expect(out).toBe(template.replace(" data-bascik-prop-v", ""));
      expect(warn).toHaveBeenCalledWith(
        `Ignoring data-bascik-prop-v on a <${tag}>: a prop is never written into script or style text. ` +
          `Bind it to a data-* attribute instead (data-bascik-attr-data-v="v") and read it from the element's dataset.`,
      );
    },
  );

  it("a receiver on any other raw-text element is still filled, escaped", () => {
    const warn = vi.fn();
    expect(
      injectProps(
        `<textarea data-bascik-prop-v>t</textarea><title data-bascik-prop-v>t</title>`,
        { v: "</textarea><b>" },
        warn,
      ),
    ).toBe(
      `<textarea>&lt;/textarea&gt;&lt;b&gt;</textarea><title>&lt;/textarea&gt;&lt;b&gt;</title>`,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("inherited attributes on the root", () => {
  it("a value with no quote is written byte for byte as before", () => {
    expect(
      mergeAttributesOntoRoot(`<div class='r' title="t">x</div>`, {
        class: "a &amp; b",
        "aria-label": "Close &lt;menu&gt;",
      }),
    ).toBe(
      `<div class='r a &amp; b' title="t" aria-label="Close &lt;menu&gt;">x</div>`,
    );
  });

  it("an apostrophe written into a double-quoted value stays as written", () => {
    expect(
      mergeAttributesOntoRoot(`<nav class="r">x</nav>`, {
        "aria-label": "Collin's menu",
        class: "Collin's",
        style: "content: 'x'",
      }),
    ).toBe(
      `<nav class="r Collin's" aria-label="Collin's menu" style="content: 'x'">x</nav>`,
    );
  });

  it("a double quote written into a single-quoted value stays as written", () => {
    expect(
      mergeAttributesOntoRoot(`<nav class='r' style='color: red'>x</nav>`, {
        class: `a"b`,
        style: `content: "x"`,
      }),
    ).toBe(`<nav class='r a"b' style='color: red; content: "x"'>x</nav>`);
  });

  it("a raw quote of either kind is encoded, whatever quote the root uses", () => {
    expect(
      mergeAttributesOntoRoot(`<div class='r' style='color: red'>x</div>`, {
        class: `x' onmouseover='alert(1)`,
        style: `x' onfocus='alert(1)`,
        title: `y" onmouseover="alert(1)`,
      }),
    ).toBe(
      `<div class='r x&#39; onmouseover=&#39;alert(1)' style='color: red; x&#39; onfocus=&#39;alert(1)' title="y&quot; onmouseover=&quot;alert(1)">x</div>`,
    );
  });
});
