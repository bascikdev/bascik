import { type Env, verifyTicket } from "./platform.ts";

/**
 * Decides, before Bascik renders anything, whether a `/order?ticket=…`
 * request may proceed. Stream scripts cannot set a status code, so a ticket
 * whose signature does not verify gets a real 404 from the Worker wrapper.
 * A ticket with a good signature passes even when expired: the page then
 * tells the reader how to refresh it. No database is read here, so response
 * headers are never held back.
 */
export async function orderGate(
  request: Request,
  env: Env,
): Promise<"pass" | "not-found"> {
  if (request.method !== "GET" && request.method !== "HEAD") return "pass";
  const url = new URL(request.url);
  if (url.pathname !== "/order" && url.pathname !== "/order/") return "pass";
  const ticket = url.searchParams.get("ticket");
  if (ticket === null) return "pass";
  return (await verifyTicket(env, ticket)) ? "pass" : "not-found";
}
