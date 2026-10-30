/**
 * Prop values in sinks the browser runs (prompt 157 security audit): what
 * `injectPropAttributes`, `injectProps` and `mergeAttributesOntoRoot` keep,
 * refuse and rewrite, with the warning a page or script author sees. The
 * attacker's view of the same rules, at build and request time on both
 * hosts, is request-render-security.test.ts and the Cloudflare parity test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeAttributesOntoRoot } from "./component-inheritance.ts";
import {
  BLOCKED_URL,
  injectPropAttributes,
  injectProps,
} from "./component-props.ts";
import { html as htmlTag } from "./html-template.ts";

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
    // A data: URL is named as one; every other scheme is a script URL.
    const what = /data:/i.test(url)
      ? "a data: URL"
      : "a script URL such as javascript:";
    expect(warnings).toEqual([
      `data-bascik-attr-href="u" received ${what}, so href is set to about:invalid.`,
    ]);
  });

  it("names a data: URL as the reason only when no entry is a script URL", () => {
    const srcset = (value: string) =>
      bind(`<img data-bascik-attr-srcset="u">`, value).warnings;
    expect(srcset("data:text/html,x 1x, /b.png 2x")).toEqual([
      `data-bascik-attr-srcset="u" received a data: URL, so srcset is set to about:invalid.`,
    ]);
    expect(srcset("data:text/html,x 1x, javascript:x 2x")).toEqual([
      `data-bascik-attr-srcset="u" received a script URL such as javascript:, so srcset is set to about:invalid.`,
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
  // Collin 2026-10-28: nothing extra by default. A URL the page runs or
  // applies takes any http(s) URL, third-party included, as the browser
  // does; the script-scheme block still holds, so correctly escaped data
  // never becomes code. CSP script-src/style-src and safeUrl(value,
  // { origins }) are the opt-in protections (docs /security).
  const RUNS_OR_APPLIES: [string, string, string][] = [
    ["script", "src", ""],
    ["script", "href", ""],
    ["script", "xlink:href", ""],
    ["object", "data", ""],
    ["embed", "src", ""],
    ["base", "href", ""],
    ["link", "href", ` rel="stylesheet"`],
    ["link", "href", ` rel="modulepreload"`],
    ["link", "href", ` rel="Preload  ModulePreload"`],
    ["link", "href", ` rel="prefetch"`],
    ["link", "href", ` rel="import"`],
  ];

  it.each(RUNS_OR_APPLIES)(
    "<%s %s%s> keeps a same-origin path",
    (tag, target, extra) => {
      for (const url of ["/js/app.js", "js/app.js", "./a.js?v=1", "#x", ""]) {
        const { html, warnings } = bind(
          `<${tag}${extra} data-bascik-attr-${target}="u">`,
          url,
        );
        expect(html).toBe(`<${tag}${extra} ${target}="${url}">`);
        expect(warnings).toEqual([]);
      }
    },
  );

  it.each(RUNS_OR_APPLIES)(
    "<%s %s%s> keeps a third-party https URL, as the browser allows, with no warning",
    (tag, target, extra) => {
      for (const url of [
        "https://cdn.example.net/x.js",
        "HTTP://cdn.example.net/x.js",
        "//cdn.example.net/x.js",
      ]) {
        const { html, warnings } = bind(
          `<${tag}${extra} data-bascik-attr-${target}="u">`,
          url,
        );
        expect(html, url).toBe(`<${tag}${extra} ${target}="${url}">`);
        expect(warnings, url).toEqual([]);
      }
    },
  );

  it.each(RUNS_OR_APPLIES)(
    "<%s %s%s> still blocks javascript:, vbscript:, livescript:, mocha: and non-image data:",
    (tag, target, extra) => {
      for (const url of [
        "javascript:alert(1)",
        " \u0001JaVa\tScript:alert(1)",
        "vbscript:msgbox(1)",
        "livescript:x",
        "mocha:x",
        "data:text/javascript,alert(1)",
        "data:image/svg+xml,<svg onload=alert(1)>",
      ]) {
        const { html, warnings } = bind(
          `<${tag}${extra} data-bascik-attr-${target}="u">`,
          url,
        );
        expect(html, url).toBe(`<${tag}${extra} ${target}="${BLOCKED_URL}">`);
        expect(warnings, url).toHaveLength(1);
        expect(warnings[0], url).toContain(
          url.startsWith("data:")
            ? "received a data: URL"
            : "received a script URL such as javascript:",
        );
        expect(warnings[0], url).not.toContain("outside this site");
      }
    },
  );

  it("a rel another binding gives does not change what href may hold", () => {
    const warnings: string[] = [];
    expect(
      injectPropAttributes(
        `<link data-bascik-attr-rel="r" data-bascik-attr-href="u">`,
        { r: "stylesheet", u: "https://cdn.example.net/x.css" },
        undefined,
        (message) => warnings.push(message),
      ),
    ).toBe(`<link rel="stylesheet" href="https://cdn.example.net/x.css">`);
    expect(warnings).toEqual([]);
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
    "scroll-behavior: smooth",
    "overscroll-behavior: contain; max-height: 20rem",
    "overscroll-behavior-y: none",
    "--caption: 'Data: Q3 sales'",
    '--note: "data: not a URL"',
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
    "color: red;behavior: url(x.htc)",
    "color: red; BEHAVIOR : url(x.htc)",
    "/**/behavior: url(x.htc)",
    "*behavior: url(x.htc)",
    "-ms-behavior: url(x.htc)",
    "\\62 ehavior: url(x.htc)",
    "-moz-binding: url(x.xml#a)",
    "background-image: image-set('data:text/html,x' 1x)",
    "background-image: -webkit-image-set(\"data:text/html,x\" 1x, 'b.png' 2x)",
    "background-image: image-set('a.png' 1x, \"data:text/html,x\" 2x)",
    "--x: 'safe'; background-image: url('data:text/html,x')",
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

