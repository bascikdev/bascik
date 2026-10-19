#!/usr/bin/env node
// Builds the extension into dist/: type-checks and emits the tests with tsc, then bundles the two files that
// ship. The extension (`dist/extension.js`) is the language client. The server (`dist/server.js`) is the
// language server from ../../lsp, bundled with its dependencies, because a VSIX ships no node_modules.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const lspSource = resolve(root, "../../lsp/src");

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // The oldest VS Code this extension supports (1.91) runs Node 20.
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
};

/** Bundles the language server and everything it imports into one file. */
export function bundleServer(outfile = join(root, "dist/server.js")) {
  return build({
    ...shared,
    // `start.ts` is the same entry the `bascik-language-server` command uses.
    stdin: {
      contents:
        "import { startLanguageServer } from './start.ts';\nstartLanguageServer();\n",
      resolveDir: lspSource,
      sourcefile: "server-entry.ts",
      loader: "ts",
    },
    outfile,
  });
}

/** Bundles the language client. The `vscode` module is provided by the editor, so it stays external. */
export function bundleExtension(outfile = join(root, "dist/extension.js")) {
  return build({
    ...shared,
    entryPoints: [join(root, "src/extension.ts")],
    external: ["vscode"],
    outfile,
  });
}

function typeCheckAndEmit() {
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
    "bin/tsc",
  );
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", join(root, "tsconfig.json")],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Start clean so a file deleted from src/ does not linger in dist/ and ship.
  rmSync(join(root, "dist"), { recursive: true, force: true });
  typeCheckAndEmit();
  // Written after tsc, which also emits dist/extension.js, so the bundle is the file that remains.
  await Promise.all([bundleExtension(), bundleServer()]);
}
