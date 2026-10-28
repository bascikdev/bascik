/**
 * Writes the Output blocks of the "Returning component tags" demos from the real `bascik --server` responses.
 *
 *   yarn workspace bascik-docs generate:rtc-demos
 *
 * Run it after changing a demo's source blocks or the request renderer (build pkg first: `yarn pkg:build`).
 * scripts/rtc-demos.test.ts regenerates the same way and fails when a committed block differs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMOS, runRtcDemos } from "./rtc-demos.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "..");

/** Replaces the fence after `<!-- demo:marker -->` (and an optional prettier-ignore line) with `code`. */
export function replaceDemoFence(
  md: string,
  marker: string,
  code: string,
): string {
  const re = new RegExp(
    `(<!--\\s*demo:${marker}\\s*-->\\s*\\n(?:\\s*<!--\\s*prettier-ignore\\s*-->\\s*\\n)?\\s*\`\`\`html\\n)([\\s\\S]*?)(^\`\`\`)`,
    "m",
  );
  if (!re.test(md)) throw new Error(`no html fence after demo:${marker}`);
  return md.replace(re, (_, open: string, _old: string, close: string) => {
    return `${open}${code}\n${close}`;
  });
}

async function main(): Promise<void> {
  const run = await runRtcDemos();
  const files = new Map<string, string>();
  for (const demo of DEMOS) {
    const file = path.join(DOCS_ROOT, demo.md);
    const md = files.get(file) ?? readFileSync(file, "utf8");
    files.set(
      file,
      replaceDemoFence(md, demo.outputMarker, run.formatted[demo.id]),
    );
  }
  for (const [file, md] of files) {
    writeFileSync(file, md);
    console.log(`[rtc-demos] wrote ${path.relative(DOCS_ROOT, file)}`);
  }
  console.log(`[rtc-demos] bascik --check:\n${run.check.output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
