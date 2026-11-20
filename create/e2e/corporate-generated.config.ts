import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import feedback, { verification } from "./corporate-feedback.config.ts";

export default defineConfig({
  ...feedback,
  testDir: resolve(verification.site, "e2e"),
  testMatch: "app.spec.ts",
  outputDir: resolve(verification.root, "generated-browser-results"),
});
