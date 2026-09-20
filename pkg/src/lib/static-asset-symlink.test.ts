import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    directory: { pages: "", components: [], out: "" },
    minify: { css: false, js: false, html: false },
    logging: { level: "silent", copies: true, deletes: true },
    assets: { inlineStyles: false, exclude: [], symlink: true },
    isBuild: false,
  },
  shouldLog: () => false,
}));

import { BascikConfig } from "./config.ts";
import { copyReplicatePath } from "./file-system.ts";

describe.skipIf(process.platform === "win32")("development static-asset symlinks", () => {
  let root: string;
  let source: string;
  let output: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-asset-link-"));
    source = join(root, "src/pages");
    output = join(root, "dist");
    await mkdir(join(source, "images"), { recursive: true });
    await writeFile(join(source, "images/logo.svg"), "first", "utf8");
    Object.assign(BascikConfig, {
      directory: { pages: source, components: [], out: output },
      assets: { inlineStyles: false, exclude: [], symlink: true },
      minify: { css: false, js: false, html: false },
      isBuild: false,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a relative link, reflects source edits, and replaces it with a regular production file", async () => {
    const sourceFile = join(source, "images/logo.svg");
    const outputFile = join(output, "images/logo.svg");
    await copyReplicatePath(sourceFile, output);

    expect((await lstat(outputFile)).isSymbolicLink()).toBe(true);
    expect(await readlink(outputFile)).toBe(relative(join(output, "images"), sourceFile));

    await writeFile(sourceFile, "updated", "utf8");
    expect(await readFile(outputFile, "utf8")).toBe("updated");

    (BascikConfig as any).isBuild = true;
    await copyReplicatePath(sourceFile, output);
    expect((await lstat(outputFile)).isSymbolicLink()).toBe(false);
    expect(await readFile(outputFile, "utf8")).toBe("updated");
  });
});