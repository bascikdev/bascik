/**
 * @module init
 *
 * Bootstraps a new Bascik project in the current working directory.
 * Invoked via `bascik init`.
 *
 * Creates:
 *  - src/pages/index.html   — starter HTML page
 *  - src/components/        — empty components directory
 *  - .gitignore additions    — dist/ and node_modules/.cache/bascik/
 *
 * Updates package.json (if present):
 *  - Adds "type": "module" only when absent (never rewrites "commonjs")
 *  - Adds @bascik/bascik dependency when missing
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

const REQUIRED_GITIGNORE_ENTRIES = ["dist/", "node_modules/.cache/bascik/"];

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
  const gitignorePath = join(cwd, ".gitignore");
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

  await ensureGitignoreEntries(gitignorePath, REQUIRED_GITIGNORE_ENTRIES);
  console.log("  updated: .gitignore (dist/, node_modules/.cache/bascik/)");

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

  if (pkg.type === "commonjs") {
    throw new Error(
      "[bascik] init aborted: package.json sets \"type\": \"commonjs\". " +
      "Bascik config uses ESM syntax, so update this project manually if you want to migrate.",
    );
  }

  // Use ESM for future bascik.config.ts support when package type is absent.
  if (pkg.type === undefined) {
    pkg.type = "module";
    changes.push('"type": "module"');
  }

  if (typeof pkg.dependencies !== "object" || pkg.dependencies === null) {
    pkg.dependencies = {};
  }
  const dependencies = pkg.dependencies as Record<string, string>;
  if (!dependencies["@bascik/bascik"]) {
    dependencies["@bascik/bascik"] = "latest";
    changes.push('"@bascik/bascik" dependency');
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

Configuration is optional. Create bascik.config.ts only when you need
to change a default: https://bascik.dev/configuration
`);
}

async function ensureGitignoreEntries(path: string, entries: string[]): Promise<void> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }

  const normalized = current.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const existing = new Set(lines.map((line) => line.trim()));
  const toAppend = entries.filter((entry) => !existing.has(entry));
  if (toAppend.length === 0) {
    return;
  }

  let next = normalized;
  if (next.length > 0 && !next.endsWith("\n")) {
    next += "\n";
  }
  next += toAppend.join("\n") + "\n";
  await writeFile(path, next, "utf8");
}
