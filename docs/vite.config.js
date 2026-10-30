import { defineConfig } from "vite";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "lighthouse/**/*.test.ts",
          ],
          exclude: [
            "src/**/*.integration.test.ts",
            "scripts/**/*.integration.test.ts",
          ],
          // Recompute every reused scoping result and fail on any difference (pkg scoping-template.ts).
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "src/**/*.integration.test.ts",
            "scripts/**/*.integration.test.ts",
          ],
          env: { BASCIK_VERIFY_SCOPING_TEMPLATES: "1" },
        },
      },
    ],
    // No top-level `include`: inline projects inherit it (arrays merge, Vitest 5), which made the
    // integration project run every unit test too. Coverage collects from `coverage.include`.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "scripts/**/*.test.ts",
        "lighthouse/**/*.test.ts",
      ],
    },
  },
});
