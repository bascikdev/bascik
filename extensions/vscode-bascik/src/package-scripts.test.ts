import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const scripts = manifest.scripts;

/**
 * The repo runs scripts with Yarn 4, which does not run npm's implicit
 * `pre<name>` and `post<name>` hooks (only install and pack lifecycle ones).
 * A hook here runs under `npm run` and silently not under `yarn ext:compile`,
 * so the two entry points would build from different inputs.
 */
const YARN_LIFECYCLE = new Set([
  "preinstall",
  "postinstall",
  "prepack",
  "postpack",
  "prepublish",
]);

describe("extension package scripts", () => {
  it("has no pre/post hooks that Yarn 4 would skip", () => {
    const hooks = Object.keys(scripts).filter((name) => {
      const match = /^(pre|post)(.+)$/.exec(name);
      return match !== null && match[2] in scripts && !YARN_LIFECYCLE.has(name);
    });
    expect(hooks).toEqual([]);
  });

  it("regenerates the compatibility rules as part of compile, before bundling", () => {
    const compile = scripts.compile;
    const generate = compile.indexOf("generate-compatibility-rules.ts");
    const bundle = compile.indexOf("build.mjs");
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(bundle).toBeGreaterThan(generate);
    // `&&`, so a generator failure stops the build instead of bundling stale rules.
    expect(compile.slice(generate, bundle)).toContain("&&");
  });

  it("builds through compile wherever the extension is packaged or tested", () => {
    for (const name of ["vscode:prepublish", "e2e", "test"]) {
      expect(scripts[name], name).toMatch(/(npm|yarn) run compile/);
    }
  });
});
