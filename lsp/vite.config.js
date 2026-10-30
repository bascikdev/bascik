import { defineConfig } from "vite";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/bin.ts"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.linear-time.test.ts"],
        },
      },
      {
        test: {
          // CPU-growth checks (linear-time.test.util.ts). Each sample spans
          // sixteen clock ticks, so on Windows they take minutes; CI runs
          // them once, on Linux, beside the integration tests.
          name: "linear-time",
          include: ["src/**/*.linear-time.test.ts"],
        },
      },
    ],
  },
});
