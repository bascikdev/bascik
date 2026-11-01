import { defineConfig } from "vite";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // Real-editor suites, run by vscode-test (.vscode-test.cjs), not by Vitest.
    exclude: ["src/test/**", "src/test-no-html/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/test/**", "src/test-no-html/**", "src/extension.ts"],
    },
  },
});
