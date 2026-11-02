// Tests for the post-build step that moves the adapter's output to the paths
// Netlify deploys from.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAdapterOutput, installNetlifyOutput } from "./install.js";

let root: string;

async function target(
  name: string,
  adapter: string,
  files: Record<string, string>,
  mtime = Date.now() / 1000,
) {
  const dir = join(root, "dist", ".bascik", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "build-info.json"), JSON.stringify({ adapter }));
  await utimes(join(dir, "build-info.json"), mtime, mtime);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "netlify-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installNetlifyOutput", () => {
  it("replaces publish/ and installs the function", async () => {
    await target("netlify_1", "netlify", {
      "publish/index.html": "home",
      "functions/bascik-pages.mjs": "fn",
    });
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(join(root, "publish", "stale.html"), "old");

    const result = await installNetlifyOutput(root);
    expect(await readFile(join(root, "publish", "index.html"), "utf8")).toBe(
      "home",
    );
    expect(
      await readFile(join(root, "publish", "stale.html")).catch(() => null),
    ).toBeNull();
    expect(result.functionPath).toBe(
      join(root, ".netlify", "v1", "functions", "bascik-pages.mjs"),
    );
    expect(await readFile(result.functionPath!, "utf8")).toBe("fn");
  });

  it("removes a stale function when the site has no dynamic pages", async () => {
    await target("netlify_1", "netlify", { "publish/index.html": "home" });
    const stale = join(root, ".netlify", "v1", "functions", "bascik-pages.mjs");
    await mkdir(join(stale, ".."), { recursive: true });
    await writeFile(stale, "old");

    const result = await installNetlifyOutput(root);
    expect(result.functionPath).toBeUndefined();
    expect(await readFile(stale).catch(() => null)).toBeNull();
  });
});

describe("findAdapterOutput", () => {
  it("picks the newest Netlify build and ignores other adapters", async () => {
    await target("old", "netlify", {}, 1_000);
    const newest = await target("new", "netlify", {}, 2_000);
    await target("cf", "cloudflare", {}, 3_000);
    expect(await findAdapterOutput(join(root, "dist"))).toBe(newest);
  });

  it("explains how to build when there is no output", async () => {
    await expect(findAdapterOutput(join(root, "dist"))).rejects.toThrow(
      "Run bascik --build",
    );
  });
});
