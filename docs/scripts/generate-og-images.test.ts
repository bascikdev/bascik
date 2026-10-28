import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { NAV } from "../src/lib/nav.ts";
import {
  generateOgImages,
  renderOgJpeg,
  renderOgSvg,
} from "./generate-og-images.js";

// A valid JPEG shape (SOI ... EOI) that encodes the SVG it came from.
const fakeJpeg = (svg: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from(svg.slice(0, 64)),
    Buffer.from([0xff, 0xd9]),
  ]);

const temporaryDirs: string[] = [];
const makeTemporaryDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bascik-og-"));
  temporaryDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

// A fake card whose bytes differ for every SVG (fakeJpeg keeps only the
// SVG's first characters, which every card shares).
const uniqueRenderer = () => ({
  render: async (svg: string) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      createHash("sha256").update(svg).digest(),
      Buffer.from([0xff, 0xd9]),
    ]),
});

const countingRenderer = () => {
  const rendered: string[] = [];
  return {
    rendered,
    render: async (svg: string) => {
      rendered.push(svg);
      return fakeJpeg(svg);
    },
  };
};

const readCards = async (dir: string): Promise<Map<string, Buffer>> => {
  const cards = new Map<string, Buffer>();
  for (const name of (await fs.readdir(dir)).sort())
    cards.set(name, await fs.readFile(path.join(dir, name)));
  return cards;
};

