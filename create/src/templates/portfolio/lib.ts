/**
 * @module templates/portfolio/lib
 *
 * The portfolio's TypeScript modules under `src/lib/`, their tests, and the project config.
 *
 * `src/lib/projects.ts` is the collection: a typed array, checked when the module loads so a bad entry stops the
 * build with a message that names it. `src/lib/site.ts` is the only file that holds the site's name.
 */

/**
 * `src/lib/site.ts` for a site name. The name is written as a JSON string, which is a TypeScript string literal,
 * so any name is safe here; the pages print it with `html` from `@bascik/bascik/html`, which escapes it for HTML.
 */
export const siteModule = (
  siteName: string,
): string => `// The facts several pages and components show. Change one here and every page follows.
export const site = {
  /** The site's name: the header logo, og:site_name, and the end of every page title. */
  name: ${JSON.stringify(siteName)},
  /** Who the site is about. */
  author: "Your Name",
  role: "Independent designer & art director",
  tagline:
    "Independent design and art direction for ideas with something to say.",
  /** The home page's description in search results: one or two sentences. */
  description:
    "Selected identity, editorial, campaign, and art direction work by an independent creative practice.",
} as const;
`;

/** `bascik.config.ts`: the one setting the site needs that is not a default. */
export const BASCIK_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in dev when project Markdown or shared helpers change.
    // Component and page folders are watched already.
    watchPaths: ["src/lib/", "content/projects/"],
  },
  scripts: {
    cache: {
      exclude: ["@/lib/projects.ts", "src/pages/work/[slug].html", "src/pages/work.html", "src/pages/index.html"],
    },
  },
});
`;

export const PROJECTS_TS = `import { readdir, readFile } from "node:fs/promises";
import { raw, type SafeHtml } from "@bascik/bascik/html";

export interface Project {
  slug: string;
  title: string;
  year: number;
  category: string;
  tags: string[];
  summary: string;
  accent: "clay" | "sage" | "blue" | "citrus" | "lilac" | "ink";
  featured?: boolean;
  html: SafeHtml;
}

