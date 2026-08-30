/**
 * Generates docs/lighthouse/lighthouserc.all.json and docs/lighthouse/lighthouserc.all-light.json
 * dynamically from docs/scripts/nav.ts.
 *
 * Run with:
 *   node docs/lighthouse/generate-config.ts
 */
import { writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV } from '../src/lib/nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lighthouseDir = resolve(__dirname);

export async function generateLighthouseAllConfig(baseUrl = 'http://localhost:8080'): Promise<string[]> {
  // Collect all page hrefs from NAV
  const navHrefs = NAV.flatMap((section) => section.pages.map((page) => page.href));

  // Standalone pages not listed in main nav hierarchy
  const extraPages = ['/', '/license'];

  // Combine and deduplicate
  const allRoutes = Array.from(new Set([...extraPages, ...navHrefs])).sort();
  const allUrls = allRoutes.map((route) => `${baseUrl}${route === '/' ? '/' : route}`);
  const lightUrls = allRoutes.map((route) => `${baseUrl}${route === '/' ? '/?theme=light' : `${route}?theme=light`}`);

  const config = {
    ci: {
      collect: {
        startServerCommand: 'bascik --serve',
        startServerReadyPattern: 'Loaded \\d+ pages? from dist/',
        url: allUrls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: '--no-sandbox --headless',
        },
      },
      assert: {
        assertions: {
          'is-crawlable': 'off',
          'categories:performance': ['warn', { minScore: 0.9 }],
          'categories:accessibility': ['error', { minScore: 1.0 }],
          'categories:best-practices': ['error', { minScore: 1.0 }],
          'categories:seo': ['error', { minScore: 1.0 }],
        },
      },
      upload: {
        target: 'filesystem',
        outputDir: './.lighthouseci',
      },
    },
  };

  const lightConfig = {
    ci: {
      collect: {
        startServerCommand: 'bascik --serve',
        startServerReadyPattern: 'Loaded \\d+ pages? from dist/',
        url: lightUrls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: '--no-sandbox --headless',
          onlyCategories: ['accessibility'],
        },
      },
      assert: {
        assertions: {
          'categories:accessibility': ['error', { minScore: 1.0 }],
        },
      },
      upload: {
        target: 'filesystem',
        outputDir: './.lighthouseci-light',
      },
    },
  };

  const outPath = join(lighthouseDir, 'lighthouserc.all.json');
  await writeFile(outPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  const lightOutPath = join(lighthouseDir, 'lighthouserc.all-light.json');
  await writeFile(lightOutPath, JSON.stringify(lightConfig, null, 2) + '\n', 'utf8');

  return allUrls;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('generate-config.ts') || process.argv[1].endsWith('generate-config.js'));

if (isMain) {
  const urls = await generateLighthouseAllConfig();
  console.log(
    `[generate-lighthouse-config] Generated lighthouserc.all.json and lighthouserc.all-light.json with ${urls.length} URLs from nav.ts`
  );
}
