import { describe, it, expect } from "vitest";
import { cleanStackTrace } from "./stack-trace.ts";

describe("cleanStackTrace", () => {
  it("returns raw trace if trace is empty or falsy", () => {
    expect(cleanStackTrace("", "/tmp/file.mjs", "src/pages/index.html", 10)).toBe("");
  });

  it("replaces tmp file path and maps line numbers using lineOffset", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/server-123.mjs";
    const realPath = "src/pages/about.html";
    const lineOffset = 15;
    const rawTrace = `Error: Server error\n    at ${tmpPath}:3:8`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Server error\n    at ${realPath}:17:8`);
  });

  it("handles file:// URI format in stack trace", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-456.mjs";
    const realPath = "src/components/card.html";
    const lineOffset = 5;
    const rawTrace = `Error: Build error\n    at file://${tmpPath}:2:4`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error: Build error\n    at ${realPath}:6:4`);
  });

  it("filters out Command failed lines and node:internal stack frames/code frames", () => {
    const tmpPath = "/project/node_modules/.cache/bascik/build-456.mjs";
    const realPath = "src/pages/cli.html";
    const lineOffset = 5;
    const rawTrace = `Command failed: /node /project/node_modules/.cache/bascik/build-456.mjs
node:internal/modules/esm/resolve:271
    throw new ERR_MODULE_NOT_FOUND(
          ^
Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from file://${tmpPath}:2:4
    at finalizeResolution (node:internal/modules/esm/resolve:271:11)
    at moduleResolve (node:internal/modules/esm/resolve:865:10)
    at TracingChannel.tracePromise (node:diagnostics_channel:362:14) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///project/docs/scripts/does-not-exist.ts'
}`;

    const cleaned = cleanStackTrace(rawTrace, tmpPath, realPath, lineOffset);
    expect(cleaned).toBe(`Error [ERR_MODULE_NOT_FOUND]: Cannot find module './does-not-exist' imported from ${realPath}:6:4 {\n  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///project/docs/scripts/does-not-exist.ts'\n}`);
  });
});
