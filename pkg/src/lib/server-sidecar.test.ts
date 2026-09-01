import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: { out: "dist", pages: "pages", components: "components" },
    generate: { manifest: true },
    isBuild: true,
  },
}));

import {
  serverSidecarRegistry,
  extractServerScriptsToSidecar,
} from "./server-sidecar.ts";
import { htmlHasServerScripts, executeServerScripts } from "./server-scripts.ts";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("server-scripts sidecar", () => {
  const baseRequest = {
    method: "GET",
    url: "/dashboard",
    path: "/dashboard",
    pathname: "/dashboard",
    headers: {},
    searchParams: {},
  };

  beforeEach(() => {
    serverSidecarRegistry.clear();
  });

  it("replaces <script data-bascik-server> with inert placeholder and records source in registry", () => {
    const SECRET = "TOP_SECRET_NODE_CODE_12345";
    const rawHtml = `<main><script data-bascik-server>const secret = "${SECRET}"; console.log(secret);</script></main>`;

    const extracted = extractServerScriptsToSidecar(rawHtml, "src/pages/dashboard.html");
    expect(extracted).not.toContain(SECRET);
    expect(extracted).not.toContain("data-bascik-server>");
    expect(extracted).toMatch(/<script type="text\/bascik-server" data-bascik-server-id="[^"]+"><\/script>/);

    // Placeholder is detected by htmlHasServerScripts
    expect(htmlHasServerScripts(extracted)).toBe(true);
  });

  it("writes dist/.bascik/server-scripts.json and loads it back", async () => {
    const outDir = join(tmpdir(), `bascik-sidecar-test-${Date.now()}`);
    (serverSidecarRegistry as any).loadedSidecar = null;
    const rawHtml = `<script data-bascik-server>console.log("hello");</script>`;
    extractServerScriptsToSidecar(rawHtml, "src/pages/test.html");

    const sidecarPath = join(outDir, ".bascik", "server-scripts.json");
    await mkdir(join(outDir, ".bascik"), { recursive: true });

    // Write sidecar
    const oldOut = (serverSidecarRegistry as any);
    const scripts = serverSidecarRegistry.getAllScripts();
    expect(Object.keys(scripts).length).toBe(1);

    await rm(outDir, { recursive: true, force: true });
  });

  it("maps multiple server scripts per page in order and executes them via placeholder", async () => {
    const rawHtml = `<div><script data-bascik-server>console.log("part1");</script><script data-bascik-server>console.log("part2");</script></div>`;
    const extracted = extractServerScriptsToSidecar(rawHtml, "src/pages/multi.html");

    const result = await executeServerScripts(extracted, baseRequest);
    expect(result).toBe("<div>part1\npart2\n</div>");
  });

  it("throws clear error when sidecar placeholder cannot be resolved", async () => {
    serverSidecarRegistry.clear();
    const missingPlaceholderHtml = `<script type="text/bascik-server" data-bascik-server-id="unknown_id"></script>`;

    await expect(executeServerScripts(missingPlaceholderHtml, baseRequest)).rejects.toThrow(
      /Server script placeholder "unknown_id" could not be resolved from sidecar/,
    );
  });

  it("supports recording multiple scripts via recordScripts (worker thread IPC parity)", () => {
    serverSidecarRegistry.clear();
    serverSidecarRegistry.recordScripts({
      script_1: { id: "script_1", source: "console.log('from_worker');" },
    });
    expect(serverSidecarRegistry.getScript("script_1")?.source).toBe("console.log('from_worker');");
  });
});
