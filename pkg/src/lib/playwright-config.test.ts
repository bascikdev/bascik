import { describe, expect, it } from 'vitest';
import staticConfig from '../../e2e/playwright.config.ts';
import devConfig from '../../e2e/playwright.dev.config.ts';
import http1Config from '../../e2e/playwright.server.config.ts';
import http2Config from '../../e2e/playwright.server-http2.config.ts';

const defaultProjectExclusions = (config: typeof staticConfig): string[] => {
  const project = config.projects?.find(({ name }) => name === 'default');
  const exclusions = project?.testIgnore;
  return (Array.isArray(exclusions) ? exclusions : [exclusions])
    .filter((pattern): pattern is string => typeof pattern === 'string');
};

describe('Playwright project test selection', () => {
  it.each([
    [staticConfig, [
      '**/server-scripts.test.ts',
      '**/server-scripts-stream.test.ts',
      '**/api-routes.test.ts',
      '**/dev-server-reload.test.ts',
      '**/prod-server.test.ts',
      '**/preserve-server-form.test.ts',
      '**/caching-layer.test.ts',
      '**/bascik-add-dev.test.ts',
      '**/base-serving.test.ts',
    ]],
    [devConfig, [
      '**/prod-server.test.ts',
      '**/sitemap.test.ts',
      '**/exec.test.ts',
      '**/dist-lifecycle.test.ts',
      '**/preserve-server-form.test.ts',
      '**/caching-layer.test.ts',
      '**/base-serving.test.ts',
    ]],
    [http1Config, [
      '**/dev-server-reload.test.ts',
      '**/dist-lifecycle.test.ts',
      '**/bascik-add.test.ts',
      '**/bascik-add-dev.test.ts',
      '**/base-serving.test.ts',
    ]],
    [http2Config, [
      '**/dev-server-reload.test.ts',
      '**/dist-lifecycle.test.ts',
      '**/bascik-add.test.ts',
      '**/bascik-add-dev.test.ts',
      '**/base-serving.test.ts',
    ]],
  ])('keeps mode exclusions on the default project', (config, expected) => {
    expect(defaultProjectExclusions(config)).toEqual(expected);
  });
});