// bascik.config.ts: run fingerprinting as a post-transpile exec step,
// after pages are written to dist/ and asset references exist to rewrite.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    exec: [
      {
        script: 'fingerprint-assets.mjs',
        phase: 'post',
      },
    ],
  },
});
