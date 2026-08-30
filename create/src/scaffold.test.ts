import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASCIK_CONFIG,
  E2E_APP_SPEC,
  FEAT_CARD_CSS,
  FEAT_CARD_HTML,
  FEAT_CARD_TEST,
  GITIGNORE,
  MY_COUNTER_CSS,
  MY_COUNTER_HTML,
  MY_COUNTER_TEST,
  PACKAGE_JSON,
  PLAYWRIGHT_CONFIG,
  SITE_FOOTER_CSS,
  SITE_FOOTER_HTML,
  SITE_FOOTER_TEST,
  SITE_HEADER_CSS,
  SITE_HEADER_HTML,
  SITE_HEADER_TEST,
  SITE_META_HTML,
  SITE_META_TEST,
  STYLES_CSS,
  VITE_CONFIG,
  VSCODE_LAUNCH_JSON,
  aboutPage,
  contactPage,
  indexPage,
  notFoundPage,
  scaffold,
  validateProjectName,
} from "./scaffold.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "# Bascik Skill"),
  writeFile: vi.fn(async () => undefined),
}));

import { mkdir, readFile, writeFile } from "node:fs/promises";

const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;

vi.spyOn(console, "log").mockImplementation(() => { });

const writtenTo = (suffix: string): string | undefined => {
  for (const call of mockWriteFile.mock.calls) {
    if (String(call[0]).endsWith(suffix)) return call[1] as string;
  }
  return undefined;
};

const allWrittenPaths = (): string[] =>
  mockWriteFile.mock.calls.map((c) => String(c[0]));

// ─── validateProjectName ──────────────────────────────────────────────────────

describe("validateProjectName", () => {
  it("accepts a simple name", () => {
    expect(validateProjectName("my-app")).toBeNull();
  });

  it("accepts names with numbers and dots", () => {
    expect(validateProjectName("app.v2")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateProjectName("")).not.toBeNull();
  });

  it("rejects invalid directory names with special characters", () => {
    const res = validateProjectName("my app*invalid");
    expect(res).not.toBeNull();
    expect(res).toContain("is not a valid directory name");
  });
});

// ─── Template exports ─────────────────────────────────────────────────────────

describe("PACKAGE_JSON", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(PACKAGE_JSON("my-app"))).not.toThrow();
  });

  it('sets type:module, dev, build, test, and e2e scripts', () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.type).toBe("module");
    expect(pkg.scripts.dev).toBe("bascik");
    expect(pkg.scripts.build).toBe("bascik --build");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:watch"]).toBe("vitest");
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(pkg.scripts.e2e).toBe("playwright test --config e2e/playwright.config.ts");
  });

  it("includes vitest, coverage-v8, and playwright in devDependencies", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.devDependencies.vitest).toBeDefined();
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeDefined();
    expect(pkg.devDependencies["@playwright/test"]).toBeDefined();
  });

  it("includes @bascik/bascik as a dependency", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.dependencies["@bascik/bascik"]).toBe("file:../pkg");
  });

  it("uses the supplied name", () => {
    const pkg = JSON.parse(PACKAGE_JSON("cool-site"));
    expect(pkg.name).toBe("cool-site");
  });
});

describe("VITE_CONFIG", () => {
  it("includes test matchers and coverage config", () => {
    expect(VITE_CONFIG).toContain("src/**/*.test.ts");
    expect(VITE_CONFIG).toContain("provider: 'v8'");
  });
});

describe("PLAYWRIGHT_CONFIG", () => {
  it("configures port 8080 webServer and base URL", () => {
    expect(PLAYWRIGHT_CONFIG).toContain("http://localhost:8080");
    expect(PLAYWRIGHT_CONFIG).toContain("npx bascik --build && npx bascik --serve 8080");
  });
});

describe("E2E_APP_SPEC", () => {
  it("includes tests for navigation, counter, and mobile menu toggle", () => {
    expect(E2E_APP_SPEC).toContain("navigates pages and checks titles");
    expect(E2E_APP_SPEC).toContain("counter component increments and decrements count");
    expect(E2E_APP_SPEC).toContain("mobile navigation toggle expands and collapses menu");
  });
});

describe("BASCIK_CONFIG", () => {
  it("contains a link to the docs", () => {
    expect(BASCIK_CONFIG).toContain("bascik.dev/configuration");
  });
});

