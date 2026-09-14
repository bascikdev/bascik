/**
 * @module index
 *
 * Default export of @bascik/adapter-cloudflare.
 */

import { defineAdapter } from "@bascik/bascik/adapter";
import { build } from "./build.js";

export { CLOUDFLARE_COMPATIBILITY_DATE, CLOUDFLARE_COMPATIBILITY_FLAGS } from "./compat.js";
export { buildInvocationRoutes } from "./build.js";

export default defineAdapter({
  name: "cloudflare",
  build,
});
