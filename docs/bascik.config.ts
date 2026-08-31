import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  watch: ['scripts/', 'src/lib/', 'content/', '../pkg/test-coverage.json', '../pkg/e2e-test-coverage.json'],
  exec: [
    { script: 'scripts/generate-search-index.ts', phase: 'parallel', watch: ['content/'] },
  ],
  siteUrl: 'https://bascik.dev',
  inlineStyles: ['src/css/styles.css'],
});

export const build = defineConfig({
  exec: [
    { script: 'scripts/generate-search-index.ts', phase: 'parallel' },
    { script: 'scripts/generate-llms-txt.ts', phase: 'parallel' },
    { script: 'scripts/generate-og-images.ts', phase: 'parallel' },
  ],
});
