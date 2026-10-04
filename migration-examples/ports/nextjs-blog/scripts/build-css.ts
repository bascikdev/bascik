import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import autoprefixer from "autoprefixer";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

// Replaces the Next.js CSS pipeline (postcss.config.js applied to src/app/globals.css). Runs as a
// `pre` exec step, so the stylesheet exists before pages compile, and again whenever a watched
// template changes. It writes into the output directory, never into src/.
const outDirectory = process.env.BASCIK_OUT_DIR;
if (!outDirectory) throw new Error("BASCIK_OUT_DIR is required");

const from = "src/css/globals.css";
const input = await readFile(from, "utf8");
const result = await postcss([tailwindcss("./tailwind.config.ts"), autoprefixer]).process(input, {
  from,
  to: join(outDirectory, "assets/styles.css"),
});
await mkdir(join(outDirectory, "assets"), { recursive: true });
await writeFile(join(outDirectory, "assets/styles.css"), result.css);
console.log(`wrote assets/styles.css (${result.css.length} bytes)`);
