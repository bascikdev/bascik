import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Tests for the public agent skills in ../skills/. The skills folder ships to users (npx skills add, the
// bascik.dev tarball), so their tests and fixtures live here instead. Integration tests drive a real browser or the
// real compiler, so they run in their own project.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // The code under test is the skills' scripts, outside this package.
      allowExternal: true,
      include: [fileURLToPath(new URL("../skills/**/*.mjs", import.meta.url))],
    },
  },
});
