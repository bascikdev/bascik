/**
 * A component companion script a `<script src>` can inline. `.ts` and `.mts`
 * are TypeScript (`isTypeScriptFile`) and are stripped when inlined; `.js` and
 * `.mjs` are inlined as written. `.test.*` / `.spec.*` files are never
 * companions.
 */
export const COMPANION_SCRIPT_RE = /\.(js|mjs|ts|mts)$/;
export const TEST_COMPANION_SCRIPT_RE = /\.(test|spec)\.(js|mjs|ts|mts)$/;
