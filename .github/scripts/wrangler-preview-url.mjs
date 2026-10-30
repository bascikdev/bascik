#!/usr/bin/env node
// Reads the Preview alias URL from Wrangler's machine-readable output. With
// WRANGLER_OUTPUT_FILE_PATH set, `wrangler versions upload` appends one
// ND-JSON line per command; the "version-upload" entry carries
// `preview_alias_url` when the upload had --preview-alias and the Worker has
// Preview URLs on (`preview_urls: true`).
//
// Usage: node .github/scripts/wrangler-preview-url.mjs <output-file>
// Prints the URL, or exits 1 naming what is missing.
import { readFileSync } from "node:fs";

/**
 * @param {string} ndjson The contents of the Wrangler output file.
 * @returns {string} The `preview_alias_url` of the last version upload.
 */
export function previewAliasUrl(ndjson) {
  /** @type {Record<string, unknown> | undefined} */
  let upload;
  const lines = ndjson.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(
        `wrangler-preview-url: line ${index + 1} of the Wrangler output is not JSON`,
      );
    }
    if (entry && entry.type === "version-upload") upload = entry;
  }
  if (!upload)
    throw new Error(
      "wrangler-preview-url: the Wrangler output has no version-upload entry (did `wrangler versions upload` run and succeed?)",
    );
  const url = upload.preview_alias_url;
  if (typeof url !== "string" || url === "")
    throw new Error(
      "wrangler-preview-url: the upload has no Preview alias URL. Pass --preview-alias, set preview_urls: true in the Worker's config, and check that the account has a workers.dev subdomain.",
    );
  if (!url.startsWith("https://"))
    throw new Error(
      `wrangler-preview-url: unexpected Preview alias URL "${url}"`,
    );
  return url;
}

if (import.meta.main) {
  const file = process.argv[2];
  try {
    if (!file)
      throw new Error(
        "wrangler-preview-url: pass the WRANGLER_OUTPUT_FILE_PATH file",
      );
    process.stdout.write(`${previewAliasUrl(readFileSync(file, "utf8"))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
