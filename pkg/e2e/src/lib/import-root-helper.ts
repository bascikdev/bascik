// Fixture helper imported via the `@/` and `/` import-root aliases.
// The dev-server E2E test rewrites the marker below and asserts the page
// re-renders, proving alias-imported helpers are watched.
export const IMPORT_ROOT_MARKER = 'import-root-helper-v1';

export const importRootMarker = (): string => IMPORT_ROOT_MARKER;
