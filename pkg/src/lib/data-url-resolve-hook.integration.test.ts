/**
 * The resolve hook for inline server and stream scripts, which run as `data:` URL modules.
 * registerHooks is process-wide, so each case runs in its own Node.js process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hookUrl = pathToFileURL(
  fileURLToPath(new URL("./data-url-resolve-hook.ts", import.meta.url)),
).href;

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "bascik-data-hook-")));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "hook-site",
      type: "module",
      imports: { "#lib/*": "./src/lib/*" },
    }),
  );
  mkdirSync(join(project, "src/lib"), { recursive: true });
  writeFileSync(
    join(project, "src/lib/format.js"),
    "export const fmt = () => 'formatted';\n",
  );
  mkdirSync(join(project, "node_modules/dep"), { recursive: true });
  writeFileSync(
    join(project, "node_modules/dep/package.json"),
    JSON.stringify({ name: "dep", type: "module", exports: "./index.js" }),
  );
  writeFileSync(
    join(project, "node_modules/dep/index.js"),
    "export const dep = () => 'from dep';\n",
  );
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Run an inline module (as server-scripts.ts does) in a fresh process with the hook installed. */
const runInline = (moduleSource: string) => {
  const runner = join(project, "runner.mjs");
  writeFileSync(
    runner,
    [
      `import { installDataUrlResolveHook } from ${JSON.stringify(hookUrl)};`,
      `installDataUrlResolveHook(${JSON.stringify(project)});`,
      `const url = "data:text/javascript;charset=utf-8," + encodeURIComponent(${JSON.stringify(moduleSource)});`,
      "try {",
      "  const mod = await import(url);",
      "  console.log(mod.default());",
      "} catch (error) {",
      "  console.log(`${error.code}: ${error.message}`);",
      "}",
    ].join("\n"),
  );
  return spawnSync(process.execPath, [runner], {
    cwd: project,
    encoding: "utf8",
  }).stdout.trim();
};

describe("installDataUrlResolveHook", () => {
  it("resolves a package `imports` (#) specifier from an inline script (F046)", () => {
    expect(
      runInline(
        'import { fmt } from "#lib/format.js"; export default () => fmt();',
      ),
    ).toBe("formatted");
  });

  it("still resolves a bare package specifier", () => {
    expect(
      runInline('import { dep } from "dep"; export default () => dep();'),
    ).toBe("from dep");
  });

  it("names the specifier when a # import is not in package.json imports", () => {
    const out = runInline(
      'import { x } from "#missing/x.js"; export default () => x;',
    );
    expect(out).toMatch(/^ERR_PACKAGE_IMPORT_NOT_DEFINED: /);
    expect(out).toContain("#missing/x.js");
  });
});