describe("VSCODE_LAUNCH_JSON", () => {
  it("is valid JSON and configures dev server and Chrome debugging", () => {
    expect(() => JSON.parse(VSCODE_LAUNCH_JSON)).not.toThrow();
    const config = JSON.parse(VSCODE_LAUNCH_JSON);
    expect(config.version).toBe("0.2.0");
    expect(config.configurations.some((c: { name: string }) => c.name.includes("Debug Dev Server"))).toBe(true);
    expect(config.configurations.some((c: { name: string }) => c.name.includes("Launch Chrome"))).toBe(true);
  });
});

describe("GITIGNORE", () => {
  it("ignores node_modules, dist, coverage, and pem files", () => {
    expect(GITIGNORE).toContain("node_modules/");
    expect(GITIGNORE).toContain("dist/");
    expect(GITIGNORE).toContain("coverage/");
    expect(GITIGNORE).toContain(".pem");
  });
});

describe("component test templates", () => {
  it("SITE_META_TEST asserts head tags", () => {
    expect(SITE_META_TEST).toContain("charset");
    expect(SITE_META_TEST).toContain("styles.css");
  });

  it("SITE_HEADER_TEST asserts brand and links", () => {
    expect(SITE_HEADER_TEST).toContain("data-bascik-prop-brand");
    expect(SITE_HEADER_TEST).toContain("nav-toggle");
  });

  it("SITE_FOOTER_TEST asserts brand and year script", () => {
    expect(SITE_FOOTER_TEST).toContain("getFullYear");
  });

  it("FEAT_CARD_TEST asserts slot zones", () => {
    expect(FEAT_CARD_TEST).toContain('data-bascik-slot="header"');
  });

  it("MY_COUNTER_TEST asserts counter controls", () => {
    expect(MY_COUNTER_TEST).toContain("btn-dec");
  });
});

describe("STYLES_CSS", () => {
  it("defines core CSS variables", () => {
    expect(STYLES_CSS).toContain("--bg:");
    expect(STYLES_CSS).toContain("--accent:");
    expect(STYLES_CSS).toContain("--text:");
  });

  it("includes button, card, and form rules", () => {
    expect(STYLES_CSS).toContain(".btn");
    expect(STYLES_CSS).toContain(".card");
    expect(STYLES_CSS).toContain(".form-group");
  });
});

describe("SITE_META_HTML", () => {
  it("contains charset and viewport meta tags", () => {
    expect(SITE_META_HTML).toContain('charset="UTF-8"');
    expect(SITE_META_HTML).toContain("viewport");
  });

  it("links the global stylesheet", () => {
    expect(SITE_META_HTML).toContain("styles.css");
  });
});

describe("SITE_HEADER_HTML", () => {
  it("has a brand prop placeholder", () => {
    expect(SITE_HEADER_HTML).toContain("data-bascik-prop-brand");
  });

  it("interpolates SITE_HEADER_CSS inside style block without escaping", () => {
    expect(SITE_HEADER_HTML).toContain(".header {");
    expect(SITE_HEADER_HTML).not.toContain("${SITE_HEADER_CSS}");
  });

  it("contains nav links to all three pages", () => {
    expect(SITE_HEADER_HTML).toContain('href="/"');
    expect(SITE_HEADER_HTML).toContain('href="/about"');
    expect(SITE_HEADER_HTML).toContain('href="/contact"');
  });

  it("has a mobile toggle with aria-expanded", () => {
    expect(SITE_HEADER_HTML).toContain("aria-expanded");
  });

  it("uses id-based DOM lookups (not class-based) in the script", () => {
    expect(SITE_HEADER_HTML).toContain("getElementById");
    expect(SITE_HEADER_HTML).not.toContain("querySelector(");
  });
});

describe("SITE_HEADER_CSS", () => {
  it("makes the header sticky", () => {
    expect(SITE_HEADER_CSS).toContain("position: sticky");
  });

  it("has responsive styles", () => {
    expect(SITE_HEADER_CSS).toContain("@media");
  });
});

