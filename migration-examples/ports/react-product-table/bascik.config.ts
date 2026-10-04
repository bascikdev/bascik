import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: {
    // Page-level rules (the body padding), inlined into every page head.
    inlineStyles: ['src/css/global.css'],
  },
  // Rows are printed by a build script in the product-table component from src/data/.
  pipeline: {
    watchPaths: ['src/data/'],
  },
});
