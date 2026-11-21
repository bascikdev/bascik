/**
 * @module templates/portfolio/pages
 *
 * The portfolio's pages, the rules it adds to the global stylesheet, and its Playwright spec.
 *
 * Every page is a list of component tags. Its `<head>` holds the shared `<site-meta />` and one build script
 * that calls `seo()` for the title, description, canonical URL and Open Graph tags.
 */

import { STYLES_CSS } from "../../scaffold.js";

/** A page: the shared head and layout around its own head script and the tags inside `<main>`. */
const page = (options: {
  /** The page's name in its `<main>` test id. */
  name: string;
  /** What goes in `<head>` after `<site-meta />`, indented four spaces. */
  head: string;
  /** Classes on `<main>`, when the page is not full width. */
  mainClass?: string;
  /** The tags inside `<main>`, indented six spaces. */
  body: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <site-meta />
${options.head}
  </head>
  <body>
    <site-header />
    <main id="main"${options.mainClass ? ` class="${options.mainClass}"` : ""} data-testid="${options.name}-main">
${options.body}
    </main>
    <site-footer />
  </body>
</html>
`;

/** A head build script that calls `seo()` with a fixed title and description. */
const seoScript = (title: string, description: string): string =>
  `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      export default () =>
        seo({
          title: ${JSON.stringify(title)},
          description:
            ${JSON.stringify(description)},
        });
    </script>`;

export const INDEX_PAGE = page({
  name: "home",
  head: `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      import { site } from "@/lib/site.ts";
      export default () =>
        seo({ title: site.author, description: site.description });
    </script>`,
  body: `      <home-intro />
      <featured-projects />`,
});

export const WORK_PAGE = page({
  name: "work",
  head: seoScript(
    "Work",
    "Selected identity, editorial, campaign, and art direction projects with a page for every case study.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="Selected work"
        data-bascik-prop-title="A collection of ideas, made real"
        data-bascik-prop-text="Sample work: fictional identity, editorial, campaigns, and image-making projects. Replace these examples with your own."
      />
      <project-list />`,
});

/**
 * The dynamic route: one page per project. The routes script returns a route for each entry in `src/lib/projects.ts`,
 * with the project as the route's data; the head script and `<project-detail>` read it from `BASCIK_ROUTE`.
 */
export const PROJECT_PAGE = page({
  name: "project",
  head: `    <!-- One page per project at /work/<slug>. The routes script hands each page its project as the route's data. -->
    <script data-bascik-routes type="text/typescript">
      import { projects } from "@/lib/projects.ts";
      export default () =>
        projects.map((project) => ({ params: { slug: project.slug }, data: project }));
    </script>
    <script data-bascik-build type="text/typescript">
      import type { Project } from "@/lib/projects.ts";
      import { seo } from "@/lib/seo.ts";
      export default () => {
        const { data: project }: { data: Project } = JSON.parse(
          process.env.BASCIK_ROUTE || "{}",
        );
        return seo({
          title: project.title,
          description: project.summary,
          type: "article",
        });
      };
    </script>`,
  mainClass: "container page",
  body: `      <project-detail />`,
});

