import { describe, expect, it } from "vitest";
import { resolveAdapterTarget } from "./adapter-resolution.ts";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("resolveAdapterTarget", () => {
  it("resolves cloudflare-pages to official package with pages variant", async () => {
    const resolved = await resolveAdapterTarget("cloudflare-pages", process.cwd(), { load: false });
    expect(resolved.package).toBe("@bascik/adapter-cloudflare");
    expect(resolved.variant).toBe("pages");
  });

  it("resolves cloudflare-workers to official package with workers variant", async () => {
    const resolved = await resolveAdapterTarget("cloudflare-workers", process.cwd(), { load: false });
    expect(resolved.package).toBe("@bascik/adapter-cloudflare");
    expect(resolved.variant).toBe("workers");
  });

  it("treats custom package name as package specifier", async () => {
    const resolved = await resolveAdapterTarget("@acme/adapter-foo", process.cwd(), { load: false });
    expect(resolved.package).toBe("@acme/adapter-foo");
    expect(resolved.variant).toBeUndefined();
  });

  it("treats relative path as path form", async () => {
    const resolved = await resolveAdapterTarget("./my-adapter.ts", process.cwd(), { load: false });
    expect(resolved.package).toBeUndefined();
    expect(resolved.path).toBe(join(process.cwd(), "my-adapter.ts"));
  });

  it("missing official package produces actionable error naming npm install", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ name: "dummy" }));

    try {
      await expect(resolveAdapterTarget("cloudflare-pages", tempDir)).rejects.toThrow(
        /npm install --save-dev @bascik\/adapter-cloudflare/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adapter export lacking name or build fails with contract violation error", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-invalid-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    const invalidAdapterPath = join(tempDir, "invalid-adapter.mjs");
    await writeFile(invalidAdapterPath, "export default { name: 'invalid' };");

    try {
      await expect(resolveAdapterTarget("./invalid-adapter.mjs", tempDir)).rejects.toThrow(
        /HostingAdapter contract violation/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adapter export with empty name string fails with contract violation error", async () => {
    const tempDir = join(tmpdir(), `bascik-test-res-empty-name-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    const emptyNameAdapterPath = join(tempDir, "empty-name-adapter.mjs");
    await writeFile(emptyNameAdapterPath, "export default { name: '   ', build: async () => ({ publicDir: 'out' }) };");

    try {
      await expect(resolveAdapterTarget("./empty-name-adapter.mjs", tempDir)).rejects.toThrow(
        /HostingAdapter contract violation/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
