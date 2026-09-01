import type { UserConfig } from "./types.ts";

export type * from "./types.ts";

/** Public type for bascik.config.ts — use with `defineConfig`. */
export type BascikConfig = UserConfig;

/** Type helper for bascik.config.ts — wraps config in the correct type. */
export const defineConfig = (config: BascikConfig): BascikConfig => config;
