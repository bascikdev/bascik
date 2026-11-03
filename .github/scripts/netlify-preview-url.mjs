#!/usr/bin/env node
import { readFileSync } from "node:fs";

export function netlifyPreviewUrl(output) {
  const deploy = JSON.parse(output);
  const url = deploy?.deploy_url;
  const id = deploy?.deploy_id;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{24}$/.test(id) ||
    typeof url !== "string" ||
    new URL(url).origin !==
      `https://${id}--bascik-netlify-adapter.netlify.app` ||
    new URL(url).pathname !== "/"
  ) {
    throw new Error(
      "netlify-preview-url: expected the dedicated site's immutable draft deploy URL, not production",
    );
  }
  return new URL(url).origin;
}

if (import.meta.main) {
  try {
    if (!process.argv[2])
      throw new Error("netlify-preview-url: pass the deploy JSON output file");
    console.log(netlifyPreviewUrl(readFileSync(process.argv[2], "utf8")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
