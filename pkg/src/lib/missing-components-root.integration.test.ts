import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupFixture, fixtureRoot, runRealBuild, writeFixtureFile } from "./build-fixtures.ts";

// A project without src/components (the default root) is a pages-only site, not
// a broken one. A components root the user named and that is missing is most
// likely a typo, so the build fails and names the path. Both go through the real
// CLI, in the main thread and in worker threads.

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(cleanupFixture));
});

const page = `<!doctype html><html lang="en"><head><title>P</title></head><body>
<h1>Pages only</h1><site-banner></site-banner>
</body></html>`;

const project = async (name: string, config: string): Promise<string> => {
  const root = fixtureRoot(name);
  fixtureRoots.push(root);
  await mkdir(join(root, "src/pages"), { recursive: true });
  await writeFixtureFile(root, "src/pages/index.html", page);
  await writeFixtureFile(root, "bascik.config.js", config);
  return root;
};

const failure = async (run: Promise<unknown>): Promise<string> => {
  const error = await run.then(() => undefined, (caught: { stdout?: string; stderr?: string }) => caught);
  expect(error, "the build should fail").toBeDefined();
  return `${error!.stdout ?? ""}${error!.stderr ?? ""}`;
};

describe.each([false, true])("missing components root (workers: %s)", (workers) => {
  it("builds a site with no src/components directory", async () => {
    const root = await project("no-components", `module.exports = {
  pipeline: { workers: ${workers} },
  generate: { sitemap: false, robots: false },
};`);
    const { stdout, stderr } = await runRealBuild({ projectRoot: root });
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain("<h1>Pages only</h1>");
    // An unmatched tag is still reported, so a missing component is not silent.
    expect(html).toContain("<site-banner></site-banner>");
    expect(`${stdout}${stderr}`).not.toMatch(/ENOENT/);
    expect(stdout).toContain("Build complete");
  }, 120_000);

  it("fails and names a configured root that does not exist", async () => {
    const root = await project("typo-components", `module.exports = {
  directory: { components: ["src/widgets"] },
  pipeline: { workers: ${workers} },
  generate: { sitemap: false, robots: false },
};`);
    const output = await failure(runRealBuild({ projectRoot: root }));
    expect(output).toContain('components directory "src/widgets" does not exist');
    expect(output).toContain("directory.components");
    expect(output).not.toContain("Build complete");
  }, 120_000);
});

describe("bascik --check with a missing components root", () => {
  it("reports a missing configured root as an error", async () => {
    const root = await project("check-typo-components", `module.exports = {
  directory: { components: "src/widgets" },
};`);
    const output = await failure(runRealBuild({ projectRoot: root, args: ["--check"] }));
    expect(output).toContain('components directory "src/widgets" does not exist');
  }, 120_000);

  it("does not report a missing default root", async () => {
    const root = await project("check-no-components", `module.exports = {
  generate: { sitemap: false, robots: false },
};`);
    await writeFile(join(root, "src/pages/index.html"), page.replace("<site-banner></site-banner>", ""));
    const { stdout, stderr } = await runRealBuild({ projectRoot: root, args: ["--check"] });
    expect(`${stdout}${stderr}`).not.toMatch(/components directory|ENOENT/);
  }, 120_000);
});