describe("an inherited attribute that is a URL only on the root's real tag gets the URL check", () => {
  const inherit = (
    root: string,
    attrs: Record<string, string>,
    usageTag?: string,
  ): { html: string; warnings: string[] } => {
    const warnings: string[] = [];
    const html = mergeAttributesOntoRoot(
      root,
      attrs,
      (message) => warnings.push(message),
      usageTag,
    );
    return { html, warnings };
  };

  it.each([
    [
      `<object class="r"></object>`,
      "data",
      "data:text/html,<script>x</script>",
      "object",
    ],
    [`<object class="r"></object>`, "data", "javascript:alert(1)", "object"],
    [`<OBJECT class="r"></OBJECT>`, "DATA", " java\tscript:x", "object"],
    [`<object class="r"></object>`, "data", "&#106;avascript:x", "object"],
    [`<object class="r"></object>`, "data", "javascript&colon;x", "object"],
    [`<object class="r"></object>`, "data", "java&Tab;script:x", "object"],
    [`<object class="r"></object>`, "data", "&#x6a;avascript:x", "object"],
    [`<object class="r"></object>`, "data", "&#106avascript:x", "object"],
    [
      `<object class="r"></object>`,
      "data",
      "&#100;ata:text/html,&lt;script&gt;x&lt;/script&gt;",
      "object",
    ],
    [`<set attributeName="href">`, "to", "javascript:alert(1)", "set"],
    [`<animate attributeName="href">`, "values", "/a;javascript:x", "animate"],
    [`<animate attributeName="href">`, "from", "vbscript:x", "animate"],
    [`<set attributeName="href">`, "by", "data:text/html,x", "set"],
  ])("%s %s=%j becomes about:invalid and says so", (root, attr, value, tag) => {
    const { html, warnings } = inherit(root, { [attr]: value }, "x-embed");
    expect(html).toContain(` ${attr}="${BLOCKED_URL}"`);
    expect(html).not.toContain(value);
    const what = /^(&#100;|d)ata/i.test(value)
      ? "a data: URL"
      : "a script URL such as javascript:";
    expect(warnings).toEqual([
      `inherited attribute ${attr} received ${what}, so ${attr} on the root <${tag}> is set to about:invalid.`,
    ]);
  });

  it.each([
    [`<a class="r">x</a>`, { href: "javascript:void(0)" }],
    [`<a class="r">x</a>`, { href: "&#106;avascript:alert(1)" }],
    [`<a class="r">x</a>`, { "xlink:href": "javascript:alert(1)" }],
    [`<iframe class="r"></iframe>`, { src: "javascript:alert(1)" }],
    [
      `<iframe class="r"></iframe>`,
      { srcdoc: "&lt;script&gt;alert(1)&lt;/script&gt;" },
    ],
    [`<embed class="r">`, { src: "vbscript:x" }],
    [`<form class="r"></form>`, { action: "javascript:submit()" }],
    [`<button class="r">x</button>`, { formaction: "javascript:x" }],
    [`<img class="r">`, { srcset: "/a.png 1x, javascript:x 2x" }],
    [`<a class="r">x</a>`, { ping: "/ok javascript:x" }],
    [`<button class="btn">go</button>`, { onclick: "go()" }],
    [`<div class="r">x</div>`, { onload: "init()", ONMOUSEOVER: "hover()" }],
    [`<svg class="r"></svg>`, { onclick: "alert(1)" }],
    [`<div class="r">x</div>`, { style: "background:url(javascript:x)" }],
    [`<div class="r">x</div>`, { style: "width:expression(alert(1))" }],
    [`<div class="r">x</div>`, { style: "@import 'https://x.example/x.css'" }],
    [`<set class="r">`, { attributeName: "href" }],
    [`<div class="r">x</div>`, { "http-equiv": "refresh", content: "0" }],
    [`<span class="dot"></span>`, { online: "", one: "1", onboarding: "" }],
    [`<div class="r">x</div>`, { data: "javascript:not-a-url-on-a-div" }],
  ])("%s inherits %j exactly as written, without a warning", (root, attrs) => {
    const { html, warnings } = inherit(root, attrs, "x-thing");
    for (const [name, value] of Object.entries(attrs))
      expect(html).toContain(` ${name}="${value}"`);
    expect(warnings).toEqual([]);
  });

  it("a style merged into the root's own style is inherited as written", () => {
    expect(
      inherit(`<div style="color: red">x</div>`, {
        style: "background:url(javascript:x)",
      }),
    ).toEqual({
      html: `<div style="color: red; background:url(javascript:x)">x</div>`,
      warnings: [],
    });
  });

  it("an <img src> root keeps a data:image URL", () => {
    const { html, warnings } = inherit(`<img class="r">`, {
      src: "data:image/png;base64,AAAA",
    });
    expect(html).toBe(`<img class="r" src="data:image/png;base64,AAAA">`);
    expect(warnings).toEqual([]);
  });

  // <object data> is not an image slot, so every data: URL is refused there,
  // data:image/... included, the same as html`<object data="${v}">`.
  it.each([
    "data:image/png;base64,iVBOR",
    "data:image/svg+xml,%3Csvg/%3E",
    "data:application/pdf;base64,AA",
  ])("an <object> root refuses data=%j, as html`` does", (value) => {
    const { html, warnings } = inherit(
      `<object type="x"></object>`,
      { data: value },
      "x-embed",
    );
    expect(html).toBe(`<object type="x" data="${BLOCKED_URL}"></object>`);
    expect(warnings).toHaveLength(1);
    expect(String(htmlTag`<object data="${value}"></object>`)).toBe(
      `<object data="${BLOCKED_URL}"></object>`,
    );
  });

  it("attribute-inheritance.md does not promise a data:image URL survives on an <object> root", () => {
    const doc = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../docs/content/attribute-inheritance.md",
      ),
      "utf8",
    );
    const sentence = doc
      .split("\n")
      .find((line) => line.includes("`data` on an `<object>` root"));
    expect(sentence).toBeDefined();
    expect(sentence).not.toContain("non-image `data:`");
    expect(sentence).toContain("`data:image/...` included");
  });

  it("an attribute the root already has is kept as the template wrote it, and is not judged", () => {
    for (const [root, attrs] of [
      [`<a class="r" href="/home">x</a>`, { href: "javascript:alert(1)" }],
      [`<object data="/a.pdf"></object>`, { data: "javascript:alert(1)" }],
    ] as const) {
      const { html, warnings } = inherit(root, attrs);
      expect(html).toBe(root);
      expect(warnings).toEqual([]);
    }
  });

  it.each([
    [`<a class="r">x</a>`, { href: "https://example.com/?a=1&amp;b=2" }],
    [`<a class="r">x</a>`, { href: "/relative", "aria-label": "Go", id: "x" }],
    [`<div class="r">x</div>`, { title: "javascript:alert(1)", role: "note" }],
    [
      `<object class="r"></object>`,
      { data: "files/a.pdf", type: "application/pdf" },
    ],
    [`<object class="r"></object>`, { data: "https://example.com/a.pdf" }],
    [`<set attributeName="fill">`, { to: "red", values: "red;blue" }],
  ])("%s keeps safe values %j as written, without a warning", (root, attrs) => {
    const { html, warnings } = inherit(root, attrs);
    for (const [name, value] of Object.entries(attrs))
      expect(html).toContain(`${name}="${value}"`);
    expect(warnings).toEqual([]);
  });
});

