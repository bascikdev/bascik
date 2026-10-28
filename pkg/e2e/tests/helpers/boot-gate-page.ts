/**
 * The page the cold-start boot-screen test (dev-server-reload.test.ts)
 * writes into the shared fixture's src/pages to hold the initial transpile.
 * Its build script waits for the test, so a copy left by a killed run
 * would ship in every later build: the test removes it in `finally`, and
 * run-lanes.ts removes a leftover copy before any lane starts.
 */
export const BOOT_GATE_PAGE = "dev-boot-gate-test.html";
