import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Runs as a pipeline.exec script, which always receives the resolved
// directory.out. Each e2e lane builds into its own one (BASCIK_E2E_OUT).
const outDir = process.env.BASCIK_OUT_DIR;
if (!outDir) {
  throw new Error(
    "generate-manifest.ts expects BASCIK_OUT_DIR; run it through bascik's pipeline.exec, not directly",
  );
}
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, "exec-manifest.json"),
  JSON.stringify({ generated: true }),
);
