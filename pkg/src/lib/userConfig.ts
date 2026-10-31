import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONFIG_FILE_LIST,
  CONFIG_FILE_NAMES,
  findConfigFile,
} from "./config-file-names.ts";
import type { UserConfig } from "./types.ts";

export { CONFIG_FILE_NAMES };

// The user-facing `defineConfig` helper and its `BascikConfig` input type
// live in defineConfig.ts only — keeping a second, divergent copy here is how
// the two drifted apart on `minify: boolean`.

interface UserConfigModule {
  default?: UserConfig;
  dev?: UserConfig;
  build?: UserConfig;
  server?: UserConfig;
}

/**
 * Import a user config module. Node ESM requires a file:// URL for absolute
 * paths — importing a bare absolute path fails on Windows
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME). Exported so tests can spy on the
 * import seam without needing to mock a file:// specifier.
 */
export const importUserConfig = async (
  configPath: string,
): Promise<UserConfigModule> => {
  return (await import(pathToFileURL(configPath).href)) as UserConfigModule;
};

/**
 * The file, line, and caret for a syntax error in a JavaScript config. A
 * SyntaxError from a dynamic import carries no location, so on that failure
 * only, the file is parsed again with `node --check`, which prints
 * "<file>:<line>", the line, and a caret under the token. The file itself is
 * checked, not its source as a module, so Node picks the same format the
 * import did: ESM for .mjs, and for .js whatever package.json "type" and
 * syntax detection say (a CommonJS config allows sloppy-mode syntax that a
 * module check would stop on first). Returns "" when the check reports a
 * different error than the import (so the location could point at the wrong
 * line), when the config parses (the SyntaxError came from linking, such as
 * a missing named export), or for a TypeScript config, which `node --check`
 * would parse without stripping its types.
 */
const syntaxErrorLocation = (configPath: string, err: unknown): string => {
  if (!(err instanceof Error) || err.name !== "SyntaxError") return "";
  if (![".js", ".mjs"].includes(extname(configPath))) return "";
  const check = (flags: string[]) =>
    spawnSync(process.execPath, [...flags, "--check", configPath], {
      encoding: "utf8",
    });
  let result = check([]);
  // Node 22 passes `--check` on a .js file with no package.json "type" when the module syntax it guesses also
  // fails to parse; the import above still threw. Check it again as a module. The message must match the import's
  // error, so a CommonJS file never gets a location from this.
  if (
    result.status === 0 &&
    extname(configPath) === ".js" &&
    process.allowedNodeEnvironmentFlags.has("--experimental-default-type")
  )
    result = check(["--experimental-default-type=module"]);
  if (result.status === 0 || !result.stderr) return "";
  return checkOutputLocation(result.stderr, configPath, err.message);
};

/**
 * The location lines from `node --check` output for this file and error, or "". Node prints
 * "<file>:<line>", the source line, a caret line, a blank line, then "SyntaxError: <message>" and
 * its stack; keep the first three. Windows ends the lines with CRLF.
 */
export const checkOutputLocation = (
  output: string,
  configPath: string,
  message: string,
): string => {
  const lines = output.split(/\r?\n/);
  if (!lines[0]?.startsWith(`${configPath}:`)) return "";
  if (!lines.includes(`SyntaxError: ${message}`)) return "";
  return [lines[0], lines[1] ?? "", lines[2] ?? ""].join("\n").trimEnd();
};

const rejectRemovedKeys = (cfg: UserConfig, exportName: string): void => {
  if (typeof cfg === "object" && cfg !== null && "siteUrl" in cfg) {
    throw new Error(
      `[bascik] error: \`siteUrl\` is not a bascik.config option (found in the ${exportName} export).\n` +
        `  The site URL is a per-deployment value. Set it one of these ways:\n` +
        `    BASCIK_SITE_URL=https://example.com bascik --build\n` +
        `    echo 'BASCIK_SITE_URL=https://example.com' >> .env\n` +
        `    bascik --build --site-url https://example.com`,
    );
  }
};

/** The exports Bascik reads from a config module. */
const CONFIG_EXPORTS = ["default", "dev", "build", "server"] as const;

