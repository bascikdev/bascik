/**
 * Writes the Output blocks of the demos on /component-best-practices from a real `bascik --build`, and the audit finding the page
 * quotes from a real run of the bascik skill's audit-components.mjs.
 *
 *   yarn workspace bascik-docs generate:semantic-html-demos
 *
 * Run it after changing the demos' source blocks, the compiler, or the audit (build pkg first: `yarn pkg:build`).
 * scripts/semantic-html-demos.test.ts regenerates the same way and fails when a committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDemoFence } from "./generate-rtc-demos.ts";
import {
  AUDIT_MARKER,
  DEMOS,
  MD,
  runSemanticHtmlDemos,
} from "./semantic-html-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

/** Replace the ```text fence after `<!-- example:<marker> -->`. */
export function replaceExampleText(
  md: string,
  marker: string,
  text: string,
): string {
  const re = new RegExp(
    `(<!--\\s*example:${marker}\\s*-->\\s*\\n\\s*\`\`\`text\\n)([\\s\\S]*?)(^\`\`\`)`,
    "m",
  );
  if (!re.test(md)) throw new Error(`no text fence after example:${marker}`);
  return md.replace(re, (_, open: string, _old: string, close: string) => {
    return `${open}${text}\n${close}`;
  });
}

async function main(): Promise<void> {
  const run = await runSemanticHtmlDemos();
  const file = path.join(DOCS_ROOT, MD);
  let md = readFileSync(file, "utf8");
  for (const demo of DEMOS)
    md = replaceDemoFence(md, demo.output, run.formatted[demo.id], "html");
  md = replaceExampleText(md, AUDIT_MARKER, run.audit);
  writeFileSync(file, md);
  console.log(`[semantic-html-demos] wrote ${MD}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
