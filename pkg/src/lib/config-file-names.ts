import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The config filenames Bascik discovers in the project root, in priority
 * order: the first one that exists is loaded and the rest are ignored. The
 * language server (`lsp/src/project.ts`) and the VS Code extension read the
 * same names in the same order, so the editor and the CLI agree on which
 * file is the config when more than one is present.
 *
 * Kept in its own module because userConfig.ts loads the config at import
 * time, and the check and watch code need the names without that.
 */
export const CONFIG_FILE_NAMES = [
  "bascik.config.js",
  "bascik.config.mjs",
  "bascik.config.ts",
] as const;

/** The names as the CLI writes them: "./bascik.config.js, ./bascik.config.mjs, or ./bascik.config.ts". */
export const CONFIG_FILE_LIST = CONFIG_FILE_NAMES.map((name) => `./${name}`)
  .join(", ")
  .replace(/, ([^,]*)$/, ", or $1");

/**
 * Find the config file to load. An explicit `--config <path>` (or
 * `--config=<path>`) wins and is resolved against the cwd whether or not it
 * exists, so the loader can report a missing one. Otherwise the first of
 * CONFIG_FILE_NAMES that exists in the cwd, or `undefined` when none does.
 * Synchronous so config.ts and check.ts can name the file without waiting on
 * the loader.
 */
export const findConfigFile = (
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): { path: string | undefined; explicit: boolean } => {
  const inline = argv.find((a) => a.startsWith("--config="));
  const flagIndex = argv.indexOf("--config");
  const flagValue =
    flagIndex !== -1 &&
    argv[flagIndex + 1] &&
    !argv[flagIndex + 1].startsWith("-")
      ? argv[flagIndex + 1]
      : undefined;
  const explicitValue = inline ? inline.slice("--config=".length) : flagValue;
  if (explicitValue) {
    return { path: resolve(cwd, explicitValue), explicit: true };
  }
  const found = CONFIG_FILE_NAMES.find((name) =>
    existsSync(resolve(cwd, name)),
  );
  return { path: found && resolve(cwd, found), explicit: false };
};
