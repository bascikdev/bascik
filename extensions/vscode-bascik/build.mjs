#!/usr/bin/env node
// Builds the extension: type-checks the sources and emits the tests into out/ with tsc, then bundles the two
// files that ship into dist/. The extension (`dist/extension.js`) is the language client. The server
// (`dist/server.js`) is the language server from ../../lsp, bundled with its dependencies, because a VSIX ships
// no node_modules. Beside them it writes THIRD-PARTY-NOTICES.txt, the license of every package the bundles
// inline. dist/ holds nothing else, and .vscodeignore ships only those three files from it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // The bundled packages' license comments are not kept; their full license texts go to NOTICES_FILE instead.
  legalComments: "none",
  logLevel: "warning",
  // Metafile input paths are relative to this folder, whatever the current directory is.
  absWorkingDir: root,
  metafile: true,
};

/** Written to dist/ beside the bundles: the license of every package they inline, as those licenses require. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;
const PACKAGE_NOTICES_FILE = /^third-?party-?notices(?:\..*)?$/i;
const RULE = "=".repeat(80);

/**
 * The folder of each package that put a file into a bundle, from esbuild metafiles. A nested copy
 * (`a/node_modules/b`) is its own package. The extension's and the language server's sources are not packages.
 */
export function bundledPackageFolders(metafiles, workingDir = root) {
  const folders = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const match = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(
        input,
      );
      if (match) folders.add(resolve(workingDir, match[1].replace(/\\/g, "/")));
    }
  }
  return [...folders];
}

/**
 * The notices file for the given package folders: one entry per package and version, with the license file it
 * ships and its own third-party notices file, if it has one. Throws, naming the package, when a package has no
 * license file, so a new dependency cannot be bundled without its notice.
 */
export function thirdPartyNotices(packageFolders) {
  const entries = new Map();
  for (const folder of packageFolders) {
    const manifest = JSON.parse(
      readFileSync(join(folder, "package.json"), "utf8"),
    );
    const id = `${manifest.name}@${manifest.version}`;
    if (entries.has(id)) continue;
    const files = readdirSync(folder).sort();
    const licenseFile = files.find((name) => LICENSE_FILE.test(name));
    if (!licenseFile) {
      throw new Error(
        `${id} is bundled into the extension, but there is no license file in ${folder}, so its notice cannot ship. ` +
          "Keep it out of the bundle or bundle a release that includes its license.",
      );
    }
    const texts = [
      licenseFile,
      ...files.filter((name) => PACKAGE_NOTICES_FILE.test(name)),
    ].map((name) => readFileSync(join(folder, name), "utf8").trim());
    entries.set(id, {
      id,
      license: manifest.license ?? "see the text below",
      texts,
    });
  }
  const sorted = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  return [
    "Bascik for VS Code bundles the following packages into dist/extension.js and dist/server.js.",
    "Each is listed with its version and license, followed by the license text it ships with.",
    "",
    ...sorted.flatMap((entry) => [
      RULE,
      `${entry.id} (${entry.license})`,
      RULE,
      "",
      ...entry.texts.flatMap((text) => [text, ""]),
    ]),
  ].join("\n");
}

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
  // Start clean so a file deleted from src/ does not linger in dist/ and ship, or in out/ and run as a test.
  for (const folder of ["dist", "out"]) {
    rmSync(join(root, folder), { recursive: true, force: true });
  }
  typeCheckAndEmit();
  const results = await Promise.all([bundleExtension(), bundleServer()]);
  writeFileSync(
    join(root, "dist", NOTICES_FILE),
    thirdPartyNotices(
      bundledPackageFolders(results.map((result) => result.metafile)),
    ),
  );
}
