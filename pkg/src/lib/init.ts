/**
 * @module init
 *
 * Bootstraps a new Bascik project in the current working directory.
 * Invoked via `bascik init`.
 *
 * Creates:
 *  - src/pages/index.html   — starter HTML page
 *  - src/components/        — empty components directory
 *  - bascik.config.js       — minimal project config
 *
 * Updates package.json (if present):
 *  - Adds "type": "module" (required for bascik.config.js ES syntax)
 *  - Adds "dev" and "build" scripts if not already defined
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Bascik App</title>
</head>
<body>
  <h1>Hello from Bascik</h1>
  <p>Edit <code>src/pages/index.html</code> to get started.</p>
</body>
</html>
`;

const BASCIK_CONFIG = `// Bascik works without this file — defaults are src/pages and src/components.
// Uncomment to customize directories or other options.
// Full reference: https://bascik.dev/configuration
//
// import { defineConfig } from '@bascik/bascik/config';
// export default defineConfig({
//   directory: { pages: 'src/pages', components: 'src/components' },
// });

// Applied only during \`bascik --build\` and \`bascik --server\`.
export const build = {
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
};
`;

/** Write a file only if it does not already exist. Returns true when written. */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    await writeFile(path, content, "utf8");
    return true;
  }
}

export async function initProject(): Promise<void> {
  const cwd = process.cwd();

  const pagesDir = join(cwd, "src", "pages");
  const componentsDir = join(cwd, "src", "components");
  const indexPath = join(pagesDir, "index.html");
  const configPath = join(cwd, "bascik.config.js");
  const pkgPath = join(cwd, "package.json");

  // Ensure directories exist
  await mkdir(pagesDir, { recursive: true });
  await mkdir(componentsDir, { recursive: true });

  // Create starter files (skip if already present)
  const wroteIndex = await writeIfAbsent(indexPath, INDEX_HTML);
  console.log(
    wroteIndex
      ? "  created: src/pages/index.html"
      : "  skipped: src/pages/index.html (already exists)",
  );

  const wroteConfig = await writeIfAbsent(configPath, BASCIK_CONFIG);
  console.log(
    wroteConfig
      ? "  created: bascik.config.js"
      : "  skipped: bascik.config.js (already exists)",
  );

  // Update package.json
  let pkgRaw: string;
  try {
    pkgRaw = await readFile(pkgPath, "utf8");
  } catch {
    console.log("  skipped: package.json (not found — run `npm init` first)");
    printDone();
    return;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    console.log("  skipped: package.json (could not parse — edit manually)");
    printDone();
    return;
  }

  const changes: string[] = [];

  // Require ESM for bascik.config.js
  if (pkg.type !== "module") {
    pkg.type = "module";
    changes.push('"type": "module"');
  }

  // Add dev/build scripts
  if (typeof pkg.scripts !== "object" || pkg.scripts === null) {
    pkg.scripts = {};
  }
  const scripts = pkg.scripts as Record<string, string>;

  if (!scripts.dev) {
    scripts.dev = "bascik";
    changes.push('"dev" script');
  }
  if (!scripts.build) {
    scripts.build = "bascik --build";
    changes.push('"build" script');
  }

  if (changes.length > 0) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.log(`  updated: package.json (${changes.join(", ")})`);
  } else {
    console.log("  skipped: package.json (already configured)");
  }

  printDone();
}

function printDone(): void {
  console.log(`
Done! Start the dev server with:

  npm run dev
  yarn dev
`);
}
