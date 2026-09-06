import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPackageSpecifiers,
  computePackageIdentity,
  hasDynamicImport,
  isExternalPackageSpecifier,
  resetPackageIdentity,
  resolvePackages,
} from "./package-identity.ts";

/**
 * Prompt 104 unit tests for resolved-package cache identity. These use real
 * temp project trees with a real `node_modules` (the resolver stub lives under
 * `node_modules/.cache/bascik`, exactly where the executing child runs), so
 * resolution parity is exercised without mocking the module boundary.
 */

const tempDirs: string[] = [];
let previousCwd = process.cwd();

afterEach(async () => {
  process.chdir(previousCwd);
  resetPackageIdentity();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Create an isolated project root and chdir into it. Returns the root. */
async function fixtureProject(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `bascik-104-${label}-`));
  tempDirs.push(root);
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "node_modules", ".cache", "bascik"), { recursive: true });
  process.chdir(root);
  resetPackageIdentity();
  return root;
}

async function writePkg(rel: string, name: string, version: string, entry: string, extraFiles: Record<string, string> = {}, exports?: Record<string, string>): Promise<void> {
  const dir = join(process.cwd(), "node_modules", ...rel.split("/"));
  await mkdir(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name, version, type: "module", main: "index.mjs" };
  if (exports) pkg.exports = exports;
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(dir, "index.mjs"), entry);
  for (const [name_, content] of Object.entries(extraFiles)) {
    await writeFile(join(dir, name_), content);
  }
}

describe("isExternalPackageSpecifier / collectPackageSpecifiers", () => {
  it("keeps bare, scoped, and subpath specifiers; drops relative/@/ and remote URLs", () => {
    expect(isExternalPackageSpecifier("marked")).toBe(true);
    expect(isExternalPackageSpecifier("@scope/pkg")).toBe(true);
    expect(isExternalPackageSpecifier("audit-lib/sub")).toBe(true);
    expect(isExternalPackageSpecifier("./x.mjs")).toBe(false);
    expect(isExternalPackageSpecifier("@/lib/a.ts")).toBe(false);
    expect(isExternalPackageSpecifier("https://x")).toBe(false);
  });

  it("collects distinct specifiers in stable sorted order", () => {
    expect(collectPackageSpecifiers(`import { a } from 'zebra';
import { b } from 'alpha';
import { c } from 'alpha';
import 'node:fs';
import d from './local.mjs';`)).toEqual(["alpha", "zebra"]);
  });
});

describe("hasDynamicImport (non-cacheable classification)", () => {
  it("is false for static string imports", () => {
    expect(hasDynamicImport(`import { x } from 'pkg';`)).toBe(false);
    expect(hasDynamicImport(`const y = await import('pkg');`)).toBe(false);
    expect(hasDynamicImport(`import('pkg');`)).toBe(false);
  });

  it("is true for dynamic non-literal imports", () => {
    expect(hasDynamicImport(`const m = await import(name);`)).toBe(true);
    expect(hasDynamicImport("const m = await import(`./${part}.mjs`);")).toBe(true);
    expect(hasDynamicImport("const m = await import(foo + '.mjs');")).toBe(true);
  });

  it("does not misclassify import.meta or static named/namespace imports", () => {
    expect(hasDynamicImport("import.meta.url")).toBe(false);
    expect(hasDynamicImport(`import * as ns from 'pkg';`)).toBe(false);
    expect(hasDynamicImport(`import def, { a } from 'pkg';`)).toBe(false);
  });
});

