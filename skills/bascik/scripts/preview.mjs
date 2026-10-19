#!/usr/bin/env node
// Compile an HTML snippet, a file, or an existing page with the project's real components and config, in a
// throwaway build, and print the unminified result. Nothing in the project's dist/ is touched.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fail,
  findConfigFile,
  findPackageBin,
  findProjectRoot,
  isMain,
  loadProjectConfig,
  pagesDirectory,
  run,
} from "./lib/project.mjs";

const HELP = `Usage: node preview.mjs '<my-card data-bascik-prop-title="Hi" />' [--count 2]
       node preview.mjs --file snippet.html
       node preview.mjs --page src/pages/about.html

Compiles with the project's components and bascik.config, using production mode (bascik --build) with
minification off so scoped names stay readable, and prints the compiled HTML. Exec scripts, sitemap, and
robots generation are skipped. The project's own dist/ is never written.

Options:
  --file <path>    Read the snippet from a file
  --page <path>    Print an existing page instead of a snippet (builds every page into a scratch directory)
  --count <n>      Repeat the snippet n times (check multi-instance isolation), default 1
  --body           Print only the <body> contents (and the <style> blocks from <head>)
  --minify         Keep the project's production minification (hashed identifiers)
  --keep           Keep the temporary build directory and print its path
  --help           Show this message`;

const wrapSnippet = (snippet) =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Bascik preview</title>\n</head>\n<body>\n${snippet}\n</body>\n</html>\n`;

/** Source of the temporary config that layers preview overrides on the project's config. Exported for tests. */
export function previewConfigSource({ projectConfigUrl, directory, minify }) {
  const importLine = projectConfigUrl
    ? `import * as project from ${JSON.stringify(projectConfigUrl)};`
    : "const project = {};";
  return `${importLine}
const directory = ${JSON.stringify(directory)};
// A boolean minify is expanded after merging and would beat the object override below, so expand it here.
const expandMinify = (base) =>
  typeof base.minify === 'boolean'
    ? { minify: { html: base.minify, css: base.minify, js: base.minify, identifiers: base.minify } }
    : {};
const layer = (base = {}) => ({
  ...base,
  ...expandMinify(base),
  directory: { ...(base.directory ?? {}), ...directory },
  generate: { ...(base.generate ?? {}), sitemap: false, robots: false, manifest: false, cspHashes: false },
  pipeline: { ...(base.pipeline ?? {}), exec: [], workers: false },
});
export default layer(project.default ?? {});
export const build = {
  ...layer(project.build ?? {}),
  ${minify ? "" : "minify: { html: false, css: false, js: false, identifiers: false },"}
};
`;
}

function bodyOnly(html) {
  const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(
    (m) => m[0],
  );
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  return [...styles, body.trim()].join("\n");
}

function relevantLog(output) {
  return output
    .split("\n")
    .filter((line) => /warn|error|unresolved|fail|\[bascik\]/i.test(line))
    .filter((line) => !/^\s*$/.test(line))
    .join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      page: { type: "string" },
      count: { type: "string", default: "1" },
      body: { type: "boolean", default: false },
      minify: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = findProjectRoot();
  const bin = findPackageBin(root, "@bascik/bascik", "bascik");
  if (!bin)
    fail(
      `preview: @bascik/bascik is not installed in ${root}. Run npm install @bascik/bascik first.`,
    );

  const config = await loadProjectConfig(root);
  if (config?.error)
    fail(`preview: could not load ${config.path}: ${config.error.message}`);
  const pagesDir = pagesDirectory(root, config?.module);

  let snippet;
  let pageRel;
  if (values.page) {
    const pagePath = resolve(root, values.page);
    if (!existsSync(pagePath)) fail(`preview: ${values.page} does not exist.`);
    pageRel = relative(pagesDir, pagePath).replace(/\\/g, "/");
    if (pageRel.startsWith(".."))
      fail(
        `preview: ${values.page} is not inside the pages directory (${relative(root, pagesDir)}).`,
      );
    if (/\[[^\]]+\]/.test(pageRel))
      fail(
        "preview: dynamic route templates cannot be previewed directly; preview a snippet that uses the same components.",
      );
  } else {
    snippet = values.file
      ? readFileSync(resolve(values.file), "utf8")
      : positionals.join(" ");
    if (!snippet.trim())
      fail(`preview: pass an HTML snippet, --file, or --page.\n\n${HELP}`, 2);
    const count = Math.max(1, Number.parseInt(values.count, 10) || 1);
    snippet = Array.from({ length: count }, () => snippet.trim()).join("\n");
  }

  // The output directory must sit inside the project, so the scratch space lives in Bascik's cache folder.
  const cacheDir = join(root, "node_modules", ".cache", "bascik");
  mkdirSync(cacheDir, { recursive: true });
  const tmp = mkdtempSync(join(cacheDir, "preview-"));
  const out = join(tmp, "out");
  const directory = { out, api: join(tmp, "api") };
  if (snippet !== undefined) {
    const pages = join(tmp, "pages");
    mkdirSync(pages, { recursive: true });
    const isDocument = /^\s*(<!doctype|<html)/i.test(snippet);
    writeFileSync(
      join(pages, "index.html"),
      isDocument ? snippet : wrapSnippet(snippet),
      "utf8",
    );
    directory.pages = pages;
    pageRel = "index.html";
  }

  const configFile = findConfigFile(root);
  const tmpConfig = join(tmp, "bascik.preview.config.mjs");
  writeFileSync(
    tmpConfig,
    previewConfigSource({
      projectConfigUrl: configFile ? pathToFileURL(configFile).href : undefined,
      directory,
      minify: values.minify,
    }),
    "utf8",
  );

  // Page mode compiles the whole pages directory into the scratch output: targeted --only builds need an
  // existing complete build in the output directory, and the build script cache keeps repeat runs fast.
  const args = [bin, "--build", "--config", tmpConfig];
  const result = await run(process.execPath, args, {
    cwd: root,
    env: { ...process.env },
  });

  try {
    const outputFile = join(out, pageRel);
    if (result.code !== 0 || !existsSync(outputFile)) {
      process.stderr.write(
        `preview: the build failed (exit ${result.code}).\n${result.output.trim()}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const html = readFileSync(outputFile, "utf8");
    const log = relevantLog(result.output);
    if (log) process.stderr.write(`${log}\n\n`);
    process.stdout.write(values.body ? `${bodyOnly(html)}\n` : html);
  } finally {
    if (values.keep) process.stderr.write(`\nKept ${tmp}\n`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await main();