const describeValue = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "an array"
      : typeof value === "function"
        ? "a function (Bascik reads the object, it does not call it)"
        : `${typeof value} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;

/**
 * A config file whose settings Bascik would never see is an error, not a
 * zero config: every setting in it would be ignored and never validated.
 * That is a read export that is not a plain object (a function, a string,
 * null), or a module whose only exports are names Bascik does not read
 * (`export const config = ...`). A module that exports nothing at all gets a
 * warning: the defaults apply, as with no file.
 */
const assertReadableExports = (
  mod: UserConfigModule,
  configPath: string,
): void => {
  const exports = mod as Record<string, unknown>;
  const problems: string[] = [];
  for (const name of CONFIG_EXPORTS) {
    const value = exports?.[name];
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      continue;
    const declaration =
      name === "default" ? "export default" : `export const ${name} =`;
    problems.push(
      `  the ${name} export must be an object, not ${describeValue(value)}. ` +
        `Write \`${declaration} defineConfig({ ... })\`.`,
    );
  }
  if (problems.length > 0)
    throw new Error(
      `[bascik] error: ${configPath} does not export a configuration object:\n${problems.join("\n")}`,
    );
  if (CONFIG_EXPORTS.some((name) => exports?.[name] !== undefined)) return;
  // Node adds a "module.exports" name to a CommonJS module's namespace.
  const others = Object.keys(exports ?? {}).filter(
    (name) => name !== "module.exports",
  );
  if (others.length > 0)
    throw new Error(
      `[bascik] error: ${configPath} exports ${others.map((name) => `\`${name}\``).join(", ")}, which Bascik does not read, and no default export, so none of its settings would apply.\n` +
        `  Bascik reads \`export default\` and the mode exports \`dev\`, \`build\` and \`server\`. ` +
        `Write \`export default defineConfig({ ... })\`.`,
    );
  console.warn(
    `[bascik] warning: ${configPath} exports nothing, so the built-in defaults apply. ` +
      `Add \`export default defineConfig({ ... })\` to configure Bascik, or delete the file.`,
  );
};

/** Load and validate the project's bascik.config, if present. */
export const loadUserConfig = async (
  configPath: string,
  options: { explicit?: boolean } = {},
): Promise<{
  config: UserConfig;
  dev: UserConfig;
  build: UserConfig;
  server: UserConfig;
}> => {
  // Probe first, in its own try. An ENOENT here means there is no config
  // file: that is the zero-config default, so return silently. A warning
  // should mean something is wrong, and a missing config is not wrong.
  // An explicitly passed --config path, however, must exist (mirroring the
  // --env-file versus --env-file-if-exists distinction).
  try {
    await access(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (options.explicit) {
        throw new Error(
          `[bascik] error: --config "${configPath}" does not exist. ` +
            `Pass an existing file, or omit the flag to use ${CONFIG_FILE_LIST} when present.`,
        );
      }
      return { config: {}, dev: {}, build: {}, server: {} };
    }
    throw new Error(
      `[bascik] Failed to load bascik.config (${configPath}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // The file exists. Anything thrown from here on (including an ENOENT from
  // inside the user's own config code) is a real load failure and must
  // surface with its message and the config path — never be misreported as
  // "no config found" while defaults silently apply.
  let mod: UserConfigModule;
  try {
    mod = await importUserConfig(configPath);
  } catch (err) {
    // A config file that exists but fails to load is fatal — throw (rather
    // than process.exit) so the CLI can surface the error and library
    // consumers (worker threads) don't nuke the whole process.
    const location = syntaxErrorLocation(configPath, err);
    throw new Error(
      `[bascik] Failed to load bascik.config (${configPath}): ${err instanceof Error ? err.message : String(err)}` +
        (location ? `\n${location}` : ""),
      { cause: err },
    );
  }

  assertReadableExports(mod, configPath);
  const result = {
    config: mod?.default ?? {},
    dev: mod?.dev ?? {},
    build: mod?.build ?? {},
    server: mod?.server ?? {},
  };
  rejectRemovedKeys(result.config, "default");
  rejectRemovedKeys(result.dev, "dev");
  rejectRemovedKeys(result.build, "build");
  rejectRemovedKeys(result.server, "server");
  return result;
};

/**
 * Resolve which config file to load.
 *
 * An explicit `--config <path>` (or `--config=<path>`) wins and is resolved
 * against the cwd. Otherwise discovery looks in the cwd only, in
 * CONFIG_FILE_NAMES order: bascik.config.js, then bascik.config.mjs, then
 * bascik.config.ts. The first that exists wins and the others are ignored,
 * because an `init`-scaffolded .js file would otherwise silently shadow the
 * user's .ts config.
 *
 * Intentionally unsupported: .cjs/.mts/.cts extensions, a config/
 * subdirectory, and parent-directory search. TypeScript configs work through
 * Node 24's native type stripping, so non-erasable syntax such as `enum`
 * fails with a Node error at import time.
 */
export const resolveConfigPath = async (
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<{ path: string; explicit: boolean }> => {
  const found = findConfigFile(argv, cwd);
  // None exists: loadUserConfig treats the missing last candidate as the
  // zero-config default.
  return {
    path:
      found.path ??
      resolve(cwd, CONFIG_FILE_NAMES[CONFIG_FILE_NAMES.length - 1]),
    explicit: found.explicit,
  };
};

const discovered = await resolveConfigPath();
const loaded = await loadUserConfig(discovered.path, {
  explicit: discovered.explicit,
});

export const config: UserConfig = loaded.config;
export const modeOverrides = {
  dev: loaded.dev,
  build: loaded.build,
  server: loaded.server,
};
export const buildConfig: UserConfig = loaded.build;