describe("resolvePackages + computePackageIdentity (real node_modules)", () => {
  it("classifies a hoisted package as installed and its entry realpath is under node_modules", async () => {
    const root = await fixtureProject("installed");
    const realRoot = await realpath(root);
    await writePkg("dep", "dep", "1.0.0", `export const v = "one";`);
    const [pkg] = await resolvePackages(["dep"]);
    expect(pkg?.kind).toBe("installed");
    expect(pkg?.resolvedPath.startsWith(join(realRoot, "node_modules"))).toBe(true);
  });

  it("classifies a symlink-escaped package (workspace) as userlinked", async () => {
    const root = await fixtureProject("linked");
    const realRoot = await realpath(root);
    // Real package outside node_modules, linked via directory symlink.
    await mkdir(join(realRoot, "vendor", "linked"), { recursive: true });
    await writeFile(join(realRoot, "vendor", "linked", "package.json"),
      JSON.stringify({ name: "linked", version: "1.0.0", main: "index.mjs", type: "module" }));
    await writeFile(join(realRoot, "vendor", "linked", "index.mjs"), `export const v = "one";`);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(realRoot, "vendor", "linked"), join(realRoot, "node_modules", "linked"), "dir");
    const [pkg] = await resolvePackages(["linked"]);
    expect(pkg?.kind).toBe("userlinked");
    expect(pkg?.resolvedPath.startsWith(join(realRoot, "vendor"))).toBe(true);
  });

  it("builtins carry runtime identity and no filesystem hash", async () => {
    await fixtureProject("builtin");
    const [pkg] = await resolvePackages(["node:fs"]);
    expect(pkg?.kind).toBe("builtin");
    expect(pkg?.resolvedPath).toBe("node:fs");
    const identity = await computePackageIdentity(["node:fs"]);
    // Identity is deterministic and does not depend on machine-specific paths.
    const again = await computePackageIdentity(["node:fs"]);
    expect(identity).toBe(again);
  });

  it("package identity changes when the entry content changes (upgrade path)", async () => {
    await fixtureProject("change");
    await writePkg("dep", "dep", "1.0.0", `export const v = "one";`);
    const before = await computePackageIdentity(["dep"]);
    await writePkg("dep", "dep", "2.0.0", `export const v = "two";`);
    const after = await computePackageIdentity(["dep"]);
    expect(before).not.toBe(after);
  });

  it("same content but changed manifest version changes identity", async () => {
    await fixtureProject("version");
    await writePkg("dep", "dep", "1.0.0", `export const v = "one";`);
    const before = await computePackageIdentity(["dep"]);
    await writePkg("dep", "dep", "2.0.0", `export const v = "one";`);
    const after = await computePackageIdentity(["dep"]);
    expect(before).not.toBe(after);
  });

  it("a userlinked package content edit changes identity (no version bump)", async () => {
    const root = await fixtureProject("linkedchange");
    const realRoot = await realpath(root);
    await mkdir(join(realRoot, "lib"), { recursive: true });
    await writeFile(join(realRoot, "lib", "package.json"),
      JSON.stringify({ name: "local", version: "1.0.0", main: "index.mjs", type: "module" }));
    await writeFile(join(realRoot, "lib", "index.mjs"), `export const v = "one";`);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(realRoot, "lib"), join(realRoot, "node_modules", "local"), "dir");

    const before = await computePackageIdentity(["local"]);
    await writeFile(join(realRoot, "lib", "index.mjs"), `export const v = "two";`);
    const after = await computePackageIdentity(["local"]);
    expect(before).not.toBe(after);
  });

  it("a transitive package change reached via a subpath export invalidates the graph", async () => {
    await fixtureProject("transitive");
    await writePkg("dep-base", "dep-base", "1.0.0", `export const value = "A";`);
    await writePkg(
      "audit-lib",
      "audit-lib",
      "1.0.0",
      `export const top = 1;`,
      { "sub.mjs": `import { value } from 'dep-base'; export const sub = value;` },
      { ".": "./index.mjs", "./sub": "./sub.mjs" },
    );
    const before = await computePackageIdentity(["audit-lib/sub"]);
    await writePkg("dep-base", "dep-base", "1.0.0", `export const value = "B";`);
    const after = await computePackageIdentity(["audit-lib/sub"]);
    expect(before).not.toBe(after);
  });

  it("stays deterministic across repeated computation (ordering + cycle detection)", async () => {
    await fixtureProject("determinism");
    const nm = join(process.cwd(), "node_modules");
    await writePkg("a", "a", "1.0.0", `export const v = "a";`);
    await writePkg("b", "b", "1.0.0", `export const v = "b";`);
    // a imports b; b imports a (cycle).
    await writeFile(join(nm, "a", "index.mjs"), `import { v } from 'b'; export const a = v;`);
    await writeFile(join(nm, "b", "index.mjs"), `import { v } from 'a'; export const b = v;`);
    const first = await computePackageIdentity(["b", "a"]);
    const second = await computePackageIdentity(["a", "b"]);
    expect(first).toBe(second);
  });

  it("unresolvable specifier records a stable MISSING marker and does not throw", async () => {
    await fixtureProject("missing");
    const [pkg] = await resolvePackages(["nope-there-is-no-such-pkg"]);
    expect(pkg?.resolvedPath.startsWith("MISSING:")).toBe(true);
    const id = await computePackageIdentity(["nope-there-is-no-such-pkg"]);
    const id2 = await computePackageIdentity(["nope-there-is-no-such-pkg"]);
    expect(id).toBe(id2);
  });
});