export const ABOUT_PAGE = page({
  name: "about",
  head: seoScript(
    "About",
    "An independent creative practice across visual identity, editorial, and art direction.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="About"
        data-bascik-prop-title="Visual worlds built with care"
        data-bascik-prop-text="An independent practice in identity, editorial, and art direction."
      />
      <creator-bio />`,
});

export const CONTACT_PAGE = page({
  name: "contact",
  head: seoScript(
    "Contact",
    "Start a conversation about identity, editorial, art direction, or another thoughtful creative project.",
  ),
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="Contact"
        data-bascik-prop-title="Have a good one in mind?"
        data-bascik-prop-text="Tell me what you are making, who it is for, and what you hope it will do."
      />
      <contact-form />`,
});

/** Served with status 404 for unknown URLs. Bascik keeps a 404 page out of the sitemap by itself. */
export const NOT_FOUND_PAGE = page({
  name: "not-found",
  head: `    <script data-bascik-build type="text/typescript">
      import { seo } from "@/lib/seo.ts";
      export default () =>
        seo({
          title: "Page not found",
          description: "This page does not exist or has moved.",
          noindex: true,
        });
    </script>`,
  mainClass: "container page",
  body: `      <page-intro
        data-bascik-prop-label="404"
        data-bascik-prop-title="Page not found"
        data-bascik-prop-text="This page does not exist or has moved."
      />
      <p><a href="/work" class="btn btn-primary">Back to selected work</a></p>`,
});

/**
 * The global stylesheet: an editorial portfolio system layered over the shared accessible foundation.
 * `.project-grid` is global because project components build the same grid.
 */
export const PORTFOLIO_STYLES_CSS = `${STYLES_CSS}
/* ── Portfolio: warm paper, botanical green, and a quiet clay accent ── */
:root {
  --portfolio-accent: light-dark(#b64f3c, #f09a81);
  --bg: light-dark(#f5f2eb, #171916);
  --surface: light-dark(#fbf9f4, #22241f);
  --surface-top: light-dark(#fffdf8, #292c26);
  --elevated: light-dark(#e9e5db, #2b2e28);
  --border: light-dark(#d8d4c9, #41443d);
  --border-hover: light-dark(#9d9a8d, #777a70);
  --accent: var(--portfolio-accent);
  --accent-hover: light-dark(#943f31, #ffae98);
  --accent-dim: light-dark(#f2e3dc, #382a25);
  --on-accent: light-dark(#fffaf5, #171916);
  --text: light-dark(#262820, #f1efe7);
  --text-muted: light-dark(#696b61, #bcbbb0);
  --shadow: none;
  --r: 2px;
  --r-sm: 2px;
}

:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
nav a { text-decoration: none; }
body { font-family: "Avenir Next", "Segoe UI", system-ui, sans-serif; line-height: 1.65; }
h1, h2, h3, h4 {
  font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  font-weight: 500;
  letter-spacing: -0.045em;
}
.container { max-width: 1360px; }
.hero { padding: clamp(72px, 10vw, 128px) 0 clamp(80px, 12vw, 150px); text-align: left; }
.hero > .container { max-width: 1360px; }
.hero-actions { justify-content: flex-start; }
.page { max-width: 1100px; padding-top: clamp(52px, 8vw, 100px); padding-bottom: clamp(64px, 9vw, 112px); }
.project-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: clamp(40px, 7vw, 92px) clamp(20px, 4vw, 56px);
  margin: clamp(36px, 6vw, 76px) 0 0;
  padding: 0;
  list-style: none;
}
.project-grid > li { min-width: 0; grid-column: span 7; }
.project-grid > li:nth-child(4n + 2),
.project-grid > li:nth-child(4n + 3) { grid-column: span 5; }
.project-grid > li:nth-child(4n + 2) { padding-top: 54px; }
.project-grid > li:nth-child(4n + 3) { padding-top: 16px; }
.project-grid > li:nth-child(4n) { padding-top: 70px; }
.more { margin-top: 42px; }
footer { background: var(--bg); }
@media (max-width: 760px) {
  .project-grid { gap: 36px 18px; }
  .project-grid > li,
  .project-grid > li:nth-child(n) { grid-column: span 6; padding-top: 0; }
  .project-grid > li:nth-child(odd) { padding-top: 28px; }
}
@media (max-width: 480px) {
  .project-grid { grid-template-columns: minmax(0, 1fr); gap: 34px; }
  .project-grid > li,
  .project-grid > li:nth-child(n) { grid-column: 1; padding-top: 0; }
}
`;

/** With an adapter: the shared `/api/hello` route answers under `bascik --server`, the E2E web server. */
const API_ROUTE_E2E_TEST = `
  test("the API route answers with JSON", async ({ request }) => {
    const response = await request.get("/api/hello?name=reader");
    expect(response.ok()).toBe(true);
    expect((await response.json()).hello).toBe("reader");
  });
`;

/**
 * The Playwright spec imports the Markdown projects, so project changes update the fixture automatically.
 */
const E2E_APP_SPEC_TESTS = `import { test, expect } from "@playwright/test";
import { projects, featuredProjects } from "../src/lib/projects.ts";

const [project] = projects;

test.describe("Portfolio E2E Tests", () => {
  test("icon-only theme toggle persists and global styles are inline", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByTestId("site-header-theme-toggle");
    await expect(toggle).toHaveAccessibleName("Dark theme");
    await expect(toggle).toHaveText("");
    await toggle.focus();
    await toggle.press("Space");
    const pressed = await toggle.getAttribute("aria-pressed");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-pressed", pressed!);
    await expect(page.locator('link[rel="stylesheet"][href*="styles.css"]')).toHaveCount(0);
    await expect(page.getByTestId("featured-projects")).toContainText("Sample work");
  });

  test("home page introduces a creator and shows featured projects", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "A practice in color, shape, and story.",
    );
    await expect(page.getByTestId("home-intro-art")).toBeVisible();
    const cards = page.getByTestId("featured-projects").getByTestId("project-card");
    await expect(cards).toHaveCount(featuredProjects().length);

    const [featured] = featuredProjects();
    await cards
      .filter({ hasText: featured.title })
      .getByTestId("project-card-link")
      .click();
    await expect(page).toHaveURL(\`/work/\${featured.slug}\`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      featured.title,
    );
  });

  test("work page lists every project, each linking to its own page", async ({
    page,
  }) => {
    await page.goto("/work");
    await expect(page).toHaveTitle(/^Work - /);
    const cards = page.getByTestId("project-list").getByTestId("project-card");
    await expect(cards).toHaveCount(projects.length);
    for (const each of projects) {
      const card = cards.filter({ hasText: each.title });
      await expect(card.getByTestId("project-card-link")).toHaveAttribute(
        "href",
        \`/work/\${each.slug}\`,
      );
    }
  });

  test("every project has a page with its title, text and absolute SEO URLs", async ({
    page,
  }) => {
    for (const each of projects) {
      const response = await page.goto(\`/work/\${each.slug}\`);
      expect(response?.status(), each.slug).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        each.title,
      );
      await expect(page.getByTestId("project-detail")).toContainText(
        each.summary,
      );
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        each.summary,
      );
      for (const tag of ['link[rel="canonical"]', 'meta[property="og:url"]']) {
        const url = await page
          .locator(tag)
          .getAttribute(tag.startsWith("link") ? "href" : "content");
        expect(url, tag).toMatch(/^https?:\\/\\//);
        expect(new URL(url!).pathname).toBe(\`/work/\${each.slug}\`);
      }
    }
  });

  test("a project page links to adjacent projects", async ({
    page,
  }) => {
    test.skip(projects.length < 2, "needs two projects");
    await page.goto(\`/work/\${project.slug}\`);
    await expect(page.getByTestId("project-detail-newer")).toHaveCount(0);
    await page.getByTestId("project-detail-older").click();
    await expect(page).toHaveURL(\`/work/\${projects[1].slug}\`);
    await page.getByTestId("project-detail-newer").click();
    await expect(page).toHaveURL(\`/work/\${project.slug}\`);
    await page.getByTestId("project-detail-all").click();
    await expect(page).toHaveURL("/work");
  });

  test("navigates between the pages from the header", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("site-header-about").click();
    await expect(page).toHaveURL("/about");
    await expect(page).toHaveTitle(/^About - /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Visual worlds built with care",
    );
    await page.getByTestId("site-header-logo").click();
    await expect(page).toHaveURL("/");
  });

  test("skip link is the first stop and moves to the main content", async ({
    page,
  }) => {
    await page.goto("/work");
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("site-header-skip-link");
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/work#main");
  });

  test("mobile navigation toggle expands and collapses menu", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    const toggle = page.getByTestId("site-header-nav-toggle");
    const menu = page.getByTestId("site-header-nav-menu");

    // Assert visible state, not production-minified classes.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();

    // At phone width the theme switch is the last row of the menu and names the theme it switches to.
    await expect(page.getByTestId("site-header-theme-toggle")).toBeHidden();
    const themeRow = page.getByTestId("site-header-mobile-theme");
    const before = await themeRow.innerText();
    await themeRow.click();
    await expect(themeRow).not.toHaveText(before);

    await toggle.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("pages fit a phone screen without scrolling sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    for (const path of [
      "/",
      "/work",
      \`/work/\${project.slug}\`,
      "/about",
      "/contact",
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("contact form reports the first invalid field, then accepts a complete form", async ({
    page,
  }) => {
    await page.goto("/contact");
    const status = page.getByTestId("contact-form-status");
    const name = page.getByTestId("contact-form-name");
    const email = page.getByTestId("contact-form-email");
    const message = page.getByTestId("contact-form-message");
    const submit = page.getByTestId("contact-form-submit");

    // Empty: the name is the first problem.
    await submit.click();
    await expect(status).toContainText("Name:");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");

    // A name, and an email that is not one.
    await name.fill("Collin");
    await email.fill("not-an-email");
    await submit.click();
    await expect(status).toContainText("Email:");
    await expect(email).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "false");

    // A message shorter than the form asks for.
    await email.fill("collin@example.com");
    // Typed, not filled: browsers apply minlength only to text a person typed.
    await message.pressSequentially("Hi");
    await submit.click();
    await expect(status).toContainText("Message:");

    await message.fill("I would like to discuss a visual identity project.");
    await submit.click();
    await expect(page).toHaveURL("/contact");
    await expect(status).toContainText("Thanks");
    await expect(message).toHaveAttribute("aria-invalid", "false");
  });

  test("unknown URL gets the 404 page with a way back", async ({ page }) => {
    const response = await page.goto("/work/no-such-project");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Page not found",
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex",
    );
    await page.getByRole("link", { name: "Back to selected work" }).click();
    await expect(page).toHaveURL("/work");
  });
`;

export const e2eAppSpec = (options: { adapter: boolean }): string =>
  `${E2E_APP_SPEC_TESTS}${options.adapter ? API_ROUTE_E2E_TEST : ""}});
`;
