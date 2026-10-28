#!/usr/bin/env node
// Responsive WebP: write <name>-<width>.webp variants of each source image at the standard widths up to its own
// width (never upscaled, and the source width itself when it falls between two), plus manifest.json with each
// file's width, path, site URL, bytes and sha256, for <img srcset>.
// Dependency-free; Node.js 22.18+; needs sharp in your project (npm install -D sharp). Writes only into --out.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadSharp } from "./lib/project-deps.mjs";
import { fail, isMain } from "./lib/cli.mjs";

const HELP = `Usage: node responsive-webp.mjs --src <image>... --out <dir> [--widths 320,480,...] [--quality 80]
                                   [--url-prefix /img/] [--manifest <file>]

Writes <name>-<width>.webp for every width up to the source width and a manifest.json:
{ "sources": { "hero.png": { "width", "height" } },
  "images": { "hero.png": [{ "width", "path", "url", "bytes", "sha256" }] } }
"url" is the root-relative address of each file, so a srcset built from it works on nested routes. Run it once and
commit the output (or register it as a pre exec script); then print <img srcset> from the manifest.

Options:
  --src <file>         Source image (repeatable; file names must differ)
  --out <dir>          Output folder, such as src/pages/img
  --widths <list>      Comma-separated widths (default 320,480,640,768,960,1200,1440,1600)
  --quality <1-100>    WebP quality (default 80)
  --url-prefix <path>  URL folder of --out (default: derived from a folder inside src/pages, such as /img/)
  --manifest <file>    Manifest path (default <out>/manifest.json)
  --help               Show this message`;

export const DEFAULT_WIDTHS = Object.freeze([
  320, 480, 640, 768, 960, 1200, 1440, 1600,
]);

/**
 * The widths to generate for a source: those at or below its width, plus the source width itself when it lies
 * between two requested widths (a 1500 px source gets 1440 and 1500). Never upscales.
 */
export function planWidths(sourceWidth, widths = DEFAULT_WIDTHS) {
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0)
    throw new Error(
      `source width must be a positive number (got ${sourceWidth})`,
    );
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const fit = sorted.filter((w) => w <= sourceWidth);
  if (fit.length === 0) return [sourceWidth];
  if (fit.at(-1) < sourceWidth && sorted.at(-1) > sourceWidth)
    fit.push(sourceWidth);
  return fit;
}

/** A srcset attribute value in ascending width order, from each entry's url (or its path when it has none). */
export function srcsetFor(entries) {
  return [...entries]
    .sort((a, b) => a.width - b.width)
    .map((e) => `${e.url ?? e.path} ${e.width}w`)
    .join(", ");
}

/**
 * The root-relative URL folder of an output folder inside src/pages: "src/pages/img" -> "/img/". Undefined for a
 * folder outside src/pages, where only the caller knows the URL.
 */
export function urlPrefixFor(out) {
  const parts = String(out)
    .split(/[\\/]+/)
    .filter((p) => p && p !== ".");
  for (let i = parts.length - 2; i >= 0; i--)
    if (parts[i] === "src" && parts[i + 1] === "pages") {
      const rest = parts.slice(i + 2);
      return rest.length ? `/${rest.join("/")}/` : "/";
    }
  return undefined;
}

/** A manifest entry: width, path (relative to --out), url, byte count and sha256 hex of the encoded file. */
export function manifestEntry({ width, path, url, buffer }) {
  return {
    width,
    path,
    ...(url !== undefined && { url }),
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Encodes every source. `sharp` is the sharp factory (injected so tests and callers choose it). Returns and writes
 * the manifest: { sources: { name: { width, height } }, images: { name: [entry] } }.
 */
export async function generateResponsive({
  src,
  out,
  widths = DEFAULT_WIDTHS,
  quality = 80,
  manifest,
  urlPrefix,
  sharp,
}) {
  const prefix = urlPrefix ?? urlPrefixFor(out);
  if (prefix === undefined)
    throw new Error(
      `${out} is not inside src/pages, so its URL is unknown; pass --url-prefix, such as /img/`,
    );
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const byName = new Map();
  for (const file of src) {
    const name = basename(file);
    if (byName.has(name))
      throw new Error(
        `${name}: ${byName.get(name)} and ${file} have the same name and would overwrite each other; rename one`,
      );
    byName.set(name, file);
  }
  const result = { sources: {}, images: {} };
  for (const file of src) {
    let input;
    try {
      input = readFileSync(file);
    } catch (error) {
      throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
    }
    const name = basename(file);
    const meta = await sharp(input).metadata();
    result.sources[name] = { width: meta.width, height: meta.height };
    mkdirSync(out, { recursive: true });
    const stem = basename(file, extname(file));
    result.images[name] = [];
    for (const width of planWidths(meta.width, widths)) {
      const buffer = await sharp(input)
        .resize({ width })
        .webp({ quality })
        .toBuffer();
      const path = `${stem}-${width}.webp`;
      writeFileSync(join(out, path), buffer);
      result.images[name].push(
        manifestEntry({ width, path, url: `${base}${path}`, buffer }),
      );
    }
  }
  const manifestPath = manifest ?? join(out, "manifest.json");
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(result, null, 2) + "\n");
  return result;
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      src: { type: "string", multiple: true },
      out: { type: "string" },
      widths: { type: "string" },
      quality: { type: "string" },
      manifest: { type: "string" },
      "url-prefix": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.src?.length)
    throw new Error("--src <image> is required (repeatable)");
  if (!values.out) throw new Error("--out <dir> is required");
  let widths = [...DEFAULT_WIDTHS];
  if (values.widths !== undefined) {
    widths = values.widths.split(",").map((s) => Number(s.trim()));
    if (widths.some((w) => !Number.isInteger(w) || w <= 0))
      throw new Error(
        `--widths must be positive integers such as 320,640,1200 (got "${values.widths}")`,
      );
  }
  const quality = values.quality === undefined ? 80 : Number(values.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new Error(
      `--quality must be an integer from 1 to 100 (got "${values.quality}")`,
    );
  return {
    src: values.src,
    out: values.out,
    widths,
    quality,
    manifest: values.manifest ?? join(values.out, "manifest.json"),
    ...(values["url-prefix"] !== undefined && {
      urlPrefix: values["url-prefix"],
    }),
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  const sharp = await loadSharp();
  const result = await generateResponsive({ ...args, sharp });
  for (const [name, images] of Object.entries(result.images))
    console.log(
      `${name}: ${images.map((i) => `${i.width}w ${Math.round(i.bytes / 1024)} KB`).join(", ")}`,
    );
  console.log(`manifest: ${args.manifest}`);
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(`responsive-webp: ${error.message}`);
  }
}
