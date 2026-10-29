import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  ensurePrivateDir,
  privateDirFor,
  privateDirLabel,
} from "./private-dir.ts";

const BUILD_STATE_FILE = "build-state.json";
const BUILD_STATE_FORMAT = 1;

type BuildMode = "development" | "build";

interface BuildState {
  format: number;
  mode: BuildMode;
  version: string;
  /**
   * The SHA-256 of every HTML page in the output directory, by path relative
   * to it, written when the private folder holds files that describe those
   * pages (the server-script sidecar, the CSP hashes). Targeted builds refuse
   * an output directory whose pages differ; `bascik --server` warns and
   * names them (a deploy step may edit pages after the build).
   */
  pages?: Record<string, string>;
}

/** Private files whose contents are tied to the pages of the same build. */
const PAGE_BOUND_FILES = ["server-scripts.json", "csp-hashes.json"];

export const hashPage = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");

/** Every `.html` file under `dir`, relative with forward slashes. */
export const collectHtmlPaths = async (
  dir: string,
  prefix = "",
): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      out.push(...(await collectHtmlPaths(join(dir, entry.name), `${rel}/`)));
    else if (entry.isFile() && extname(entry.name) === ".html") out.push(rel);
  }
  return out;
};

const hashPages = async (outDir: string): Promise<Record<string, string>> => {
  const pages: Record<string, string> = {};
  let paths: string[];
  try {
    paths = (await collectHtmlPaths(outDir)).sort();
  } catch (err) {
    // A site with no pages may leave no output directory at all.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return pages;
    throw err;
  }
  for (let i = 0; i < paths.length; i += 32)
    await Promise.all(
      paths.slice(i, i + 32).map(async (rel) => {
        pages[rel] = hashPage(await readFile(join(outDir, rel)));
      }),
    );
  return Object.fromEntries(Object.entries(pages).sort());
};

const statePath = (): string =>
  join(privateDirFor(BascikConfig.directory.out), BUILD_STATE_FILE);

export const writeBuildState = async (
  mode: BuildMode,
  version: string,
): Promise<void> => {
  const path = statePath();
  const privateDir = await ensurePrivateDir(BascikConfig.directory.out);
  const state: BuildState = { format: BUILD_STATE_FORMAT, mode, version };
  if (mode === "build") {
    let pageBound = false;
    for (const name of PAGE_BOUND_FILES)
      try {
        await access(join(privateDir, name));
        pageBound = true;
      } catch {
        // absent
      }
    if (pageBound)
      state.pages = await hashPages(resolve(BascikConfig.directory.out));
  }
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
};

/** Why a missing or development build state stops `purpose`, naming both folders. */
const notBuiltMessage = (purpose: "server" | "targeted-build"): string => {
  const out = BascikConfig.directory.out;
  const outLabel = `${relative(process.cwd(), resolve(out)).replace(/\\/g, "/") || "."}/`;
  const privateLabel = `${privateDirLabel(out)}/`;
  return purpose === "server"
    ? `[bascik] --server requires a completed production build in ${outLabel} and its private folder ${privateLabel} ` +
        `(a server deploy copies both). Run \`bascik --build\` first.`
    : `[bascik] targeted builds require an existing completed production build in ${outLabel} and ${privateLabel}. ` +
        `Run \`bascik --build\` first.`;
};

/**
 * The pages a production build recorded, or undefined when its private
 * folder describes no page (nothing to compare).
 */
export type RecordedPages = Record<string, string> | undefined;

export const assertProductionBuildState = async (
  purpose: "server" | "targeted-build",
): Promise<RecordedPages> => {
  let state: BuildState;
  try {
    state = JSON.parse(await readFile(statePath(), "utf8")) as BuildState;
  } catch {
    throw new Error(notBuiltMessage(purpose));
  }
  if (state.format !== BUILD_STATE_FORMAT || state.mode !== "build")
    throw new Error(notBuiltMessage(purpose));
  if (purpose === "targeted-build" && state.pages) {
    const outDir = resolve(BascikConfig.directory.out);
    const found: Record<string, string> = {};
    try {
      for (const rel of await collectHtmlPaths(outDir))
        found[rel] = hashPage(await readFile(join(outDir, rel)));
    } catch {
      // A missing output directory is reported as a mismatch below.
    }
    assertSameRelease(state.pages, found);
  }
  return state.pages;
};

