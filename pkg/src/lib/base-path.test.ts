import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "./config-validation.ts";
import {
  composeSiteUrl,
  rewriteCssBasePaths,
  rewriteHtmlBasePaths,
  rewriteManifestBasePaths,
  rewriteSrcsetBasePaths,
  shouldRewriteBasePath,
} from "./base-path.ts";
import {
  expectLinearTime,
  LINEAR_TIME_TIMEOUT_MS,
  repeatTo,
} from "./linear-time.test-helper.ts";

describe("base path normalization", () => {
  it.each([
    ["/", "/"],
    ["/sub", "/sub/"],
    ["sub", "/sub/"],
    ["/sub/", "/sub/"],
    ["/a/b", "/a/b/"],
    ["", "/"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });
});

describe("composeSiteUrl", () => {
  it.each([
    ["https://bascik.dev", "/", "/about", "https://bascik.dev/about"],
    ["https://bascik.dev///", "/", "about", "https://bascik.dev/about"],
    [
      "https://bascik.dev/",
      "/docs/",
      "/about",
      "https://bascik.dev/docs/about",
    ],
  ])("composes %j + %j + %j", (siteUrl, base, pathname, expected) => {
    expect(composeSiteUrl(siteUrl, base, pathname)).toBe(expected);
  });

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

describe("shouldRewriteBasePath", () => {
  it.each([
    ["/x", true],
    ["//cdn.example.com/x.js", false],
    ["https://example.com/x", false],
    ["http://example.com/x", false],
    ["data:image/svg+xml;base64,PHN2Zy8+", false],
    ["blob:https://example.com/id", false],
    ["mailto:a@b.c", false],
    ["tel:+15551212", false],
    ["sms:+15551212", false],
    ["javascript:void(0)", false],
    ["#top", false],
    ["./x", false],
    ["../x", false],
    ["x", false],
    ["", false],
    ["/sub/x", false],
  ])("classifies %j", (value, expected) => {
    expect(shouldRewriteBasePath(value, "/sub/")).toBe(expected);
  });
});

describe("rewriteSrcsetBasePaths", () => {
  it.each([
    ["/image.png", "/sub/image.png"],
    [
      "/small.png 320w, /large.png 1280w",
      "/sub/small.png 320w, /sub/large.png 1280w",
    ],
    ["/one.png 1x, /two.png 2x", "/sub/one.png 1x, /sub/two.png 2x"],
    [
      "https://cdn.example.com/x.png 1x, /x.png 2x",
      "https://cdn.example.com/x.png 1x, /sub/x.png 2x",
    ],
    [
      "data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, /x.png 2x",
      "data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, /sub/x.png 2x",
    ],
    [" /one.png 1x ,  /two.png 2x,", " /sub/one.png 1x ,  /sub/two.png 2x,"],
  ])("rewrites %j", (input, expected) => {
    expect(rewriteSrcsetBasePaths(input, "/sub/")).toBe(expected);
  });
});

describe("rewriteHtmlBasePaths", () => {
  it("is byte-identical for the root base", () => {
    const html = `<a href="/about">A</a><style>.x { background: url('/x.png') }</style>`;
    expect(rewriteHtmlBasePaths(html, "/")).toBe(html);
  });

  it("rewrites URL-bearing attributes and known social metadata", () => {
    const html = [
      `<a href="/about">About</a>`,
      `<img src='/logo.png' srcset="/small.png 1x, /large.png 2x">`,
      `<link rel="preload" href="/font.woff2" imagesrcset="/small.png 320w, /large.png 1280w">`,
      `<video poster="/poster.jpg"></video>`,
      `<object data="/movie.swf"></object>`,
      `<button formaction="/save">Save</button>`,
      `<form action="/submit"></form>`,
      `<meta property="og:image" content="/share.png">`,
      `<meta property="og:url" content="/about">`,
      `<meta name="twitter:image" content="/twitter.png">`,
      `<meta name="description" content="/not-a-url">`,
      `<div style="background: url(/inline.png)"></div>`,
      `<style>@import '/theme.css'; .x { background: image-set(url('/one.png') 1x, '/two.png' 2x) }</style>`,
    ].join("");

    const result = rewriteHtmlBasePaths(html, "/sub/");
    expect(result).toContain(`href="/sub/about"`);
    expect(result).toContain(`src='/sub/logo.png'`);
    expect(result).toContain(`srcset="/sub/small.png 1x, /sub/large.png 2x"`);
    expect(result).toContain(
      `imagesrcset="/sub/small.png 320w, /sub/large.png 1280w"`,
    );
    expect(result).toContain(`poster="/sub/poster.jpg"`);
    expect(result).toContain(`data="/sub/movie.swf"`);
    expect(result).toContain(`formaction="/sub/save"`);
    expect(result).toContain(`action="/sub/submit"`);
    expect(result).toContain(`content="/sub/share.png"`);
    expect(result).toContain(`content="/sub/twitter.png"`);
    expect(result).toContain(`name="description" content="/not-a-url"`);
    expect(result).toContain(`url(/sub/inline.png)`);
    expect(result).toContain(`@import '/sub/theme.css'`);
    expect(result).toContain(`url('/sub/one.png')`);
    expect(result).toContain(`'/sub/two.png' 2x`);
  });

  it("leaves fragments for ID-reference rewriting and transforms paths once", () => {
    const html = `<a href="#local-id">Local</a><a href="/about">About</a>`;
    const once = rewriteHtmlBasePaths(html, "/sub/");
    expect(once).toBe(
      `<a href="#local-id">Local</a><a href="/sub/about">About</a>`,
    );
    expect(rewriteHtmlBasePaths(once, "/sub/")).toBe(once);
  });

  it("rewrites active tags without changing markup-like text", () => {
    const html = [
      `<!-- <img src="/comment.png"> -->`,
      `<script>const template = '<img src="/script.png">';</script>`,
      `<textarea><img src="/textarea.png"></textarea>`,
      `<img alt="greater > than" src="/active.png">`,
      `<div data-example="click href='/keep-literal'"><a href="/real">Real</a></div>`,
      `<img src=/unquoted.png/>`,
    ].join("");

    expect(rewriteHtmlBasePaths(html, "/sub/")).toBe(
      [
        `<!-- <img src="/comment.png"> -->`,
        `<script>const template = '<img src="/script.png">';</script>`,
        `<textarea><img src="/textarea.png"></textarea>`,
        `<img alt="greater > than" src="/sub/active.png">`,
        `<div data-example="click href='/keep-literal'"><a href="/sub/real">Real</a></div>`,
        `<img src=/sub/unquoted.png/>`,
      ].join(""),
    );
  });

  it("Does not corrupt quoted attribute strings containing URL-like attribute text with spaces", () => {
    const html = [
      `<div data-example="click href = '/keep-literal'"><a href = /real/>Real</a></div>`,
      `<meta content=/share.png property=og:image/>`,
    ].join("");
    expect(rewriteHtmlBasePaths(html, "/sub/")).toBe(
      [
        `<div data-example="click href = '/keep-literal'"><a href=/sub/real/>Real</a></div>`,
        `<meta content=/sub/share.png property=og:image/>`,
      ].join(""),
    );
  });

  it("rewrites URL attributes after a quoted value ending in a backslash", () => {
    const html = String.raw`<img alt="C:\" src="/logo.png">`;
    expect(rewriteHtmlBasePaths(html, "/sub/")).toBe(
      String.raw`<img alt="C:\" src="/sub/logo.png">`,
    );
  });
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

  it("ends a stylesheet at </style> with attributes or a slash, as before", () => {
    for (const close of ["</style>", "</style/>", "</style x>", "</STYLE\n>"]) {
      const html = `<style>a{background:url(/a.png)}${close}<img src="/b.png">`;
      expect(rewriteHtmlBasePaths(html, "/sub/"), close).toBe(
        `<style>a{background:url(/sub/a.png)}${close}<img src="/sub/b.png">`,
      );
    }
  });

  it("still rewrites a complete tag and stylesheet after a long run of unclosed openers", () => {
    const run = repeatTo("<style '", SIZE).slice(0, 50_000);
    const html = `<p>${run.replaceAll("'", "")}</p><style>a{background:url(/i.png)}</style><img src="/i.png">`;
    expect(rewriteHtmlBasePaths(html, "/sub/")).toBe(
      html
        .replace("url(/i.png)", "url(/sub/i.png)")
        .replace('src="/i.png"', 'src="/sub/i.png"'),
    );
  });
});

describe("rewriteCssBasePaths", () => {
  it("rewrites url, import, and image-set strings", () => {
    const css = `@import "/theme.css"; a{background:url(/a.png)} b{background-image:image-set('/b.png' 1x, url("/c.png") 2x)}`;
    expect(rewriteCssBasePaths(css, "/sub/")).toBe(
      `@import "/sub/theme.css"; a{background:url(/sub/a.png)} b{background-image:image-set('/sub/b.png' 1x, url("/sub/c.png") 2x)}`,
    );
  });

  it("rewrites quoted URLs containing whitespace", () => {
    const css = `a{background:url("/hero image.png")}b{background:url('/second image.png')}`;
    expect(rewriteCssBasePaths(css, "/sub/")).toBe(
      `a{background:url("/sub/hero image.png")}b{background:url('/sub/second image.png')}`,
    );
  });

  it("leaves excluded CSS values byte-identical", () => {
    const css = `a{mask:url(#icon);background:url(data:image/svg+xml,%3Csvg/%3E)}b{background:url(https://cdn.example.com/x.png)}c{background:url(../x.png)}`;
    expect(rewriteCssBasePaths(css, "/sub/")).toBe(css);
    expect(rewriteCssBasePaths(css, "/")).toBe(css);
  });

  it("is idempotent and preserves replacement tokens", () => {
    const css = `a{background:url('/$&/$1/%24.png')}`;
    const once = rewriteCssBasePaths(css, "/sub/");
    expect(once).toBe(`a{background:url('/sub/$&/$1/%24.png')}`);
    expect(rewriteCssBasePaths(once, "/sub/")).toBe(once);
  });
});

describe("rewriteManifestBasePaths", () => {
  it("rewrites start_url, scope, and icon sources", () => {
    const manifest = JSON.stringify({
      name: "App",
      start_url: "/",
      scope: "/app/",
      icons: [
        { src: "/icon.png" },
        { src: "https://cdn.example.com/icon.png" },
      ],
    });
    expect(JSON.parse(rewriteManifestBasePaths(manifest, "/sub/"))).toEqual({
      name: "App",
      start_url: "/sub/",
      scope: "/sub/app/",
      icons: [
        { src: "/sub/icon.png" },
        { src: "https://cdn.example.com/icon.png" },
      ],
    });
  });

  it("warns and preserves malformed manifests", () => {
    const malformed = `{ "start_url": "/"`;
    expect(rewriteManifestBasePaths(malformed, "/sub/")).toBe(malformed);
  });
});
