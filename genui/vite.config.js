import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "demo/src/lib/**/*.test.ts"] },
});
