import { renderOrder, renderOrderNotice } from "../../lib/order-page.ts";
import { orderView } from "../../lib/order-view.ts";
import { type Context, environment, verifyTicket } from "../../lib/platform.ts";

/**
 * Streams the order into the skeleton's place. The Worker wrapper has already
 * answered 404 for a ticket whose signature does not verify, so by the time
 * this runs the ticket is genuine: it may only be expired, or name an order
 * that has since been revoked or aged out. A missing ticket means the page
 * was opened from the long-lived link, and the head script is exchanging it.
 */
export default async function (request: Request, context: Context) {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (ticket === null) return renderOrderNotice("no-ticket");
  try {
    const env = environment(context);
    const verified = await verifyTicket(env, ticket);
    if (!verified) return renderOrderNotice("not-found");
    if (verified.expired) return renderOrderNotice("expired");
    const order = await orderView(env, verified.id);
    if (!order) return renderOrderNotice("not-found");
    return renderOrder(order, { ticket, expired: false });
  } catch (error) {
    console.error("Order page failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return renderOrderNotice("failed");
  }
}
