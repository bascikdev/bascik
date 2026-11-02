/**
 * @module index
 *
 * Default export of @bascik/adapter-netlify.
 */

import { defineAdapter } from "@bascik/bascik/adapter";
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
});
