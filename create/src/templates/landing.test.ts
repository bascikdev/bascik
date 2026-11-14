/**
 * The landing template's own content. The rules every template shares (paths,
 * declared folders, shared files, building with each adapter, the semantic HTML
 * and data-testid audits) are held by the "template registry" tests in
 * scaffold.test.ts and the matrix in scaffold.integration.test.ts.
 *
 * The last two suites write the template into a temporary project and import
 * its modules, so the data is rendered by the real `html` helper from the
 * built `@bascik/bascik` package (`yarn pkg:build`).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ADAPTERS,
  SITE_HEADER_CSS,
  STYLES_CSS,
  type Adapter,
} from "../scaffold.ts";
import { TEMPLATES, templateNamed } from "../templates.ts";
import { LANDING_TEMPLATE } from "./landing.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** The template's files by path, as text. */
const filesFor = (siteName = "Book Box", adapter?: Adapter) =>
  new Map(
    LANDING_TEMPLATE.files({ siteName, adapter }).map(([path, data]) => [
      path,
      String(data),
    ]),
  );

const VARIANTS = [undefined, ...ADAPTERS] as const;
const SECTIONS = [
  "feature-list",
  "how-it-works",
  "reader-quotes",
  "pricing-plans",
  "faq-list",
  "waitlist-signup",
] as const;
const DATA_MODULES = [
  ["feature-list", "features.ts"],
  ["how-it-works", "steps.ts"],
  ["reader-quotes", "quotes.ts"],
  ["pricing-plans", "plans.ts"],
  ["faq-list", "faqs.ts"],
] as const;

