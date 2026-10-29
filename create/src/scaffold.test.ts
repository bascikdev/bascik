import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCliOptions } from "./cli.js";
import {
  CLOUDFLARE_E2E_APP_SPEC,
  CLOUDFLARE_GITIGNORE,
  E2E_APP_SPEC,
  FEAT_CARD_CSS,
  FEAT_CARD_HTML,
  FEAT_CARD_TEST,
  GITIGNORE,
  HELLO_API_ROUTE,
  MY_COUNTER_CSS,
  MY_COUNTER_HTML,
  MY_COUNTER_TEST,
  PACKAGE_JSON,
  PLAYWRIGHT_CONFIG,
  SKILLS_DIR,
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
  edgePage,
  indexPage,
  notFoundPage,
  scaffold,
  validateProjectName,
} from "./scaffold.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  cp: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

import { cp, mkdir, writeFile } from "node:fs/promises";

const mockCp = cp as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;

vi.spyOn(console, "log").mockImplementation(() => {});

const writtenTo = (suffix: string): string | undefined => {
  for (const call of mockWriteFile.mock.calls) {
    if (String(call[0]).replace(/\\/g, "/").endsWith(suffix))
      return call[1] as string;
  }
  return undefined;
};

const allWrittenPaths = (): string[] =>
  mockWriteFile.mock.calls.map((c) => String(c[0]).replace(/\\/g, "/"));

