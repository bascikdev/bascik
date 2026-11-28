import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "src/**/*.test.ts",
            "demo/src/lib/**/*.test.ts",
            // The browser modules beside the chat components.
            "components/**/*.test.ts",
            // The sound math the voice tests measure with.
            "voice-lab/**/*.test.ts",
          ],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        // Packs the built package and imports it as a consumer would. It
        // builds dist/ and runs real node processes, so it runs apart from
        // `unit`.
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
