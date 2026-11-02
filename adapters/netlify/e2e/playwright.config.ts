import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

process.env.BASCIK_VERIFY_SCOPING_TEMPLATES = "1";

const hostedUrl = process.env.NETLIFY_ADAPTER_TEST_URL;
if (hostedUrl) {
  const url = new URL(hostedUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "netlify-adapter.bascik.dev" &&
      url.hostname !== "bascik-netlify-adapter.netlify.app" &&
      !url.hostname.endsWith("--bascik-netlify-adapter.netlify.app"))
  ) {
    throw new Error(
      "NETLIFY_ADAPTER_TEST_URL must be the dedicated adapter project.",
    );
  }
}

export default defineConfig({
  testDir: "../..",
  testMatch: [
    "**/netlify/e2e/tests/adapter.test.ts",
    "**/e2e/demo-contract.test.ts",
  ],
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: hostedUrl ?? "http://127.0.0.1:9877",
    headless: true,
  },
  webServer: hostedUrl
    ? undefined
    : {
        command:
          "yarn adapter:nf:demo:build && yarn workspace @bascik/adapter-netlify demo:serve",
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        url: "http://127.0.0.1:9877",
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