describe("landing template", () => {
  it("is registered under the name landing with its summary", () => {
    expect(TEMPLATES).toContain(LANDING_TEMPLATE);
    expect(templateNamed("Landing")).toBe(LANDING_TEMPLATE);
    expect(LANDING_TEMPLATE.summary).toBe(
      "A product landing page: hero, features, pricing, FAQ, and a sign-up form",
    );
    expect(LANDING_TEMPLATE.dependencies).toBeUndefined();
    expect(LANDING_TEMPLATE.devDependencies).toBeUndefined();
  });

  it("writes the home page, a privacy page, a 404 page, and a test beside every component", () => {
    const files = filesFor();
    for (const page of ["index", "privacy", "404"])
      expect(files.has(`src/pages/${page}.html`), page).toBe(true);
    const components = [...files.keys()].filter((path) =>
      /^src\/components\/[^/]+\/[^/]+\.html$/.test(path),
    );
    expect(components).toHaveLength(11);
    for (const path of components)
      expect(
        files.has(path.replace(/\.html$/, ".test.ts")),
        `${path} has no test`,
      ).toBe(true);
    expect(files.has("e2e/app.spec.ts")).toBe(true);
  });

  it("keeps the home page a list of component tags inside one <main id=main>", () => {
    const home = filesFor().get("src/pages/index.html")!;
    expect(home.match(/<main[\s>]/g)).toHaveLength(1);
    const main = home.slice(home.indexOf("<main"), home.indexOf("</main>"));
    expect(main).toMatch(/^<main id="main" data-testid="home-main">/);
    const lines = main
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "<home-hero />",
      '<feature-list id="features" />',
      '<how-it-works id="how-it-works" />',
      '<reader-quotes id="readers" />',
      '<pricing-plans id="pricing" />',
      '<faq-list id="faq" />',
      '<waitlist-signup id="signup" />',
    ]);
  });

  it("has one <main id=main>, the shared header and footer, and no heading of its own on every page", () => {
    const files = filesFor();
    for (const page of ["index", "privacy", "404"]) {
      const html = files.get(`src/pages/${page}.html`)!;
      expect(html, page).toMatch(/^<!doctype html>\n<html lang="en">/);
      expect(
        html.match(/<main id="main" data-testid="[a-z-]+-main">/g),
      ).toHaveLength(1);
      expect(html).toContain("<site-head />");
      expect(html).toContain("<site-header />");
      expect(html).toContain("<site-footer />");
      expect(html).toContain('from "@/lib/seo.ts"');
      // The home page's h1 is in <home-hero>; the other pages write their own.
      expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(
        page === "index" ? 0 : 1,
      );
    }
  });

  it("makes each home section a <section> with an h2 from <section-head>, one h1 in the hero, and h3 below", () => {
    const files = filesFor();
    const html = (name: string) =>
      files.get(`src/components/${name}/${name}.html`)!;
    for (const name of SECTIONS) {
      const markup = html(name).slice(html(name).indexOf("</style>"));
      expect(markup, name).toContain(
        `<section class="section" data-testid="${name}">`,
      );
      expect(markup.match(/<section-head\n/g), name).toHaveLength(1);
      expect(markup, name).not.toMatch(/<h[1-6][\s>]/);
    }
    expect(html("home-hero").match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html("section-head")).toMatch(/<h2 data-bascik-prop-title>/);
    for (const [name, module] of DATA_MODULES) {
      const data = files.get(`src/components/${name}/${module}`)!;
      expect(data.match(/<h[1-6]/g) ?? [], module).toEqual(
        name === "faq-list" || name === "reader-quotes" ? [] : ["<h3"],
      );
    }
  });

  it("links the header only to ids the home page puts on its sections", () => {
    const files = filesFor();
    const header = files.get("src/components/site-header/site-header.html")!;
    const home = files.get("src/pages/index.html")!;
    const targets = [...header.matchAll(/href="\/#([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(targets).toEqual([
      "features",
      "how-it-works",
      "pricing",
      "faq",
      "signup",
    ]);
    for (const id of targets) expect(home).toContain(` id="${id}" />`);
    // The buttons inside the page link to sections too.
    const all = [...files.values()].join("\n");
    for (const [, id] of all.matchAll(/href="#([a-z-]+)"/g))
      expect(home, `#${id}`).toContain(` id="${id}"`);
  });

  it("puts the skip link first in the header, hidden by the default template's clipping rule", () => {
    const header = filesFor().get(
      "src/components/site-header/site-header.html",
    )!;
    expect(header).toContain(SITE_HEADER_CSS);
    expect(SITE_HEADER_CSS).toContain("clip-path: inset(50%)");
    expect(header).toMatch(
      /<header data-testid="site-header">\n\s*<a href="#main" class="skip-link"/,
    );
  });

  it("starts the global stylesheet from the default template's design tokens", () => {
    const css = filesFor().get("src/pages/css/styles.css")!;
    expect(css.startsWith(STYLES_CSS)).toBe(true);
    expect(css).toContain("scroll-margin-top");
  });

  it("gives every component root and interactive part a data-testid", () => {
    const files = filesFor("Book Box", "cloudflare");
    for (const [path, text] of files) {
      const name = /^src\/components\/([^/]+)\/\1\.html$/.exec(path)?.[1];
      // site-head is head tags only: it has no root element to name.
      if (!name || name === "site-head") continue;
      expect(text, path).toContain(`data-testid="${name}"`);
      const markup = text.slice(text.indexOf("</style>"));
      for (const [tag] of markup.matchAll(
        /<(?:button|input|form|nav)\b[^>]*>/g,
      ))
        expect(tag, path).toMatch(new RegExp(`data-testid="${name}-[a-z-]+"`));
    }
    expect(files.get("src/components/faq-list/faqs.ts")).toContain(
      '<summary class="question" data-testid="faq-list-question">',
    );
  });

  it("writes every script in TypeScript, and no JavaScript file", () => {
    for (const adapter of VARIANTS) {
      const files = filesFor("Book Box", adapter);
      for (const [path, text] of files) {
        expect(path).not.toMatch(/\.(?:js|mjs|cjs)$/);
        if (!path.endsWith(".html")) continue;
        for (const [tag] of text.matchAll(/<script\b[^>]*>/g))
          expect(tag, path).toContain('type="text/typescript"');
      }
    }
  });

  it("prints repeated content from typed data beside its component, at build time, with html", () => {
    const files = filesFor();
    for (const [name, module] of DATA_MODULES) {
      const data = files.get(`src/components/${name}/${module}`)!;
      expect(data, module).toContain('from "@bascik/bascik/html"');
      expect(data, module).toMatch(/export interface \w+ \{/);
      expect(data, module).toMatch(/export const \w+: readonly \w+\[\] = \[/);
      expect(data, module).toMatch(/\): SafeHtml \{/);
      const component = files.get(`src/components/${name}/${name}.html`)!;
      expect(component, name).toContain(
        '<script data-bascik-build-once type="text/typescript">',
      );
      expect(component, name).toContain(`from "./${module}"`);
    }
  });

  it("marks up testimonials as figures and questions as native details", () => {
    const files = filesFor();
    const quotes = files.get("src/components/reader-quotes/quotes.ts")!;
    expect(quotes).toMatch(
      /<figure class="quote">\s*<blockquote class="words"><p>\$\{quote\.words\}<\/p><\/blockquote>\s*<figcaption/,
    );
    const faqs = files.get("src/components/faq-list/faqs.ts")!;
    expect(faqs).toMatch(/<details class="item"[^>]*>\s*<summary/);
    // <details> needs no script: the component's only script is the build-time one.
    expect(
      files.get("src/components/faq-list/faq-list.html")!.match(/<script/g),
    ).toHaveLength(1);
  });

  it("uses no image file and nothing from the network: the drawing is inline SVG with a text alternative", () => {
    for (const adapter of VARIANTS) {
      for (const [path, text] of filesFor("Book Box", adapter)) {
        // The generated tests name these in their own misuse cases.
        if (!/\.(?:test|spec)\.ts$/.test(path))
          expect(text, path).not.toMatch(
            /<img\b|url\(|@import|<link[^>]*https?:/,
          );
        const urls = [...text.matchAll(/https?:\/\/[a-z0-9.-]+/g)].map(
          ([url]) => url,
        );
        for (const url of urls)
          expect(
            ["https://schema.org", "https://example.com", "http://localhost"],
            `${path}: ${url}`,
          ).toContain(url);
      }
    }
    const hero = filesFor().get("src/components/home-hero/home-hero.html")!;
    expect(hero).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]{10,}"/);
  });

  it("labels the sign-up form's controls and keeps the browser's own validation for when the script does not run", () => {
    const form = filesFor().get(
      "src/components/waitlist-signup/waitlist-signup.html",
    )!;
    for (const id of ["email", "name"]) {
      expect(form).toContain(`<label for="${id}">`);
      expect(form).toContain(`id="${id}" name="${id}"`);
    }
    expect(form).toMatch(/<input type="email"[^>]*\srequired\s/);
    expect(form).not.toMatch(/<form[^>]*novalidate/);
    expect(form).toContain("form.noValidate = true");
    expect(form).toContain('role="alert"');
    expect(form).toContain('role="status"');
  });
});

