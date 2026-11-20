import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import feedback from "./corporate-feedback.config.js";

export default defineConfig({
  ...feedback,
  testDir: resolve(
    import.meta.dirname,
    "../dist/corporate-verification/corporate/e2e",
  ),
  testMatch: "app.spec.ts",
  outputDir: "../dist/corporate-generated-browser-results",
});
