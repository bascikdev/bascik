import { describe, expect, it } from "vitest";
import { resolveAdapterTarget } from "./adapter-resolution.ts";
import { join } from "node:path";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/** A scratch project with `files` (path → contents) written under it. */
const project = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-test-res-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
};
const ADAPTER_SOURCE = (name: string) =>
  `export default { name: ${JSON.stringify(name)}, build: async () => ({ publicDir: "out" }) };\n`;

describe("resolveAdapterTarget", () => {
  it("resolves cloudflare to official package with workers variant by default", async () => {
    const resolved = await resolveAdapterTarget("cloudflare", process.cwd(), {
      load: false,
    });
    expect(resolved.package).toBe("@bascik/adapter-cloudflare");
    expect(resolved.variant).toBe("workers");
  });

  it("resolves cloudflare-pages to official package with pages variant", async () => {
    const resolved = await resolveAdapterTarget(
      "cloudflare-pages",
      process.cwd(),
      { load: false },
    );
    expect(resolved.package).toBe("@bascik/adapter-cloudflare");
    expect(resolved.variant).toBe("pages");
  });

  it("resolves cloudflare-workers to official package with workers variant", async () => {
    const resolved = await resolveAdapterTarget(
      "cloudflare-workers",
      process.cwd(),
      { load: false },
    );
    expect(resolved.package).toBe("@bascik/adapter-cloudflare");
    expect(resolved.variant).toBe("workers");
  });

  it("treats custom package name as package specifier", async () => {
    const resolved = await resolveAdapterTarget(
      "@acme/adapter-foo",
      process.cwd(),
      { load: false },
    );
    expect(resolved.package).toBe("@acme/adapter-foo");
    expect(resolved.variant).toBeUndefined();
  });

  it("treats relative path as path form", async () => {
    const resolved = await resolveAdapterTarget(
      "./my-adapter.ts",
      process.cwd(),
      { load: false },
    );
    expect(resolved.package).toBeUndefined();
    expect(resolved.path).toBe(join(process.cwd(), "my-adapter.ts"));
  });

  it("missing official package produces actionable error naming npm install", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "dummy" }),
    );

    try {
      await expect(
        resolveAdapterTarget("cloudflare-pages", tempDir),
      ).rejects.toThrow(/npm install --save-dev @bascik\/adapter-cloudflare/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("ESM-only adapter packages (F089)", () => {
    it("resolves and loads a package whose exports offer only the import condition", async () => {
      const root = await project({
        "package.json": JSON.stringify({ name: "site" }),
        "node_modules/esm-only-adapter/package.json": JSON.stringify({
          name: "esm-only-adapter",
          type: "module",
          exports: { ".": { import: "./index.js" } },
        }),
        "node_modules/esm-only-adapter/index.js": ADAPTER_SOURCE("esm-only"),
      });
      try {
        const resolved = await resolveAdapterTarget("esm-only-adapter", root);
        expect(resolved.adapter?.name).toBe("esm-only");
        expect(resolved.package).toBe("esm-only-adapter");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("resolves a scoped package's import-only subpath, nested conditions and a string exports, from a parent folder's node_modules", async () => {
      const root = await project({
        "package.json": JSON.stringify({ name: "monorepo" }),
        "node_modules/@acme/adapter/package.json": JSON.stringify({
          name: "@acme/adapter",
          type: "module",
          exports: {
            ".": "./main.js",
            "./workers": {
              node: { import: "./workers.js" },
              browser: "./x.js",
            },
            "./variants/*": { import: "./variants/*.js" },
          },
        }),
        "node_modules/@acme/adapter/main.js": ADAPTER_SOURCE("acme-main"),
        "node_modules/@acme/adapter/workers.js": ADAPTER_SOURCE("acme-workers"),
        "node_modules/@acme/adapter/variants/pages.js":
          ADAPTER_SOURCE("acme-pages"),
        "site/package.json": JSON.stringify({ name: "site" }),
      });
      const site = join(root, "site");
      try {
        for (const [target, name] of [
          ["@acme/adapter", "acme-main"],
          ["@acme/adapter/workers", "acme-workers"],
          ["@acme/adapter/variants/pages", "acme-pages"],
        ]) {
          const resolved = await resolveAdapterTarget(target, site);
          expect(resolved.adapter?.name, target).toBe(name);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("misuse: an installed package whose exports offer no import entry is reported as installed, naming the exports problem", async () => {
      const root = await project({
        "package.json": JSON.stringify({ name: "site" }),
        "node_modules/browser-only/package.json": JSON.stringify({
          name: "browser-only",
          exports: { ".": { browser: "./b.js" } },
        }),
        "node_modules/browser-only/b.js": ADAPTER_SOURCE("b"),
      });
      try {
        const error = await resolveAdapterTarget("browser-only", root).then(
          () => null,
          (err: Error) => err,
        );
        expect(error?.message).toMatch(
          /adapter package "browser-only" is installed at .*node_modules[\\/]browser-only/,
        );
        expect(error?.message).toMatch(/"exports"/);
        expect(error?.message).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
        expect(error?.message).not.toMatch(/Ensure it is installed/);
        // A subpath the package does not export is named in the message.
        const subpath = await resolveAdapterTarget(
          "browser-only/deploy",
          root,
        ).then(
          () => null,
          (err: Error) => err,
        );
        expect(subpath?.message).toMatch(/"\.\/deploy"/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("misuse: a package that is not installed anywhere keeps the install hint", async () => {
      const root = await project({
        "package.json": JSON.stringify({ name: "site" }),
      });
      try {
        await expect(resolveAdapterTarget("my-adaptr", root)).rejects.toThrow(
          /could not resolve adapter package "my-adaptr"[\s\S]*Ensure it is installed/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("adapter export lacking name or build fails with contract violation error", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-invalid-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    const invalidAdapterPath = join(tempDir, "invalid-adapter.mjs");
    await writeFile(invalidAdapterPath, "export default { name: 'invalid' };");

    try {
      await expect(
        resolveAdapterTarget("./invalid-adapter.mjs", tempDir),
      ).rejects.toThrow(/HostingAdapter contract violation/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adapter export with empty name string fails with contract violation error", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-empty-name-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    const emptyNameAdapterPath = join(tempDir, "empty-name-adapter.mjs");
    await writeFile(
      emptyNameAdapterPath,
      "export default { name: '   ', build: async () => ({ publicDir: 'out' }) };",
    );

    try {
      await expect(
        resolveAdapterTarget("./empty-name-adapter.mjs", tempDir),
      ).rejects.toThrow(/HostingAdapter contract violation/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
