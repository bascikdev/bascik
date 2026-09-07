/**
 * Prompt 140 (Half B): `http.precompress: true` gives the precompressed
 * sidecar provenance contract a producer. The build emits `<asset>.br`,
 * `<asset>.br.bmeta`, `<asset>.gz`, `<asset>.gz.bmeta` for compressible
 * assets above `COMPRESSION_MIN_BYTES`, with `.bmeta` recording exactly the
 * hash the server compares against (`getContentHashEtag(rawBytes)`), so a
 * sidecar is never served under an ETag that describes different bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

// Pass-through `node:fs/promises` with one injectable failure point: the
// nit #9 test makes `writeFile` throw AFTER the bytes reached disk (the shape
// of a mid-write ENOSPC) to prove the producer removes its temp sibling. ESM
// namespaces cannot be spied on, so the seam is a module mock.
const { writeFileFailure } = vi.hoisted(() => ({
  writeFileFailure: { nextError: null as Error | null },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof actual.writeFile = async (path, data, options) => {
    await actual.writeFile(path, data, options as never);
    if (writeFileFailure.nextError && String(path).includes(".tmp")) {
      const err = writeFileFailure.nextError;
      writeFileFailure.nextError = null;
      throw err;
    }
  };
  return { ...actual, writeFile };
});

import { mkdir, mkdtemp, readFile, rm, writeFile, stat as fsStat } from "node:fs/promises";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "src/pages", components: ["src/components"] },
    isBuild: true,
    generate: { manifest: true, cspHashes: false, sitemap: false, robots: false },
    only: undefined,
    minify: { identifiers: false },
    http: { compression: true, precompress: true },
  },
  shouldLog: vi.fn(() => true),
}));

import { finalizeOwnedArtifacts, ownershipTracker } from "./ownership.ts";
import { manifestCollector } from "./manifest.ts";
import { cspHashCollector } from "./csp-hashes.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { BascikConfig } from "./config.ts";
import {
  COMPRESSION_MIN_BYTES,
  getContentHashEtag,
  getStaticRepresentation,
  clearStaticRepresentationCache,
  getOnTheFlyCompressionCount,
} from "./caching.ts";

const exists = async (p: string): Promise<boolean> => {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
};

describe("Prompt 140 - precompressed sidecar producer (http.precompress)", () => {
  let dist: string;
  const cssBody = Buffer.from(".a{color:red}.b{margin:0}\n".repeat(60)); // well above COMPRESSION_MIN_BYTES
  const pngBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 2000 }, (_, i) => i & 0xff)]);
  const tinyBody = Buffer.from("p{}"); // below COMPRESSION_MIN_BYTES

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "bascik-precompress-"));
    (BascikConfig as any).directory.out = dist;
    (BascikConfig as any).http.precompress = true;
    (BascikConfig as any).http.compression = true;
    ownershipTracker.clear();
    manifestCollector.clear();
    cspHashCollector.clear();
    serverSidecarRegistry.clear();
    clearStaticRepresentationCache();
    await mkdir(join(dist, "nested"), { recursive: true });
    await writeFile(join(dist, "styles.css"), cssBody);
    await writeFile(join(dist, "nested", "app.js"), cssBody);
    await writeFile(join(dist, "logo.png"), pngBody);
    await writeFile(join(dist, "tiny.css"), tinyBody);
    // The build records copied assets in the manifest collector; the producer
    // walks that record rather than the filesystem so it emits only for files
    // this build produced.
    for (const rel of ["styles.css", "nested/app.js", "logo.png", "tiny.css"]) {
      await manifestCollector.recordFileFromDisk(join(dist, rel));
    }
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true }).catch(() => {});
  });

  it("emits .br/.gz sidecars with .bmeta provenance for compressible assets above COMPRESSION_MIN_BYTES only", async () => {
    expect(cssBody.byteLength).toBeGreaterThan(COMPRESSION_MIN_BYTES);
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });

    for (const rel of ["styles.css", "nested/app.js"]) {
      const asset = join(dist, rel);
      for (const enc of ["br", "gz"] as const) {
        expect(await exists(`${asset}.${enc}`), `${rel}.${enc}`).toBe(true);
        expect(await exists(`${asset}.${enc}.bmeta`), `${rel}.${enc}.bmeta`).toBe(true);
        const meta = JSON.parse(await readFile(`${asset}.${enc}.bmeta`, "utf8")) as { rawHash?: string };
        expect(meta.rawHash).toBe(getContentHashEtag(cssBody));
      }
      // Sidecar bytes decode to exactly the raw asset.
      expect(zlib.brotliDecompressSync(await readFile(`${asset}.br`)).equals(cssBody)).toBe(true);
      expect(zlib.gunzipSync(await readFile(`${asset}.gz`)).equals(cssBody)).toBe(true);
    }

    // Incompressible and too-small assets get nothing.
    for (const rel of ["logo.png", "tiny.css"]) {
      for (const suffix of [".br", ".br.bmeta", ".gz", ".gz.bmeta"]) {
        expect(await exists(join(dist, rel) + suffix), `${rel}${suffix}`).toBe(false);
      }
    }
  });

  it("records the sidecars in the manifest so the build inventory accounts for them", async () => {
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });
    const manifest = JSON.parse(await readFile(join(dist, ".bascik", "manifest.json"), "utf8")) as {
      files: Record<string, { hash: string; size: number }>;
    };
    for (const key of ["styles.css.br", "styles.css.br.bmeta", "styles.css.gz", "styles.css.gz.bmeta", "nested/app.js.br"]) {
      expect(manifest.files[key], key).toBeDefined();
    }
    expect(manifest.files["logo.png.br"]).toBeUndefined();
  });

  it("the server's representation owner accepts the emitted sidecar verbatim (no on-the-fly compression)", async () => {
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });
    const asset = join(dist, "styles.css");
    const sidecar = await readFile(`${asset}.br`);
    const codecRunsBefore = getOnTheFlyCompressionCount();
    const repr = await getStaticRepresentation(asset, "br");
    expect(repr).not.toBeNull();
    expect(repr!.buffer.equals(sidecar)).toBe(true);
    expect(getOnTheFlyCompressionCount()).toBe(codecRunsBefore);
  });

  it("emits nothing when http.precompress is off (default)", async () => {
    (BascikConfig as any).http.precompress = false;
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });
    expect(await exists(join(dist, "styles.css.br"))).toBe(false);
    expect(await exists(join(dist, "styles.css.br.bmeta"))).toBe(false);
  });

  it("is atomic: no partial sidecar temp files remain after finalize", async () => {
    await finalizeOwnedArtifacts("1.0.0", { forTargetedBuild: false });
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dist);
    expect(names.filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("a failed sidecar write removes its temp sibling and surfaces the error (nit #9)", async () => {
    // The first temp write lands on disk and then reports ENOSPC: the partial
    // temp sibling must not be left behind, and the error must propagate.
    writeFileFailure.nextError = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    try {
      const { emitPrecompressedSidecars } = await import("./precompress.ts");
      await expect(emitPrecompressedSidecars()).rejects.toThrow(/ENOSPC/);
      expect(writeFileFailure.nextError).toBeNull();
      const { readdir } = await import("node:fs/promises");
      const all = [...(await readdir(dist)), ...(await readdir(join(dist, "nested")))];
      expect(all.filter((n) => n.includes(".tmp"))).toEqual([]);
    } finally {
      writeFileFailure.nextError = null;
    }
  });
});