describe("generate-og-images cache", () => {
  it("renders every card once and copies identical bytes from the cache on the next run", async () => {
    const cacheDir = await makeTemporaryDir();
    const first = countingRenderer();
    const firstOut = await makeTemporaryDir();
    await generateOgImages({
      outDir: firstOut,
      cacheDir,
      render: first.render,
    });
    const firstCards = await readCards(firstOut);
    expect(first.rendered.length).toBe(firstCards.size);
    expect(firstCards.has("home.jpg")).toBe(true);

    const second = countingRenderer();
    const secondOut = await makeTemporaryDir();
    await generateOgImages({
      outDir: secondOut,
      cacheDir,
      render: second.render,
    });
    expect(second.rendered).toEqual([]);
    expect(await readCards(secondOut)).toEqual(firstCards);
  });

  it("re-renders a card whose cache entry is missing or corrupt", async () => {
    const cacheDir = await makeTemporaryDir();
    const outDir = await makeTemporaryDir();
    await generateOgImages({
      outDir,
      cacheDir,
      render: countingRenderer().render,
    });
    const entries = (await fs.readdir(cacheDir)).sort();
    await fs.writeFile(path.join(cacheDir, entries[0]), "not a jpeg");
    await fs.rm(path.join(cacheDir, entries[1]));

    const again = countingRenderer();
    await generateOgImages({ outDir, cacheDir, render: again.render });
    expect(again.rendered.length).toBe(2);
    const repaired = await fs.readFile(path.join(cacheDir, entries[0]));
    expect(repaired.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("keys cards by their SVG markup, so different markup never shares an entry", async () => {
    const cacheDir = await makeTemporaryDir();
    const outDir = await makeTemporaryDir();
    const run = countingRenderer();
    await generateOgImages({ outDir, cacheDir, render: run.render });
    const distinctSvgs = new Set(run.rendered).size;
    expect(
      (await fs.readdir(cacheDir)).filter((name) => name.endsWith(".jpg"))
        .length,
    ).toBe(distinctSvgs);
  });

  it("always renders when the cache is disabled", async () => {
    const outDir = await makeTemporaryDir();
    const first = countingRenderer();
    await generateOgImages({ outDir, cacheDir: false, render: first.render });
    const second = countingRenderer();
    await generateOgImages({ outDir, cacheDir: false, render: second.render });
    expect(second.rendered.length).toBe(first.rendered.length);
  });

  // The cards render in chunks with Promise.all, which is parallel only if
  // the rasterising happens off the calling thread. A synchronous
  // `new Resvg(svg).render()` held the main thread for every card in turn:
  // about 5 s for the site's cards on an idle machine, and past the 30 s
  // test timeout while four e2e lanes shared the machine. The share of a
  // render spent before the call returns is a ratio, so load does not move
  // it: almost all of it while rasterising ran in the call, almost none now.
  it("rasterises off the calling thread, so the chunked cards render in parallel", async () => {
    const svg = renderOgSvg("Title", "Overview", "Description.");
    await renderOgJpeg(svg); // load the fonts and the native module once
    let syncMs = 0;
    let totalMs = 0;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const pending = renderOgJpeg(svg);
      syncMs += performance.now() - started;
      await pending;
      totalMs += performance.now() - started;
    }
    expect(syncMs / totalMs).toBeLessThan(0.1);
  });

  it("renders a real JPEG for one card", async () => {
    const jpeg = await renderOgJpeg(
      renderOgSvg("Title", "Overview", "Description."),
    );
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe("generate-og-images", () => {
  it("renders valid SVG markup with renderOgSvg", () => {
    const svg = renderOgSvg(
      "Getting Started with Bascik",
      "Overview",
      "Learn how to install and build HTML components.",
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg).toContain("OVERVIEW");
    expect(svg).toContain("Getting Started");
    expect(svg).toContain("with Bascik");
    expect(svg).toContain("Learn how to install and build");
    expect(svg).toContain("bascik.dev");
  });

  // Every page gets a card. Rendering them all for real took about 5 s on
  // an idle machine and up to 30 s (the test's timeout) while four e2e lanes
  // built at once, so the fake renderer covers the full set and only the
  // cards checked below go through the real, default renderer.
  it("writes a card for every page, named after its path", async () => {
    const outDir = await makeTemporaryDir();
    await generateOgImages({
      outDir,
      cacheDir: false,
      render: uniqueRenderer().render,
    });
    const expected = [
      "home.jpg",
      ...NAV.flatMap((section) =>
        section.pages
          .filter((navPage) => !navPage.external)
          .map(
            (navPage) =>
              `${navPage.href.replace(/^\//, "").replace(/\//g, "-")}.jpg`,
          ),
      ),
    ].sort();
    expect((await fs.readdir(outDir)).sort()).toEqual(expected);
    for (const name of [
      "home.jpg",
      "getting-started.jpg",
      "how-to-markdown.jpg",
    ])
      expect(expected).toContain(name);
  });

  it("renders real 1200x630 JPEGs with the default renderer", async () => {
    // Fill the cache with a fake card per page, each with distinct bytes so
    // a card can be traced back to its cache entry, then remove the entries
    // of the cards checked here: the default renderer renders exactly those.
    const cacheDir = await makeTemporaryDir();
    const seededOut = await makeTemporaryDir();
    await generateOgImages({
      outDir: seededOut,
      cacheDir,
      render: uniqueRenderer().render,
    });
    const seeded = await readCards(seededOut);
    const cacheEntries = await readCards(cacheDir);
    const checked = ["home.jpg", "getting-started.jpg", "how-to-markdown.jpg"];
    for (const name of checked) {
      const entry = [...cacheEntries].find(([, bytes]) =>
        bytes.equals(seeded.get(name)!),
      );
      expect(entry, name).toBeDefined();
      await fs.rm(path.join(cacheDir, entry![0]));
    }

    const ogDir = await makeTemporaryDir();
    await generateOgImages({ outDir: ogDir, cacheDir });
    const cards = await readCards(ogDir);

    for (const name of checked) {
      const jpeg = cards.get(name)!;
      expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(jpeg.equals(seeded.get(name)!)).toBe(false);
      const { format, width, height } = await sharp(jpeg).metadata();
      expect({ format, width, height }).toEqual({
        format: "jpeg",
        width: 1200,
        height: 630,
      });
    }
    // Every other card came from the cache untouched.
    for (const [name, bytes] of seeded)
      if (!checked.includes(name)) expect(cards.get(name)).toEqual(bytes);
  });
});
