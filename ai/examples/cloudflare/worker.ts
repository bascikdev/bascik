/**
 * The Worker that deploys (wrangler.wrapper.jsonc names it as `main`): a
 * per-address request cap first, then the Worker Bascik generated, which
 * renders the chat's pages and answers its API routes. It also exports the
 * three Durable Object classes the bindings name.
 *
 * The cap is the Workers Rate Limiting binding `REQUESTS`, which costs no
 * Durable Object request to check, and it counts every request that
 * reaches the Worker, whatever its path. The exact counters (sends, sends
 * with files, new readers) run in the chat's routes (src/lib/limits.ts), on
 * the route Bascik matched, so no spelling of a path gets around them.
 *
 * `bascik-worker` is an alias (see `alias` in wrangler.wrapper.jsonc) for
 * dist/.bascik/cloudflare/worker.js, so `yarn build` must run first.
 */
import bascikWorker from "bascik-worker";
import type { Env } from "./src/lib/env.ts";
import { addressHash, tooManyRequests } from "./src/lib/guards.ts";

export { Budget } from "./do/budget.ts";
export { ConversationLive } from "./do/conversation-live.ts";
export { ReaderData } from "./do/reader-data.ts";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (env.REQUESTS) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const key = await addressHash(ip, env.IP_SALT ?? "");
      if (!(await env.REQUESTS.limit({ key })).success) {
        return tooManyRequests();
      }
    }
    return bascikWorker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
