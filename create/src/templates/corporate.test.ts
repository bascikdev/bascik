/**
 * Unit tests of the corporate template's content: what it writes, and the
 * house rules its files follow. The misuse cases that need a real build
 * (a broken service or role, a navigation link to a missing page) are in
 * corporate.integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  SITE_HEADER_CSS,
  STYLES_CSS,
  type TemplateFile,
} from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import { CORPORATE_TEMPLATE } from "./corporate.js";
import { SKIP_LINK_CSS } from "./corporate/components.js";

const files = (siteName = "My Company"): TemplateFile[] =>
  CORPORATE_TEMPLATE.files({ siteName });

/** The text files, as a map from path to content. */
const texts = (siteName?: string): Map<string, string> =>
  new Map(
    files(siteName).map(([path, data]) => {
      expect(typeof data, path).toBe("string");
      return [path, data as string];
    }),
  );

const read = (path: string, siteName?: string): string => {
  const text = texts(siteName).get(path);
  expect(text, `${path} is written`).toBeDefined();
  return text!;
};

const PAGES = [
  "src/pages/index.html",
  "src/pages/services/index.html",
  "src/pages/services/[slug].html",
  "src/pages/about.html",
  "src/pages/careers.html",
  "src/pages/news.html",
  "src/pages/contact.html",
  "src/pages/privacy.html",
  "src/pages/terms.html",
  "src/pages/404.html",
];

/** The files that ship in the site, not its tests. */
const siteSources = (): [string, string][] =>
  [...texts()].filter(
    ([path]) => !path.endsWith(".test.ts") && !path.startsWith("e2e/"),
  );

