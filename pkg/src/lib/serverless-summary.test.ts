import { describe, expect, it } from "vitest";
import {
  formatServerlessSummary,
  type ServerlessBuildResult,
} from "./serverless-artifacts.ts";

// WHY: the summary's closing note used to say "(the Worker and its config)"
// for every target, including Netlify and custom adapters that emit no
// Worker. The wording now follows the result.
const result = (
  overrides: Partial<ServerlessBuildResult>,
): ServerlessBuildResult => ({
  target: "netlify",
  adapter: "@bascik/adapter-netlify",
  outDir: "/site/dist/.bascik/netlify",
  publicDir: "/site/dist/.bascik/netlify/public",
  bundleBytes: 2048,
  dynamicPages: [],
  apiRoutes: [],
  publicFiles: 3,
  release: "abc",
  ...overrides,
});

describe("formatServerlessSummary closing note", () => {
  it("names the Worker only when the build emitted one", () => {
    const text = formatServerlessSummary(
      result({
        target: "cloudflare-workers",
        adapter: "@bascik/adapter-cloudflare",
        outDir: "/site/dist/.bascik/cloudflare-workers",
        publicDir: "/site/dist/.bascik/cloudflare-workers/public",
        workerPath: "/site/dist/.bascik/cloudflare-workers/worker.js",
      }),
      "/site",
    );
    expect(text).toContain(
      "dist/ now also holds dist/.bascik/cloudflare-workers/ (the Worker and its config).",
    );
    expect(text).toContain("do not publish dist/ to a static host.");
  });

  it("calls a bundle without a Worker the deployment bundle", () => {
    const text = formatServerlessSummary(result({}), "/site");
    expect(text).toContain(
      "dist/ now also holds dist/.bascik/netlify/ (the deployment bundle and its config).",
    );
    expect(text).not.toContain("Worker");
  });

  it("misuse: a custom adapter with no worker and a bundle outside dist/ still gets the note for its own output directory", () => {
    const text = formatServerlessSummary(
      result({
        target: "./adapters/custom.ts",
        adapter: "custom",
        outDir: "/site/out/.bascik/custom",
        publicDir: "/site/out/.bascik/custom/public",
      }),
      "/site",
    );
    expect(text).toContain(
      "out/ now also holds out/.bascik/custom/ (the deployment bundle and its config).",
    );
    expect(text).toContain("do not publish out/ to a static host.");
  });
});
