import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { USAGE, parseCliOptions } from "./cli.js";
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
  CONTACT_FORM_HTML,
  CONTACT_FORM_CSS,
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
  VSCODE_SETTINGS_JSON,
  aboutPage,
  contactPage,
  edgePage,
  MANUAL_SETUP_URL,
  ScaffoldTargetError,
  indexPage,
  notFoundPage,
  packageNameOf,
  scaffold,
  siteNameOf,
  validateProjectName,
} from "./scaffold.js";
import { CLAUDE_MD, agentsMd } from "./agent-setup.js";
import { parseJsonc } from "./vscode-settings.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const enoent = (): never => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  // The project folder does not exist yet unless a test says otherwise.
  stat: vi.fn(async () => enoent()),
  lstat: vi.fn(async () => enoent()),
  // A new project folder has no files yet, so every read finds nothing.
  readFile: vi.fn(async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFile: vi.fn(async () => undefined),
}));

import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";

const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockStat = stat as ReturnType<typeof vi.fn>;
const mockLstat = lstat as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
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
      noSkillsFlag: false,
      template: undefined,
      projectName: "my-site",
      helpFlag: false,
    });
  });

  it("supports bounded non-interactive scaffolding without changing install behavior", () => {
    expect(parseCliOptions(["my-site", "--yes", "--no-dev"])).toEqual({
      yesFlag: true,
      noDevFlag: true,
      noInstallFlag: false,
      noSkillsFlag: false,
      template: undefined,
      projectName: "my-site",
      helpFlag: false,
    });
  });

  it("supports skipping install with --no-install", () => {
    expect(
      parseCliOptions(["my-site", "-y", "--no-install", "--no-dev"]),
    ).toEqual({
      yesFlag: true,
      noDevFlag: true,
      noInstallFlag: true,
      noSkillsFlag: false,
      template: undefined,
      projectName: "my-site",
      helpFlag: false,
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
      noSkillsFlag: false,
      template: undefined,
      projectName: "my-site",
      helpFlag: false,
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

  it("accepts a relative path, a scoped name and capitals", () => {
    expect(validateProjectName("sites/my-site")).toBeNull();
    expect(validateProjectName("@acme/site")).toBeNull();
    expect(validateProjectName("MySite")).toBeNull();
  });

  it.each([".", "..", "../sibling", "a/../..", "sites/./x"])(
    "misuse: refuses %j, which writes into the current or a parent folder, and points at the manual setup",
    (name) => {
      const res = validateProjectName(name);
      expect(res).toContain('"." or ".."');
      expect(res).toContain(MANUAL_SETUP_URL);
    },
  );

  it("misuse: refuses an absolute path, which would be created under the current folder instead", () => {
    expect(validateProjectName("/tmp/site")).toContain("is an absolute path");
  });

  it.each(["my site", " my-site", "my-site "])(
    "misuse: refuses %j, with a space the printed cd command and npm cannot use",
    (name) => {
      expect(validateProjectName(name)).toContain("contains a space");
    },
  );

  it("suggests the dashed name for a name with spaces", () => {
    expect(validateProjectName("my  site")).toContain('"my-site"');
  });

  it.each(["a//b", "my-site/"])(
    "misuse: refuses %j, which has an empty path segment",
    (name) => {
      expect(validateProjectName(name)).toContain("empty path segment");
    },
  );

  it("misuse: refuses a hidden folder name", () => {
    expect(validateProjectName(".site")).toContain('with "."');
  });
});

describe("packageNameOf and siteNameOf", () => {
  it("uses the name as it is when it is already a package name", () => {
    expect(packageNameOf("my-site")).toBe("my-site");
    expect(siteNameOf("my-site")).toBe("my-site");
  });

  it("lowercases the package name and keeps the site name's capitals", () => {
    expect(packageNameOf("MySite")).toBe("mysite");
    expect(siteNameOf("MySite")).toBe("MySite");
  });

  it("uses the last segment of a nested path", () => {
    expect(packageNameOf("sites/My-Site")).toBe("my-site");
    expect(siteNameOf("sites/My-Site")).toBe("My-Site");
  });

  it("keeps a scoped name scoped", () => {
    expect(packageNameOf("@Acme/Site")).toBe("@acme/site");
  });

  it("drops a leading underscore, which npm does not allow", () => {
    expect(packageNameOf("_site")).toBe("site");
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

  it("declares the same Node 22.22 engine floor as the bascik package", () => {
    const pkg = JSON.parse(PACKAGE_JSON("my-app"));
    expect(pkg.engines.node).toBe(">=22.22.0");
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

  it("misuse: imports defineConfig from vitest/config, not vite, which the project does not declare", () => {
    expect(VITE_CONFIG).toContain(
      "import { defineConfig } from 'vitest/config';",
    );
  });

  it("misuse: every package the generated configs import is declared in the generated package.json", () => {
    for (const template of ["default", "cloudflare"] as const) {
      const pkg = JSON.parse(PACKAGE_JSON("my-app", template));
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]);
      for (const config of [VITE_CONFIG, PLAYWRIGHT_CONFIG]) {
        for (const [, spec] of config.matchAll(/\bfrom\s+'([^'.][^']*)'/g)) {
          if (spec.startsWith("node:")) continue;
          const parts = spec.split("/");
          const name = spec.startsWith("@")
            ? parts.slice(0, 2).join("/")
            : parts[0];
          expect(declared, `${template}: ${spec}`).toContain(name);
        }
      }
    }
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

  it("misuse: gives the e2e build the URL it serves, so a fresh project without BASCIK_SITE_URL still builds its sitemap", () => {
    expect(PLAYWRIGHT_CONFIG).toMatch(
      /webServer:\s*\{[^}]*\benv:\s*\{\s*BASCIK_SITE_URL:\s*'http:\/\/localhost:8080'/,
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

  it("finds only test ids the starter's components and pages write", () => {
    const markup = [
      SITE_HEADER_HTML,
      SITE_FOOTER_HTML,
      FEAT_CARD_HTML,
      MY_COUNTER_HTML,
      CONTACT_FORM_HTML,
      indexPage("My App", { template: "cloudflare" }),
      aboutPage("My App"),
      contactPage("My App"),
      notFoundPage("My App"),
      edgePage("My App"),
    ].join("\n");
    for (const spec of [E2E_APP_SPEC, CLOUDFLARE_E2E_APP_SPEC])
      for (const [, id] of spec.matchAll(/getByTestId\('([^']+)'\)/g))
        expect(markup, id).toContain(`data-testid="${id}"`);
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

  it("misuse: ignores the .env files Bascik loads, where secrets go, but keeps an example file", () => {
    const lines = GITIGNORE.split("\n");
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
    // A negation only works after the pattern it overrides.
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(
      lines.indexOf(".env.*"),
    );
    expect(CLOUDFLARE_GITIGNORE.split("\n")).toContain(".env");
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
    expect(html).toContain('<main id="main" data-testid="edge-main">');
    expect(html).toContain("<site-meta />");
    expect(html).toContain('<site-header data-bascik-prop-brand="My App" />');
    expect(html).toContain('<site-footer data-bascik-prop-brand="My App" />');
  });

  it("renders the greeting from a TypeScript data-bascik-server script with a default export", () => {
    expect(html).toContain(
      '<script data-bascik-server type="text/typescript">',
    );
    expect(html).toContain(
      "export default function (request: Request): string",
    );
    expect(html).toContain('searchParams.get("name")');
    expect(html).toContain('data-testid="edge-greeting"');
  });

  it("returns the starter's <feat-card> around the greeting, so the Worker renders a component per request", () => {
    // The tag is only in the script's returned string: this page does not
    // use <feat-card> in its own markup, so the card is rendered at request
    // time, with the header, default, and footer slots filled.
    const script = html.slice(
      html.indexOf('<script data-bascik-server type="text/typescript">'),
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
      html.indexOf('<script data-bascik-server type="text/typescript">'),
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

describe("semantic HTML in the starter", () => {
  const brand = "Milk frother";
  const pages = {
    index: indexPage(brand),
    about: aboutPage(brand),
    contact: contactPage(brand),
    notFound: notFoundPage(brand),
  };
  const levels = (html: string) =>
    [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));

  it('every page has lang, a <main id="main"> for the skip link with a test id named for the page, and one <h1>', () => {
    const testIds = {
      index: "home-main",
      about: "about-main",
      contact: "contact-main",
      notFound: "404-main",
    };
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toContain('<html lang="en">');
      expect(html.match(/<main id="main"[^>]*>/g), name).toEqual([
        `<main id="main" data-testid="${testIds[name as keyof typeof testIds]}">`,
      ]);
      expect(html.match(/<h1[\s>]/g), name).toHaveLength(1);
    }
  });

  it("no page skips a heading level, counting the headings it passes into <feat-card>", () => {
    for (const [name, html] of Object.entries(pages)) {
      let previous = 1;
      for (const level of levels(html)) {
        expect(
          level,
          `${name}: h${level} after h${previous}`,
        ).toBeLessThanOrEqual(previous + 1);
        previous = level;
      }
    }
    expect(levels(pages.about)).toEqual([1, 2, 2]);
  });

  it("the 404 page's <h1> names the page, and the code is not a heading", () => {
    expect(pages.notFound).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(pages.notFound).not.toMatch(/<h[1-6][^>]*>404<\/h[1-6]>/);
  });

  it("the header starts with a skip link to #main, names its nav, and its menu button is a real toggle", () => {
    const skip = SITE_HEADER_HTML.indexOf('href="#main"');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(SITE_HEADER_HTML.indexOf("<nav"));
    expect(SITE_HEADER_HTML).toMatch(
      /<a href="#main" class="skip-link"[^>]*>Skip to content<\/a>/,
    );
    expect(SITE_HEADER_CSS).toMatch(/\.skip-link:focus/);
    expect(SITE_HEADER_HTML).toMatch(/<nav class="nav" aria-label="Main"[\s>]/);
    const toggle = /<button id="nav-toggle"[^>]*>/.exec(SITE_HEADER_HTML)![0];
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('aria-controls="nav-menu"');
    expect(toggle).toContain('aria-expanded="false"');
  });

  it("the counter's buttons are type=button with names a screen reader reads, and the count is announced", () => {
    for (const id of ["btn-dec", "btn-inc"]) {
      const button = new RegExp(`<button id="${id}"[^>]*>`).exec(
        MY_COUNTER_HTML,
      )![0];
      expect(button, id).toContain('type="button"');
      expect(button, id).toMatch(/aria-label="(Decrease|Increase)"/);
    }
    expect(MY_COUNTER_HTML).toMatch(
      /<output id="count-val"[^>]*aria-live="polite"/,
    );
    expect(MY_COUNTER_HTML).toMatch(/role="group" aria-label="Counter"/);
  });

  it("the card styles the h2 and h3 that pages pass into its body", () => {
    expect(FEAT_CARD_CSS).toMatch(/\.fcard-body :is\(h2, h3\) \{/);
  });
});

describe("the starter does not rely on name scoping", () => {
  // `name` ships as written by default, so the contact form's keys are its
  // literal names: no data-bascik-preserve, no getElementsByName, and no radio
  // group that would need a <form> of its own per copy.
  it("CONTACT_FORM_HTML names its fields with literal keys inside its own form", () => {
    expect(CONTACT_FORM_HTML).not.toContain("data-bascik-preserve");
    expect(CONTACT_FORM_HTML).not.toContain("getElementsByName");
    for (const key of ["name", "email", "message"])
      expect(CONTACT_FORM_HTML).toContain(`name="${key}"`);
    const openAt = CONTACT_FORM_HTML.indexOf("<form");
    const closeAt = CONTACT_FORM_HTML.indexOf("</form>");
    for (const match of CONTACT_FORM_HTML.matchAll(/\sname="/g))
      expect(match.index).toBeGreaterThan(openAt);
    expect(
      [...CONTACT_FORM_HTML.matchAll(/\sname="/g)].every(
        (match) => match.index! < closeAt,
      ),
    ).toBe(true);
    expect(CONTACT_FORM_HTML).not.toMatch(/type="radio"/);
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

  it("includes button and card rules, and leaves form rules to <contact-form>", () => {
    expect(STYLES_CSS).toContain(".btn");
    expect(STYLES_CSS).toContain(".card");
    // A component's classes are scoped, so a global .form-group would never match its fields.
    expect(STYLES_CSS).not.toContain(".form-group");
    expect(CONTACT_FORM_CSS).toContain(".field input");
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

  it("uses a TypeScript build-once script for the year", () => {
    expect(SITE_FOOTER_HTML).toContain(
      '<script data-bascik-build-once type="text/typescript">',
    );
    expect(SITE_FOOTER_HTML).toContain("export default (): string =>");
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

  it("writes its script in TypeScript and leaves the per-instance wrapper to Bascik", () => {
    expect(MY_COUNTER_HTML).toContain('<script type="text/typescript">');
    expect(MY_COUNTER_HTML).toContain("let count: number = 0;");
    expect(MY_COUNTER_HTML).not.toMatch(/\(function\s*\(\)/);
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
      /\.fcard-body :is\(h2, h3\) \{[^}]*font-size: 1rem/,
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
    expect(html).toContain('<feat-card data-testid="feature-zero-runtime">');
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
    expect(plain.match(/<feat-card /g)).toHaveLength(3);
    expect(indexPage("My App", { template: "default" })).toBe(plain);
    expect(cloudflare).toContain('href="/edge"');
    expect(cloudflare.match(/<feat-card /g)).toHaveLength(4);
    // The extra card is an insertion: everything else on the page is unchanged.
    const edgeCard =
      /\n\s*<feat-card data-testid="feature-edge">\s*<div data-bascik-slot="header">Edge<\/div>[\s\S]*?<\/feat-card>/;
    expect(cloudflare.replace(edgeCard, "")).toBe(plain);
  });

  it("aboutPage composes two <feat-card> components with test ids", () => {
    const html = aboutPage("My App");
    expect(html).toContain("<site-header");
    expect(html).toContain('<feat-card data-testid="about-mission">');
    expect(html).toContain('<feat-card data-testid="about-approach">');
    expect(html).not.toContain('class="card"');
    expect(html).toContain("/contact");
  });

  it("contactPage places the <contact-form> component, which has the name, email, and message fields", () => {
    const html = contactPage("My App");
    expect(html).toContain("<contact-form />");
    expect(html).not.toContain("onsubmit");
    expect(CONTACT_FORM_HTML).toContain('<input type="text"');
    expect(CONTACT_FORM_HTML).toContain('<input type="email"');
    expect(CONTACT_FORM_HTML).toContain("<textarea");
    expect(CONTACT_FORM_HTML).toContain('<script type="text/typescript">');
  });

  it.each([
    [
      "SITE_HEADER_HTML",
      SITE_HEADER_HTML,
      [
        "site-header",
        "site-header-skip-link",
        "site-header-nav",
        "site-header-logo",
        "site-header-nav-toggle",
        "site-header-nav-menu",
        "site-header-home",
        "site-header-about",
        "site-header-contact",
      ],
    ],
    [
      "SITE_FOOTER_HTML",
      SITE_FOOTER_HTML,
      [
        "site-footer",
        "site-footer-nav",
        "site-footer-home",
        "site-footer-about",
        "site-footer-contact",
      ],
    ],
    [
      "MY_COUNTER_HTML",
      MY_COUNTER_HTML,
      ["my-counter", "my-counter-dec", "my-counter-value", "my-counter-inc"],
    ],
    [
      "CONTACT_FORM_HTML",
      CONTACT_FORM_HTML,
      [
        "contact-form",
        "contact-form-name",
        "contact-form-email",
        "contact-form-message",
        "contact-form-submit",
        "contact-form-status",
      ],
    ],
  ])(
    "%s gives its root and interactive parts a data-testid",
    (_name, html, ids) => {
      for (const id of ids) expect(html).toContain(`data-testid="${id}"`);
      // Every test id names its component: the root's is the component name, and each part's starts with it.
      const component = ids[0];
      for (const [, id] of html.matchAll(/data-testid="([^"]+)"/g))
        expect(id === component || id.startsWith(`${component}-`), id).toBe(
          true,
        );
    },
  );

  it("gives <feat-card>'s root a data-testid, which each usage's own data-testid replaces", () => {
    expect(FEAT_CARD_HTML).toMatch(
      /<article class="fcard" data-testid="feat-card">/,
    );
  });

  it("writes every component script in TypeScript", () => {
    for (const html of [SITE_HEADER_HTML, MY_COUNTER_HTML, CONTACT_FORM_HTML])
      expect(html.match(/<script\b[^>]*>/gi)).toEqual([
        '<script type="text/typescript">',
      ]);
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("creates all component, page, and e2e directories", async () => {
    await scaffold("my-app", "/tmp");
    const dirs = mockMkdir.mock.calls.map((c) =>
      String(c[0]).replace(/\\/g, "/"),
    );
    // The skills CLI creates the skills folders when the reader says yes.
    expect(dirs.some((d) => d.includes("skills"))).toBe(false);
    expect(dirs.some((d) => d.endsWith("e2e"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/assets"))).toBe(true);
    expect(dirs.some((d) => d.includes("src/pages/css"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-header"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-footer"))).toBe(true);
    expect(dirs.some((d) => d.includes("my-counter"))).toBe(true);
    expect(dirs.some((d) => d.includes("site-meta"))).toBe(true);
  });

  it("writes all 31 expected files", async () => {
    await scaffold("my-app", "/tmp");
    expect(mockWriteFile.mock.calls.length).toBe(31);
  });

  it("writes E2E config and spec files", async () => {
    await scaffold("my-app", "/tmp");
    const paths = allWrittenPaths();
    expect(paths.some((p) => p.endsWith("e2e/playwright.config.ts"))).toBe(
      true,
    );
    expect(paths.some((p) => p.endsWith("e2e/app.spec.ts"))).toBe(true);
  });

  it("writes AGENTS.md and a CLAUDE.md that imports it, with the template's preview command", async () => {
    await scaffold("my-app", "/tmp");
    expect(writtenTo("/tmp/my-app/AGENTS.md")).toBe(agentsMd());
    expect(writtenTo("/tmp/my-app/CLAUDE.md")).toBe(CLAUDE_MD);
    vi.clearAllMocks();
    await scaffold("edge-app", "/tmp", { template: "cloudflare" });
    expect(writtenTo("/tmp/edge-app/AGENTS.md")).toBe(
      agentsMd({ template: "cloudflare" }),
    );
  });

  it("merges into an AGENTS.md and CLAUDE.md the folder already has, and notes what it added", async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      const file = String(path).replace(/\\/g, "/");
      if (file.endsWith("/AGENTS.md")) return "# Team rules\n";
      if (file.endsWith("/CLAUDE.md")) return "# Notes\n";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const { notes } = await scaffold("my-app", "/tmp");
    expect(writtenTo("AGENTS.md")).toMatch(/^# Team rules\n\n## Bascik\n/);
    expect(writtenTo("CLAUDE.md")).toBe("# Notes\n\n@AGENTS.md\n");
    expect(notes).toContain('AGENTS.md: added a "## Bascik" section');
    expect(notes).toContain("CLAUDE.md: added @AGENTS.md");
  });

  it("no longer copies agent skills: the CLI installs them with the skills CLI", async () => {
    await scaffold("my-app", "/tmp");
    expect(allWrittenPaths().some((p) => p.includes("skills/"))).toBe(false);
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
    expect(writtenTo(".vscode/settings.json")).toBe(VSCODE_SETTINGS_JSON);
  });

  for (const template of ["default", "cloudflare"] as const) {
    it(`turns off VS Code's inline-script check in the ${template} template`, async () => {
      await scaffold("my-app", "/tmp", { template });
      const settings = writtenTo(".vscode/settings.json");
      expect(parseJsonc(settings!)).toEqual({
        "html.validate.scripts": false,
      });
      expect(JSON.parse(writtenTo(".vscode/extensions.json")!)).toEqual({
        recommendations: ["bascik.bascik-vscode"],
      });
    });
  }

  it("misuse: merges into .vscode files the target folder already has", async () => {
    const existing: Record<string, string> = {
      "settings.json": '{\n  // mine\n  "editor.tabSize": 4\n}\n',
      "extensions.json": '{ "recommendations": ["esbenp.prettier-vscode"] }',
    };
    mockReadFile.mockImplementation(async (path: unknown) => {
      const name = String(path).replace(/\\/g, "/").split("/").pop()!;
      if (String(path).includes(".vscode") && name in existing) {
        return existing[name];
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const result = await scaffold("my-app", "/tmp");
    const settings = writtenTo(".vscode/settings.json")!;
    expect(settings).toContain("// mine");
    expect(parseJsonc(settings)).toEqual({
      "html.validate.scripts": false,
      "editor.tabSize": 4,
    });
    expect(parseJsonc(writtenTo(".vscode/extensions.json")!)).toEqual({
      recommendations: ["bascik.bascik-vscode", "esbenp.prettier-vscode"],
    });
    expect(result.notes.join("\n")).toContain(
      '.vscode/settings.json: added "html.validate.scripts": false',
    );
  });

  it("misuse: leaves an unreadable settings file alone and says what to add", async () => {
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (String(path).replace(/\\/g, "/").endsWith(".vscode/settings.json")) {
        return "{ broken";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const result = await scaffold("my-app", "/tmp");
    expect(writtenTo(".vscode/settings.json")).toBeUndefined();
    expect(result.notes.join("\n")).toContain('"html.validate.scripts": false');
  });

  it("misuse: keeps a launch.json the target folder already has", async () => {
    mockWriteFile.mockImplementation(async (path: unknown, _data, options) => {
      if (
        String(path).replace(/\\/g, "/").endsWith(".vscode/launch.json") &&
        (options as { flag?: string } | undefined)?.flag === "wx"
      ) {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
    });
    const result = await scaffold("my-app", "/tmp");
    mockWriteFile.mockImplementation(async () => undefined);
    const launchCall = mockWriteFile.mock.calls.find((c) =>
      String(c[0]).replace(/\\/g, "/").endsWith(".vscode/launch.json"),
    );
    expect(launchCall?.[2]).toMatchObject({ flag: "wx" });
    expect(result.notes).toEqual([]);
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

  describe("an existing target folder", () => {
    /** Make `paths` (relative to /tmp/my-app, "" for the folder itself) exist; a trailing "/" makes a folder. */
    const existing = (paths: string[]) => {
      const lookup = async (path: unknown) => {
        const rel = String(path)
          .replace(/\\/g, "/")
          .replace(/^\/tmp\/my-app\/?/, "");
        if (rel === "" && !paths.includes(""))
          return { isDirectory: () => true };
        if (paths.includes(`${rel}/`)) return { isDirectory: () => true };
        if (paths.includes(rel)) return { isDirectory: () => false };
        return enoent();
      };
      mockStat.mockImplementation(lookup);
      mockLstat.mockImplementation(lookup);
    };

    beforeEach(() => {
      mockStat.mockImplementation(async () => enoent());
      mockLstat.mockImplementation(async () => enoent());
    });

    it("misuse: refuses a folder that already has a package.json and pages, and writes nothing", async () => {
      existing(["package.json", "src/pages/index.html"]);
      await expect(scaffold("my-app", "/tmp")).rejects.toThrow(
        '"my-app" already has package.json, src/pages/index.html, which the starter would replace. Nothing was written.',
      );
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("misuse: the refusal is a ScaffoldTargetError that points at the manual setup", async () => {
      existing([".gitignore"]);
      const err = await scaffold("my-app", "/tmp").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScaffoldTargetError);
      expect((err as Error).message).toContain(MANUAL_SETUP_URL);
    });

    it("misuse: lists five files and counts the rest", async () => {
      existing([
        "package.json",
        "vite.config.js",
        ".gitignore",
        "e2e/playwright.config.ts",
        "e2e/app.spec.ts",
        "src/pages/index.html",
        "src/pages/about.html",
      ]);
      await expect(scaffold("my-app", "/tmp")).rejects.toThrow(
        /already has (?:[^,]+, ){4}[^,]+ and 2 more, which/,
      );
    });

    it("misuse: refuses a file where one of the starter's folders goes", async () => {
      existing(["src/pages/css"]);
      await expect(scaffold("my-app", "/tmp")).rejects.toThrow(
        '"my-app" already has src/pages/css,',
      );
    });

    it("misuse: refuses a project name that is an existing file", async () => {
      existing([""]);
      mockStat.mockImplementation(async (path: unknown) =>
        String(path).replace(/\\/g, "/") === "/tmp/my-app"
          ? { isDirectory: () => false }
          : enoent(),
      );
      await expect(scaffold("my-app", "/tmp")).rejects.toThrow(
        '"my-app" already exists and is not a folder.',
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("misuse: refuses the cloudflare starter's own files, which the default starter does not write", async () => {
      existing(["src/api/hello.ts"]);
      await expect(scaffold("my-app", "/tmp")).resolves.toBeDefined();
      vi.clearAllMocks();
      await expect(
        scaffold("my-app", "/tmp", { template: "cloudflare" }),
      ).rejects.toThrow('"my-app" already has src/api/hello.ts,');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("scaffolds into a folder that has only the files it merges into and its own empty folders", async () => {
      existing([
        "AGENTS.md",
        "CLAUDE.md",
        ".vscode/",
        ".vscode/settings.json",
        "README.md",
        ".git/",
        "src/",
        "src/pages/",
      ]);
      await scaffold("my-app", "/tmp");
      expect(writtenTo("/tmp/my-app/package.json")).toBeDefined();
      expect(mockWriteFile.mock.calls.length).toBe(31);
    });
  });

  it("names the package and brands the pages after the last segment of a nested name", async () => {
    await scaffold("sites/My-Site", "/tmp");
    expect(
      allWrittenPaths().every((p) => p.startsWith("/tmp/sites/My-Site/")),
    ).toBe(true);
    expect(JSON.parse(writtenTo("/tmp/sites/My-Site/package.json")!).name).toBe(
      "my-site",
    );
    const index = writtenTo("/tmp/sites/My-Site/src/pages/index.html")!;
    expect(index).toContain('data-bascik-prop-brand="My-Site"');
    expect(index).not.toContain("sites/My-Site");
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

    it("writes the 31 default files plus the edge page and API route", () => {
      expect(mockWriteFile.mock.calls.length).toBe(33);
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

    it("writes the brief with the Worker preview command", () => {
      expect(writtenFiles().get("/tmp/my-app/AGENTS.md")).toBe(
        agentsMd({ template: "cloudflare" }),
      );
    });
  });
});

describe("parseCliOptions --no-skills", () => {
  it("reads --no-skills, which skips the agent skills question and install", () => {
    expect(parseCliOptions(["my-site", "--no-skills"]).noSkillsFlag).toBe(true);
    expect(parseCliOptions(["my-site", "-y", "--no-skills"])).toMatchObject({
      yesFlag: true,
      noSkillsFlag: true,
      projectName: "my-site",
    });
  });

  it("honors npm's consumed --no-skills through npm_config_skills, as npm keeps flags written before --", () => {
    expect(
      parseCliOptions(["my-site"], { npm_config_skills: "false" }).noSkillsFlag,
    ).toBe(true);
    expect(
      parseCliOptions(["my-site"], { npm_config_skills: "true" }).noSkillsFlag,
    ).toBe(false);
  });

  it("misuse: honors --no-skills and --no-install written before --, which npm exports as empty npm_config_* values", () => {
    // What npm 11 sets for `npm create bascik my-site --no-skills --no-install`.
    expect(
      parseCliOptions(["my-site"], {
        npm_config_skills: "",
        npm_config_install: "",
      }),
    ).toMatchObject({ noSkillsFlag: true, noInstallFlag: true });
    expect(
      parseCliOptions(["my-site"], { npm_config_install: "false" })
        .noInstallFlag,
    ).toBe(true);
    expect(
      parseCliOptions(["my-site"], {
        npm_config_skills: "true",
        npm_config_install: "true",
      }),
    ).toMatchObject({ noSkillsFlag: false, noInstallFlag: false });
    expect(parseCliOptions(["my-site"], {})).toMatchObject({
      noSkillsFlag: false,
      noInstallFlag: false,
    });
  });

  it("misuse: a typo'd flag such as --no-skill is refused with the flag it meant, instead of installing the skills", () => {
    expect(() => parseCliOptions(["my-site", "--no-skill"])).toThrow(
      'Unknown option "--no-skill". Did you mean "--no-skills"?',
    );
    expect(() => parseCliOptions(["my-site", "--no-instal"])).toThrow(
      /Did you mean "--no-install"\?/,
    );
  });

  it.each([["--help"], ["-h"], ["my-site", "--help"], ["--no-skill", "-h"]])(
    "%s asks for help, which wins over everything else on the line",
    (...args) => {
      expect(parseCliOptions(args).helpFlag).toBe(true);
    },
  );

  it("documents every flag it accepts in the usage text", () => {
    for (const flag of [
      "--template",
      "-y",
      "--yes",
      "--no-skills",
      "--no-install",
      "--no-dev",
      "-h",
      "--help",
    ])
      expect(USAGE).toContain(flag);
    expect(USAGE).toContain(
      "npm create bascik@rc my-site -- --template cloudflare",
    );
  });

  it("misuse: --helps is refused, pointing at --help", () => {
    expect(() => parseCliOptions(["--helps"])).toThrow(
      'Unknown option "--helps". Did you mean "--help"?',
    );
  });

  it("misuse: an unrelated flag is refused with the list of flags and no guess", () => {
    expect(() =>
      parseCliOptions(["my-site", "--typescript-everywhere"]),
    ).toThrow(
      'Unknown option "--typescript-everywhere". create-bascik accepts -h, --help, -y, --yes, --no-install, --no-dev, --no-skills, --template.',
    );
  });
});