describe("parseCliOptions", () => {
  it("starts development by default for the non-interactive yes mode", () => {
    expect(parseCliOptions(["my-site", "-y"])).toEqual({
      yesFlag: true,
      noDevFlag: false,
      noInstallFlag: false,
      template: undefined,
      projectName: "my-site",
    });
  });

  it("supports bounded non-interactive scaffolding without changing install behavior", () => {
    expect(parseCliOptions(["my-site", "--yes", "--no-dev"])).toEqual({
      yesFlag: true,
      noDevFlag: true,
      noInstallFlag: false,
      template: undefined,
      projectName: "my-site",
    });
  });

  it("supports skipping install with --no-install", () => {
    expect(
      parseCliOptions(["my-site", "-y", "--no-install", "--no-dev"]),
    ).toEqual({
      yesFlag: true,
      noDevFlag: true,
      noInstallFlag: true,
      template: undefined,
      projectName: "my-site",
    });
  });

  it("leaves the project name undefined when no positional is given", () => {
    expect(parseCliOptions(["-y"]).projectName).toBeUndefined();
    expect(parseCliOptions([]).template).toBeUndefined();
  });

  it("reads --template as a two-token form without consuming it as the project name", () => {
    const options = parseCliOptions(["--template", "cloudflare", "my-site"]);
    expect(options.template).toBe("cloudflare");
    expect(options.projectName).toBe("my-site");
    expect(parseCliOptions(["my-site", "--template", "cloudflare"])).toEqual(
      options,
    );
  });

  it("reads --template=<name>", () => {
    const options = parseCliOptions(["my-site", "--template=cloudflare", "-y"]);
    expect(options.template).toBe("cloudflare");
    expect(options.projectName).toBe("my-site");
    expect(options.yesFlag).toBe(true);
  });

  it("accepts default and its static alias, ignoring case", () => {
    expect(parseCliOptions(["--template", "default"]).template).toBe("default");
    expect(parseCliOptions(["--template=static"]).template).toBe("default");
    expect(parseCliOptions(["--template", "Cloudflare"]).template).toBe(
      "cloudflare",
    );
  });

  it("rejects an unknown template with the available choices", () => {
    expect(() => parseCliOptions(["--template", "vercel"])).toThrow(
      'Unknown template "vercel". Choose one of: default, cloudflare, static.',
    );
    expect(() => parseCliOptions(["--template=vercel"])).toThrow(
      /Unknown template/,
    );
  });

  it("rejects --template without a value, including when a flag follows it", () => {
    expect(() => parseCliOptions(["--template"])).toThrow(
      "--template needs a value. Choose one of: default, cloudflare, static.",
    );
    expect(() => parseCliOptions(["--template", "-y"])).toThrow(
      /--template needs a value/,
    );
    expect(() => parseCliOptions(["--template="])).toThrow(
      /--template needs a value/,
    );
  });

  // `npm create bascik my-site --template cloudflare` (no `--`) reaches the CLI
  // as ["my-site", "cloudflare"]: npm keeps the flag and forwards its value as a
  // plain argument, so a second positional must be reported, not dropped.
  it("rejects a stray second positional and points at the -- form", () => {
    expect(() => parseCliOptions(["my-site", "cloudflare", "-y"], {})).toThrow(
      'Unexpected argument "cloudflare". When running through npm create, put flags after "--": npm create bascik@rc my-site -- --template cloudflare',
    );
  });

  it("honors npm's consumed -y through npm_config_yes", () => {
    expect(parseCliOptions(["my-site"], { npm_config_yes: "true" })).toEqual({
      yesFlag: true,
      noDevFlag: false,
      noInstallFlag: false,
      template: undefined,
      projectName: "my-site",
    });
    expect(parseCliOptions(["my-site"], {}).yesFlag).toBe(false);
    expect(parseCliOptions(["my-site"], { npm_config_yes: "" }).yesFlag).toBe(
      false,
    );
  });

  it("honors npm's consumed --template=<name> through npm_config_template", () => {
    expect(
      parseCliOptions(["my-site"], { npm_config_template: "cloudflare" })
        .template,
    ).toBe("cloudflare");
    expect(
      parseCliOptions(["my-site"], { npm_config_template: "static" }).template,
    ).toBe("default");
    expect(() =>
      parseCliOptions(["my-site"], { npm_config_template: "vercel" }),
    ).toThrow(/Unknown template "vercel"/);
  });

  it("prefers an explicit --template over npm_config_template", () => {
    expect(
      parseCliOptions(["my-site", "--template", "default"], {
        npm_config_template: "cloudflare",
      }).template,
    ).toBe("default");
  });

  it("reports the two-token form npm reduced to npm_config_template=true", () => {
    expect(() =>
      parseCliOptions(["my-site"], { npm_config_template: "true" }),
    ).toThrow(
      'npm kept --template for itself and dropped its value. Put flags after "--": npm create bascik@rc my-site -- --template cloudflare',
    );
  });
});

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

  it("sets type:module, dev, build, lint, test, and e2e scripts", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.type).toBe("module");
    expect(pkg.scripts.dev).toBe("bascik");
    expect(pkg.scripts.build).toBe("bascik --build");
    // One command for the whole project: `bascik --check` runs the per-file linter and the project-wide checks.
    expect(pkg.scripts.lint).toBe("bascik --check");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:watch"]).toBe("vitest");
    expect(pkg.scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(pkg.scripts.e2e).toBe(
      "playwright test --config e2e/playwright.config.ts",
    );
  });

  it("includes language-server, vitest, coverage-v8, and playwright in devDependencies", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    // `bascik --check` skips the per-file checks when the language server is not installed.
    expect(pkg.devDependencies["@bascik/language-server"]).toBeDefined();
    expect(pkg.devDependencies.vitest).toBeDefined();
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeDefined();
    expect(pkg.devDependencies["@playwright/test"]).toBeDefined();
  });

  it("includes Bascik as a dependency", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.dependencies["@bascik/bascik"]).toBeDefined();
  });

  it("pins @bascik/bascik and @bascik/language-server to the current workspace versions", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const pkgJson = JSON.parse(
      readFileSync(resolve(repoRoot, "pkg/package.json"), "utf8"),
    ) as { version: string };
    const lspJson = JSON.parse(
      readFileSync(resolve(repoRoot, "lsp/package.json"), "utf8"),
    ) as { version: string };
    const adapterJson = JSON.parse(
      readFileSync(
        resolve(repoRoot, "adapters/cloudflare/package.json"),
        "utf8",
      ),
    ) as {
      version: string;
      peerDependencies: Record<string, string>;
    };
    const scaffolded = JSON.parse(PACKAGE_JSON("my-app"));
    const cloudflare = JSON.parse(PACKAGE_JSON("my-app", "cloudflare"));

    expect(scaffolded.dependencies["@bascik/bascik"]).toBe(
      `^${pkgJson.version}`,
    );
    expect(scaffolded.devDependencies["@bascik/language-server"]).toBe(
      `^${lspJson.version}`,
    );
    expect(adapterJson.peerDependencies["@bascik/bascik"]).toBe(
      `^${pkgJson.version}`,
    );
    expect(cloudflare.devDependencies["@bascik/adapter-cloudflare"]).toBe(
      `^${adapterJson.version}`,
    );
  });

  it("uses the supplied name", () => {
    const pkg = JSON.parse(PACKAGE_JSON("cool-site"));
    expect(pkg.name).toBe("cool-site");
  });

  it("declares the same Node 22.18 engine floor as the bascik package", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.engines.node).toBe(">=22.18.0");
  });

  it("treats the default template the same as no template", () => {
    expect(PACKAGE_JSON("my-app", "default")).toBe(PACKAGE_JSON("my-app"));
  });

  it("leaves wrangler and the adapter out of the default template", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.devDependencies["@bascik/adapter-cloudflare"]).toBeUndefined();
    expect(pkg.devDependencies.wrangler).toBeUndefined();
    expect(pkg.scripts.preview).toBeUndefined();
    expect(pkg.scripts.deploy).toBeUndefined();
  });

  describe("cloudflare template", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app", "cloudflare"));

    it("builds the Cloudflare bundle and keeps the Bascik dev server as the authoring loop", () => {
      expect(pkg.scripts.dev).toBe("bascik");
      expect(pkg.scripts.build).toBe("bascik --build --target cloudflare");
    });

    it("previews and deploys from the emitted target directory", () => {
      expect(pkg.scripts.preview).toBe(
        "cd dist/.bascik/cloudflare && wrangler dev",
      );
      expect(pkg.scripts.deploy).toBe(
        "cd dist/.bascik/cloudflare && wrangler deploy",
      );
    });

    it("adds the adapter and a caret range on the current wrangler major", () => {
      expect(pkg.devDependencies["@bascik/adapter-cloudflare"]).toMatch(
        /^\^\d/,
      );
      expect(pkg.devDependencies.wrangler).toMatch(/^\^4\.\d+\.\d+$/);
    });

    it("keeps every default script and dependency", () => {
      const base = JSON.parse(PACKAGE_JSON("my-app"));
      for (const key of Object.keys(base.scripts)) {
        if (key !== "build") expect(pkg.scripts[key]).toBe(base.scripts[key]);
      }
      expect(pkg.dependencies).toEqual(base.dependencies);
      expect(pkg.devDependencies).toMatchObject(base.devDependencies);
      expect(pkg.engines).toEqual(base.engines);
    });
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
    expect(PLAYWRIGHT_CONFIG).toContain(
      "npx bascik --build && npx bascik --server --port 8080",
    );
  });

  it("misuse: the webServer runs from the project root, not from e2e/ where Playwright starts it beside the config", () => {
    // Playwright runs webServer.command in the config file's directory, and
    // `npm run e2e` points it at e2e/playwright.config.ts: without a cwd the
    // build looks for e2e/src/pages and the run fails before any test.
    expect(PLAYWRIGHT_CONFIG).toMatch(
      /webServer:\s*\{[^}]*\bcwd:\s*(['"])\.\.\1/,
    );
  });
});

