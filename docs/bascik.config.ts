import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    watchPaths: ['scripts/', 'src/lib/', 'content/', '../pkg/test-coverage.json', '../pkg/e2e-test-coverage.json'],
    exec: [
      { script: 'scripts/generate-search-index.ts', phase: 'parallel', watch: ['content/'] },
    ],
  },
  assets: {
    inlineStyles: ['src/css/styles.css'],
  },
});

export const build = defineConfig({
  pipeline: {
    exec: [
      { script: 'scripts/generate-search-index.ts', phase: 'parallel' },
      { script: 'scripts/generate-llms-txt.ts', phase: 'parallel' },
      { script: 'scripts/generate-og-images.ts', phase: 'parallel' },
    ],
  },
});
