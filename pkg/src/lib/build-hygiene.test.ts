import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

/**
 * Every published workspace builds with `tsc` into `dist/`, and `files`
 * ships `dist/`. tsc never deletes output, so a build without a clean step
 * lets `npm pack` ship stale fixtures and modules that were removed from src.
 * The emitted `.js.map` files also point at `../src/*.ts`, which is not in
 * the tarball, so they must either embed their sources or ship src/ too.
 */
const WORKSPACES = [
  { dir: "pkg", shipsSrc: false },
  { dir: "create", shipsSrc: true },
  { dir: "adapters/cloudflare", shipsSrc: false },
  { dir: "adapters/netlify", shipsSrc: false },
];

describe.each(WORKSPACES)("build output of $dir", ({ dir, shipsSrc }) => {
  const manifest = JSON.parse(read(`${dir}/package.json`));
  const buildConfig = read(`${dir}/tsconfig.build.json`);

  it("cleans dist/ before compiling", () => {
    const build: string = manifest.scripts.build;
    const clean = build.indexOf("rmSync");
    const compile = build.indexOf("tsc ");
    expect(clean).toBeGreaterThanOrEqual(0);
    expect(compile).toBeGreaterThan(clean);
    expect(build).toContain("dist");
  });

  it("emits source maps that resolve inside the tarball", () => {
    if (!/"sourceMap":\s*true/.test(buildConfig)) return;
    const inline = /"inlineSources":\s*true/.test(buildConfig);
    const files: string[] = manifest.files;
    expect(inline || (shipsSrc && files.includes("src/"))).toBe(true);
  });
});

/**
 * What npm renders for each published package: the registry page shows the
 * README, homepage, keywords, and author, and none of it can lean on files
 * that exist only in the repository.
 */
const PUBLISHED = [
  "pkg",
  "create",
  "lsp",
  "adapters/cloudflare",
  "adapters/netlify",
];

describe.each(PUBLISHED)("npm metadata of %s", (dir) => {
  const manifest = JSON.parse(read(`${dir}/package.json`));

  it("names bascik.dev, an author, and keywords", () => {
    expect(manifest.homepage).toBe("https://bascik.dev");
    expect(manifest.author).toBe("Collin Thomas");
    expect(manifest.keywords).toContain("bascik");
  });

  it("has a README without repository-relative links", () => {
    const readme = read(`${dir}/README.md`);
    const relative = [
      ...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g),
    ];
    expect(relative.map((match) => match[1])).toEqual([]);
  });
});

describe("community health files", () => {
  it.each([
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/dependabot.yml",
    ".github/FUNDING.yml",
  ])("ships %s", (path) => {
    expect(read(path).trim().length).toBeGreaterThan(0);
  });

  it("points security reports at private advisories, not public issues", () => {
    expect(read("SECURITY.md")).toMatch(/private/i);
    expect(read("SECURITY.md")).toContain("/security");
  });

  it("keeps Dependabot on the same 7-day age gate as Yarn", () => {
    expect(read(".yarnrc.yml")).toContain('npmMinimalAgeGate: "7d"');
    const config = read(".github/dependabot.yml");
    expect(config).toContain("package-ecosystem: npm");
    expect(config).toContain("package-ecosystem: github-actions");
    expect(config.match(/default-days: 7/g)).toHaveLength(2);
  });
});
