import { loadUserConfig, resolveConfigPath } from "./user-config-loader.ts";
import type { UserConfig } from "./types.ts";

export * from "./user-config-loader.ts";

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
