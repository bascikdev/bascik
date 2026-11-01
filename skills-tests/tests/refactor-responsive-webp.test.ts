// Unit tests for skills/bascik-refactor/scripts/responsive-webp.mjs: planning widths (never upscaling), the srcset
// string, the manifest with byte counts and sha256, and the CLI flags. sharp is the reader's project dependency, so
// the script takes it injected; the tests use a fake, plus one round trip through the real sharp the docs package
// already has. Temp dirs only; no network.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  DEFAULT_WIDTHS,
  generateResponsive,
  manifestEntry,
  parseCliArgs,
  planWidths,
  srcsetFor,
  urlPrefixFor,
} from "../../skills/bascik-refactor/scripts/responsive-webp.mjs";

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** A fake sharp: reports the given size and "encodes" to a buffer that names the width and quality. */
const fakeSharp = (size: { width: number; height: number }) => {
  const calls: { width?: number; quality?: number }[] = [];
  const factory = (_input: unknown) => {
    const op: { width?: number; quality?: number } = {};
    const chain = {
      metadata: async () => ({ ...size, format: "png" }),
      rotate: () => chain,
      resize: (o: { width: number }) => {
        op.width = o.width;
        return chain;
      },
      webp: (o: { quality: number }) => {
        op.quality = o.quality;
        return chain;
      },
      toBuffer: async () => {
        calls.push({ ...op });
        return Buffer.from(`webp w=${op.width} q=${op.quality}`);
      },
    };
    return chain;
  };
  return { factory, calls };
};

describe("planWidths", () => {
  it("defaults to the documented widths", () => {
    expect(DEFAULT_WIDTHS).toEqual([320, 480, 640, 768, 960, 1200, 1440, 1600]);
  });

  it("keeps widths up to the source width and never upscales", () => {
    expect(planWidths(2000)).toEqual(DEFAULT_WIDTHS);
    expect(planWidths(640)).toEqual([320, 480, 640]);
  });

  it("adds the source's own width when it falls between two standard widths, so the sharpest variant is not lost", () => {
    expect(planWidths(700)).toEqual([320, 480, 640, 700]);
    expect(planWidths(1500)).toEqual([
      320, 480, 640, 768, 960, 1200, 1440, 1500,
    ]);
  });

  it("a source narrower than every width yields the source width itself", () => {
    expect(planWidths(200)).toEqual([200]);
  });

  it("accepts custom widths, sorted and deduped", () => {
    expect(planWidths(1000, [800, 400, 400, 1200])).toEqual([400, 800, 1000]);
    expect(planWidths(1000, [800, 400])).toEqual([400, 800]);
  });

  it("misuse: a non-positive source width is rejected", () => {
    expect(() => planWidths(0)).toThrow(/width/);
  });
});

describe("srcsetFor and manifestEntry", () => {
  it("builds a srcset in ascending width order", () => {
    expect(
      srcsetFor([
        { width: 960, path: "/img/hero-960.webp" },
        { width: 320, path: "/img/hero-320.webp" },
      ]),
    ).toBe("/img/hero-320.webp 320w, /img/hero-960.webp 960w");
  });

  it("prefers each entry's url, so the srcset works on nested routes", () => {
    expect(
      srcsetFor([
        { width: 640, path: "hero-640.webp", url: "/img/hero-640.webp" },
        { width: 320, path: "hero-320.webp", url: "/img/hero-320.webp" },
      ]),
    ).toBe("/img/hero-320.webp 320w, /img/hero-640.webp 640w");
  });

  it("derives the URL folder from an --out inside src/pages", () => {
    expect(urlPrefixFor("src/pages/img")).toBe("/img/");
    expect(urlPrefixFor("./src/pages/assets/heroes/")).toBe("/assets/heroes/");
    expect(urlPrefixFor("/home/me/site/src/pages")).toBe("/");
    expect(urlPrefixFor("public/img")).toBeUndefined();
  });

  it("a manifest entry carries width, path, bytes and sha256", () => {
    const buf = Buffer.from("webp bytes");
    expect(
      manifestEntry({ width: 320, path: "hero-320.webp", buffer: buf }),
    ).toEqual({
      width: 320,
      path: "hero-320.webp",
      bytes: buf.length,
      sha256: sha(buf),
    });
  });
});

