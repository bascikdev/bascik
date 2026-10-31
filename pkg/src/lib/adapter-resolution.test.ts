import { describe, expect, it } from "vitest";
import {
  isLocalAdapterPath,
  resolveAdapterTarget,
} from "./adapter-resolution.ts";
import { join, posix, win32 } from "node:path";
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

    it("misuse: an exports target or wildcard with a '..', '.' or node_modules segment is not followed outside the package, as in Node", async () => {
      const root = await project({
        "package.json": JSON.stringify({ name: "site" }),
        "node_modules/escaping-adapter/package.json": JSON.stringify({
          name: "escaping-adapter",
          type: "module",
          exports: {
            ".": { import: "./../outside.js" },
            "./here": { import: "./././index.js" },
            "./dep": { import: "./node_modules/dep/index.js" },
            "./p/*": { import: "./p/*.js" },
          },
        }),
        "node_modules/escaping-adapter/index.js": ADAPTER_SOURCE("inside"),
        "node_modules/escaping-adapter/node_modules/dep/index.js":
          ADAPTER_SOURCE("dep"),
        "node_modules/escaping-adapter/p/ok.js": ADAPTER_SOURCE("ok"),
        "node_modules/outside.js": ADAPTER_SOURCE("outside"),
      });
      try {
        for (const target of [
          "escaping-adapter",
          "escaping-adapter/here",
          "escaping-adapter/dep",
          "escaping-adapter/p/../../outside",
          "escaping-adapter/p/%2e%2e/%2E%2E/outside",
          "escaping-adapter/p/node_modules/x",
        ]) {
          const error = await resolveAdapterTarget(target, root).then(
            () => null,
            (err: Error) => err,
          );
          expect(error?.message, target).toMatch(
            /adapter package "[^"]+" is installed at .*, but it has no entry Bascik can import/,
          );
        }
        // A wildcard with ordinary segments still resolves.
        const ok = await resolveAdapterTarget("escaping-adapter/p/ok", root);
        expect(ok.adapter?.name).toBe("ok");
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

  it("resolves an official adapter whose exports offer only the import condition, like any package adapter", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "site" }),
      "node_modules/@bascik/adapter-cloudflare/package.json": JSON.stringify({
        name: "@bascik/adapter-cloudflare",
        type: "module",
        exports: { ".": { import: "./index.js" } },
      }),
      "node_modules/@bascik/adapter-cloudflare/index.js":
        ADAPTER_SOURCE("cloudflare"),
    });
    try {
      const resolved = await resolveAdapterTarget("cloudflare-pages", root);
      expect(resolved.adapter?.name).toBe("cloudflare");
      expect(resolved.variant).toBe("pages");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("misuse: an installed official adapter with no importable entry is reported as installed, not as missing", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "site" }),
      "node_modules/@bascik/adapter-cloudflare/package.json": JSON.stringify({
        name: "@bascik/adapter-cloudflare",
        exports: { ".": { browser: "./b.js" } },
      }),
    });
    try {
      const error = await resolveAdapterTarget("cloudflare", root).then(
        () => null,
        (err: Error) => err,
      );
      expect(error?.message).toMatch(
        /adapter package "@bascik\/adapter-cloudflare" is installed at .*, but it has no entry Bascik can import/,
      );
      expect(error?.message).not.toMatch(/is not installed in this project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("misuse: an installed official adapter whose own import fails names the missing module, not a missing adapter (F090)", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "site" }),
      "node_modules/@bascik/adapter-cloudflare/package.json": JSON.stringify({
        name: "@bascik/adapter-cloudflare",
        type: "module",
        exports: { ".": { default: "./index.js" } },
      }),
      "node_modules/@bascik/adapter-cloudflare/index.js":
        'import "pruned-bundler-dependency";\n' + ADAPTER_SOURCE("cloudflare"),
    });
    try {
      const error = await resolveAdapterTarget("cloudflare", root).then(
        () => null,
        (err: Error) => err,
      );
      expect(error?.message).toMatch(
        /--target cloudflare: "@bascik\/adapter-cloudflare" is installed but failed to load/,
      );
      expect(error?.message).toContain("pruned-bundler-dependency");
      expect(error?.message).not.toMatch(/is not installed in this project/);
      // The original error stays reachable for a stack trace.
      expect((error?.cause as NodeJS.ErrnoException)?.code).toBe(
        "ERR_MODULE_NOT_FOUND",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

// docs/content/cli.md: --target takes "a local path". PowerShell and cmd
// complete a relative file as .\my-adapter.ts, which was read as a package
// name on Windows ("could not resolve adapter package").
describe("isLocalAdapterPath", () => {
  it.each([
    ["./my-adapter.ts", true],
    ["../shared/adapter.ts", true],
    ["/abs/adapter.ts", true],
    ["@acme/adapter-foo", false],
    ["adapter-foo", false],
    ["cloudflare", false],
    // A backslash is a filename character on posix, never a separator.
    [".\\my-adapter.ts", false],
    ["..\\shared\\adapter.ts", false],
  ])("posix %s -> %s", (target, expected) => {
    expect(isLocalAdapterPath(target, posix)).toBe(expected);
  });

  it.each([
    ["./my-adapter.ts", true],
    ["../shared/adapter.ts", true],
    [".\\my-adapter.ts", true],
    ["..\\shared\\adapter.ts", true],
    ["C:\\site\\adapter.ts", true],
    ["C:/site/adapter.ts", true],
    ["\\\\srv\\share\\adapter.ts", true],
    ["@acme/adapter-foo", false],
    ["adapter-foo", false],
    // misuse: a dot-prefixed name that is not a relative path stays a package.
    [".adapter", false],
    ["..adapter", false],
  ])("win32 %s -> %s", (target, expected) => {
    expect(isLocalAdapterPath(target, win32)).toBe(expected);
  });
});
