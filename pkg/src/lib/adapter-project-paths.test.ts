import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAdapterProjectPaths } from "./adapter-project-paths.ts";

let root: string;

beforeEach(async () => {
  const cache = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, "adapter-project-paths-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("resolves defaults relative to the explicit project, not the cwd", async () => {
  expect(await resolveAdapterProjectPaths(root)).toEqual({
    distDir: join(root, "dist"),
    sourceRoots: [
      join(root, "src/pages"),
      join(root, "src/components"),
      join(root, "src/api"),
      join(root, "src"),
    ],
  });
});

it("uses build layers and replaces component arrays while retaining other user paths", async () => {
  await mkdir(join(root, "pages"));
  await writeFile(
    join(root, "bascik.config.mjs"),
    `export default {
      directory: { pages: "pages", out: "old", components: ["old-components"], api: "api" },
      scripts: { importRoot: "old-imports" }
    };
    export const dev = { directory: { out: "dev-output" } };
    export const build = {
      directory: { out: "build-output", components: ["one", "../shared"] },
      scripts: { importRoot: "imports" }
    };`,
  );
  expect(await resolveAdapterProjectPaths(root)).toEqual({
    distDir: join(root, "build-output"),
    sourceRoots: [
      join(root, "pages"),
      join(root, "one"),
      join(root, "../shared"),
      join(root, "api"),
      join(root, "imports"),
    ],
  });
});

it("uses the standard --config selection and preserves undefined defaults", async () => {
  await writeFile(
    join(root, "custom.mjs"),
    `export default { directory: { out: "custom" } };
     export const build = { directory: { out: undefined } };`,
  );
  expect(
    (await resolveAdapterProjectPaths(root, ["--config=custom.mjs"])).distDir,
  ).toBe(join(root, "custom"));
  await expect(
    resolveAdapterProjectPaths(root, ["--config", "missing.mjs"]),
  ).rejects.toThrow("does not exist");
});

it("propagates configuration load and validation errors instead of using defaults", async () => {
  await writeFile(
    join(root, "invalid.mjs"),
    `export default { directory: { out: 42 } };`,
  );
  await expect(
    resolveAdapterProjectPaths(root, ["--config", "invalid.mjs"]),
  ).rejects.toThrow("directory.out");
  await writeFile(
    join(root, "broken.mjs"),
    `throw new Error("broken config");`,
  );
  await expect(
    resolveAdapterProjectPaths(root, ["--config", "broken.mjs"]),
  ).rejects.toThrow("broken config");
});
