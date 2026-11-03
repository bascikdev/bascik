#!/usr/bin/env node
// Reads the JSON that `netlify deploy --alias <alias> --json` prints and returns
// the alias URL, https://<alias>--bascik-netlify-adapter.netlify.app. Fails on
// anything else, such as a production deploy or another Netlify project.
//
// Usage: node .github/scripts/netlify-preview-url.mjs <deploy-json-file> <alias>
import { readFileSync } from "node:fs";

export const NETLIFY_SITE_ID = "268cf8fb-826b-421a-8a34-abd78bf9be1e";
export const NETLIFY_SITE_NAME = "bascik-netlify-adapter";

/**
 * @param {string} output The CLI's JSON output.
 * @param {string} alias The alias passed to `--alias`.
 * @returns {string} The alias URL, without a trailing slash.
 */
export function netlifyPreviewUrl(output, alias) {
  if (typeof alias !== "string" || !/^[a-z][a-z0-9-]*$/.test(alias))
    throw new Error(`netlify-preview-url: "${alias}" is not a preview alias`);
  const deploy = JSON.parse(output);
  const expected = `https://${alias}--${NETLIFY_SITE_NAME}.netlify.app`;
  if (
    deploy?.site_id !== NETLIFY_SITE_ID ||
    typeof deploy?.deploy_url !== "string" ||
    deploy.deploy_url.replace(/\/$/, "") !== expected
  )
    throw new Error(
      `netlify-preview-url: expected ${expected} on the dedicated adapter project, got ${deploy?.deploy_url}`,
    );
  return expected;
}

if (import.meta.main) {
  try {
    const [file, alias] = process.argv.slice(2);
    if (!file || !alias)
      throw new Error(
        "netlify-preview-url: pass the deploy JSON file and the alias",
      );
    console.log(netlifyPreviewUrl(readFileSync(file, "utf8"), alias));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
