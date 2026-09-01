import { describe, it, expect } from "vitest";
import { defineConfig, type BascikConfig } from "./defineConfig.ts";

describe("defineConfig", () => {
  it("returns the exact config object passed to it", () => {
    const config: BascikConfig = {
      scoping: {
        scriptBlocks: true,
      },
      directory: {
        pages: "src/pages",
        components: "src/components",
      },
    };
    const result = defineConfig(config);
    expect(result).toBe(config);
    expect(result.scoping?.scriptBlocks).toBe(true);
    expect(result.directory?.pages).toBe("src/pages");
  });

  it("accepts minify as a boolean shorthand", () => {
    // Runtime already accepts `minify: true` (config.ts normalizes it); the
    // user-facing type must not reject it.
    const result = defineConfig({ minify: true });
    expect(result.minify).toBe(true);
  });

  it("rejects runtime-only keys in the user-facing type", () => {
    // isBuild and isProdServer are derived from argv/env, never from the
    // config file. Writing them must be a type error, not silently discarded.
    defineConfig({
      // @ts-expect-error isBuild is a resolved-runtime key, not user input
      isBuild: true,
    });
    defineConfig({
      // @ts-expect-error isProdServer is a resolved-runtime key, not user input
      isProdServer: true,
    });
  });

  it("is the only defineConfig export in the package source", async () => {
    // The published helper lives in defineConfig.ts. userConfig.ts must not
    // carry a divergent duplicate.
    const userConfigModule = await import("./userConfig.ts");
    expect("defineConfig" in userConfigModule).toBe(false);
  });
});