function scalar(value: string | undefined, field: string, file: string): string {
  if (!value?.trim()) throw new Error(\`\${file}: missing "\${field}" in frontmatter.\`);
  return value.trim();
}

function markdownToHtml(markdown: string): SafeHtml {
  const rendered = markdown.trim().split(/\\n\\s*\\n/).map((block) => {
    if (block.startsWith("## ")) return \`<h2>\${block.slice(3)}</h2>\`;
    if (block.startsWith("### ")) return \`<h3>\${block.slice(4)}</h3>\`;
    return \`<p>\${block.replace(/\\n/g, " ")}</p>\`;
  }).join("\\n");
  return raw(rendered);
}

export async function listProjects(): Promise<Project[]> {
  const names = (await readdir("./content/projects")).filter((name) => name.endsWith(".md")).sort();
  const projects: Project[] = [];
  for (const name of names) {
    const file = \`content/projects/\${name}\`;
    const source = await readFile(file, "utf8");
    const match = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(source);
    if (!match) throw new Error(\`\${file} is missing frontmatter\`);
    const fields = new Map<string, string>();
    for (const line of match[1].split("\\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^["']|["']$/g, ""));
    }
    const slug = scalar(fields.get("slug"), "slug", file);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(\`\${file}: invalid slug "\${slug}"\`);
    const year = Number(fields.get("year"));
    if (!Number.isInteger(year)) throw new Error(\`\${file}: "year" must be a whole number\`);
    const category = scalar(fields.get("category"), "category", file);
    const summary = scalar(fields.get("summary"), "summary", file);
    const accentValue = scalar(fields.get("accent"), "accent", file);
    if (!["clay", "sage", "blue", "citrus", "lilac", "ink"].includes(accentValue))
      throw new Error(\`\${file}: invalid accent "\${accentValue}"\`);
    const tags = (fields.get("tags") || "").split("|").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length === 0) throw new Error(\`\${file}: missing "tags"\`);
    projects.push({
      slug,
      title: scalar(fields.get("title"), "title", file),
      year,
      category,
      tags,
      summary,
      accent: accentValue as Project["accent"],
      featured: fields.get("featured") === "true",
      html: markdownToHtml(match[2]),
    });
  }
  const slugs = new Set<string>();
  for (const project of projects) {
    if (slugs.has(project.slug)) throw new Error(\`duplicate project slug: \${project.slug}\`);
    slugs.add(project.slug);
  }
  return projects.sort((a, b) => b.year - a.year);
}

export const projects = await listProjects();
export const featuredProjects = (): Project[] => projects.filter((project) => project.featured);
export const projectPath = (project: Pick<Project, "slug">): string => \`/work/\${project.slug}\`;
`;

export const PROJECT_MARKDOWN = {
  "juniper-plant-studio": `---
slug: "juniper-plant-studio"
title: "Juniper Plant Studio"
date: "2026-05-02"
year: 2026
category: "Visual identity"
tags: "Identity|Packaging|Art direction"
summary: "A fictional identity for a neighborhood plant shop, built around patient growth and the small rituals of care."
accent: "clay"
featured: "true"
---
## A little more room to grow

A fictional neighborhood plant shop needed an identity that felt grounded without leaning on familiar botanical shorthand. The visual system pairs a quiet wordmark with expressive, cut-paper forms.

## From shelf to storefront

The identity carries across plant labels, paper wraps, and a small set of in-store signs, with enough flexibility for each new season.
`,
  "sunday-paper-journal": `---
slug: "sunday-paper-journal"
title: "Sunday Paper Journal"
date: "2026-03-18"
year: 2026
category: "Editorial"
tags: "Art direction|Publication|Typography"
summary: "A fictional independent journal about slow weekends, thoughtful living, and noticing the details close at hand."
accent: "sage"
featured: "true"
---
## A journal with room to breathe

This sample publication gives essays and photography equal space. An unhurried grid and a warm, readable type palette keep each issue inviting.

## A flexible issue system

The cover, section openers, and recurring page furniture make one issue recognizable while giving each story room to feel different.
`,
  "common-ground-campaign": `---
slug: "common-ground-campaign"
title: "Common Ground Campaign"
date: "2025-10-07"
year: 2025
category: "Campaign"
tags: "Art direction|Illustration|Community"
summary: "A fictional neighborhood growing project made visible through bold type, hand-cut shapes, and friendly public posters."
accent: "blue"
---
## A shared invitation

This concept campaign invites neighbors to share small growing spaces. Its graphic system was designed to feel at home on a street poster, a community noticeboard, or a digital announcement.

## A language for many voices

Simple shapes and short, open-ended messages make the campaign easy to adapt for different events and local groups.
`,
  "soft-form-ceramics": `---
slug: "soft-form-ceramics"
title: "Soft Form Ceramics"
date: "2025-08-14"
year: 2025
category: "Packaging"
tags: "Identity|Packaging|Photography"
summary: "A fictional ceramics label with a tactile identity system that gives quiet, hand-finished objects a confident voice."
accent: "lilac"
featured: "true"
---
## Letting the material lead

The concept pairs a compact wordmark with soft color blocks and close-cropped photography, leaving the forms themselves in focus.

## Made for a considered unboxing

Labels, packing cards, and simple shipping materials share one flexible system.
`,
  "field-notes-identity": `---
slug: "field-notes-identity"
title: "Field Notes Identity"
date: "2024-11-22"
year: 2024
category: "Identity"
tags: "Brand strategy|Typography|Digital"
summary: "A fictional research studio identity that turns observation, collected fragments, and fieldwork into a clear visual language."
accent: "ink"
---
## Marking what matters

The studio brings together many disciplines. A flexible set of typographic and graphic tools gives each report and conversation a coherent thread.

## From note to system

Short notes, small diagrams, and a restrained palette help a complex subject become clear without losing its texture.
`,
} as const;

/** `src/lib/projects.test.ts`: checks the reader's frontmatter contract. */
export const PROJECTS_TEST = `import { describe, expect, it } from "vitest";
import { projectPath, projects, featuredProjects } from "./projects.ts";

describe("projects", () => {
  it("loads a creative project collection with unique slugs", () => {
    expect(projects.length).toBeGreaterThanOrEqual(5);
    expect(new Set(projects.map((project) => project.slug)).size).toBe(projects.length);
    expect(featuredProjects().length).toBeGreaterThan(0);
  });

  it("gives each project a valid work route", () => {
    for (const project of projects) {
      expect(project.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(project.title.length).toBeGreaterThan(0);
      expect(project.summary.length).toBeGreaterThanOrEqual(50);
      expect(project.tags.length).toBeGreaterThan(0);
      expect(projectPath(project)).toBe(\`/work/\${project.slug}\`);
    }
  });
});
`;

/** `src/lib/seo.ts`: each page's title, description, canonical URL, and Open Graph tags. */
export const SEO_TS = `// The head tags each page needs: title, description, canonical URL, and Open Graph tags. A page calls it from
// a build script in its <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { seo } from "@/lib/seo.ts";
//     export default () => seo({ title: "About", description: "Who I am and what I write." });
//   </script>
//
// The domain comes from BASCIK_SITE_URL (.env or the host's settings), never from this file. html escapes each
// value for where it lands, so a title with quotes or an ampersand is safe.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { site } from "./site.ts";

export interface SeoOptions {
  /** The page's own title. The site's name is added after it. */
  title: string;
  /** One or two sentences for search results. */
  description: string;
  /** "article" on a project page, otherwise "website". */
  type?: "website" | "article";
  /** Keep the page out of search results, as the 404 page does. */
  noindex?: boolean;
}

/** The absolute URL of the page being built, or undefined when the site URL is not set (as in dev). */
export function pageUrl(): string | undefined {
  const origin = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${process.env.BASCIK_PAGE_PATH || "/"}\`;
}

export function seo(options: SeoOptions): SafeHtml {
  const title = \`\${options.title} - \${site.name}\`;
  // A canonical URL must be absolute, so it is written only when the site URL is known.
  const url = options.noindex ? undefined : pageUrl();
  return html\`<title>\${title}</title>
    <meta name="description" content="\${options.description}" />
    \${options.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${url ? html\`<link rel="canonical" href="\${url}" />\` : ""}
    <meta property="og:type" content="\${options.type ?? "website"}" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${options.description}" />
    \${url ? html\`<meta property="og:url" content="\${url}" />\` : ""}
    <meta property="og:site_name" content="\${site.name}" />
    <meta name="twitter:card" content="summary" />\`;
}
`;

/** `src/lib/seo.test.ts`. */
export const SEO_TEST = `import { afterEach, describe, expect, it, vi } from "vitest";
import { pageUrl, seo } from "./seo.ts";
import { site } from "./site.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seo", () => {
  it("writes absolute canonical and Open Graph URLs from the site URL and the page path", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_BASE", "/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/work/a-test-book");
    expect(pageUrl()).toBe("https://example.com/work/a-test-book");
    const tags = String(
      seo({ title: "A Test Book", description: "About it." }),
    );
    expect(tags).toContain(
      '<link rel="canonical" href="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain(
      '<meta property="og:url" content="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain('<meta property="og:type" content="website" />');
  });

  it("keeps the base path of a site served from a subfolder", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/books/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/about");
    expect(pageUrl()).toBe("https://example.com/books/about");
  });

  it("leaves the canonical and og:url out when the site URL is not set, as in dev", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const tags = String(seo({ title: "About", description: "About me." }));
    expect(pageUrl()).toBeUndefined();
    expect(tags).not.toContain("canonical");
    expect(tags).not.toContain("og:url");
    expect(tags).toContain("<title>About - ");
  });

  it("ends each title with the site's name and marks a project page", () => {
    const tags = String(
      seo({ title: "Juniper Plant Studio", description: "About it.", type: "article" }),
    );
    expect(tags).toContain('<meta property="og:type" content="article" />');
    expect(tags).toContain('<meta property="og:site_name" content="');
    expect(site.name.length).toBeGreaterThan(0);
  });

  it("marks a noindex page and gives it no canonical URL", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const tags = String(
      seo({
        title: "Page not found",
        description: "Nothing here.",
        noindex: true,
      }),
    );
    expect(tags).toContain('<meta name="robots" content="noindex" />');
    expect(tags).not.toContain("canonical");
  });

  it("misuse: escapes markup and quotes in a title or description", () => {
    const tags = String(
      seo({
        title: '<script>alert("x")</script> & Sons',
        description: 'She said "no" & left <b>',
      }),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).not.toContain("<b>");
    expect(tags).toContain("&lt;script&gt;");
    expect(tags).toContain("&amp; Sons");
    expect(tags).not.toContain('content="She said "no"');
  });
});
`;
