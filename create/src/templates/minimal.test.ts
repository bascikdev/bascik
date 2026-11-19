import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  DEFAULT_TEMPLATE,
  PACKAGE_JSON,
  SITE_META_HTML,
  SITE_META_TEST,
  type TemplateContext,
} from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import {
  MINIMAL_E2E_APP_SPEC,
  MINIMAL_STYLES_CSS,
  MINIMAL_TEMPLATE,
  escapeHtml,
  minimalIndexPage,
  minimalNotFoundPage,
} from "./minimal.js";

const filesOf = (context: TemplateContext): Map<string, string | Buffer> =>
  new Map(MINIMAL_TEMPLATE.files(context));

const textOf = (context: TemplateContext, path: string): string => {
  const data = filesOf(context).get(path);
  if (typeof data !== "string") throw new Error(`${path} is not a text file`);
  return data;
};

/** Every `<tag` a page opens, so a test can say which elements exist without depending on formatting. */
const tagsIn = (html: string): string[] =>
  [...html.matchAll(/<([a-z][a-z0-9-]*)[\s/>]/g)].map((match) => match[1]);

/** The text between a page's first `<tag ...>` and its `</tag>`. */
const contentOf = (html: string, tag: string): string => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(
    html,
  );
  if (!match) throw new Error(`no <${tag}> in the page`);
  return match[1];
};

describe("minimal template", () => {
  it("is registered after the default and found by name without case", () => {
    expect(TEMPLATES).toContain(MINIMAL_TEMPLATE);
    expect(TEMPLATES[0]).toBe(DEFAULT_TEMPLATE);
    expect(templateNamed("minimal")).toBe(MINIMAL_TEMPLATE);
    expect(templateNamed("MINIMAL")).toBe(MINIMAL_TEMPLATE);
    expect(templateNamed("minimum")).toBeUndefined();
  });

  it("writes one page, a 404 page, one stylesheet, the head component and one spec, and nothing else", () => {
    expect([...filesOf({ siteName: "my-site" }).keys()].sort()).toEqual([
      "e2e/app.spec.ts",
      "src/components/site-meta/site-meta.html",
      "src/components/site-meta/site-meta.test.ts",
      "src/pages/404.html",
      "src/pages/css/styles.css",
      "src/pages/index.html",
    ]);
    expect(MINIMAL_TEMPLATE.directories({ siteName: "my-site" })).toEqual([
      "src/pages/css",
      "src/components/site-meta",
    ]);
  });

  it.each(ADAPTERS)(
    "writes the same files with the %s adapter as with none",
    (adapter) => {
      expect(MINIMAL_TEMPLATE.files({ siteName: "my-site", adapter })).toEqual(
        MINIMAL_TEMPLATE.files({ siteName: "my-site" }),
      );
      expect(
        MINIMAL_TEMPLATE.directories({ siteName: "my-site", adapter }),
      ).toEqual(MINIMAL_TEMPLATE.directories({ siteName: "my-site" }));
    },
  );

  it("adds no packages to the project", () => {
    expect(MINIMAL_TEMPLATE.dependencies).toBeUndefined();
    expect(MINIMAL_TEMPLATE.devDependencies).toBeUndefined();
    expect(PACKAGE_JSON("my-site", undefined, MINIMAL_TEMPLATE)).toBe(
      PACKAGE_JSON("my-site"),
    );
  });

  it("reuses the default template's head component and its test, unchanged", () => {
    const context = { siteName: "my-site" };
    expect(textOf(context, "src/components/site-meta/site-meta.html")).toBe(
      SITE_META_HTML,
    );
    expect(textOf(context, "src/components/site-meta/site-meta.test.ts")).toBe(
      SITE_META_TEST,
    );
    // The head component links the stylesheet this template writes.
    expect(SITE_META_HTML).toContain('href="/css/styles.css"');
    expect(filesOf(context).has("src/pages/css/styles.css")).toBe(true);
  });
});

describe("minimal pages", () => {
  const pages = [
    ["index.html", minimalIndexPage("my-site"), "home-main"],
    ["404.html", minimalNotFoundPage("my-site"), "404-main"],
  ] as const;

  it.each(pages)(
    "%s is a whole document with a language, the head component, a title, one <main id=main> and one <h1>",
    (_name, html, testId) => {
      expect(html).toMatch(/^<!doctype html>\n<html lang="en">/i);
      expect(html.trimEnd()).toMatch(/<\/html>$/);
      const tags = tagsIn(html);
      for (const once of ["html", "head", "title", "body", "main", "h1"])
        expect(
          tags.filter((tag) => tag === once),
          once,
        ).toHaveLength(1);
      expect(contentOf(html, "head")).toContain("<site-meta />");
      expect(html).toMatch(
        new RegExp(`<main\\s+id="main"\\s+data-testid="${testId}"\\s*>`),
      );
      expect(contentOf(html, "main")).toContain("<h1>");
    },
  );

  it.each(pages)(
    "%s uses only the head component: no header, footer, nav, script, form or generic wrapper",
    (_name, html) => {
      const tags = tagsIn(html);
      for (const absent of [
        "header",
        "footer",
        "nav",
        "script",
        "style",
        "form",
        "button",
        "div",
        "span",
        "section",
      ])
        expect(tags, absent).not.toContain(absent);
      expect(tags.filter((tag) => tag.includes("-"))).toEqual(["site-meta"]);
    },
  );

  it("names the site in the home page's title and heading and tells the reader which file to edit", () => {
    const html = minimalIndexPage("book-club");
    expect(contentOf(html, "title")).toBe("book-club");
    expect(contentOf(html, "h1")).toBe("book-club");
    expect(contentOf(html, "main")).toContain(
      "<code>src/pages/index.html</code>",
    );
  });

  it("gives the 404 page its own title and a link home with a test id", () => {
    const html = minimalNotFoundPage("book-club");
    expect(contentOf(html, "title")).toBe("Page not found - book-club");
    expect(contentOf(html, "h1")).toBe("Page not found");
    expect(html).toMatch(/<a\s+href="\/"\s+data-testid="404-home-link"\s*>/);
  });

  it("puts the scaffold's site name, not a fixed one, on both pages", () => {
    const context = { siteName: "reading-list" };
    expect(textOf(context, "src/pages/index.html")).toBe(
      minimalIndexPage("reading-list"),
    );
    expect(textOf(context, "src/pages/404.html")).toBe(
      minimalNotFoundPage("reading-list"),
    );
  });
});

