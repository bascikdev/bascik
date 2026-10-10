import { defineConfig } from "vite";

export default defineConfig({
  test: {
    benchmark: {
      include: ["bench/**/*.bench.ts"],
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
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
        },
      },
    ],
  },
});