describe("landing template: with and without an adapter", () => {
  it("without an adapter has no API route, no form action, and no request from the form's script", () => {
    const files = filesFor("Book Box");
    expect(
      [...files.keys()].filter((path) => path.startsWith("src/api/")),
    ).toEqual([]);
    const form = files.get(
      "src/components/waitlist-signup/waitlist-signup.html",
    )!;
    expect(form).not.toMatch(/\saction=/);
    expect(form).not.toContain("fetch(");
    expect(form).toContain("does not send anything yet");
    expect(files.get("e2e/app.spec.ts")).not.toContain("/api/");
    expect([...files.values()].join("\n")).not.toContain("/api/waitlist");
  });

  it.each(ADAPTERS)(
    "with the %s adapter posts the form as JSON to a route that validates it again, and tests both",
    (adapter) => {
      const files = filesFor("Book Box", adapter);
      const form = files.get(
        "src/components/waitlist-signup/waitlist-signup.html",
      )!;
      expect(form).toContain("fetch('/api/waitlist'");
      expect(form).not.toMatch(/\saction=/);
      expect(form).not.toContain("does not send anything yet");
      const route = files.get("src/api/waitlist.ts")!;
      expect(route).toContain("export const POST");
      expect(route).toContain("export function validateSignup");
      expect(route).toContain("status: 422");
      expect(files.has("src/api/waitlist.test.ts")).toBe(true);
      expect(files.get("e2e/app.spec.ts")).toContain(
        "request.post('/api/waitlist'",
      );
      // The shared /api/hello route is scaffold's, not the template's.
      expect(files.has("src/api/hello.ts")).toBe(false);
    },
  );

  it("differs between adapters in nothing: the host is chosen by the build target, not by the pages", () => {
    expect([...filesFor("Book Box", "cloudflare")]).toEqual([
      ...filesFor("Book Box", "netlify"),
    ]);
  });

  it("leaves no placeholder from this module's own templating in any file", () => {
    for (const adapter of VARIANTS)
      for (const [path, text] of filesFor("Book Box", adapter)) {
        expect(text, path).not.toMatch(/@@|\[object /);
        expect(text.endsWith("\n"), `${path} ends with a newline`).toBe(true);
      }
  });
});

// ─── Rendering with the real html helper ──────────────────────────────────────

const PKG_HTML = join(REPO_ROOT, "pkg/dist/html.js");
const roots: string[] = [];

/** Write the template into a temporary project that can import `@bascik/bascik`. */
async function writeProject(siteName: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bascik-landing-"));
  roots.push(root);
  for (const [path, text] of filesFor(siteName)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text, "utf8");
  }
  await mkdir(join(root, "node_modules/@bascik"), { recursive: true });
  await symlink(
    join(REPO_ROOT, "pkg"),
    join(root, "node_modules/@bascik/bascik"),
    "dir",
  );
  return root;
}

