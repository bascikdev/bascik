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

/** Every file under components/, by absolute path. */
async function packageFiles(): Promise<string[]> {
  const entries = await readdir(components, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The components: one HTML file each. */
async function componentFiles(): Promise<string[]> {
  return (await packageFiles()).filter((file) => file.endsWith(".html"));
}

/** The browser modules the components' scripts import, without their tests. */
async function moduleFiles(): Promise<string[]> {
  return (await packageFiles()).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
}

describe("the package", () => {
  it("offers its components to `bascik add`, and ships them", () => {
    expect(manifest.bascik.components).toBe("./components");
    expect(manifest.files).toContain("components/");
    expect(manifest.files).toContain("dist/");
    // The components' module tests stay in the repository.
    expect(manifest.files).toContain("!components/**/*.test.ts");
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

  it("ships browser modules that bundle into the components", async () => {
    const modules = await moduleFiles();
    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const source = await readFile(file, "utf8");
      // Each says what it is for, first thing.
      expect(source, file).toMatch(/^\/\*/);
      // Bascik bundles relative imports only: a package or `@/` import
      // would not resolve in the reader's project.
      for (const [, specifier] of source.matchAll(
        /^import\b[^"']*["']([^"']+)["']/gm,
      )) {
        expect(specifier, file).toMatch(/^\.\.?\//);
      }
    }
  });

  it("does not take a component's module folder for a component", async () => {
    const folder = join(components, "chat");
    const chat = await readCatalog(folder);
    const html = (await componentFiles())
      .filter((file) => file.startsWith(`${folder}/`))
      .map((file) => file.slice(folder.length + 1).replace(/\.html$/, ""))
      .sort();
    expect([...chat.keys()].sort()).toEqual(html);
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