describe("SITE_FOOTER_HTML", () => {
  it("has a brand prop placeholder", () => {
    expect(SITE_FOOTER_HTML).toContain("data-bascik-prop-brand");
  });

  it("interpolates SITE_FOOTER_CSS inside style block without escaping", () => {
    expect(SITE_FOOTER_HTML).toContain(".footer {");
    expect(SITE_FOOTER_HTML).not.toContain("${SITE_FOOTER_CSS}");
  });

  it("uses a build-time script for the year", () => {
    expect(SITE_FOOTER_HTML).toContain("data-bascik-build");
    expect(SITE_FOOTER_HTML).toContain("getFullYear");
  });
});

describe("SITE_FOOTER_CSS", () => {
  it("has footer layout rules", () => {
    expect(SITE_FOOTER_CSS).toContain(".footer");
    expect(SITE_FOOTER_CSS).toContain(".footer-inner");
  });
});

describe("MY_COUNTER_HTML", () => {
  it("interpolates MY_COUNTER_CSS inside style block without escaping", () => {
    expect(MY_COUNTER_HTML).toContain(".counter {");
    expect(MY_COUNTER_HTML).not.toContain("${MY_COUNTER_CSS}");
  });

  it("uses id-based DOM lookups for instance safety", () => {
    expect(MY_COUNTER_HTML).toContain("getElementById");
    expect(MY_COUNTER_HTML).not.toContain("querySelector(");
  });

  it("has increment and decrement buttons", () => {
    expect(MY_COUNTER_HTML).toContain("btn-dec");
    expect(MY_COUNTER_HTML).toContain("btn-inc");
  });

  it("wraps the script in an IIFE", () => {
    expect(MY_COUNTER_HTML).toMatch(/\(function\s*\(\)/);
  });
});

describe("FEAT_CARD_HTML", () => {
  it("interpolates FEAT_CARD_CSS inside style block without escaping", () => {
    expect(FEAT_CARD_HTML).toContain(".fcard {");
    expect(FEAT_CARD_HTML).not.toContain("${FEAT_CARD_CSS}");
  });

  it("defines three slot zones: header, default, and footer", () => {
    expect(FEAT_CARD_HTML).toContain('data-bascik-slot="header"');
    expect(FEAT_CARD_HTML).toContain("data-bascik-slot>");
    expect(FEAT_CARD_HTML).toContain('data-bascik-slot="footer"');
  });
});

describe("FEAT_CARD_CSS", () => {
  it("styles all three card zones", () => {
    expect(FEAT_CARD_CSS).toContain(".fcard-header");
    expect(FEAT_CARD_CSS).toContain(".fcard-body");
    expect(FEAT_CARD_CSS).toContain(".fcard-footer");
  });

  it("has hover lift effect", () => {
    expect(FEAT_CARD_CSS).toContain("translateY");
  });
});

describe("MY_COUNTER_CSS", () => {
  it("uses the mono CSS variable for the count display", () => {
    expect(MY_COUNTER_CSS).toContain("var(--mono)");
  });
});

describe("page templates", () => {
  it("indexPage uses feat-card with named slots for the features section", () => {
    const html = indexPage("My App");
    expect(html).toContain("<feat-card>");
    expect(html).toContain('data-bascik-slot="header"');
    expect(html).toContain('data-bascik-slot="footer"');
  });

  it("indexPage contains hero, features, and counter demo", () => {
    const html = indexPage("My App");
    expect(html).toContain("hero");
    expect(html).toContain("<my-counter />");
    expect(html).toContain("<site-header");
    expect(html).toContain("<site-footer");
    expect(html).toContain("<site-meta />");
  });

  it("aboutPage contains two feature cards", () => {
    const html = aboutPage("My App");
    expect(html).toContain("<site-header");
    expect(html).toContain("card");
    expect(html).toContain("/contact");
  });

  it("contactPage contains a form with name, email, and message fields", () => {
    const html = contactPage("My App");
    expect(html).toContain('<input type="text"');
    expect(html).toContain('<input type="email"');
    expect(html).toContain("<textarea");
  });

  it("notFoundPage contains 404 and a home link", () => {
    const html = notFoundPage("My App");
    expect(html).toContain("404");
    expect(html).toContain('href="/"');
  });

  it("all pages inject brand name into header and footer props", () => {
    for (const fn of [indexPage, aboutPage, contactPage, notFoundPage]) {
      const html = fn("cool-site");
      expect(html).toContain('data-bascik-prop-brand="cool-site"');
    }
  });

  it("all pages use site-meta head component", () => {
    for (const fn of [indexPage, aboutPage, contactPage, notFoundPage]) {
      expect(fn("x")).toContain("<site-meta />");
    }
  });
});

// ─── scaffold ─────────────────────────────────────────────────────────────────

describe("scaffold", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates all component, page, and e2e directories", async () => {
    await scaffold("my-app", "/tmp");
    const dirs = mockMkdir.mock.calls.map((c) => String(c[0]));
    expect(dirs.some((d) => d.includes(".github/skills/bascik"))).toBe(true);
    expect(dirs.some((d) => d.includes(".claude/skills/bascik"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("e2e"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/assets"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/css"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-header"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-footer"))).toBe(true);
    expect(dirs.some((d) => d.includes("my-counter"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-meta"))).toBe(true);
  });

  it("writes all 28 expected files", async () => {
    await scaffold("my-app", "/tmp");
    expect(mockWriteFile.mock.calls.length).toBe(28);
  });

  it("writes E2E config and spec files", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths();
    expect(paths.some((p) => p.endsWith("e2e/playwright.config.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("e2e/app.spec.ts"))).toBe(true);
  });

  it("writes SKILL.md into .github/skills/bascik and .claude/skills/bascik", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths().filter((p) => p.endsWith("SKILL.md"));
    expect(paths.some((p) => p.includes(".github/skills/bascik"))).toBe(true);
    expect(paths.some((p) => p.includes(".claude/skills/bascik"))).toBe(true);
  });

  it("writes root config files", async () => {
    await scaffold("my-app", "/tmp");
    expect(writtenTo("package.json")).toBeDefined();
    expect(writtenTo("bascik.config.ts")).toBeDefined();
    expect(writtenTo("vite.config.js")).toBeDefined();
    expect(writtenTo(".gitignore")).toBeDefined();
    expect(writtenTo(".hintrc")).toBeUndefined();
    expect(writtenTo(".vscode/launch.json")).toBeDefined();
  });

  it("writes all four pages", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths();
    expect(paths.some((p) => p.endsWith("index.html"))).toBe(true);
    expect(paths.some((p) => p.endsWith("about.html"))).toBe(true);
    expect(paths.some((p) => p.endsWith("contact.html"))).toBe(true);
    expect(paths.some((p) => p.endsWith("404.html"))).toBe(true);
  });

  it("writes all component files and tests", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths();
    expect(paths.some((p) => p.includes("site-meta"))).toBe(true);
    expect(paths.some((p) => p.includes("site-header"))).toBe(true);
    expect(paths.some((p) => p.includes("site-footer"))).toBe(true);
    expect(paths.some((p) => p.includes("feat-card"))).toBe(true);
    expect(paths.some((p) => p.includes("my-counter"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".css"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".test.ts"))).toBe(true);
  });

  it("writes styles.css", async () => {
    await scaffold("my-app", "/tmp");
    expect(writtenTo("styles.css")).toBeDefined();
  });

  it("writes favicon assets", async () => {
    await scaffold("my-app", "/tmp");
    expect(allWrittenPaths().some((p) => p.endsWith("favicon.ico"))).toBe(true);
    expect(allWrittenPaths().some((p) => p.endsWith("favicon-32x32.png"))).toBe(true);
    expect(allWrittenPaths().some((p) => p.endsWith("apple-touch-icon.png"))).toBe(true);
    expect(allWrittenPaths().some((p) => p.endsWith("favicon.svg"))).toBe(true);
  });

  it("scopes everything under targetDir/projectName", async () => {
    await scaffold("cool-site", "/projects");
    expect(allWrittenPaths().every((p) => p.startsWith("/projects/cool-site"))).toBe(true);
  });

  it("uses cwd as default targetDir", async () => {
    await scaffold("app");
    expect(allWrittenPaths().every((p) => p.includes("app"))).toBe(true);
  });

  it("injects the project name into the index page", async () => {
    await scaffold("hello-world", "/tmp");
    const paths = allWrittenPaths();
    const indexCall = mockWriteFile.mock.calls.find((c) =>
      String(c[0]).endsWith("index.html"),
    );
    expect(indexCall?.[1]).toContain("hello-world");
  });
});

