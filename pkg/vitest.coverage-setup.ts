/**
 * Global setup for both Vitest projects (vite.config.js): tells the tests
 * whether this run collects coverage, which slows the code under test and
 * not the plain JavaScript a calibrated cost ratio compares it with
 * (`coverageEnabled` in src/lib/linear-time.test-helper.ts). It reads the
 * resolved configuration, so `--coverage.enabled` on the command line and
 * `coverage.enabled` in a config file both count.
 */
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Whether this run collects coverage. */
    bascikCoverage: boolean;
  }
}

export default function setup(project: TestProject): void {
  const enabled: unknown = project.globalConfig.coverage?.enabled;
  if (typeof enabled !== "boolean")
    throw new Error(
      `vitest.coverage-setup.ts: the resolved coverage.enabled is ${String(enabled)}, not a boolean; Vitest may have moved it`,
    );
  project.provide("bascikCoverage", enabled);
}
