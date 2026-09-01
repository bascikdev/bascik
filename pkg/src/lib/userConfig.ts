import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UserConfig } from "./types.ts";

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
          `Pass an existing file, or omit the flag to use ./bascik.config.js or ./bascik.config.ts when present.`,
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
    throw new Error(
      `[bascik] Failed to load bascik.config (${configPath}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const rawConfig = mod?.default;
  const rawDev = mod?.dev;
  const rawBuild = mod?.build;
  const rawServer = mod?.server;
  const result = {
    config: typeof rawConfig === "object" && rawConfig !== null ? rawConfig : {},
    dev: typeof rawDev === "object" && rawDev !== null ? rawDev : {},
    build: typeof rawBuild === "object" && rawBuild !== null ? rawBuild : {},
    server: typeof rawServer === "object" && rawServer !== null ? rawServer : {},
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
 * against the cwd. Otherwise discovery looks in the cwd only:
 * bascik.config.js is preferred over bascik.config.ts when both exist,
 * because an `init`-scaffolded .js file would otherwise silently shadow the
 * user's .ts config.
 *
 * Intentionally unsupported: .mjs/.cjs/.mts/.cts extensions, a config/
 * subdirectory, and parent-directory search. TypeScript configs work through
 * Node 24's native type stripping, so non-erasable syntax such as `enum`
 * fails with a Node error at import time.
 */
export const resolveConfigPath = async (
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<{ path: string; explicit: boolean }> => {
  const inline = argv.find((a) => a.startsWith("--config="));
  const flagIndex = argv.indexOf("--config");
  const flagValue =
    flagIndex !== -1 && argv[flagIndex + 1] && !argv[flagIndex + 1].startsWith("-")
      ? argv[flagIndex + 1]
      : undefined;
  const explicitValue = inline ? inline.slice("--config=".length) : flagValue;
  if (explicitValue) {
    return { path: resolve(cwd, explicitValue), explicit: true };
  }
  const jsPath = resolve(cwd, "bascik.config.js");
  try {
    await access(jsPath);
    return { path: jsPath, explicit: false };
  } catch {
    return { path: resolve(cwd, "bascik.config.ts"), explicit: false };
  }
};

const discovered = await resolveConfigPath();
const loaded = await loadUserConfig(discovered.path, { explicit: discovered.explicit });

export const config: UserConfig = loaded.config;
export const modeOverrides = {
  dev: loaded.dev,
  build: loaded.build,
  server: loaded.server,
};
export const buildConfig: UserConfig = loaded.build;