describe("corporate template", () => {
  it("is registered under its name, with the summary the help text shows", () => {
    expect(TEMPLATES).toContain(CORPORATE_TEMPLATE);
    expect(templateNamed("corporate")).toBe(CORPORATE_TEMPLATE);
    expect(templateNamed("Corporate")).toBe(CORPORATE_TEMPLATE);
    expect(CORPORATE_TEMPLATE.summary).toBe(
      "A company site: services, about, careers, news, and contact pages",
    );
  });

  it("needs no package beyond the starter's own", () => {
    expect(CORPORATE_TEMPLATE.dependencies).toBeUndefined();
    expect(CORPORATE_TEMPLATE.devDependencies).toBeUndefined();
    // Node-side code imports Bascik's html helpers and Node's own modules, nothing else.
    for (const [path, text] of texts()) {
      for (const [, specifier] of text.matchAll(
        /\bfrom\s+["']([^"'./@][^"']*|@[^"'/][^"']*)["']/g,
      )) {
        expect(
          specifier.startsWith("node:") ||
            specifier.startsWith("@bascik/bascik/") ||
            ["vitest", "@playwright/test"].includes(specifier),
          `${path} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("writes every page of the site, the dynamic service route included", () => {
    const paths = files().map(([path]) => path);
    for (const page of PAGES) expect(paths).toContain(page);
    expect(
      paths.filter(
        (path) => path.startsWith("src/pages/") && path.endsWith(".html"),
      ),
    ).toHaveLength(PAGES.length);
    expect(paths).toContain("bascik.config.ts");
    expect(paths).toContain("src/lib/services.ts");
  });

  it("is the same static site with any adapter or none", () => {
    const plain = CORPORATE_TEMPLATE.files({ siteName: "My Company" });
    for (const adapter of ADAPTERS) {
      const context = { siteName: "My Company", adapter };
      expect(CORPORATE_TEMPLATE.files(context)).toEqual(plain);
      expect(CORPORATE_TEMPLATE.directories(context)).toEqual(
        CORPORATE_TEMPLATE.directories({ siteName: "My Company" }),
      );
    }
    // The /api/hello route is scaffold's; the template adds no request-time code.
    expect(plain.some(([path]) => path.startsWith("src/api/"))).toBe(false);
    for (const [path, text] of siteSources()) {
      expect(text, path).not.toMatch(/data-bascik-(server|stream)/);
    }
  });

  it("declares exactly the folders its files sit in", () => {
    const context = { siteName: "My Company" };
    const declared = CORPORATE_TEMPLATE.directories(context);
    expect(new Set(declared).size).toBe(declared.length);
    const used = new Set(
      files()
        .map(([path]) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)))
        .filter((folder) => folder !== "" && folder !== "e2e"),
    );
    expect(new Set(declared)).toEqual(used);
    expect(declared).toContain("src/pages/services");
    expect(declared).toContain("src/lib");
  });
});

describe("corporate template: the site name", () => {
  /** The name src/lib/site.ts would hold at run time. */
  const nameIn = (source: string): unknown => {
    const literal = /^export const SITE_NAME: string = (.*);$/m.exec(
      source,
    )?.[1];
    expect(literal, "the SITE_NAME line").toBeDefined();
    return JSON.parse(literal!);
  };

  it("is written once, in src/lib/site.ts, and in no page or component", () => {
    const name = "Zyxwv Qponm";
    const holding = [...texts(name)]
      .filter(([, text]) => text.includes(name))
      .map(([path]) => path);
    expect(holding).toEqual(["src/lib/site.ts"]);
    expect(nameIn(read("src/lib/site.ts", name))).toBe(name);
  });

  it.each([
    ["HTML-special characters", `<script>alert("x")</script> & 'Sons'`],
    ["a closing script tag and a comment", "</script><!-- x --> */ //"],
    ["template literal syntax", "`${process.exit(1)}` $& $1 $`"],
    ["quotes, backslashes and line breaks", String.raw`a"b\c` + "\nd\re\\"],
    ["an empty name", ""],
  ])("survives %s unchanged, as data and never as code", (_case, name) => {
    const source = read("src/lib/site.ts", name);
    expect(nameIn(source)).toBe(name);
    // The name stays inside its one string literal: the rest of the module is unchanged.
    const [before, after] = read("src/lib/site.ts", "x").split('"x"');
    expect(source).toBe(`${before}${JSON.stringify(name)}${after}`);
    // No other file changes with the name, so no page can carry it unescaped.
    const other = texts(name);
    for (const [path, text] of texts("x")) {
      if (path !== "src/lib/site.ts") expect(other.get(path), path).toBe(text);
    }
  });

  it("is printed through @bascik/bascik/html wherever the site shows it", () => {
    for (const path of [
      "src/lib/seo.ts",
      "src/components/site-footer/footer-nav.ts",
      "src/components/office-details/office.ts",
    ]) {
      const source = read(path);
      expect(source, path).toContain('from "@bascik/bascik/html"');
      expect(source, path).toMatch(/\bSITE\b|\bsite\.name\b/);
    }
    expect(read("src/components/site-header/site-header.html")).toMatch(
      /html`\$\{SITE\.name\}`/,
    );
  });
});

describe("corporate template: house rules", () => {
  it('gives every page one <main id="main">, the shared head, header and footer, and its head tags from pageHead()', () => {
    for (const page of PAGES) {
      const html = read(page);
      expect(html, page).toMatch(/^<!doctype html>\n<html lang="en">/);
      expect(html.match(/<main\b/g), page).toHaveLength(1);
      expect(html, page).toMatch(/<main id="main" data-testid="[a-z-]+-main">/);
      expect(html, page).toMatch(/<head>\s*<site-head \/>/);
      expect(html, page).toMatch(/<body>\s*<site-header \/>\s*<main/);
      expect(html, page).toMatch(/<\/main>\s*<site-footer \/>\s*<\/body>/);
      expect(html, page).toMatch(
        /import \{[^}]*\bpageHead\b[^}]*\} from "@\/lib\/seo\.ts"/,
      );
      // pageHead() writes these: a literal copy would ship twice.
      expect(html, page).not.toMatch(
        /<title|name="description"|rel="canonical"/,
      );
    }
  });

  it("gives every page exactly one <h1>, its own or its intro's, and starts no section below <h2>", () => {
    const h1 = (path: string): number =>
      read(path).match(/<h1[\s>]/g)?.length ?? 0;
    for (const page of PAGES) {
      const html = read(page);
      const own = h1(page);
      const fromHero = (html.match(/<home-hero \/>/g) ?? []).length;
      const fromIntro = (html.match(/<page-intro /g) ?? []).length;
      const fromDetail = (html.match(/<service-detail \/>/g) ?? []).length;
      expect(own + fromHero + fromIntro + fromDetail, page).toBe(1);
    }
    expect(h1("src/components/home-hero/home-hero.html")).toBe(1);
    expect(h1("src/components/page-intro/page-intro.html")).toBe(1);
    // <service-detail> gets its <h1> from the <page-intro> it prints.
    expect(read("src/components/service-detail/detail.ts")).toContain(
      "<page-intro",
    );
    for (const [path, text] of siteSources()) {
      if (
        !path.endsWith("home-hero.html") &&
        !path.endsWith("page-intro.html") &&
        path !== "src/pages/404.html"
      ) {
        expect(text, path).not.toMatch(/<h1[\s>]/);
      }
    }
  });

  it("keeps the 404 page out of search results", () => {
    expect(read("src/pages/404.html")).toContain("noindex: true");
  });

  it("writes every script in TypeScript", () => {
    const paths = [...texts().keys()];
    expect(paths.filter((path) => /\.(js|mjs|cjs)$/.test(path))).toEqual([]);
    for (const [path, text] of siteSources()) {
      if (!path.endsWith(".html")) continue;
      for (const [tag] of text.matchAll(/<script\b[^>]*>/g)) {
        expect(
          /type="text\/typescript"/.test(tag) || /src="[\w-]+\.ts"/.test(tag),
          `${path}: ${tag}`,
        ).toBe(true);
      }
    }
  });

  it("builds markup only with @bascik/bascik/html, never an escaper of its own", () => {
    for (const [path, text] of siteSources()) {
      expect(text, path).not.toMatch(
        /&amp;["'`]|escapeHtml|\.replace\(\/[&<>]/,
      );
      // A module with an html`` template imports the helper it uses.
      if (path.endsWith(".ts") && /\bhtml`/.test(text)) {
        expect(text, path).toMatch(
          /import \{[^}]*\bhtml\b[^}]*\} from "@bascik\/bascik\/html"/,
        );
      }
    }
  });

  it("loads no image and nothing from the network", () => {
    for (const [path, text] of siteSources()) {
      expect(text, path).not.toMatch(
        /<img\b|<picture\b|url\(|@import|\bfetch\(/,
      );
      expect(text, path).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    }
    // Only scaffold's favicons are binary.
    for (const [path, data] of files())
      expect(typeof data, path).toBe("string");
  });

  it("gives every drawing a text alternative or hides it from assistive technology", () => {
    for (const [path, text] of siteSources()) {
      for (const [tag] of text.matchAll(/<svg\b[^>]*>/g)) {
        expect(
          /aria-hidden="true"/.test(tag) ||
            (/role="img"/.test(tag) && /aria-label(ledby)?=/.test(tag)),
          `${path}: ${tag}`,
        ).toBe(true);
      }
    }
  });

  it("labels every navigation, and uses the elements HTML has for an address and a quotation", () => {
    const labels: string[] = [];
    for (const [path, text] of siteSources()) {
      for (const [tag] of text.matchAll(/<nav\b[^>]*>/g)) {
        const label = /aria-label="([^"]+)"/.exec(tag)?.[1];
        expect(label, `${path}: ${tag}`).toBeDefined();
        labels.push(label!);
      }
    }
    expect(labels.sort()).toEqual(["Breadcrumb", "Footer", "Main"]);
    expect(read("src/components/office-details/office.ts")).toContain(
      "<address>",
    );
    const quotes = read("src/components/testimonial-list/testimonials.ts");
    expect(quotes).toContain("<figure");
    expect(quotes).toContain("<blockquote>");
    expect(quotes).toContain("<figcaption>");
  });

  it("puts a data-testid on every component root, and a test beside every component", () => {
    const components = [...texts().keys()]
      .map((path) => /^src\/components\/([\w-]+)\/\1\.html$/.exec(path)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(components.length).toBeGreaterThanOrEqual(15);
    for (const name of components) {
      const folder = `src/components/${name}`;
      expect(texts().has(`${folder}/${name}.test.ts`), name).toBe(true);
      // site-head is a list of head tags: it has no root element to mark.
      if (name !== "site-head") {
        expect(read(`${folder}/${name}.html`), name).toContain(
          `data-testid="${name}"`,
        );
      }
    }
    for (const module of ["collection", "navigation", "seo", "services"]) {
      expect(texts().has(`src/lib/${module}.test.ts`), module).toBe(true);
    }
  });

  it("starts the header with the default template's skip link, clipped until it has focus", () => {
    const html = read("src/components/site-header/site-header.html");
    expect(html.slice(html.indexOf("<header"))).toMatch(
      /^<header[^>]*>\s*<a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content<\/a>/,
    );
    const css = read("src/components/site-header/site-header.css");
    expect(css.startsWith(SKIP_LINK_CSS)).toBe(true);
    expect(SITE_HEADER_CSS.startsWith(SKIP_LINK_CSS)).toBe(true);
    expect(SKIP_LINK_CSS).toMatch(
      /\.skip-link:not\(:focus\) \{[^}]*clip-path: inset\(50%\);[^}]*\}\n$/,
    );
    // Only the skip link's rules are shared: the default header's own rules stay behind.
    expect(SKIP_LINK_CSS).not.toMatch(/(^|\n)header \{/);
    expect(css.match(/\.skip-link \{/g)).toHaveLength(1);
  });

  it("keeps the menu usable without JavaScript: both buttons start hidden and the script shows them", () => {
    const html = read("src/components/site-header/site-header.html");
    expect(html).toMatch(/<button id="nav-toggle"[^>]*\shidden>/);
    expect(read("src/components/site-header/primary-nav.ts")).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*\shidden\s*>/s,
    );
    const script = read("src/components/site-header/site-header.ts");
    expect(script).toContain("toggle.hidden = false");
    expect(script).toContain("caret.hidden = false");
    // The CSS hides a closed menu only once the script has marked the header.
    expect(script).toContain('header.classList.add("enhanced")');
    expect(read("src/components/site-header/site-header.css")).toContain(
      ".bar:not(.enhanced) .group:focus-within .submenu { display: block; }",
    );
  });

  it("extends the default stylesheet instead of copying it", () => {
    const css = read("src/pages/css/styles.css");
    expect(css.startsWith(STYLES_CSS)).toBe(true);
    expect(css.length).toBeGreaterThan(STYLES_CSS.length);
    expect(css.match(/:root \{/g)).toHaveLength(1);
  });

  it("marks both legal pages as placeholders", () => {
    for (const page of ["src/pages/privacy.html", "src/pages/terms.html"]) {
      expect(read(page), page).toContain("<legal-text>");
    }
    expect(read("src/components/legal-text/legal-text.html")).toContain(
      "<strong>Placeholder.</strong>",
    );
  });

  it("covers the home page, the menu by mouse and keyboard, a service page, the form, the phone menu and the 404 in its E2E spec", () => {
    const spec = read("e2e/app.spec.ts");
    for (const title of [
      "home page shows",
      "services menu opens and closes with the mouse",
      "services menu works with the keyboard alone",
      "without JavaScript the navigation is plain links",
      "service page has its breadcrumb",
      "contact form says what is wrong",
      "mobile navigation toggle",
      "unknown URL gets the 404 page",
    ]) {
      expect(spec).toContain(`test('${title}`);
    }
    for (const key of ["'Escape'", "'ArrowDown'", "'ArrowUp'"]) {
      expect(spec).toContain(`page.keyboard.press(${key})`);
    }
    // Class names and ids are hashed in a build: the spec finds elements by test id or role.
    expect(spec).not.toMatch(/locator\('[.#][\w-]/);
  });
});
