// Where the Lighthouse audits build and serve their copy of the docs site. It is kept apart from `yarn docs:dev`
// (port 8080, docs/dist) and from the docs e2e run (docs/.e2e/dist, port 8099), so all three run at once: an audit
// never rebuilds the files the dev server or the e2e specs serve, and it never audits a dev build.
import { fileURLToPath } from "node:url";

/**
 * The port the audited server listens on. The lighthouserc*.json files name it in their URLs and ready pattern
 * (lighthouserc.test.ts checks they agree). Bascik's dev server tries 8081, 8082… when 8080 is taken, so this sits
 * well past it, and below the e2e default (8099).
 */
export const LIGHTHOUSE_PORT = 8097;

/** The origin every audited URL starts with. */
export const LIGHTHOUSE_ORIGIN = `http://localhost:${LIGHTHOUSE_PORT}`;

/**
 * The audited build. Inside docs/ because Bascik requires the output directory in the project, and under its own
 * parent so its private folder (.lighthouse/.bascik/dist) is neither the dev server's nor the e2e run's.
 */
export const LIGHTHOUSE_DIST_DIR = fileURLToPath(
  new URL("../.lighthouse/dist", import.meta.url),
);

/** The `bascik` arguments every audit command passes, so builds and servers use the Lighthouse config. */
export const LIGHTHOUSE_CONFIG_ARG = "--config lighthouse/bascik.config.ts";

/** The command each lighthouserc*.json starts (cwd docs/): the production server on the Lighthouse port. */
export const LIGHTHOUSE_SERVER_COMMAND = `bascik ${LIGHTHOUSE_CONFIG_ARG} --server --port ${LIGHTHOUSE_PORT}`;
