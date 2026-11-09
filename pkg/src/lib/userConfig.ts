import { loadUserConfig, resolveConfigPath } from "./user-config-loader.ts";
import type { UserConfig } from "./types.ts";

export * from "./user-config-loader.ts";

// The CLI's config singleton: loaded once, at import, through a module-scope
// await. Only CLI-side modules may reach this file statically. The
// `@bascik/bascik/adapter` entry must not (it would load the working
// directory's config on import and could not be `require()`d), so it loads
// site-graph.ts, and with it this file, on first use instead.
// adapter-entry-config.test.ts pins that.

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
