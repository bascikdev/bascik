import { describe, expect, it } from "vitest";
import staticConfig from "../../e2e/playwright.config.ts";
import devConfig, {
  devSourceEditingSpecs,
} from "../../e2e/playwright.dev.config.ts";
import http1Config from "../../e2e/playwright.server.config.ts";
import http2Config from "../../e2e/playwright.server-http2.config.ts";

const projectExclusions = (
  config: typeof staticConfig,
  name: string,
): string[] => {
  const project = config.projects?.find((candidate) => candidate.name === name);
  const exclusions = project?.testIgnore;
  return (Array.isArray(exclusions) ? exclusions : [exclusions]).filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
};

describe("Playwright project test selection", () => {
  it.each([
    [
      staticConfig,
      "default",
      [
        "**/static-asset-symlinks.test.ts",
        "**/server-scripts.test.ts",
        "**/server-scripts-stream.test.ts",
        "**/server-components.test.ts",
        "**/api-routes.test.ts",
        "**/dev-server-reload.test.ts",
        "**/prod-server.test.ts",
        "**/preserve-server-form.test.ts",
        "**/caching-layer.test.ts",
        "**/security-defaults.test.ts",
        "**/bascik-add-dev.test.ts",
        "**/dev-exec-lifecycle.test.ts",
        "**/exec-error-policy.test.ts",
        "**/base-serving.test.ts",
      ],
    ],
    [
      // The dev lane's main project is split: read-only specs run in parallel
      // in dev-readonly, then the source-editing specs run in dev-mutating.
      devConfig,
      "dev-readonly",
      [
        "**/prod-server.test.ts",
        "**/sitemap.test.ts",
        "**/exec.test.ts",
        "**/dist-lifecycle.test.ts",
        "**/preserve-server-form.test.ts",
        "**/caching-layer.test.ts",
        "**/dev-exec-lifecycle.test.ts",
        "**/exec-error-policy.test.ts",
        "**/dev-server-reload.test.ts",
        "**/bascik-add-dev.test.ts",
        "**/multi-component-roots.test.ts",
        "**/import-root.test.ts",
        "**/server-scripts-stream.test.ts",
        "**/base-serving.test.ts",
        "**/static-asset-symlinks.test.ts",
      ],
    ],
    [
      http1Config,
      "default",
      [
        "**/static-asset-symlinks.test.ts",
        "**/dev-server-reload.test.ts",
        "**/dist-lifecycle.test.ts",
        "**/bascik-add.test.ts",
        "**/bascik-add-dev.test.ts",
        "**/dev-exec-lifecycle.test.ts",
        "**/exec-error-policy.test.ts",
        "**/base-serving.test.ts",
      ],
    ],
    [
      http2Config,
      "default",
      [
        "**/static-asset-symlinks.test.ts",
        "**/dev-server-reload.test.ts",
        "**/dist-lifecycle.test.ts",
        "**/bascik-add.test.ts",
        "**/bascik-add-dev.test.ts",
        "**/dev-exec-lifecycle.test.ts",
        "**/exec-error-policy.test.ts",
        "**/base-serving.test.ts",
      ],
    ],
  ])(
    "keeps mode exclusions on the main project (%#: %s)",
    (config, name, expected) => {
      expect(projectExclusions(config, name)).toEqual(expected);
    },
  );

  it("runs the dev lane's source-editing specs one at a time, after every read-only spec", () => {
    const mutating = devConfig.projects?.find(
      ({ name }) => name === "dev-mutating",
    );
    expect(mutating?.testMatch).toEqual(devSourceEditingSpecs);
    expect(mutating?.dependencies).toEqual(["dev-readonly"]);
    expect(mutating?.workers).toBe(1);
    // Only the read-only specs share the dev server in parallel.
    const readonly = devConfig.projects?.find(
      ({ name }) => name === "dev-readonly",
    );
    expect(readonly?.fullyParallel).toBe(true);
  });
});
