import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeComponent, readCatalog } from "./catalog.ts";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as {
  files: string[];
  bascik: { components: string };
  exports: Record<string, string>;
  publishConfig: {
    exports: Record<string, { types: string; default: string }>;
  };
};
const components = join(root, manifest.bascik.components);

async function componentFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const folder of await readdir(components)) {
    for (const file of await readdir(join(components, folder))) {
      files.push(join(components, folder, file));
    }
  }
  return files;
}

describe("the package", () => {
  it("offers its components to `bascik add`, and ships them", () => {
    expect(manifest.bascik.components).toBe("./components");
    expect(manifest.files).toContain("components/");
    expect(manifest.files).toContain("dist/");
  });

  it("carries the metadata a published package needs", () => {
    const full = manifest as unknown as Record<string, unknown> & {
      publishConfig: { access: string; types: string };
      engines: { node: string };
    };
    expect(full.name).toBe("@bascik/ai");
    expect(full.license).toBe("MIT");
    expect(full.sideEffects).toBe(false);
    expect(full.engines.node).toBe(">=24.21.0");
    expect(full.publishConfig.access).toBe("public");
    expect(full.publishConfig.types).toBe("./dist/index.d.ts");
    expect(full.repository).toMatchObject({ directory: "ai" });
    // The lab notebook stays in the repository; npm gets the README.
    expect(manifest.files).toContain("README.md");
    expect(manifest.files).not.toContain("NOTES.md");
  });

  it("publishes built JavaScript for every entry it has in source", () => {
    // Node does not strip types under node_modules, so what is published is
    // dist/, while this repository runs src/ as it is.
    expect(Object.keys(manifest.publishConfig.exports)).toEqual(
      Object.keys(manifest.exports),
    );
    for (const [entry, source] of Object.entries(manifest.exports)) {
      const name = /^\.\/src\/(.+)\.ts$/.exec(source)![1]!;
      expect(manifest.publishConfig.exports[entry]).toEqual({
        types: `./dist/${name}.d.ts`,
        default: `./dist/${name}.js`,
      });
    }
  });

  it("ships components that work in any project", async () => {
    const files = await componentFiles();
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const described = describeComponent(file, source);
      // A component a model or an editor can be told about.
      expect(described, file).not.toBeNull();
      expect(described!.description, file).not.toBe("");
      // No import of the project it came from: `@/` is the reader's own root.
      expect(source, file).not.toMatch(/from\s+["']@\//);
      expect(source, file).toMatch(/data-testid="/);
    }
  });

  it("brings a catalog a model can be taught as it is", async () => {
    const catalog = await readCatalog(join(components, "catalog"));
    expect([...catalog.keys()]).toContain("ask-button");
    expect([...catalog.keys()]).toContain("data-table");
    // The chat's own pieces are not a model's to write.
    expect(catalog.has("tool-approval")).toBe(false);
    expect(catalog.has("chat-enhance")).toBe(false);
  });

  it("reads several catalog folders, the later one winning", async () => {
    const both = await readCatalog([
      join(components, "catalog"),
      join(root, "demo", "src", "genui"),
    ]);
    expect(both.has("ask-button")).toBe(true);
    expect(both.has("book-card")).toBe(true);
  });
});
