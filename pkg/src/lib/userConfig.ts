import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { UserConfig } from "./types.ts";

/** Public type for bascik.config.ts — use with `defineConfig`. */
export type BascikConfig = UserConfig;

/** Type helper for bascik.config.ts — wraps config in the correct type. */
export const defineConfig = (config: BascikConfig): BascikConfig => config;

export interface UserConfigModule {
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
): Promise<{
  config: UserConfig;
  dev: UserConfig;
  build: UserConfig;
  server: UserConfig;
}> => {
  try {
    await access(configPath);
    const mod = await importUserConfig(configPath);
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.warn("[bascik] No bascik.config found. Using defaults.");
      return { config: {}, dev: {}, build: {}, server: {} };
    }
    // A config file that exists but fails to load is fatal — throw (rather
    // than process.exit) so the CLI can surface the error and library
    // consumers (worker threads) don't nuke the whole process.
    throw new Error(
      `[bascik] Failed to load bascik.config: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
};

const jsPath = resolve(process.cwd(), "bascik.config.js");
const configPath = await access(jsPath).then(() => jsPath, () => resolve(process.cwd(), "bascik.config.ts"));
const loaded = await loadUserConfig(configPath);

export let config: UserConfig = loaded.config;
export let modeOverrides = {
  dev: loaded.dev,
  build: loaded.build,
  server: loaded.server,
};
export let buildConfig: UserConfig = loaded.build;