describe("a class or style merged onto the root changes only the root's own class or style", () => {
  const inherit = (
    root: string,
    attrs: Record<string, string>,
  ): { html: string; warnings: string[] } => {
    const warnings: string[] = [];
    const html = mergeAttributesOntoRoot(root, attrs, (message) =>
      warnings.push(message),
    );
    return { html, warnings };
  };
  /** Attribute names of the first tag, as the HTML tokenizer reads them. */
  const attrNames = (html: string): string[] => {
    const open = /^<[a-z]+((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(html)![1];
    return [
      ...open.matchAll(
        /\s([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
      ),
    ].map((match) => match[1].toLowerCase());
  };

  it.each([
    [
      "class, unquoted inside an earlier value",
      `<span>badge</span>`,
      {
        title: " class=x onfocus=alert(document.domain) autofocus tabindex=1 ",
        class: "big",
      },
      ["title", "class"],
    ],
    [
      "style, unquoted inside an earlier value",
      `<button class="b">go</button>`,
      {
        "aria-label":
          " style=x onfocus=document.title=document.domain autofocus ",
        style: "color:red",
      },
      ["class", "aria-label", "style"],
    ],
    [
      "class, single-quoted inside an earlier value",
      `<span>badge</span>`,
      { title: " class='x' onfocus=alert(1) autofocus ", class: "big" },
      ["title", "class"],
    ],
    [
      "style, single-quoted inside an earlier value",
      `<span>badge</span>`,
      { title: " style='x' onfocus=alert(1) autofocus ", style: "color:red" },
      ["title", "style"],
    ],
    [
      "class, double-quoted inside a single-quoted earlier value",
      `<span>badge</span>`,
      { title: ` class="x" onfocus=alert(1) autofocus `, class: "big" },
      ["title", "class"],
    ],
  ])("%s never ends the earlier value", (_label, root, attrs, names) => {
    const { html, warnings } = inherit(root, attrs);
    expect(attrNames(html)).toEqual(names);
    expect(warnings).toEqual([]);
  });

  it("the earlier value round-trips, and class and style land once on the root", () => {
    const title = " class=x onfocus=alert(1) style=y ";
    const { html } = inherit(`<span>badge</span>`, {
      title,
      class: "big",
      style: "color:red",
    });
    expect(html).toBe(
      `<span title="${title}" class="big" style="color:red">badge</span>`,
    );
  });

  it("a root that has a class or style merges into it, wherever it sits and however it is quoted", () => {
    expect(
      inherit(`<div title="class=q" class=r style='color: blue'>x</div>`, {
        "aria-label": " class=z style=z ",
        class: "big",
        style: "margin: 0",
      }).html,
    ).toBe(
      `<div title="class=q" class="r big" style='color: blue; margin: 0' aria-label=" class=z style=z ">x</div>`,
    );
  });

  it("a root attribute the tokenizer reads as one whole value (an @-named one spelling class=) is not taken for the class", () => {
    expect(
      inherit(`<div @click="a class=b" class="r">x</div>`, { class: "big" })
        .html,
    ).toBe(`<div @click="a class=b" class="r big">x</div>`);
    expect(
      inherit(`<div @click="a class=b">x</div>`, { class: "big" }).html,
    ).toBe(`<div @click="a class=b" class="big">x</div>`);
  });

  it("a root whose own title spells class= keeps it as written", () => {
    expect(
      inherit(`<div title=" class=q ">x</div>`, { class: "big" }).html,
    ).toBe(`<div title=" class=q " class="big">x</div>`);
  });
});

describe("a binding appended to a tag that already holds a bound value", () => {
  const two = (template: string, props: Record<string, string>): string =>
    injectPropAttributes(template, props, undefined, () => {});

  it("goes before the tag's closing whitespace, / and >", () => {
    expect(
      two(`<p data-bascik-attr-title="a" data-bascik-attr-lang="b">x</p>`, {
        a: "a   a",
        b: "en",
      }),
    ).toBe(`<p title="a   a" lang="en">x</p>`);
    expect(
      two(`<img data-bascik-attr-alt="a" data-bascik-attr-title="a" \n />`, {
        a: "x\n\ny",
      }),
    ).toBe(`<img alt="x\n\ny" title="x\n\ny" \n />`);
  });
});
