// scripts/publish-heading-anchors.ts: copies a ready-to-use npm browser module
// into the output directory. Run it as a pipeline.exec step with phase: 'pre'.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const outDir = process.env.BASCIK_OUT_DIR;
if (!outDir) throw new Error('BASCIK_OUT_DIR is not set; run this as a pipeline.exec step');

// Resolve from the project's node_modules, wherever the package manager put it.
const source = createRequire(import.meta.url).resolve('@zachleat/heading-anchors');

await mkdir(join(outDir, 'assets/vendor'), { recursive: true });
await copyFile(source, join(outDir, 'assets/vendor/heading-anchors.js'));
