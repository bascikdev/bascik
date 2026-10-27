// Fixture helper for src/pages/import-root-server-test.html, imported via the
// `@/` import-root alias by a server script. The production server imports it
// from the source tree on the first request, so it is kept separate from
// import-root-helper.ts, which the dev lane rewrites while other lanes run.
export const IMPORT_ROOT_MARKER = "import-root-helper-v1";

export const importRootMarker = (): string => IMPORT_ROOT_MARKER;