describe("E2E_APP_SPEC", () => {
  it("includes tests for navigation, counter, and mobile menu toggle", () => {
    expect(E2E_APP_SPEC).toContain("navigates pages and checks titles");
    expect(E2E_APP_SPEC).toContain(
      "counter component increments and decrements count",
    );
    expect(E2E_APP_SPEC).toContain(
      "mobile navigation toggle expands and collapses menu",
    );
  });

  it("misuse: the mobile navigation test asserts the menu's visibility, never the literal is-open class the build scopes away", () => {
    for (const spec of [E2E_APP_SPEC, CLOUDFLARE_E2E_APP_SPEC]) {
      expect(spec).not.toMatch(/toHaveClass\(\s*\/is-open\//);
      expect(spec).not.toContain("'is-open'");
      expect(spec).toContain("await expect(menu).toBeVisible();");
      expect(spec).toContain("await expect(menu).toBeHidden();");
    }
  });

  it("does not mention the edge page", () => {
    expect(E2E_APP_SPEC).not.toContain("/edge");
    // The feature cards' body rules reach the slot content in the browser.
    for (const spec of [E2E_APP_SPEC, CLOUDFLARE_E2E_APP_SPEC])
      expect(spec).toContain(
        "feature card styles the title and text passed through its slot",
      );
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain(
      "await expect(page.getByTestId('edge-greeting')).toHaveCSS('font-size', '16px');",
    );
    expect(E2E_APP_SPEC.endsWith("  });\n});\n")).toBe(true);
  });
});

describe("CLOUDFLARE_E2E_APP_SPEC", () => {
  it("extends the default spec with an edge page test", () => {
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain(
      "mobile navigation toggle expands and collapses menu",
    );
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain("page.goto('/edge?name=Ada')");
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain("getByTestId('edge-greeting')");
    expect(CLOUDFLARE_E2E_APP_SPEC.endsWith("  });\n});\n")).toBe(true);
  });

  it("asserts the <feat-card> the server script returns is rendered, not sent as a tag", () => {
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain("getByTestId('edge-card')");
    // The component's scoped CSS reached the browser: .fcard is a flex column.
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain(
      "toHaveCSS('flex-direction', 'column')",
    );
    expect(CLOUDFLARE_E2E_APP_SPEC).toContain(
      "expect(html).not.toContain('<feat-card')",
    );
  });
});

describe("VSCODE_LAUNCH_JSON", () => {
  it("is valid JSON and configures dev server and Chrome debugging", () => {
    expect(() => JSON.parse(VSCODE_LAUNCH_JSON)).not.toThrow();
    const config = JSON.parse(VSCODE_LAUNCH_JSON);
    expect(config.version).toBe("0.2.0");
    expect(
      config.configurations.some((c: { name: string }) =>
        c.name.includes("Debug Dev Server"),
      ),
    ).toBe(true);
    expect(
      config.configurations.some((c: { name: string }) =>
        c.name.includes("Launch Chrome"),
      ),
    ).toBe(true);
  });
});

describe("GITIGNORE", () => {
  it("ignores node_modules, dist, coverage, and pem files", () => {
    expect(GITIGNORE).toContain("node_modules/");
    expect(GITIGNORE).toContain("dist/");
    expect(GITIGNORE).toContain("coverage/");
    expect(GITIGNORE).toContain(".pem");
  });

  it("does not ignore .wrangler/ in the default template", () => {
    expect(GITIGNORE).not.toContain(".wrangler/");
  });
});

describe("CLOUDFLARE_GITIGNORE", () => {
  it("adds .wrangler/ after every default entry", () => {
    expect(CLOUDFLARE_GITIGNORE.startsWith(GITIGNORE)).toBe(true);
    expect(CLOUDFLARE_GITIGNORE).toBe(`${GITIGNORE}.wrangler/\n`);
  });
});

describe("edgePage", () => {
  const html = edgePage("My App");

  it("uses the shared page shell with the brand", () => {
    expect(html).toContain("<title>Edge - My App</title>");
    expect(html).toContain("<site-meta />");
    expect(html).toContain('<site-header data-bascik-prop-brand="My App" />');
    expect(html).toContain('<site-footer data-bascik-prop-brand="My App" />');
  });

  it("renders the greeting from a data-bascik-server script with a default export", () => {
    expect(html).toContain("<script data-bascik-server>");
    expect(html).toContain("export default function (request)");
    expect(html).toContain('searchParams.get("name")');
    expect(html).toContain('data-testid="edge-greeting"');
  });

  it("returns the starter's <feat-card> around the greeting, so the Worker renders a component per request", () => {
    // The tag is only in the script's returned string: this page does not
    // use <feat-card> in its own markup, so the card is rendered at request
    // time, with the header, default, and footer slots filled.
    const script = html.slice(
      html.indexOf("<script data-bascik-server>"),
      html.indexOf("</script>"),
    );
    expect(script).toContain('<feat-card data-testid="edge-card">');
    expect(script).toContain('<div data-bascik-slot="header">');
    expect(script).toContain('<div data-bascik-slot="footer">');
    expect(script).toContain("</feat-card>");
    expect(script.indexOf('data-testid="edge-greeting"')).toBeGreaterThan(
      script.indexOf("<feat-card"),
    );
    expect(script.indexOf('data-testid="edge-greeting"')).toBeLessThan(
      script.indexOf("</feat-card>"),
    );
    expect(html.replace(script, "")).not.toContain("<feat-card");
  });

  it("does not skip a heading level between the page h1 and the card's h3", () => {
    // The card styles an h3 greeting, so an h2 sits between it and the h1.
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) =>
      Number(m[1]),
    );
    expect(levels).toEqual([1, 2, 3]);
  });

  it("escapes the query parameter with html from @bascik/bascik/html, not a handwritten escaper", () => {
    const script = html.slice(
      html.indexOf("<script data-bascik-server>"),
      html.indexOf("</script>"),
    );
    expect(script).toContain('import { html } from "@bascik/bascik/html";');
    expect(script).toMatch(/return html`/);
    expect(script).toContain("${name}");
    expect(script).not.toContain('"&": "&amp;"');
    expect(script).not.toMatch(/const escape\b/);
    // One template, so no string concatenation of markup around the value.
    expect(script).not.toMatch(/'\s*\+\s*\w+\(?name/);
  });

  it("links to the API route", () => {
    expect(html).toContain('href="/api/hello"');
    expect(html).toContain("src/api/hello.ts");
  });
});

describe("HELLO_API_ROUTE", () => {
  it("exports a GET handler returning JSON that names the host platform", () => {
    expect(HELLO_API_ROUTE).toContain("export const GET = async (");
    expect(HELLO_API_ROUTE).toContain("request: Request");
    expect(HELLO_API_ROUTE).toContain("Promise<Response>");
    expect(HELLO_API_ROUTE).toContain("Response.json({");
    expect(HELLO_API_ROUTE).toContain("context.platform?.name");
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

  it("uses a build-once script for the year", () => {
    expect(SITE_FOOTER_HTML).toContain("<script data-bascik-build-once>");
    expect(SITE_FOOTER_HTML).toContain("export default () =>");
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

  it("misuse: styles the slot content's h3 and p through :is(), since scoping turns a bare element selector into a class the usage site's elements never carry", () => {
    // `.fcard-body h3` scopes to `.<fcard-body> .<h3>`, a class only the
    // component's own <h3> elements get; slot content keeps plain tags.
    expect(FEAT_CARD_CSS).not.toMatch(/\.fcard-[a-z]+ +[a-z][a-z0-9]* *[{,]/);
    expect(FEAT_CARD_CSS).toMatch(
      /\.fcard-body :is\(h3\) \{[^}]*font-size: 1rem/,
    );
    expect(FEAT_CARD_CSS).toMatch(
      /\.fcard-body :is\(p\) \{[^}]*font-size: 0\.88rem/,
    );
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

  it("indexPage adds an edge feature card only for the cloudflare template", () => {
    const plain = indexPage("My App");
    const cloudflare = indexPage("My App", { template: "cloudflare" });
    expect(plain).not.toContain('href="/edge"');
    expect(plain.match(/<feat-card>/g)).toHaveLength(3);
    expect(indexPage("My App", { template: "default" })).toBe(plain);
    expect(cloudflare).toContain('href="/edge"');
    expect(cloudflare.match(/<feat-card>/g)).toHaveLength(4);
    // The extra card is an insertion: everything else on the page is unchanged.
    const edgeCard =
      /\n\s*<feat-card>\s*<div data-bascik-slot="header">Edge<\/div>[\s\S]*?<\/feat-card>/;
    expect(cloudflare.replace(edgeCard, "")).toBe(plain);
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
    const dirs = mockMkdir.mock.calls.map((c) =>
      String(c[0]).replace(/\\/g, "/"),
    );
    expect(dirs.some((d) => d.endsWith(".agents/skills"))).toBe(true);
    expect(dirs.some((d) => d.endsWith(".claude/skills"))).toBe(true);
    expect(dirs.some((d) => d.endsWith("e2e"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/assets"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/css"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-header"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-footer"))).toBe(true);
    expect(dirs.some((d) => d.includes("my-counter"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-meta"))).toBe(true);
  });

  it("writes all 26 expected files", async () => {
    await scaffold("my-app", "/tmp");
    expect(mockWriteFile.mock.calls.length).toBe(26);
  });

  it("writes E2E config and spec files", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths();
    expect(paths.some((p) => p.endsWith("e2e/playwright.config.ts"))).toBe(
      true,
    );
    expect(paths.some((p) => p.endsWith("e2e/app.spec.ts"))).toBe(true);
  });

  it("copies the bundled agent skills into .agents/skills and .claude/skills", async () => {
    await scaffold("my-app", "/tmp");
    expect(mockCp).toHaveBeenCalledTimes(2);
    const destinations = mockCp.mock.calls.map((c) =>
      String(c[1]).replace(/\\/g, "/"),
    );
    expect(destinations).toEqual([
      "/tmp/my-app/.agents/skills",
      "/tmp/my-app/.claude/skills",
    ]);
    for (const call of mockCp.mock.calls) {
      expect(call[0]).toBe(SKILLS_DIR);
      expect(call[2]).toMatchObject({ recursive: true });
    }
  });

  it("skips only the README at the root of the bundled skills folder", async () => {
    await scaffold("my-app", "/tmp");
    const { filter } = mockCp.mock.calls[0][2] as {
      filter: (source: string) => boolean;
    };
    expect(filter(`${SKILLS_DIR}/README.md`)).toBe(false);
    expect(filter(`${SKILLS_DIR}/bascik/SKILL.md`)).toBe(true);
    expect(filter(`${SKILLS_DIR}/bascik/references/README.md`)).toBe(true);
    expect(filter(SKILLS_DIR)).toBe(true);
  });

  it("no longer writes skills into .github/skills", async () => {
    await scaffold("my-app", "/tmp");
    expect(allWrittenPaths().some((p) => p.includes(".github/skills"))).toBe(
      false,
    );
    expect(
      mockMkdir.mock.calls.some((c) => String(c[0]).includes(".github/skills")),
    ).toBe(false);
  });

  it("writes root config files", async () => {
    await scaffold("my-app", "/tmp");
    expect(writtenTo("package.json")).toBeDefined();
    expect(writtenTo("bascik.config.ts")).toBeUndefined();
    expect(writtenTo("vite.config.js")).toBeDefined();
    expect(writtenTo(".gitignore")).toBeDefined();
    expect(writtenTo(".hintrc")).toBeUndefined();
    expect(writtenTo(".vscode/launch.json")).toBeDefined();
    const extensionsJson = writtenTo(".vscode/extensions.json");
    expect(extensionsJson).toBeDefined();
    expect(JSON.parse(extensionsJson!).recommendations).toContain(
      "bascik.bascik-vscode",
    );
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
    expect(allWrittenPaths().some((p) => p.endsWith("favicon-32x32.png"))).toBe(
      true,
    );
    expect(
      allWrittenPaths().some((p) => p.endsWith("apple-touch-icon.png")),
    ).toBe(true);
    expect(allWrittenPaths().some((p) => p.endsWith("favicon.svg"))).toBe(true);
  });

  it("scopes everything under targetDir/projectName", async () => {
    await scaffold("cool-site", "/projects");
    expect(
      allWrittenPaths().every((p) => p.startsWith("/projects/cool-site")),
    ).toBe(true);
  });

  it("uses cwd as default targetDir", async () => {
    await scaffold("app");
    expect(allWrittenPaths().every((p) => p.includes("app"))).toBe(true);
  });

  it("injects the project name into the index page", async () => {
    await scaffold("hello-world", "/tmp");
    const indexCall = mockWriteFile.mock.calls.find((c) =>
      String(c[0]).endsWith("index.html"),
    );
    expect(indexCall?.[1]).toContain("hello-world");
  });

  const writtenFiles = (): Map<string, string> =>
    new Map(
      mockWriteFile.mock.calls.map((c) => [
        String(c[0]).replace(/\\/g, "/"),
        typeof c[1] === "string" ? c[1] : Buffer.from(c[1]).toString("base64"),
      ]),
    );

  it("writes the same files for an explicit default template as for none", async () => {
    await scaffold("my-app", "/tmp");
    const implicit = writtenFiles();
    vi.clearAllMocks();
    await scaffold("my-app", "/tmp", { template: "default" });
    expect(writtenFiles()).toEqual(implicit);
    expect(
      mockMkdir.mock.calls.some((c) => String(c[0]).endsWith("src/api")),
    ).toBe(false);
  });

  it("keeps the Cloudflare pieces out of the default template", async () => {
    await scaffold("my-app", "/tmp");
    const files = writtenFiles();
    expect(allWrittenPaths().some((p) => p.endsWith("edge.html"))).toBe(false);
    expect(allWrittenPaths().some((p) => p.includes("src/api/"))).toBe(false);
    expect(files.get("/tmp/my-app/package.json")).not.toContain("wrangler");
    expect(files.get("/tmp/my-app/.gitignore")).not.toContain(".wrangler/");
    expect(files.get("/tmp/my-app/src/pages/index.html")).not.toContain(
      "/edge",
    );
    expect(files.get("/tmp/my-app/e2e/app.spec.ts")).not.toContain("/edge");
  });

  describe("cloudflare template", () => {
    beforeEach(() => scaffold("my-app", "/tmp", { template: "cloudflare" }));

    it("writes the 26 default files plus the edge page and API route", () => {
      expect(mockWriteFile.mock.calls.length).toBe(28);
      const paths = allWrittenPaths();
      expect(paths).toContain("/tmp/my-app/src/pages/edge.html");
      expect(paths).toContain("/tmp/my-app/src/api/hello.ts");
    });

    it("creates the src/api directory", () => {
      expect(
        mockMkdir.mock.calls.some((c) =>
          String(c[0]).replace(/\\/g, "/").endsWith("/tmp/my-app/src/api"),
        ),
      ).toBe(true);
    });

    it("writes the Cloudflare package.json, .gitignore, index page, and E2E spec", () => {
      const files = writtenFiles();
      expect(files.get("/tmp/my-app/package.json")).toBe(
        PACKAGE_JSON("my-app", "cloudflare"),
      );
      expect(files.get("/tmp/my-app/.gitignore")).toBe(CLOUDFLARE_GITIGNORE);
      expect(files.get("/tmp/my-app/src/pages/index.html")).toBe(
        indexPage("my-app", { template: "cloudflare" }),
      );
      expect(files.get("/tmp/my-app/src/pages/edge.html")).toBe(
        edgePage("my-app"),
      );
      expect(files.get("/tmp/my-app/src/api/hello.ts")).toBe(HELLO_API_ROUTE);
      expect(files.get("/tmp/my-app/e2e/app.spec.ts")).toBe(
        CLOUDFLARE_E2E_APP_SPEC,
      );
    });

    it("still copies the agent skills to both destinations", () => {
      expect(mockCp).toHaveBeenCalledTimes(2);
    });
  });
});