describe("generateResponsive", () => {
  it("writes <name>-<w>.webp files and manifest.json with an injected sharp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-webp-"));
    try {
      const src = join(dir, "hero.png");
      writeFileSync(src, "not really a png");
      const out = join(dir, "out");
      const { factory, calls } = fakeSharp({ width: 700, height: 350 });
      const manifest = await generateResponsive({
        src: [src],
        out,
        quality: 75,
        urlPrefix: "/img/",
        sharp: factory,
      });
      expect(calls).toEqual([
        { width: 320, quality: 75 },
        { width: 480, quality: 75 },
        { width: 640, quality: 75 },
        { width: 700, quality: 75 },
      ]);
      const images = manifest.images["hero.png"];
      expect(images.map((i: { path: string }) => i.path)).toEqual([
        "hero-320.webp",
        "hero-480.webp",
        "hero-640.webp",
        "hero-700.webp",
      ]);
      expect(images[0].url).toBe("/img/hero-320.webp");
      expect(srcsetFor(images)).toMatch(/^\/img\/hero-320\.webp 320w, /);
      for (const image of images) {
        const buf = readFileSync(join(out, image.path));
        expect(image.bytes).toBe(buf.length);
        expect(image.sha256).toBe(sha(buf));
      }
      expect(manifest.sources["hero.png"]).toEqual({ width: 700, height: 350 });
      const written = JSON.parse(
        readFileSync(join(out, "manifest.json"), "utf8"),
      );
      expect(written).toEqual(manifest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the manifest's folder when --manifest points outside --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-webp-manifest-"));
    try {
      const src = join(dir, "hero.png");
      writeFileSync(src, "not really a png");
      const { factory } = fakeSharp({ width: 400, height: 200 });
      const manifest = join(dir, "src/lib/images.json");
      await generateResponsive({
        src: [src],
        out: join(dir, "src/pages/img"),
        manifest,
        sharp: factory,
      });
      expect(
        JSON.parse(readFileSync(manifest, "utf8")).images["hero.png"][0],
      ).toMatchObject({
        width: 320,
        url: "/img/hero-320.webp",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misuse: a missing source file is named", async () => {
    const { factory } = fakeSharp({ width: 700, height: 350 });
    await expect(
      generateResponsive({
        src: ["/nonexistent/hero.png"],
        out: join(tmpdir(), "never-written"),
        quality: 75,
        urlPrefix: "/img/",
        sharp: factory,
      }),
    ).rejects.toThrow(/\/nonexistent\/hero\.png/);
  });

  it("misuse: two sources with the same file name are rejected before anything is written", async () => {
    const { factory, calls } = fakeSharp({ width: 700, height: 350 });
    await expect(
      generateResponsive({
        src: ["legacy/public/a/hero.png", "legacy/public/b/hero.png"],
        out: join(tmpdir(), "never-written"),
        urlPrefix: "/img/",
        sharp: factory,
      }),
    ).rejects.toThrow(/hero\.png.*a\/hero\.png.*b\/hero\.png|same name/);
    expect(calls).toEqual([]);
  });

  it("misuse: an --out outside src/pages without a URL prefix is rejected with the flag to use", async () => {
    const { factory } = fakeSharp({ width: 700, height: 350 });
    await expect(
      generateResponsive({
        src: ["hero.png"],
        out: join(tmpdir(), "public-img"),
        sharp: factory,
      }),
    ).rejects.toThrow(/--url-prefix/);
  });

  it("round-trips a real 2000x10 PNG through sharp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-webp-real-"));
    try {
      const src = join(dir, "strip.png");
      await sharp({
        create: { width: 2000, height: 10, channels: 3, background: "#336699" },
      })
        .png()
        .toFile(src);
      const out = join(dir, "out");
      const manifest = await generateResponsive({
        src: [src],
        out,
        widths: [320, 1600],
        quality: 80,
        urlPrefix: "/img/",
        sharp,
      });
      expect(
        manifest.images["strip.png"].map((i: { width: number }) => i.width),
      ).toEqual([320, 1600]);
      const meta = await sharp(join(out, "strip-1600.webp")).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(1600);
      expect(existsSync(join(out, "manifest.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EXIF orientation (a phone photo)", () => {
  it("writes the photo upright and sizes it from its oriented dimensions", async () => {
    // Stored 40x20 with EXIF orientation 6 (rotate 90 degrees): the photo is 20x40, portrait. sharp drops the tag
    // when it encodes, so a variant that is not rotated first displays sideways.
    const dir = mkdtempSync(join(tmpdir(), "migrate-webp-exif-"));
    try {
      const src = join(dir, "team.jpg");
      await sharp({
        create: { width: 40, height: 20, channels: 3, background: "#336699" },
      })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(src);
      const out = join(dir, "out");
      const manifest = await generateResponsive({
        src: [src],
        out,
        widths: [10, 30],
        urlPrefix: "/img/",
        sharp,
      });
      expect(manifest.sources["team.jpg"]).toEqual({ width: 20, height: 40 });
      expect(
        manifest.images["team.jpg"].map((i: { width: number }) => i.width),
      ).toEqual([10, 20]);
      const meta = await sharp(join(out, "team-10.webp")).metadata();
      expect([meta.width, meta.height]).toEqual([10, 20]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCliArgs", () => {
  it("parses --src (repeatable), --out, --widths, --quality and --manifest", () => {
    expect(
      parseCliArgs([
        "--src",
        "legacy/public/hero.png",
        "--src",
        "legacy/public/press.jpg",
        "--out",
        "src/assets/img",
        "--widths",
        "480,960,1440",
        "--quality",
        "72",
        "--manifest",
        "docs/migration/images.json",
        "--url-prefix",
        "/assets/img/",
      ]),
    ).toEqual({
      src: ["legacy/public/hero.png", "legacy/public/press.jpg"],
      out: "src/assets/img",
      widths: [480, 960, 1440],
      quality: 72,
      manifest: "docs/migration/images.json",
      urlPrefix: "/assets/img/",
    });
  });

  it("defaults quality and manifest", () => {
    expect(parseCliArgs(["--src", "a.png", "--out", "o"])).toMatchObject({
      quality: 80,
      widths: DEFAULT_WIDTHS,
      manifest: join("o", "manifest.json"),
    });
  });

  it("misuse: no --src, no --out, or a quality outside 1-100 names the flag", () => {
    expect(() => parseCliArgs(["--out", "o"])).toThrow(/--src/);
    expect(() => parseCliArgs(["--src", "a.png"])).toThrow(/--out/);
    expect(() =>
      parseCliArgs(["--src", "a.png", "--out", "o", "--quality", "101"]),
    ).toThrow(/--quality/);
    expect(() =>
      parseCliArgs(["--src", "a.png", "--out", "o", "--widths", "320,big"]),
    ).toThrow(/--widths/);
  });
});
