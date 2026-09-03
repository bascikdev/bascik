// bascik.config.ts: run the bundler as a pre-transpile exec step.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'build-bundle.mjs',
        phase: 'pre',
        watch: ['src/client/'],
      },
    ],
  },
});
