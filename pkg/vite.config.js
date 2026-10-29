import { defineConfig } from "vite";

export default defineConfig({
  test: {
    benchmark: {
      include: ["bench/**/*.bench.ts"],
      // Calls between src/lib modules go through Vite's export getters. Removing
      // them means disabling the module runner, which the benchmarks' vi.mock
      // calls need; Vitest 4 measured with the same overhead.
      suppressExportGetterWarnings: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // Test helpers too: a calibrated cost ratio's reference work
      // (linear-time.test-helper.ts) must run at the same speed with and
      // without coverage.
      exclude: ["src/**/*.test.ts", "src/**/*.test-helper.ts"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "e2e/scripts/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          // Recompute every reused scoping result and fail on any difference (scoping-template.ts).
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
          // Whether the run collects coverage, for calibrated cost ratios.
          globalSetup: ["./vitest.coverage-setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          // Inline projects inherit the root `benchmark.include` (Vitest 5), so
          // without this `vitest bench` runs every benchmark twice.
          benchmark: { exclude: ["bench/**"] },
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
          globalSetup: ["./vitest.coverage-setup.ts"],
        },
      },
    ],
  },
});
