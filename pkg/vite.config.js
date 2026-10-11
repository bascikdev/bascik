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
      exclude: ["src/**/*.test.ts"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          // Recompute every reused scoping result and fail on any difference (scoping-template.ts).
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
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
        },
      },
    ],
  },
});
