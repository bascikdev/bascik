import type { BascikConfigOptions } from "./types.ts";

// Partial on nested objects that config.ts deep-merges individually.
type UserConfig = Partial<
  Omit<BascikConfigOptions, "isBuild" | "directory" | "scopeAttribute" | "generate" | "minify">
> & {
  directory?: Partial<BascikConfigOptions["directory"]>;
  scopeAttribute?: Partial<BascikConfigOptions["scopeAttribute"]>;
  generate?: Partial<BascikConfigOptions["generate"]>;
  minify?: boolean | Partial<BascikConfigOptions["minify"]>;
};

/** Public type for bascik.config.ts — use with `defineConfig`. */
export type BascikConfig = UserConfig;

/** Type helper for bascik.config.ts — wraps config in the correct type. */
export const defineConfig = (config: BascikConfig): BascikConfig => config;
