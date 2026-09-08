import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  pipeline: {
    watchPaths: ['scripts/', 'content/', 'src/lib/', 'src/css/', '../pkg/test-coverage.json', '../pkg/e2e-test-coverage.json'],
    exec: [
      {
        script: 'scripts/generate-search-index.ts',
        phase: 'parallel',
        watch: ['content/'],
        // Fetched by the browser. Completion does not trigger compilation.
      },
      {
        script: 'scripts/publish-agent-skill.ts',
        phase: 'parallel',
        watch: ['src/pages/assets/SKILL.md'],
        // Publishes the one intentional Markdown download (/assets/SKILL.md) to dist. Static asset copying
        // denies .md by design; the authored input is watched, the generated output never is.
      },
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
      { script: 'scripts/publish-agent-skill.ts', phase: 'parallel' },
      { script: 'scripts/generate-llms-txt.ts', phase: 'parallel' },
      { script: 'scripts/generate-og-images.ts', phase: 'parallel' },
    ],
  },
});
