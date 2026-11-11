import { money } from "./catalog.ts";
import type { OrderView } from "./order-view.ts";

/** Text the order page shows for each fulfillment status. */
export function statusLabel(order: Pick<OrderView, "status" | "testMode">) {
  const labels: Record<string, string> = {
    pending: "Waiting for payment confirmation.",
    expired: "This checkout expired without payment. Your cart is unchanged.",
    paid: "Payment received. Preparing your order.",
    submitting: "Your order is being submitted to Printful.",
    submitted: "Your order is with Printful.",
    test_draft:
      "Test payment received. Printful draft created. Nothing will be produced or shipped.",
    failed: order.testMode
      ? "Sandbox order needs attention. Nothing will be produced or shipped."
      : "Your order needs attention. Our team has been notified.",
    shipped: "Your order has shipped.",
    cancelled: "Your order was cancelled.",
  };
  return labels[order.status] ?? "Checking fulfillment status.";
}
/** The refund line, or an empty string when there is nothing to say. */
export function refundLabel(order: Pick<OrderView, "status" | "refund">) {
  const amount = money(order.refund?.amount ?? 0);
  const refunded = order.refund?.amount
    ? ` ${amount} has already been refunded.`
    : "";
  const labels: Record<string, string> = {
    refunded: `Your full refund of ${amount} has been issued. Bank processing may take several days.`,
    partial: `A partial refund of ${amount} has been issued. Your original purchase totals are shown below.`,
    pending: `A refund is processing.${refunded}`,
    failed: `A refund needs attention.${refunded} Please contact us.`,
    none:
      order.status === "cancelled"
        ? "Your order was canceled. A full refund has not yet been confirmed."
        : "",
  };
  return labels[order.refund?.state ?? "none"] ?? "";
}
/** The confirmation email notice; empty until payment is confirmed. */
export function emailLabel(
  order: Pick<OrderView, "paymentConfirmed" | "confirmationEmail">,
) {
  if (!order.paymentConfirmed) return "";
  const labels: Record<string, string> = {
    pending:
      "Your confirmation email is queued. Keep this private order link while it is sent.",
    sent: "Your confirmation email has been sent. If it has not arrived, check spam or contact us.",
    failed:
      "We could not send your confirmation email. Keep this private link and contact us for help.",
    disabled: "Confirmation emails are disabled for test orders.",
  };
  return labels[order.confirmationEmail] ?? "";
}
/** Whether the browser should keep polling for a change. */
export function orderPending(
  order: Pick<OrderView, "status" | "paymentConfirmed" | "confirmationEmail">,
) {
  return (
    ["pending", "paid", "submitting"].includes(order.status) ||
    (order.paymentConfirmed && order.confirmationEmail === "pending")
  );
}
