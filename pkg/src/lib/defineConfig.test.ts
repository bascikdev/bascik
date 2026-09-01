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
});
