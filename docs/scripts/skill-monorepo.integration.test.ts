// Builds a two-site monorepo the way the bascik-config skill and /how-to/monorepos describe it, then runs the skill's workspace checker
// and the core verify.mjs against it with the real compiler and linter.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SITE_URL, repoRoot, skillsDir } from "./example-fixtures.ts";

let dir: string;
const write = (path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const node = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, args, {
    cwd: join(dir, cwd),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", BASCIK_SITE_URL: SITE_URL },
    timeout: 120_000,
  });
const output = (result: { stdout: string; stderr: string }) =>
  `${result.stdout}\n${result.stderr}`;
const bascik = (site: string, args: string[]) =>
  node(`sites/${site}`, [
    join(dir, "node_modules/@bascik/bascik/bin/bascik.js"),
    ...args,
  ]);
const checkWorkspace = () =>
  node(".", [
    join(skillsDir, "bascik-config/scripts/check-workspace.mjs"),
    "--json",
  ]);
const verify = (site: string) =>
  node(`sites/${site}`, [join(skillsDir, "bascik/scripts/verify.mjs")]);

const page = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body><site-nav /><main id="main"><h1>${title}</h1></main></body>
</html>
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bascik-monorepo-"));
  for (const [name, target] of [
    ["@bascik/bascik", "pkg"],
    ["@bascik/language-server", "lsp"],
  ]) {
    mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
    symlinkSync(join(repoRoot, target), join(dir, "node_modules", name), "dir");
  }
  write(
    "package.json",
    JSON.stringify({ private: true, type: "module", workspaces: ["sites/*"] }),
  );
  write(
    "shared/lib/links.ts",
    'export const links = (): string => `<a href="/">Home</a><a href="/about">About</a>`;\n',
  );
  write("shared/styles/tokens.css", ":root { --brand: rebeccapurple; }\n");
  write(
    "shared/components/site-nav/site-nav.html",
    `<style>
  .nav { display: flex; gap: 1rem; color: var(--brand, currentColor); }
</style>
<nav class="nav" id="nav" aria-label="Main">
  <script data-bascik-build>
    import { links } from '../../lib/links.ts';
    export default () => links();
  </script>
</nav>
<script>
  const nav = document.getElementById('nav');
  nav.dataset.ready = 'true';
</script>
`,
  );
  for (const site of ["marketing", "docs"]) {
    write(
      `sites/${site}/package.json`,
      JSON.stringify({
        name: site,
        private: true,
        type: "module",
        dependencies: { "@bascik/bascik": "*" },
      }),
    );
    write(`sites/${site}/src/pages/index.html`, page(`${site} home page`));
    write(`sites/${site}/src/pages/about.html`, page(`About the ${site} site`));
  }
  write(
    "sites/marketing/bascik.config.ts",
    `import { defineConfig } from '@bascik/bascik/config';
export default defineConfig({
  directory: { components: ['src/components', '../../shared/components'] },
  pipeline: { watchPaths: ['../../shared/lib/'] },
});
`,
  );
  mkdirSync(join(dir, "sites/marketing/src/components"), { recursive: true });
  write(
    "sites/docs/bascik.config.ts",
    `import { defineConfig } from '@bascik/bascik/config';
export default defineConfig({
  base: '/docs/',
  directory: { components: '../../shared/components' },
  assets: { inlineStyles: ['../../shared/styles/tokens.css'] },
  pipeline: { watchPaths: ['../../shared/lib/', '../../shared/styles/'] },
});
`,
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("monorepo layout", () => {
  it("maps both sites and their shared root with no problems", () => {
    const checked = checkWorkspace();
    expect(checked.status, output(checked)).toBe(0);
    const report = JSON.parse(checked.stdout);
    expect(report.sites.map((site: { dir: string }) => site.dir)).toEqual([
      "sites/docs",
      "sites/marketing",
    ]);
    expect(report.sharedRoots).toEqual([
      { root: "shared/components", sites: ["sites/docs", "sites/marketing"] },
    ]);
    expect(report.findings).toEqual([]);
  });

  it("builds each site with the shared component, its relative helper import, and the site base", () => {
    for (const site of ["marketing", "docs"]) {
      const built = bascik(site, ["--build"]);
      expect(built.status, output(built)).toBe(0);
    }
    const marketing = readFileSync(
      join(dir, "sites/marketing/dist/about.html"),
      "utf8",
    );
    const docs = readFileSync(join(dir, "sites/docs/dist/about.html"), "utf8");
    expect(marketing).toMatch(/<a href="?\/about"?>About<\/a>/);
    expect(docs).toMatch(/<a href="?\/docs\/about"?>About<\/a>/);
    expect(docs).toMatch(/<style>[^<]*--brand:\s*rebeccapurple/);
  });

  it("passes verify.mjs in each site, including a lint pass over the shared root", () => {
    const verified = verify("marketing");
    expect(verified.status, output(verified)).toBe(0);
    expect(verified.stdout).toContain(
      "== PASS  bascik-language-server --check ../../shared/components",
    );
    // The shared nav and the pages' <main> have no data-testid: the advisory lists them, and the exit code stays 0.
    expect(verified.stdout).toContain("== NOTE  data-testid advisory");
    expect(verified.stdout).toContain(
      '../../shared/components/site-nav/site-nav.html:4  <nav> root of <site-nav> has no data-testid; add data-testid="site-nav"',
    );
    expect(verified.stdout).toContain("All checks passed.");
  });

  it("catches a scoping error in a shared component from inside a site", () => {
    const file = join(dir, "shared/components/site-nav/site-nav.html");
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original.replace(
        "nav.dataset.ready = 'true';",
        "nav.dataset.ready = 'true';\n  nav.id = 'renamed';",
      ),
    );
    try {
      const verified = verify("docs");
      expect(verified.status).toBe(1);
      expect(verified.stdout).toContain(
        "== FAIL  bascik-language-server --check ../../shared/components",
      );
      expect(verified.stdout).toContain("js-id-setter");
    } finally {
      writeFileSync(file, original);
    }
  });

  const brokenImportFooter = (directive: string) =>
    `<footer>\n  <script ${directive}>\n    import { links } from "@/lib/links.ts";\n    export default () => links();\n  </script>\n</footer>\n`;

  const withBrokenImport = (directive: string, run: () => void) => {
    write(
      "sites/marketing/src/lib/links.ts",
      'export const links = () => "";\n',
    );
    write(
      "shared/components/site-footer/site-footer.html",
      brokenImportFooter(directive),
    );
    try {
      const checked = checkWorkspace();
      expect(checked.status).toBe(1);
      const errors = JSON.parse(checked.stdout).findings.filter(
        (f: { level: string }) => f.level === "error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].site).toBe("sites/docs");
      expect(errors[0].message).toContain(
        "shared/components/site-footer/site-footer.html imports @/lib/links.ts",
      );
      run();
    } finally {
      rmSync(join(dir, "shared/components/site-footer"), {
        recursive: true,
        force: true,
      });
      rmSync(join(dir, "sites/marketing/src/lib"), {
        recursive: true,
        force: true,
      });
    }
  };

  it("reports a shared component whose @/ import only resolves in some sites", () => {
    withBrokenImport("data-bascik-build-once", () => {
      // The checker's claim is real: a build-once script runs at component
      // registration, so the docs build fails even though no page uses <site-footer>.
      const built = bascik("docs", ["--build"]);
      expect(built.status).not.toBe(0);
      expect(output(built)).toContain("links.ts");
    });
  });

  it("reports the broken import for a per-use build script before a page uses it", () => {
    withBrokenImport("data-bascik-build", () => {
      // A per-use script runs only where the component is used, so the build
      // passes until a page adds <site-footer>; the checker reports it first.
      expect(bascik("docs", ["--build"]).status).toBe(0);
    });
  });
});
