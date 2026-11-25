/**
 * The Worker that deploys (wrangler.wrapper.jsonc names it as `main`): the
 * guards first, then the Worker Bascik generated, which renders the chat's
 * pages and answers its API routes. It also exports the three Durable
 * Object classes the bindings name.
 *
 * `bascik-worker` is an alias (see `alias` in wrangler.wrapper.jsonc) for
 * dist/.bascik/cloudflare/worker.js, so `yarn build` must run first.
 */
import bascikWorker from "bascik-worker";
import { charge } from "./src/lib/cf-stores.ts";
import { numberVar, type Env } from "./src/lib/env.ts";
import {
  SEND_WINDOW_MS,
  addressHash,
  carriesFiles,
  checkRequest,
  sendWindow,
  tooMany,
} from "./src/lib/guards.ts";

export { Budget } from "./do/budget.ts";
export { ConversationLive } from "./do/conversation-live.ts";
export { ReaderData } from "./do/reader-data.ts";

/** Sends and sends with files one address may make in ten minutes. */
const IP_SENDS = 30;
const IP_UPLOADS = 10;

/**
 * Whether this send fits its address's window: one Budget object per
 * address and window, which deletes itself once the window is over.
 */
async function sendAllowed(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const name = `ip:${await addressHash(ip, env.IP_SALT!)}:${sendWindow()}`;
  const ttl = 2 * SEND_WINDOW_MS;
  if (
    !(await charge(
      env.BUDGET,
      name,
      "sends",
      numberVar(env.GENUI_IP_SENDS, IP_SENDS),
      ttl,
    ))
  ) {
    return false;
  }
  return (
    !carriesFiles(request) ||
    charge(
      env.BUDGET,
      name,
      "uploads",
      numberVar(env.GENUI_IP_UPLOADS, IP_UPLOADS),
      ttl,
    )
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      const refused = checkRequest(request);
      if (refused) return refused;
      if (request.method === "POST" && pathname === "/api/send") {
        if (!env.IP_SALT) {
          console.error("IP_SALT is not set: sends are refused.");
          return new Response("This demo is not set up yet.\n", {
            status: 503,
          });
        }
        if (!(await sendAllowed(request, env))) return tooMany();
      }
    }
    return bascikWorker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
