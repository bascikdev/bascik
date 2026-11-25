/**
 * .github/scripts/publish-npm.sh publishes the package in the current directory.
 * npm ignores publishConfig.exports and publishConfig.types, so a package that
 * declares either must be packed by Yarn (which applies them) and the tarball
 * published; every other package is published from its directory as before.
 * The tests run the real script with fake `npm` and `yarn` programs that record
 * their arguments.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repoDir, ".github/scripts/publish-npm.sh");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Runs the script in a temporary package whose manifest is `manifest`. */
function publish(
  manifest: Record<string, unknown>,
  { onNpm = false, tag = "v1.2.3", prefix = "v" } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "bascik-publish-npm-"));
  roots.push(root);
  const bin = join(root, "bin");
  const packageDir = join(root, "package");
  const log = join(root, "calls.log");
  mkdirSync(bin);
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@bascik/example", version: "1.2.3", ...manifest }),
  );
  // `npm view` reports whether the version is already published; every other
  // call is recorded. `yarn pack --out <file>` creates the file, like Yarn.
  writeFileSync(
    join(bin, "npm"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "view" ]; then',
      onNpm ? '  echo "1.2.3"' : "  exit 1",
      "  exit 0",
      "fi",
      `echo "npm $*" >> "${log}"`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "yarn"),
    [
      "#!/usr/bin/env bash",
      `echo "yarn $*" >> "${log}"`,
      'if [ "$1" = "pack" ] && [ "$2" = "--out" ]; then echo packed > "$3"; fi',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "yarn"), 0o755);
  const result = spawnSync("bash", [script, prefix], {
    cwd: packageDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      GITHUB_REF_NAME: tag,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // Nothing was recorded.
  }
  return { ...result, calls };
}

describe.skipIf(process.platform === "win32")("publish-npm.sh", () => {
  it("publishes a plain package straight from its directory", () => {
    const result = publish({ publishConfig: { access: "public" } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "npm publish --provenance --access public --tag latest",
    ]);
  });

  it.each([
    ["exports", { exports: { ".": "./dist/index.js" } }],
    ["types", { types: "./dist/index.d.ts" }],
  ])(
    "packs with Yarn and publishes the tarball when publishConfig sets %s",
    (_field, extra) => {
      const result = publish({ publishConfig: { access: "public", ...extra } });
      expect(result.status).toBe(0);
      expect(result.calls).toHaveLength(2);
      const [pack, upload] = result.calls;
      const tarball = /^yarn pack --out (\S+\.tgz)$/.exec(pack)?.[1];
      expect(tarball).toBeDefined();
      expect(upload).toBe(
        `npm publish ${tarball} --provenance --access public --tag latest`,
      );
    },
  );

  it("removes the temporary tarball folder afterwards", () => {
    const result = publish({
      publishConfig: { access: "public", types: "./dist/index.d.ts" },
    });
    const tarball = /^yarn pack --out (\S+\.tgz)$/.exec(result.calls[0])![1];
    expect(() => readFileSync(tarball)).toThrow();
  });

  it("publishes a prerelease of a packed package under its channel tag", () => {
    const result = publish(
      {
        version: "0.2.0-rc.1",
        publishConfig: { access: "public", types: "./dist/index.d.ts" },
      },
      { tag: "ai-v0.2.0-rc.1", prefix: "ai-v" },
    );
    expect(result.status).toBe(0);
    expect(result.calls[1]).toMatch(
      /^npm publish \S+\.tgz --provenance --access public --tag rc$/,
    );
  });

  it("does nothing when the version is already on npm", () => {
    const result = publish(
      { publishConfig: { access: "public", types: "./dist/index.d.ts" } },
      { onNpm: true },
    );
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
  });

  it("misuse: refuses a tag that does not match the version before packing", () => {
    const result = publish(
      { publishConfig: { access: "public", types: "./dist/index.d.ts" } },
      { tag: "v9.9.9" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match package\.json version/);
    expect(result.calls).toEqual([]);
  });
});
