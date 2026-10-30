// The public agent skills' scripts are plain .mjs files outside this package, so they have no types here. Tests that
// import them get `any`, instead of a `@ts-expect-error` above each import that stops applying once a formatter
// wraps the import across lines.
declare module "*.mjs";
