// Where the e2e run builds and serves its copy of the docs site. It is kept apart from `yarn docs:dev` (port 8080,
// docs/dist) so both run at once: the dev server never rewrites the files these tests read, and the tests never
// reach the dev server.
import { fileURLToPath } from "node:url";

/** The port `yarn docs:dev` serves on. Bascik tries 8081, 8082… when it is taken, so the e2e port sits well past it. */
export const DEV_PORT = 8080;

/** The e2e server's port when BASCIK_E2E_PORT is unset. */
const DEFAULT_E2E_PORT = 8099;

/**
 * The e2e build output. Inside docs/ because Bascik requires the output directory in the project, and under its own
 * parent so its private folder (.e2e/.bascik/dist) is not the dev server's (.bascik/dist).
 */
export const E2E_DIST_DIR = fileURLToPath(
  new URL("../.e2e/dist", import.meta.url),
);

/** The port from BASCIK_E2E_PORT, or the e2e default when it is unset or empty. */
export const parseE2ePort = (value: string | undefined): number => {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return DEFAULT_E2E_PORT;
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 1 || port > 65535)
    throw new Error(
      `BASCIK_E2E_PORT must be a port number from 1 to 65535 (received ${JSON.stringify(value)}).`,
    );
  return port;
};
