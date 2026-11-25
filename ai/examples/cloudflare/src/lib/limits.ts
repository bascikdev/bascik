/**
 * What a chat route checks before the chat handler reads the request
 * (`route` in src/lib/chat.ts calls `refusal` first). It runs in the route
 * itself, not in the wrapper Worker, so it holds for every path Bascik
 * routes to the handler: `/api/send/`, `/api/%73end` and `//api//send`
 * reach the same route as `/api/send`, and are counted the same.
 *
 * - Every route: the method, and a POST's declared length (guards.ts).
 * - `file` and `stop` act only on what a reader already has: without a
 *   visitor cookie this server issued, they answer 404 before any store is
 *   asked.
 * - `send`, `approve` and `answer` each start a model turn, so each is a
 *   send in the address's ten-minute window. A send with files is counted
 *   again against a smaller window, and a send from a client with no
 *   visitor cookie (a new reader, who will keep data) against the
 *   address's day.
 *
 * Counters are Budget objects named by a salted hash of the address's
 * `addressKey` (an IPv6 address by its /64), so none holds an address.
 */
import { charge } from "./cf-stores.ts";
import { numberVar, RETENTION_MS, utcDay, type Env } from "./env.ts";
import {
  SEND_WINDOW_MS,
  addressHash,
  carriesFiles,
  checkRequest,
  notFound,
  sendWindow,
  tooMany,
  tooManyReaders,
} from "./guards.ts";

/** The chat's handlers that have a route. */
export type Handler =
  "send" | "approve" | "answer" | "forget" | "stop" | "open" | "file";

/** Sends, sends with files, and new readers one address may make: per ten minutes, then per UTC day. */
export const IP_SENDS = 30;
export const IP_UPLOADS = 10;
export const IP_READERS = 5;

/** The handlers that start a model turn. */
const TURNS = new Set<Handler>(["send", "approve", "answer"]);
/** The handlers that only act on what a reader already has. */
const READER_ONLY = new Set<Handler>(["file", "stop"]);

/**
 * The answer for a request the route must not pass to the chat, or null
 * when it may go on. `knownReader` is whether the request carries a visitor
 * cookie this server issued.
 */
export async function refusal(
  handler: Handler,
  request: Request,
  env: Env,
  knownReader: boolean,
): Promise<Response | null> {
  const refused = checkRequest(request);
  if (refused) return refused;
  if (READER_ONLY.has(handler) && !knownReader) return notFound();
  if (!TURNS.has(handler)) return null;
  if (!env.IP_SALT) {
    console.error("IP_SALT is not set: sends are refused.");
    return new Response("This demo is not set up yet.\n", { status: 503 });
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const client = `ip:${await addressHash(ip, env.IP_SALT)}`;
  const window = `${client}:${sendWindow()}`;
  const windowTtl = 2 * SEND_WINDOW_MS;
  const sends = numberVar(env.GENUI_IP_SENDS, IP_SENDS);
  if (!(await charge(env.BUDGET, window, "sends", sends, windowTtl))) {
    return tooMany();
  }
  if (handler !== "send") return null;
  const uploads = numberVar(env.GENUI_IP_UPLOADS, IP_UPLOADS);
  if (
    carriesFiles(request) &&
    !(await charge(env.BUDGET, window, "uploads", uploads, windowTtl))
  ) {
    return tooMany();
  }
  // A new reader: without this, one client could use up the whole day's
  // cap on new readers (ReaderData), and shut the demo to everyone else.
  const readers = numberVar(env.GENUI_IP_READERS, IP_READERS);
  if (
    !knownReader &&
    !(await charge(
      env.BUDGET,
      `${client}:day:${utcDay()}`,
      "readers",
      readers,
      2 * RETENTION_MS,
    ))
  ) {
    return tooManyReaders();
  }
  return null;
}
