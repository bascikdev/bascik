import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    // Recompute every reused scoping result and fail on any difference (pkg
    // scoping-template.ts); the fixture builds the tests spawn inherit it.
    env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-helper.ts"],
    },
  },
});
