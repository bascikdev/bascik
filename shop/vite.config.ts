import { defineConfig } from "vitest/config";

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
  },
});