/** The output directory as messages name it, with a trailing slash. */
const outDirLabel = (): string =>
  `${relative(process.cwd(), resolve(BascikConfig.directory.out)).replace(/\\/g, "/") || "."}/`;

/**
 * Every page that differs between the build record and the output directory,
 * described against `outLabel`, in path order: changed pages, pages the
 * build did not write, then pages it wrote that are missing.
 */
const pageDifferences = (
  recorded: Record<string, string>,
  found: Record<string, string>,
  outLabel: string,
): string[] => {
  const out: string[] = [];
  for (const rel of Object.keys(found).sort()) {
    if (!(rel in recorded))
      out.push(`${outLabel}${rel} is not a page that build wrote`);
    else if (recorded[rel] !== found[rel])
      out.push(`${outLabel}${rel} is not the page that build wrote`);
  }
  for (const rel of Object.keys(recorded).sort())
    if (!(rel in found))
      out.push(`${outLabel}${rel}, which that build wrote, is missing`);
  return out;
};

/** How many differing pages a startup warning names before it counts the rest. */
const WARNING_PAGE_LIMIT = 10;

/**
 * The startup warning `bascik --server` prints when the pages in the output
 * directory are not the ones the private folder's build recorded, or
 * undefined when they are. Never an error: a deploy step that edits or
 * post-processes the built pages (analytics, a minifier, a CDN rewrite) is
 * legitimate, and the code you wrote is the code that ships. The server
 * refuses only what it cannot run: a page's server-script placeholder the
 * sidecar does not hold, or a mode marker the sidecar contradicts (the
 * production readiness check in server-prod.ts). A changed page is served
 * as it is in the output directory, with the server scripts and CSP hashes
 * the private folder holds.
 */
export const pageDifferenceWarning = (
  recorded: Record<string, string>,
  found: Record<string, string>,
): string | undefined => {
  const outLabel = outDirLabel();
  const privateLabel = `${privateDirLabel(BascikConfig.directory.out)}/`;
  const differences = pageDifferences(recorded, found, outLabel);
  if (differences.length === 0) return undefined;
  const named = differences.slice(0, WARNING_PAGE_LIMIT).join("; ");
  const more =
    differences.length > WARNING_PAGE_LIMIT
      ? `; and ${differences.length - WARNING_PAGE_LIMIT} more`
      : "";
  const count = `${differences.length} page${differences.length === 1 ? "" : "s"}`;
  const verb = differences.length === 1 ? "differs" : "differ";
  return (
    `[bascik] --server: warning: ${count} in ${outLabel} ${verb} from the pages the build recorded in ` +
    `${privateLabel}${BUILD_STATE_FILE}: ${named}${more} ` +
    `(if you edited ${outLabel} after the build this is expected; if you copied ${privateLabel} from another build, ` +
    `rebuild with \`bascik --build\` and deploy both folders). The server serves these pages as they are, with ` +
    `the server scripts and CSP hashes ${privateLabel} holds.`
  );
};

/**
 * Throw when the pages found in the output directory are not the ones the
 * private folder's build recorded, for a targeted build: the two folders
 * come from different builds (a deploy that replaced one and not the
 * other), and the targeted build would keep the other pages' private files
 * (server scripts, CSP hashes) beside pages they do not describe.
 */
export const assertSameRelease = (
  recorded: Record<string, string>,
  found: Record<string, string>,
): void => {
  const outLabel = outDirLabel();
  const privateLabel = `${privateDirLabel(BascikConfig.directory.out)}/`;
  const problem = pageDifferences(recorded, found, outLabel)[0];
  if (!problem) return;
  throw new Error(
    `[bascik] --only: ${outLabel} and ${privateLabel} come from different builds: ${problem} ` +
      `(as recorded in ${privateLabel}${BUILD_STATE_FILE}). ${privateLabel} holds the server scripts and CSP hashes ` +
      `for the pages of its own build, so a deploy copies both folders from the same \`bascik --build\`. ` +
      `Run \`bascik --build\` and copy both again. A page changed after the build counts as a different build: ` +
      `make the change in the source, or in an exec script, which runs before the build records its pages.`,
  );
};