// The CLI refuses these names, but scaffold() and the template can be called with any string.
describe("minimal pages with a site name that is not plain text", () => {
  const hostile = [
    ['Tom & "Jerry"', "Tom &amp; &quot;Jerry&quot;"],
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["</title><h1>x", "&lt;/title&gt;&lt;h1&gt;x"],
    ["it's <b>bold</b>", "it&#39;s &lt;b&gt;bold&lt;/b&gt;"],
    ["<site-meta />", "&lt;site-meta /&gt;"],
    ["&amp;", "&amp;amp;"],
  ] as const;

  it.each(hostile)("escapes %s", (name, escaped) => {
    expect(escapeHtml(name)).toBe(escaped);
  });

  it.each(hostile)(
    "%s adds no element to either page and lands escaped in the title and heading",
    (name, escaped) => {
      const index = minimalIndexPage(name);
      const notFound = minimalNotFoundPage(name);
      expect(tagsIn(index)).toEqual(tagsIn(minimalIndexPage("my-site")));
      expect(tagsIn(notFound)).toEqual(tagsIn(minimalNotFoundPage("my-site")));
      expect(contentOf(index, "title")).toBe(escaped);
      expect(contentOf(index, "h1")).toBe(escaped);
      expect(contentOf(notFound, "title")).toBe(`Page not found - ${escaped}`);
      for (const html of [index, notFound])
        expect(html.match(/<\/title>/g)).toHaveLength(1);
    },
  );

  it("keeps replacement tokens in a name as text", () => {
    for (const name of ["$&", "$1", "$`", "$$"]) {
      expect(escapeHtml(name)).toBe(name.replace("&", () => "&amp;"));
      expect(contentOf(minimalIndexPage(name), "h1")).toBe(escapeHtml(name));
    }
  });

  it("leaves a name the CLI accepts as written", () => {
    for (const name of ["my-site", "My_Site.2", "site@home"])
      expect(escapeHtml(name)).toBe(name);
  });

  it("writes an empty name as an empty title and heading, not as broken markup", () => {
    const html = minimalIndexPage("");
    expect(contentOf(html, "title")).toBe("");
    expect(contentOf(html, "h1")).toBe("");
    expect(tagsIn(html)).toEqual(tagsIn(minimalIndexPage("my-site")));
  });

  it("keeps the site name out of the spec and the stylesheet, so no name can break them", () => {
    const context = { siteName: "'); process.exit(1); ('" };
    expect(textOf(context, "e2e/app.spec.ts")).toBe(MINIMAL_E2E_APP_SPEC);
    expect(textOf(context, "src/pages/css/styles.css")).toBe(
      MINIMAL_STYLES_CSS,
    );
  });
});

describe("minimal stylesheet", () => {
  it("keeps its minimal structure while using the shared palette and visible focus", () => {
    expect(MINIMAL_STYLES_CSS.split("\n").length).toBeLessThan(60);
    expect(MINIMAL_STYLES_CSS).toContain("color-scheme: light dark");
    expect(MINIMAL_STYLES_CSS).toContain(
      "--canvas: light-dark(#e9edf3, #11151c)",
    );
    expect(MINIMAL_STYLES_CSS).toContain("outline-offset: 3px");
    // No class or id selectors: there is nothing in the pages for them to match.
    expect(MINIMAL_STYLES_CSS).not.toMatch(/^[^{}]*[.#][a-z][^{}]*\{/m);
    const braces = (character: string): number =>
      MINIMAL_STYLES_CSS.split(character).length - 1;
    expect(braces("{")).toBe(braces("}"));
  });
});

describe("minimal e2e spec", () => {
  it("tests the home page and the 404 page through test ids the pages have", () => {
    expect(MINIMAL_E2E_APP_SPEC).toContain(
      "import { test, expect } from '@playwright/test';",
    );
    expect(MINIMAL_E2E_APP_SPEC.match(/^\s+test\('/gm)).toHaveLength(2);
    expect(MINIMAL_E2E_APP_SPEC).toContain("toBe(404)");
    const pages = minimalIndexPage("my-site") + minimalNotFoundPage("my-site");
    const used = [
      ...MINIMAL_E2E_APP_SPEC.matchAll(/getByTestId\('([^']+)'\)/g),
    ].map((match) => match[1]);
    expect(new Set(used)).toEqual(
      new Set(["home-main", "404-main", "404-home-link"]),
    );
    for (const testId of used)
      expect(pages).toContain(`data-testid="${testId}"`);
  });

  it("does not reach elements by position or by class", () => {
    expect(MINIMAL_E2E_APP_SPEC).not.toMatch(/\.nth\(|locator\(/);
  });
});
