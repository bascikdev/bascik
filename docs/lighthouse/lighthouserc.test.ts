import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateLighthouseAllConfig } from './generate-config.ts';

describe('Lighthouse CI configuration', () => {
  const configPath = join(process.cwd(), 'lighthouse/lighthouserc.json');
  const lightConfigPath = join(process.cwd(), 'lighthouse/lighthouserc.light.json');

  it('contains valid Lighthouse CI configuration JSON', async () => {
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);

    expect(config).toBeDefined();
    expect(config.ci).toBeDefined();
  });

  it('configures server collection and 3 core documentation routes by default', async () => {
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);

    const collect = config.ci.collect;
    expect(collect.startServerCommand).toBe('bascik --server');
    expect(Array.isArray(collect.url)).toBe(true);
    expect(collect.url).toEqual([
      'http://localhost:8080/',
      'http://localhost:8080/getting-started',
      'http://localhost:8080/components',
    ]);
  });

  it('contains valid light theme Lighthouse CI configuration JSON with a11y category only', async () => {
    const raw = await readFile(lightConfigPath, 'utf8');
    const config = JSON.parse(raw);

    expect(config).toBeDefined();
    expect(config.ci).toBeDefined();

    const collect = config.ci.collect;
    expect(collect.startServerCommand).toBe('bascik --server');
    expect(collect.url).toEqual([
      'http://localhost:8080/?theme=light',
      'http://localhost:8080/getting-started?theme=light',
      'http://localhost:8080/components?theme=light',
    ]);
    expect(collect.settings.onlyCategories).toEqual(['accessibility']);

    const assertions = config.ci.assert.assertions;
    expect(assertions['categories:accessibility']).toBeDefined();
    expect(assertions['categories:performance']).toBeUndefined();
  });

  it('generates lighthouserc.all.json and lighthouserc.all-light.json dynamically from nav.ts', async () => {
    const urls = await generateLighthouseAllConfig();
    expect(urls.length).toBeGreaterThan(40);
    expect(urls).toContain('http://localhost:8080/');
    expect(urls).toContain('http://localhost:8080/getting-started');
    expect(urls).toContain('http://localhost:8080/components');
    expect(urls).toContain('http://localhost:8080/performance');

    const allConfigRaw = await readFile(join(process.cwd(), 'lighthouse/lighthouserc.all.json'), 'utf8');
    const allConfig = JSON.parse(allConfigRaw);
    expect(allConfig.ci.collect.url).toHaveLength(urls.length);

    const allLightConfigRaw = await readFile(join(process.cwd(), 'lighthouse/lighthouserc.all-light.json'), 'utf8');
    const allLightConfig = JSON.parse(allLightConfigRaw);
    expect(allLightConfig.ci.collect.url).toHaveLength(urls.length);
    expect(allLightConfig.ci.collect.url[0]).toContain('?theme=light');
    expect(allLightConfig.ci.collect.settings.onlyCategories).toEqual(['accessibility']);
  });

  it('defines assertion score thresholds for Lighthouse categories', async () => {
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);

    const assertions = config.ci.assert.assertions;
    expect(assertions['categories:performance']).toBeDefined();
    expect(assertions['categories:accessibility']).toBeDefined();
    expect(assertions['categories:best-practices']).toBeDefined();
    expect(assertions['categories:seo']).toBeDefined();
  });
});
