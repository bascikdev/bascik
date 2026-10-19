/**
 * e2e tests for the `exec` config option.
 *
 * The e2e bascik.config.ts includes:
 *   exec: [{ script: 'scripts/generate-manifest.ts' }]
 *
 * That script writes `dist/exec-manifest.json` during `--build`.
 * It also calls mkdir({ recursive: true }) first, so it works on a clean
 * checkout where dist/ does not yet exist.
 * These tests verify the file is generated and served correctly.
 */
import { test, expect } from "@playwright/test";

test("exec script output is served from dist/", async ({ request }) => {
  const resp = await request.get("/exec-manifest.json");
  expect(resp.ok()).toBe(true);
  const json = await resp.json();
  expect(json).toEqual({ generated: true });
});