type Render = (items: readonly Record<string, unknown>[]) => unknown;
const load = (root: string, path: string) =>
  import(/* @vite-ignore */ join(root, path)) as Promise<
    Record<string, unknown>
  >;

beforeAll(() => {
  if (!existsSync(PKG_HTML))
    throw new Error(
      `[landing.test] ${PKG_HTML} is missing. Run \`yarn pkg:build\` from the repository root first.`,
    );
});
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("landing template: site name", () => {
  const HOSTILE = [
    `Tom & "Jerry's" <Books>`,
    "</title><script>alert(1)</script>",
    "Pay $& get $1 $` $' $$",
    "back`tick ${7 * 6} \\n line",
    "  &  ",
  ];

  it.each(HOSTILE)(
    "misuse: the name %j is written once, as a string in src/lib/site.ts, and in no page or component",
    (name) => {
      const files = filesFor(name);
      const holders = [...files]
        .filter(
          ([, text]) =>
            text.includes(name) || text.includes(JSON.stringify(name)),
        )
        .map(([path]) => path);
      expect(holders).toEqual(["src/lib/site.ts"]);
      expect(files.get("src/lib/site.ts")).toContain(
        `name: ${JSON.stringify(name)},`,
      );
      // Everything else is the same whatever the name is.
      const plain = filesFor("Book Box");
      for (const [path, text] of files)
        if (path !== "src/lib/site.ts")
          expect(text, path).toBe(plain.get(path));
    },
  );

  it.each(HOSTILE)(
    "misuse: the name %j comes back from the generated module unchanged and is printed as text",
    async (name) => {
      const root = await writeProject(name);
      const site = await load(root, "src/lib/site.ts");
      expect((site.site as { name: string }).name).toBe(name);

      const printed = String((site.siteName as () => unknown)());
      expect(printed).not.toMatch(/<script|<Books>|<\/title>/);
      expect(printed).toBe(
        name
          .replace(/&/g, () => "&amp;")
          .replace(/</g, () => "&lt;")
          .replace(/>/g, () => "&gt;")
          .replace(/"/g, () => "&quot;")
          .replace(/'/g, () => "&#39;"),
      );
      expect(String((site.copyright as (year: number) => unknown)(2026))).toBe(
        `&copy; 2026 ${printed}`,
      );

      vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
      vi.stubEnv("BASCIK_PAGE_PATH", "/privacy");
      const seo = await load(root, "src/lib/seo.ts");
      const tags = String(
        (seo.seo as (options: object) => unknown)({
          title: "Privacy",
          description: "What we keep.",
        }),
      );
      expect(tags).toContain(`<title>Privacy - ${printed}</title>`);
      expect(tags).toContain(
        `<meta property="og:site_name" content="${printed}" />`,
      );
      expect(tags).toContain(
        '<link rel="canonical" href="https://example.com/privacy" />',
      );
      expect(tags.match(/<title>/g)).toHaveLength(1);
      expect(tags).not.toContain("<script");

      // JSON-LD: the name cannot end the script element, and parses back to itself.
      const block = String((seo.websiteJsonLd as () => unknown)());
      expect(block.match(/<\/script>/g)).toHaveLength(1);
      const data = JSON.parse(
        block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1),
      ) as { name: string; url: string };
      expect(data).toMatchObject({ name, url: "https://example.com/" });
    },
  );

  it("misuse: an empty name still gives a module that loads", async () => {
    const root = await writeProject("");
    const site = await load(root, "src/lib/site.ts");
    expect((site.site as { name: string }).name).toBe("");
  });
});

describe("landing template: data", () => {
  let root: string;
  beforeAll(async () => {
    root = await writeProject("Book Box");
  });

  const RENDERERS = [
    ["feature-list", "features.ts", "features", "featureCards"],
    ["how-it-works", "steps.ts", "steps", "stepItems"],
    ["reader-quotes", "quotes.ts", "quotes", "quoteFigures"],
    ["pricing-plans", "plans.ts", "plans", "planCards"],
    ["faq-list", "faqs.ts", "faqs", "faqItems"],
  ] as const;

  /** Every string in an entry replaced by `text`; lists keep one string. */
  const poisoned = (entry: Record<string, unknown>, text: string) =>
    Object.fromEntries(
      Object.entries(entry).map(([key, value]) => [
        key,
        typeof value === "string"
          ? text
          : Array.isArray(value)
            ? [text]
            : value,
      ]),
    );

  it.each(RENDERERS)(
    "%s prints every entry of %s",
    async (name, module, list, render) => {
      const loaded = await load(root, `src/components/${name}/${module}`);
      const items = loaded[list] as Record<string, string>[];
      expect(items.length).toBeGreaterThanOrEqual(3);
      const out = String((loaded[render] as Render)(items));
      for (const item of items)
        for (const value of Object.values(item))
          if (typeof value === "string")
            expect(out).toContain(value.replace(/'/g, () => "&#39;"));
    },
  );

  it.each(RENDERERS)(
    "misuse: %s prints HTML-special characters and replacement patterns in %s as text",
    async (name, module, list, render) => {
      const loaded = await load(root, `src/components/${name}/${module}`);
      const [first] = loaded[list] as Record<string, unknown>[];
      const text = `<b onclick="x">$& $1 $\` $' & </script></details>`;
      const out = String((loaded[render] as Render)([poisoned(first, text)]));
      expect(out).not.toMatch(/<b\b|<\/script>|onclick="x"/);
      expect(out).toContain(
        "&lt;b onclick=&quot;x&quot;&gt;$&amp; $1 $` $&#39; &amp; &lt;/script&gt;&lt;/details&gt;",
      );
      // The data added no element: the markup has the tags of a clean entry.
      const tags = (html: string) => html.match(/<\/?[a-z0-9]+/g);
      const clean = String((loaded[render] as Render)([poisoned(first, "x")]));
      expect(tags(out)).toEqual(tags(clean));
    },
  );

  it.each(RENDERERS)(
    "misuse: %s with an empty %s list throws, naming the file to edit and the tag to remove",
    async (name, module, _list, render) => {
      const loaded = await load(root, `src/components/${name}/${module}`);
      expect(() => (loaded[render] as Render)([])).toThrow(
        new RegExp(
          `^${name}: ${module.replace(".", "\\.")} has no \\w+\\. Add one, or remove <${name} /> from src/pages/index\\.html`,
        ),
      );
    },
  );

  it("misuse: a plan with no featured flag and nothing in its list still prints, without a badge", async () => {
    const { planCards } = await load(
      root,
      "src/components/pricing-plans/plans.ts",
    );
    const out = String(
      (planCards as Render)([
        {
          name: "Bare",
          price: "$0",
          period: "forever",
          blurb: "",
          includes: [],
        },
      ]),
    );
    expect(out).toContain('data-featured="false"');
    expect(out).not.toContain("Most popular");
    expect(out).not.toContain("<li>");
    expect(out).toContain("Choose Bare");
  });
});
