/**
 * Checking one message's uploads before any is stored: the limits, then each
 * file's bytes, answered in words for the reader when something is refused.
 */
import { randomUUID } from "node:crypto";
import { cleanName, formatSize, storedName } from "./names.ts";
import { mediaTypeOf, sniffFile } from "./sniff.ts";
import type { ResolvedFileLimits } from "./types.ts";

const LABELS: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "application/pdf": "PDF",
  "text/plain": "plain text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
};

/** What a reader is told. The page's script says the same words. */
export const refusals = {
  count: (max: number): string =>
    `You can attach up to ${max} file${max === 1 ? "" : "s"} to one message.`,
  tooLarge: (name: string, size: number, max: number): string =>
    `"${name}" is too large (${formatSize(size)}). Each file can be up to ${formatSize(max)}.`,
  total: (size: number, max: number): string =>
    `These files are too large together (${formatSize(size)}). One message can carry up to ${formatSize(max)}.`,
  empty: (name: string): string => `"${name}" is empty.`,
  type: (name: string, types: readonly string[]): string =>
    `"${name}" cannot be attached: that type of file is not allowed. Allowed types: ${types.map((type) => LABELS[type] ?? type).join(", ")}.`,
  markup: (name: string): string =>
    `"${name}" cannot be attached: HTML and SVG files are not allowed.`,
  mismatch: (name: string, claimed: string): string =>
    `"${name}" does not look like the ${LABELS[claimed] ?? claimed} file it says it is, so it was not attached.`,
};

export interface CheckedFile {
  /** The id the file is stored under: made here, never taken from the upload. */
  id: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type UploadCheck =
  { ok: true; files: CheckedFile[] } | { ok: false; message: string };

/**
 * Check one message's uploads against the limits and their bytes, before any
 * is stored. The first problem found is the answer, in words for the reader.
 */
export async function checkUploads(
  uploads: readonly File[],
  limits: ResolvedFileLimits,
): Promise<UploadCheck> {
  if (uploads.length > limits.maxFiles) {
    return { ok: false, message: refusals.count(limits.maxFiles) };
  }
  let total = 0;
  for (const upload of uploads) {
    if (upload.size > limits.maxFileBytes) {
      return {
        ok: false,
        message: refusals.tooLarge(
          cleanName(upload.name),
          upload.size,
          limits.maxFileBytes,
        ),
      };
    }
    total += upload.size;
  }
  if (total > limits.maxTotalBytes) {
    return { ok: false, message: refusals.total(total, limits.maxTotalBytes) };
  }
  const files: CheckedFile[] = [];
  for (const upload of uploads) {
    const name = cleanName(upload.name);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const found = sniffFile(bytes, upload.type, upload.name, limits.types);
    if ("refused" in found) {
      return {
        ok: false,
        message:
          found.refused === "empty"
            ? refusals.empty(name)
            : found.refused === "markup"
              ? refusals.markup(name)
              : found.refused === "mismatch"
                ? refusals.mismatch(name, mediaTypeOf(upload.type))
                : refusals.type(name, limits.types),
      };
    }
    files.push({
      id: randomUUID(),
      name: storedName(upload.name, found.mediaType),
      mediaType: found.mediaType,
      bytes,
    });
  }
  return { ok: true, files };
}
