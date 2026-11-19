/**
 * @module templates/landing/pages
 *
 * The landing template's pages, global stylesheet, shared modules, config and
 * API route, as the text of each generated file.
 */

import { STYLES_CSS } from "../../scaffold.js";

/** `bascik.config.ts` */
export const BASCIK_CONFIG_TS = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Components and pages are watched already. src/lib/ holds the site facts and the SEO helper that
    // build scripts import, so the dev server rebuilds the pages that use them when one changes.
    watchPaths: ["src/lib/"],
  },
});
`;

/** `src/api/waitlist.test.ts` */
export const WAITLIST_API_TEST_TS = `import { describe, it, expect } from 'vitest';
import { POST, validateSignup } from './waitlist.ts';

const post = (body: string): Promise<Response> =>
  POST(
    new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );

describe('validateSignup', () => {
  it('accepts an email address, trims it, and treats the name as optional', () => {
    expect(validateSignup({ email: '  reader@example.com ' })).toEqual({
      ok: true,
      value: { email: 'reader@example.com', name: '' },
    });
    expect(validateSignup({ email: 'reader@example.com', name: ' Marta ' })).toMatchObject({
      value: { name: 'Marta' },
    });
  });

  it.each([
    ['a missing address', {}],
    ['an empty address', { email: '   ' }],
    ['an address with no domain', { email: 'reader@' }],
    ['an address with no dot in its domain', { email: 'reader@example' }],
    ['an address with a space', { email: 'rea der@example.com' }],
    ['an address that is not a string', { email: ['reader@example.com'] }],
    ['an address longer than 320 characters', { email: \`\${'a'.repeat(320)}@example.com\` }],
    ['a name longer than 80 characters', { email: 'reader@example.com', name: 'x'.repeat(81) }],
  ])('misuse: refuses %s', (_case, input) => {
    const result = validateSignup(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([null, 'reader@example.com', 42, ['reader@example.com']])(
    'misuse: refuses %j, which is not an object',
    (input) => {
      expect(validateSignup(input)).toEqual({ ok: false, errors: ['Send an object with an email address.'] });
    },
  );
});

describe('POST /api/waitlist', () => {
  it('answers 201 for a valid sign-up', async () => {
    const response = await post(JSON.stringify({ email: 'reader@example.com', name: 'Marta' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('misuse: answers 422 with the problems for an address that is not valid', async () => {
    const response = await post(JSON.stringify({ email: 'not-an-email' }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ errors: ['Enter an email address like reader@example.com.'] });
  });

  it('misuse: answers 400 for a body that is not JSON', async () => {
    const response = await post('email=reader@example.com');
    expect(response.status).toBe(400);
  });
});
`;

/** `src/api/waitlist.ts` */
export const WAITLIST_API_TS = `// POST /api/waitlist: receives the sign-up form from <waitlist-signup> as JSON.
// It runs on your host and under \`bascik --server\`, never on a static host.
// The browser checks the fields first, but anyone can post anything here, so
// this file checks them again before using them.

const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 80;

export interface Signup {
  email: string;
  /** The first name, or "" when the reader left it out. */
  name: string;
}

/** Checks untrusted input. Returns the cleaned sign-up, or what is wrong with it. */
export function validateSignup(
  input: unknown,
): { ok: true; value: Signup } | { ok: false; errors: string[] } {
  // JSON can be null, a string, or an array; only an object can hold the fields.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["Send an object with an email address."] };
  }
  const field = (key: keyof Signup): string => {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const value: Signup = { email: field("email"), name: field("name") };
  const errors: string[] = [];
  if (!value.email) errors.push("Enter your email address.");
  else if (value.email.length > MAX_EMAIL_LENGTH || !EMAIL.test(value.email))
    errors.push("Enter an email address like reader@example.com.");
  if (value.name.length > MAX_NAME_LENGTH)
    errors.push(\`Use a first name of \${MAX_NAME_LENGTH} characters or fewer.\`);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export const POST = async (request: Request): Promise<Response> => {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ errors: ["Send the form as JSON."] }, { status: 400 });
  }
  const result = validateSignup(input);
  if (!result.ok) return Response.json({ errors: result.errors }, { status: 422 });

  // Save result.value with your email provider here. Keep its API key in the
  // host's secrets, never in a component or a page.
  return Response.json({ ok: true }, { status: 201 });
};
`;

/** `src/lib/seo.test.ts` */
export const SEO_TEST_TS = `import { afterEach, describe, expect, it, vi } from "vitest";
import { absoluteUrl, seo, websiteJsonLd } from "./seo.ts";
import { copyright, site, siteName } from "./site.ts";

afterEach(() => vi.unstubAllEnvs());

describe("seo", () => {
  it("writes absolute canonical and Open Graph URLs when the site URL is set", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/privacy");
    const tags = String(seo({ title: "Privacy", description: "What we keep." }));
    expect(tags).toContain(\`<title>Privacy - \`);
    expect(tags).toContain(
      '<link rel="canonical" href="https://example.com/privacy" />',
    );
    expect(tags).toContain(
      '<meta property="og:url" content="https://example.com/privacy" />',
    );
  });

  it("leaves the canonical and og:url out when the site URL is not set, as in dev", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const tags = String(seo({ title: "Privacy", description: "What we keep." }));
    expect(tags).not.toContain("canonical");
    expect(tags).not.toContain("og:url");
    expect(absoluteUrl("/")).toBeUndefined();
    expect(String(websiteJsonLd())).toBe("");
  });

  it("keeps a noindex page out of search results and gives it no canonical", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const tags = String(
      seo({ title: "Page not found", description: "Gone.", noindex: true }),
    );
    expect(tags).toContain('<meta name="robots" content="noindex" />');
    expect(tags).not.toContain("canonical");
  });

  it("adds the base path of a site served from a subfolder", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/books/");
    expect(absoluteUrl("/privacy")).toBe("https://example.com/books/privacy");
  });

  it("misuse: a title or description with markup in it is written as text", () => {
    const tags = String(
      seo({
        title: '</title><script>alert("$&")</script>',
        description: '"><img src=x> $1 & more',
        fullTitle: true,
      }),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).not.toContain("<img");
    expect(tags).toContain("&lt;/title&gt;");
    expect(tags).toContain("$1 &amp; more");
  });

  it("writes the site name into WebSite structured data that parses as JSON", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const block = String(websiteJsonLd());
    const data = JSON.parse(
      block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1),
    ) as { name: string; url: string };
    expect(data).toMatchObject({ name: site.name, url: "https://example.com/" });
  });
});

describe("site", () => {
  it("has a name, and prints it with the year in the footer line", () => {
    expect(site.name.length).toBeGreaterThan(0);
    expect(String(siteName()).length).toBeGreaterThan(0);
    expect(String(copyright(2026))).toContain("&copy; 2026 ");
  });
});
`;

/** `src/lib/seo.ts` */
export const SEO_TS = `// Head tags for every page, written at build time. Use it from a page's <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { seo } from "@/lib/seo.ts";
//     export default () => seo({ title: "Privacy", description: "What we collect and why." });
//   </script>
//
// Absolute URLs come from BASCIK_SITE_URL (set it per deployment or in .env,
// never in bascik.config.ts). html escapes every value for where it lands.
import { html, json, type SafeHtml } from "@bascik/bascik/html";
import { site } from "./site.ts";

export interface SeoOptions {
  /** The page's own title. The site name is added after it. */
  title: string;
  /** One or two sentences for search results, roughly 50 to 160 characters. */
  description: string;
  /** Write the title as given, without the site name. The home page does. */
  fullTitle?: boolean;
  /** Keep the page out of search results, as the 404 page does. */
  noindex?: boolean;
}

/** The site origin without a trailing slash, or undefined when BASCIK_SITE_URL is not set (as in dev). */
export const siteUrl = (): string | undefined =>
  process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "") || undefined;

/** The absolute URL of a site path such as "/" or "/privacy", or undefined when the site URL is not known. */
export function absoluteUrl(path: string): string | undefined {
  const origin = siteUrl();
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${path.startsWith("/") ? path : \`/\${path}\`}\`;
}

/** The title, description, canonical, Open Graph, and Twitter tags for the page being built. */
export function seo(options: SeoOptions): SafeHtml {
  const title = options.fullTitle
    ? options.title
    : \`\${options.title} - \${site.name}\`;
  // A canonical URL must be absolute, so it is written only when the site URL is known.
  const url = options.noindex
    ? undefined
    : absoluteUrl(process.env.BASCIK_PAGE_PATH || "/");
  return html\`<title>\${title}</title>
    <meta name="description" content="\${options.description}" />
    \${options.noindex && html\`<meta name="robots" content="noindex" />\`}
    \${url && html\`<link rel="canonical" href="\${url}" />\`}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="\${site.name}" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${options.description}" />
    \${url && html\`<meta property="og:url" content="\${url}" />\`}
    <meta name="twitter:card" content="summary" />\`;
}

/**
 * WebSite structured data for the home page: it tells search engines the
 * site's name. Written only when the site URL is known, because it names the
 * home page's URL. json() keeps a value such as "</script>" from ending the tag.
 */
export function websiteJsonLd(): SafeHtml {
  const url = absoluteUrl("/");
  if (!url) return html\`\`;
  const data = json({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.name,
    url,
  });
  return html\`<script type="application/ld+json">
    \${data}
  </script>\`;
}
`;

/** `src/lib/site.ts`: the site's facts. The name is written as a JSON string, so any name is a valid one. */
export const siteModule = (siteName: string): string =>
  `// The facts several components and pages show. Change the name here and the
// header, the footer and every page's title follow.
import { html, type SafeHtml } from "@bascik/bascik/html";

export const site = {
  /** The name of the site and the product. */
  name: ${JSON.stringify(siteName)},
  /** Follows the name in the home page's title. */
  tagline: "A calmer space for client work",
  /** The home page's description, for search results and link previews. */
  description:
    "A thoughtful project workspace for independent creative teams to bring their briefs, feedback, files, and next steps together.",
} as const;

/** The name as markup, for the header and the footer. html escapes it. */
export const siteName = (): SafeHtml => html\`\${site.name}\`;

/** The footer's copyright line, with the year of the build. */
export const copyright = (year = new Date().getFullYear()): SafeHtml =>
  html\`&copy; \${year} \${site.name}\`;
`;

/** `src/pages/404.html` */
export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <!-- Served with status 404 for unknown URLs by the dev server, bascik --server, and most hosts. -->
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";

    export default () =>
      seo({
        title: "Page not found",
        description: "The page you asked for is not here. Head back to the home page.",
        noindex: true,
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="not-found-main">
    <div class="container section not-found">
      <p class="not-found-code">404</p>
      <h1>Page not found</h1>
      <p class="not-found-text">This page is not here, but your next project can be.</p>
      <a href="/" class="btn btn-primary" data-testid="not-found-home">Back to the home page</a>
    </div>
  </main>
  <site-footer />
</body>
</html>
`;

/** `src/pages/css/styles.css` */
export const LANDING_STYLES_CSS = `${STYLES_CSS}
/* ── Landing page ── */
:root {
  --landing-accent: #4263d8;
  --bg: light-dark(#f6f7fb, #151a26);
  --surface: light-dark(#fff, #202736);
  --surface-top: light-dark(#fff, #293244);
  --elevated: light-dark(#eef1f7, #252e40);
  --border: light-dark(#dce2ed, #3c465b);
  --border-hover: light-dark(#aab6cb, #65718c);
  --accent: light-dark(var(--landing-accent), #a8b8ff);
  --accent-hover: light-dark(#344fb7, #c0cbff);
  --accent-dim: light-dark(#e9edff, #2b3450);
  --on-accent: #fff;
  --error: light-dark(#a83d42, #ffaaa8);
  --text: light-dark(#172139, #eff2f8);
  --text-muted: light-dark(#5d6880, #b6bfd0);
  --shadow: 0 24px 60px -46px rgb(22 37 74 / 34%);
  --r: 12px;
  --r-sm: 8px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  line-height: 1.65;
}

h1, h2, h3 { letter-spacing: -0.045em; }
.section { padding-top: clamp(64px, 8vw, 104px); padding-bottom: clamp(64px, 8vw, 104px); }
main > section.section:nth-of-type(even) { background: var(--surface); }
main > section[id] { scroll-margin-top: 84px; }

/* A link to a section lands below the sticky header, not under it. */
a:focus-visible,
summary:focus-visible,
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Long-form text, such as the privacy page. */
.prose { max-width: 720px; }
.prose h2 { margin-top: 32px; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
`;

/** `src/pages/index.html` */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { seo, websiteJsonLd } from "@/lib/seo.ts";
    import { site } from "@/lib/site.ts";

    export default () => {
      const title = \`\${site.name}: \${site.tagline}\`;
      const tags = seo({ title, description: site.description, fullTitle: true });
      return html\`\${tags}\${websiteJsonLd()}\`;
    };
  </script>
</head>
<body>
  <site-header />
  <!-- Each id is a link target: site-header.html and the buttons link to these sections by id. -->
  <main id="main" data-testid="home-main">
    <home-hero />
    <feature-list id="features" />
    <how-it-works id="how-it-works" />
    <reader-quotes id="readers" />
    <pricing-plans id="pricing" />
    <faq-list id="faq" />
    <waitlist-signup id="signup" />
  </main>
  <site-footer />
</body>
</html>
`;

/** `src/pages/privacy.html` */
export const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { seo } from "@/lib/seo.ts";

    export default () =>
      seo({
        title: "Privacy",
        description: "What the early access form collects, why we keep it, and how to have it removed.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="privacy-main">
    <div class="container section prose">
      <h1>Privacy</h1>
      <p class="page-intro">This page is a placeholder. Replace it with your own policy before collecting information.</p>
      <h2>What we collect</h2>
      <p>The early access form asks for an email address and, if you like, a first name. Nothing else is collected, and this site sets no cookies.</p>
      <h2>Why we keep it</h2>
      <p>To write to you once, when early access opens. We do not sell or share the list.</p>
      <h2>How to be removed</h2>
      <p>Reply to any email from us and we will delete your address. You can <a href="/#signup">request access</a> again whenever you like.</p>
    </div>
  </main>
  <site-footer />
</body>
</html>
`;
