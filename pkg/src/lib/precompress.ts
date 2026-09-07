/**
 * @module precompress
 *
 * Build-time producer for the precompressed sidecar provenance contract
 * (prompt 140, Half B). The server's representation owner (`caching.ts`) will
 * only serve `<asset>.br` / `<asset>.gz` when a sibling `.bmeta` records the
 * current raw content hash. Before this module nothing in the build produced
 * those files, so the contract had a consumer and no producer.
 *
 * With `http.precompress: true` the build emits, for every compressible asset
 * it produced whose size is at least `COMPRESSION_MIN_BYTES`:
 *
 *   <asset>.br        Brotli (max quality) of the raw bytes
 *   <asset>.br.bmeta  {"rawHash": "<getContentHashEtag(raw)>"}
 *   <asset>.gz        gzip (level 9) of the raw bytes
 *   <asset>.gz.bmeta  {"rawHash": "<getContentHashEtag(raw)>"}
 *
 * The hash function is the exact one the server compares against, so a
 * sidecar written by this build can never be served under an ETag describing
 * different bytes. Files are written to a temp sibling and renamed into place
 * so a crash mid-build leaves no half-written sidecar. Each emitted file is
 * recorded in the manifest collector so the build inventory accounts for it.
 *
 * Default off: it costs build time (two max-quality codec passes per asset)
 * and roughly doubles the on-disk footprint of compressible assets.
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { BascikConfig } from "./config.ts";
import { COMPRESSION_MIN_BYTES, getContentHashEtag, isCompressibleMime } from "./caching.ts";
import { MIME_MAP } from "./mime.ts";
import { manifestCollector } from "./manifest.ts";

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

/** Suffixes this module owns; anything already carrying one is never re-encoded. */
const SIDECAR_SUFFIX = /\.(br|gz)(\.bmeta)?$/;

export interface PrecompressResult {
  /** dist-relative paths of every sidecar and provenance file written. */
  emitted: string[];
}

/** Whether a dist-relative output should receive sidecars. */
export const isPrecompressCandidate = (distRelPath: string, size: number): boolean => {
  if (SIDECAR_SUFFIX.test(distRelPath)) return false;
  // Pages are served from memory with their own precomputed Brotli/gzip;
  // sidecars are for the on-disk static asset path only.
  if (/\.html?$/i.test(distRelPath)) return false;
  // `.bascik/*` metadata is never served.
  if (distRelPath.startsWith(".bascik/")) return false;
  if (size < COMPRESSION_MIN_BYTES) return false;
  const ext = extname(distRelPath).toLowerCase();
  if (!ext) return false;
  const mime = MIME_MAP.get(ext) ?? "application/octet-stream";
  return isCompressibleMime(mime, ext);
};

const atomicWriteBytes = async (target: string, bytes: Buffer | string): Promise<void> => {
  const tmp = join(dirname(target), `.${target.split(/[\\/]/).pop()}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

/**
 * Emit verified sidecars for one asset. Reads the raw bytes once; the hash,
 * both encodings, and both provenance stamps derive from that single read.
 */
const emitSidecarsFor = async (outDir: string, distRelPath: string): Promise<string[]> => {
  const abs = resolve(outDir, distRelPath);
  const raw = await readFile(abs);
  const rawHash = getContentHashEtag(raw);
  const meta = JSON.stringify({ rawHash });

  const [br, gz] = await Promise.all([
    brotliCompressAsync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    }),
    gzipAsync(raw, { level: zlib.constants.Z_BEST_COMPRESSION }),
  ]);

  const outputs: Array<[string, Buffer | string]> = [
    [`${distRelPath}.br`, br],
    [`${distRelPath}.br.bmeta`, meta],
    [`${distRelPath}.gz`, gz],
    [`${distRelPath}.gz.bmeta`, meta],
  ];
  for (const [rel, bytes] of outputs) {
    await atomicWriteBytes(resolve(outDir, rel), bytes);
    manifestCollector.recordFile(resolve(outDir, rel), bytes);
  }
  return outputs.map(([rel]) => rel);
};

/**
 * Produce sidecars for every candidate the current build recorded in the
 * manifest collector. Walking the collector (not the filesystem) means a
 * targeted build only emits for what it rebuilt, and stale files outside this
 * build's ownership are never touched. No-op unless `http.precompress` is on.
 */
export const emitPrecompressedSidecars = async (): Promise<PrecompressResult> => {
  const emitted: string[] = [];
  if (BascikConfig.http?.precompress !== true) return { emitted };

  const outDir = resolve(process.cwd(), BascikConfig.directory.out);
  const files = manifestCollector.getFiles();
  const candidates = Object.entries(files)
    .filter(([rel, entry]) => isPrecompressCandidate(rel, entry.size))
    .map(([rel]) => rel);

  for (const rel of candidates) {
    emitted.push(...(await emitSidecarsFor(outDir, rel)));
  }
  return { emitted };
};
