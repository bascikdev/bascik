// The docs config with the Lighthouse output directory, so `yarn lighthouse` never touches docs/dist (written by
// `yarn docs:dev`) or docs/.e2e/dist (the e2e run). Paths in the config resolve against docs/, the command's cwd.
import { defineConfig } from "@bascik/bascik/config";
import base, { dev, build } from "../bascik.config.ts";
import { LIGHTHOUSE_DIST_DIR } from "./site.ts";

export default defineConfig({
  ...base,
  directory: { ...base.directory, out: LIGHTHOUSE_DIST_DIR },
});

export { dev, build };
