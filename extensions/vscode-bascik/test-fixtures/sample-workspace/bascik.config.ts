// Test fixture. The extension reads this file lexically (regex), it never
// executes it, so the import below is only here to look like a real config.
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    // Two component roots: the default tree plus a shared directory. The
    // extension must resolve Cmd/Ctrl+Click and run the hyphenation
    // diagnostic for components in either one.
    components: ['src/components', 'shared-components'],
  },
  scripts: {
    // Explicit default so the import-root tests keep resolving against src/.
    importRoot: 'src',
  },
});
