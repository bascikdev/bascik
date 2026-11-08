import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const output = resolve(process.env.BASCIK_OUT_DIR ?? "dist", "assets");
await mkdir(output, { recursive: true });
for (const name of ["bascik-logo.svg", "favicon.svg"])
  await copyFile(`../docs/src/pages/assets/${name}`, `${output}/${name}`);
await build({
  entryPoints: ["src/browser/shop.ts"],
  outfile: `${output}/shop.js`,
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
});
