import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { demoImage, VERSIONED_IMAGE_FOLDERS } from "./md-renderer.ts";

/**
 * Everything under VERSIONED_IMAGE_FOLDERS is served with `Cache-Control: immutable` for a year
 * (see scripts/generate-pages-headers.ts). That is only safe while every URL into those folders carries a
 * content hash, and the hash is added by the image helper in md-renderer.ts. A hand-written `<img src>`,
 * `<link href>`, or CSS `url()` into those folders skips the helper and would be cached for a year at a URL
 * whose bytes can change.
 *
 * This test fails when it finds such a reference. Fix it by using a Markdown image (`![alt](/assets/demos/x.webp)`)
 * or `demoImage()` from a `data-bascik-build` script, both of which add the hash. If a folder genuinely must be
 * referenced another way, stop caching it forever instead: remove it from VERSIONED_IMAGE_FOLDERS.
 *
 * Prose and code samples that merely mention a folder are fine. Only attribute and `url()` references count.
 */
const docsDir = join(import.meta.dirname, "../..");
const SCANNED = [
  { dir: join(docsDir, "content"), extensions: [".md"] },
  { dir: join(docsDir, "src/pages"), extensions: [".html"] },
  { dir: join(docsDir, "src/components"), extensions: [".html"] },
  { dir: join(docsDir, "src/css"), extensions: [".css"] },
];

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const folders = VERSIONED_IMAGE_FOLDERS.map((folder) =>
  folder.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"),
).join("|");
/** `src="/assets/demos/..."`, `srcset=...`, `href=...`, `poster=...`, or `url(/assets/vscode/...)`. */
const unversionedReference = new RegExp(
  `(?:\\b(?:src|srcset|href|poster)\\s*=\\s*["'][^"']*(?:${folders}))|(?:url\\(\\s*["']?(?:${folders}))`,
);

describe("versioned image folders", () => {
  it("the detector recognizes the references it exists to catch", () => {
    expect(
      unversionedReference.test('<img src="/assets/demos/a@2x.webp">'),
    ).toBe(true);
    // The helper emits `%40` for `@`; hand-writing the encoded name still bypasses the hash.
    expect(
      unversionedReference.test('<img src="/assets/demos/a%402x.webp">'),
    ).toBe(true);
    expect(
      unversionedReference.test('<source srcset="/assets/vscode/a.webp 2x">'),
    ).toBe(true);
    expect(
      unversionedReference.test(
        '<link rel="preload" href="/assets/demos/a.webp">',
      ),
    ).toBe(true);
    expect(
      unversionedReference.test(
        '.hero { background: url("/assets/demos/a.webp"); }',
      ),
    ).toBe(true);
    expect(
      unversionedReference.test(
        "Images live in /assets/demos/ and /assets/vscode/.",
      ),
    ).toBe(false);
    expect(unversionedReference.test('<img src="/assets/favicon.svg">')).toBe(
      false,
    );
  });

  it("are only referenced through the image helper", () => {
    const offenders: string[] = [];
    for (const { dir, extensions } of SCANNED) {
      for (const file of filesUnder(dir, extensions)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (unversionedReference.test(line))
              offenders.push(
                `${relative(docsDir, file)}:${index + 1}: ${line.trim().slice(0, 120)}`,
              );
          });
      }
    }
    expect(
      offenders,
      "These bypass the image helper, so they have no ?v= hash and would be cached for a year",
    ).toEqual([]);
  });

  it("are emitted by the helper with a hash, at the URL Workers static assets serves without a redirect", () => {
    // Workers static assets 307-redirects a path that differs from its per-segment encodeURIComponent form,
    // so every `@2x` name must go out as `%402x`. A srcset candidate ends at whitespace or a comma, so the
    // emitted URL must hold neither.
    const images = VERSIONED_IMAGE_FOLDERS.flatMap((folder) =>
      readdirSync(join(docsDir, "src/pages", folder))
        .filter((name) => /\.(?:webp|png)$/.test(name))
        .map((name) => `${folder}${name}`),
    );
    expect(images.some((image) => image.includes("@2x"))).toBe(true);
    for (const image of images) {
      const html = demoImage(image, "Image");
      const urls = [...html.matchAll(/\b(?:src|srcset)="([^"]*)"/g)].map(
        (match) => match[1],
      );
      expect(urls.length, image).toBeGreaterThan(0);
      for (const url of urls) {
        const [path, query] = url.split("?");
        expect(query, url).toMatch(/^v=[0-9a-f]{10}$/);
        expect(path, url).toBe(
          path
            .split("/")
            .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
            .join("/"),
        );
        expect(decodeURIComponent(path).startsWith("/assets/"), url).toBe(true);
        expect(url, url).not.toMatch(/[\s,@]/);
      }
    }
  });
});
