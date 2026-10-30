/**
 * Bascik's private build folder lives beside the output directory, never in
 * it: a static host serves every file of the folder it deploys, dotfiles
 * included, so anything inside dist/ is published. The folder for `dist` is
 * `.bascik/dist/` next to it, and the `.bascik/` folder ignores itself in git.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensurePrivateDir,
  privateDirFor,
  privateDirLabel,
} from "./private-dir.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("privateDirFor", () => {
  it("is .bascik/<out name> beside the output directory, never inside it", () => {
    expect(privateDirFor("/site/dist")).toBe(resolve("/site/.bascik/dist"));
    expect(privateDirFor("/site/build/www")).toBe(
      resolve("/site/build/.bascik/www"),
    );
    const out = resolve("/site/dist");
    expect(privateDirFor(out).startsWith(`${out}/`)).toBe(false);
  });

  it("resolves a relative output directory against the working directory", () => {
    expect(privateDirFor("dist")).toBe(resolve(".bascik", "dist"));
  });

  it("two output directories never share a private folder", () => {
    expect(privateDirFor("/site/dist")).not.toBe(
      privateDirFor("/site/dist-preview"),
    );
    expect(privateDirFor("/site/a/dist")).not.toBe(
      privateDirFor("/site/b/dist"),
    );
  });
});

describe("privateDirLabel", () => {
  it("names the folder relative to the working directory, with forward slashes", () => {
    expect(privateDirLabel(resolve("dist"))).toBe(".bascik/dist");
    expect(privateDirLabel(resolve("build/www"))).toBe("build/.bascik/www");
  });
});

describe("ensurePrivateDir", () => {
  it("creates the folder and a .gitignore that ignores all of .bascik/", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-private-dir-"));
    roots.push(root);
    const dir = await ensurePrivateDir(join(root, "dist"));
    expect(dir).toBe(join(root, ".bascik", "dist"));
    expect(await readFile(join(root, ".bascik", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
  });

  it("keeps a .gitignore the author already wrote there", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-private-dir-"));
    roots.push(root);
    await ensurePrivateDir(join(root, "dist"));
    await writeFile(join(root, ".bascik", ".gitignore"), "mine\n");
    await ensurePrivateDir(join(root, "dist"));
    expect(await readFile(join(root, ".bascik", ".gitignore"), "utf8")).toBe(
      "mine\n",
    );
  });
});
