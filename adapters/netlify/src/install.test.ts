// Tests for the post-build step that moves the adapter's output to the paths
// Netlify deploys from.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findAdapterOutput, installNetlifyOutput } from "./install.js";

let root: string;

async function target(
  name: string,
  adapter: string,
  files: Record<string, string>,
  mtime = Date.now() / 1000,
  output = "dist",
) {
  const dir = join(root, output, ".bascik", name);
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
  const cache = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, "netlify-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installNetlifyOutput", () => {
  async function config(value: Record<string, unknown>, build = {}) {
    await writeFile(
      join(root, "bascik.config.mjs"),
      `export default ${JSON.stringify(value)}; export const build = ${JSON.stringify(build)};`,
    );
  }

  it("uses configured build output instead of a stale dist build, including the CLI", async () => {
    await config(
      { directory: { out: "unused" } },
      { directory: { out: "output" } },
    );
    await target("stale", "netlify", { "publish/index.html": "stale" }, 3_000);
    await target(
      "current",
      "netlify",
      { "publish/index.html": "current" },
      1_000,
      "output",
    );
    await installNetlifyOutput(root);
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "current",
    );
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "current",
    );
  });

  it.each([
    ["pages", { directory: { pages: "publish" } }],
    ["nested pages", { directory: { pages: "publish/pages" } }],
    ["components", { directory: { components: ["publish", "other"] } }],
    ["import root", { scripts: { importRoot: "publish" } }],
    ["function API sources", { directory: { api: ".netlify/v1/functions" } }],
    ["function import sources", { scripts: { importRoot: ".netlify" } }],
  ])(
    "refuses overlapping %s before deleting either destination",
    async (_name, value) => {
      await mkdir(join(root, "publish/pages"), { recursive: true });
      const fn = join(root, ".netlify/v1/functions/bascik-pages.mjs");
      await mkdir(join(fn, ".."), { recursive: true });
      await writeFile(fn, "source function");
      await writeFile(join(root, "publish/index.html"), "source page");
      await config(value);
      await target("netlify", "netlify", { "publish/index.html": "compiled" });
      await expect(installNetlifyOutput(root)).rejects.toThrow(
        "overlaps source",
      );
      expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
        "source page",
      );
      expect(await readFile(fn, "utf8")).toBe("source function");
    },
  );

  it.each(["source", "destination"])(
    "refuses overlap through a %s symlink",
    async (direction) => {
      await mkdir(join(root, "publish"), { recursive: true });
      await writeFile(join(root, "publish/index.html"), "source");
      await symlink(join(root, "publish"), join(root, "linked"), "dir");
      await config({ scripts: { importRoot: "linked" } });
      if (direction === "destination") {
        await rm(join(root, "linked"));
        await rm(join(root, "publish"), { recursive: true });
        await mkdir(join(root, "sources"));
        await writeFile(join(root, "sources/index.html"), "source");
        await symlink(join(root, "sources"), join(root, "publish"), "dir");
        await symlink(join(root, "sources"), join(root, "linked"), "dir");
      }
      await target("netlify", "netlify", { "publish/index.html": "compiled" });
      await expect(installNetlifyOutput(root)).rejects.toThrow(
        "overlaps source",
      );
      expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
        "source",
      );
    },
  );

  it("does not fall back to dist when configured output is missing", async () => {
    await config({ directory: { out: "missing" } });
    await target("stale", "netlify", { "publish/index.html": "stale" });
    await expect(installNetlifyOutput(root)).rejects.toThrow("missing");
  });

  it("supports an explicit config file in the CLI", async () => {
    await writeFile(
      join(root, "custom.mjs"),
      `export default { directory: { out: "custom-output" } };`,
    );
    await target(
      "custom",
      "netlify",
      { "publish/index.html": "custom" },
      1_000,
      "custom-output",
    );
    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "--config",
        "custom.mjs",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "custom",
    );
  });

  it.each(["parent", "file"])(
    "refuses a function destination whose %s is a symlink into sources",
    async (alias) => {
      const sources = join(root, "src");
      await mkdir(sources);
      await writeFile(join(sources, "bascik-pages.mjs"), "source function");
      await mkdir(join(root, ".netlify/v1"), { recursive: true });
      if (alias === "parent") {
        await symlink(sources, join(root, ".netlify/v1/functions"), "dir");
      } else {
        await mkdir(join(root, ".netlify/v1/functions"));
        await symlink(
          join(sources, "bascik-pages.mjs"),
          join(root, ".netlify/v1/functions/bascik-pages.mjs"),
          "file",
        );
      }
      await mkdir(join(root, "publish"));
      await writeFile(join(root, "publish/index.html"), "old publish");
      await target("netlify", "netlify", {
        "publish/index.html": "compiled",
        "functions/bascik-pages.mjs": "compiled function",
      });
      await expect(installNetlifyOutput(root)).rejects.toThrow(
        "overlaps source",
      );
      expect(await readFile(join(sources, "bascik-pages.mjs"), "utf8")).toBe(
        "source function",
      );
      expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
        "old publish",
      );
    },
  );

  it("recognizes a dangling source symlink beneath the publish destination", async () => {
    await mkdir(join(root, "publish"));
    await writeFile(join(root, "publish/index.html"), "keep");
    await symlink(
      join(root, "publish/future-sources"),
      join(root, "source-link"),
      "dir",
    );
    await config({ scripts: { importRoot: "source-link" } });
    await target("netlify", "netlify", { "publish/index.html": "compiled" });
    await expect(installNetlifyOutput(root)).rejects.toThrow("overlaps source");
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "keep",
    );
  });

  it("protects source aliases nested beneath a configured source root", async () => {
    await mkdir(join(root, "src/pages"), { recursive: true });
    await mkdir(join(root, "publish"));
    await writeFile(join(root, "publish/index.html"), "source");
    await symlink(join(root, "publish"), join(root, "src/pages/shared"), "dir");
    await target("netlify", "netlify", { "publish/index.html": "compiled" });
    await expect(installNetlifyOutput(root)).rejects.toThrow("overlaps source");
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "source",
    );
  });

  it("refuses to delete the adapter build when output is nested in publish", async () => {
    await config({ directory: { out: "publish/output" } });
    const output = await target(
      "netlify",
      "netlify",
      { "publish/index.html": "compiled" },
      1_000,
      "publish/output",
    );
    await expect(installNetlifyOutput(root)).rejects.toThrow(
      "overlaps source or build output",
    );
    expect(await readFile(join(output, "publish/index.html"), "utf8")).toBe(
      "compiled",
    );
  });

  it("checks input before deleting an existing publish or stale function", async () => {
    await target("netlify", "netlify", {});
    await mkdir(join(root, "publish"));
    await writeFile(join(root, "publish/index.html"), "keep");
    const fn = join(root, ".netlify/v1/functions/bascik-pages.mjs");
    await mkdir(join(fn, ".."), { recursive: true });
    await writeFile(fn, "keep function");
    await expect(installNetlifyOutput(root)).rejects.toThrow();
    expect(await readFile(join(root, "publish/index.html"), "utf8")).toBe(
      "keep",
    );
    expect(await readFile(fn, "utf8")).toBe("keep function");
  });

  it("reports invalid config without changing existing output", async () => {
    await writeFile(
      join(root, "bascik.config.mjs"),
      "throw new Error('invalid project config');",
    );
    await target("stale", "netlify", { "publish/index.html": "stale" });
    await expect(installNetlifyOutput(root)).rejects.toThrow(
      "invalid project config",
    );
  });

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
