/**
 * @module index
 *
 * Default export of @bascik/adapter-netlify.
 */

import {
  defineAdapter,
  resolvePlatformCli,
  availableDevPort,
} from "@bascik/bascik/adapter";
import { installNetlifyOutput } from "./install.js";
import { build } from "./build.js";
import { ADAPTER_NAME } from "./paths.js";

export {
  apiRoutePattern,
  entrySource,
  fileUrlPlugin,
  functionPaths,
} from "./build.js";
export { headersFileText } from "./headers-file.js";
export {
  createNetlifyHandler,
  type DiagnosticLogEntry,
  type RequestLogEntry,
  type SiteGraph,
} from "./runtime.js";

export default defineAdapter({
  name: ADAPTER_NAME,
  build,
  async dev({ projectRoot, distDir, port }) {
    const cli = await resolvePlatformCli(projectRoot, "netlify-cli", "netlify");
    const { publishDir } = await installNetlifyOutput(projectRoot, distDir);
    const functionsPort = await availableDevPort();
    const staticServerPort = await availableDevPort();
    return {
      command: process.execPath,
      args: [
        cli,
        "dev",
        "--framework",
        "#static",
        "--dir",
        publishDir,
        "--functions",
        "netlify/functions",
        "--port",
        String(port),
        "--functions-port",
        String(functionsPort),
        "--staticServerPort",
        String(staticServerPort),
        "--offline",
        "--no-open",
      ],
      cwd: projectRoot,
      env: { NETLIFY_TELEMETRY_DISABLED: "1", BROWSER: "none" },
    };
  },
});
