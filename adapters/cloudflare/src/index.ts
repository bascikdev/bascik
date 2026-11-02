/**
 * @module index
 *
 * Default export of @bascik/adapter-cloudflare.
 */

import {
  defineAdapter,
  resolvePlatformCli,
  availableDevPort,
} from "@bascik/bascik/adapter";
import { build } from "./build.js";
import { join } from "node:path";

export {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_COMPATIBILITY_FLAGS,
} from "./compat.js";
export { buildInvocationRoutes } from "./build.js";

export default defineAdapter({
  name: "cloudflare",
  build,
  async dev({ projectRoot, outDir, variant, port }) {
    const cli = await resolvePlatformCli(projectRoot, "wrangler", "wrangler");
    const inspectorPort = await availableDevPort();
    return {
      command: process.execPath,
      args: [
        cli,
        ...(variant === "pages"
          ? [
              "pages",
              "dev",
              join(outDir, "public"),
              "--compatibility-flag",
              "nodejs_compat",
            ]
          : ["dev", "--config", join(outDir, "wrangler.jsonc")]),
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspectorPort),
        "--persist-to",
        join(projectRoot, ".wrangler", "state"),
      ],
      cwd: projectRoot,
      env: { WRANGLER_SEND_METRICS: "false" },
    };
  },
});
