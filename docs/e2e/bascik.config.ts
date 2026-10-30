// The docs config with the e2e output directory, so `bascik --build` and `bascik --server` in the e2e run never
// touch docs/dist, which `yarn docs:dev` writes. Paths in the config resolve against docs/, the command's cwd.
import { defineConfig } from "@bascik/bascik/config";
import base, { dev, build } from "../bascik.config.ts";
import { E2E_DIST_DIR } from "./site.ts";

export default defineConfig({
  ...base,
  directory: { ...base.directory, out: E2E_DIST_DIR },
});

export { dev, build };
