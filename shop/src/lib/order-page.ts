import { html, json, safeUrl, type SafeHtml } from "@bascik/bascik/html";
import { money } from "./catalog.ts";
import {
  emailLabel,
  orderPending,
  refundLabel,
  statusLabel,
} from "./order-labels.ts";
import type { OrderView, Shipment } from "./order-view.ts";

export type OrderNotice = "expired" | "not-found" | "failed" | "no-ticket";
const NOTICES: Record<OrderNotice, { text: string; error: boolean }> = {
  expired: { text: "Refreshing your order link…", error: false },
  "not-found": { text: "Order link not found.", error: true },
  failed: { text: "Order lookup failed.", error: true },
  "no-ticket": {
    text: "Use the private link from your order confirmation.",
    error: false,
  },
};
const help = html`<p class="help" data-testid="order-help">
  Keep this private link to check fulfillment and tracking. Payment confirmation
  can take a moment.
  <a href="/contact">Contact us about your order</a>.
</p>`;
const actions = (printable: boolean) =>
  html`<div class="actions print-actions">
    <a href="/">Back to the collection</a>${
      printable
        ? html`<button type="button" data-order-print data-testid="order-print">
            Print confirmation
          </button>`
        : ""
    }
  </div>`;
const placed = (iso: string) =>
  `Placed ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(iso))}`;
/**
 * The order section for one of the states where there is no order to show.
 * Both the server and the browser's "no link" case render through this.
 */
export function renderOrderNotice(kind: OrderNotice): SafeHtml {
  const notice = NOTICES[kind];
  return html`<div class="result" data-order-result data-order-notice="${kind}">
    <p
      class="${notice.error ? "status error" : "status"}"
      role="status"
      data-order-status
    >
      ${notice.text}
    </p>
    ${help} ${actions(false)}
  </div>`;
}
const statusLine = (
  text: string,
  hidden: boolean,
  testId: string,
  hook: "refund" | "email",
) =>
  hook === "refund"
    ? hidden
      ? html`<p
          role="status"
          data-order-refund
          data-testid="${testId}"
          hidden
        ></p>`
      : html`<p role="status" data-order-refund data-testid="${testId}">
          ${text}
        </p>`
    : hidden
      ? html`<p data-order-email data-testid="${testId}" hidden></p>`
      : html`<p data-order-email data-testid="${testId}">${text}</p>`;
const shipmentLine = (shipment: Shipment) => {
  const url =
    typeof shipment.tracking_url === "string" &&
    shipment.tracking_url.startsWith("https://")
      ? safeUrl(shipment.tracking_url)
      : "about:invalid";
  const text = `${shipment.carrier ?? "Carrier"}: ${shipment.tracking_number ?? "Tracking pending"}`;
  return url === "about:invalid"
    ? html`<p>${text}</p>`
    : html`<p>
        ${text}
        <a href="${url}" rel="noreferrer noopener">Track shipment</a>
      </p>`;
};
/**
 * The order section a verified ticket renders. The `ticket` is accepted so a
 * caller cannot forget it, and is deliberately not written into the markup.
 */
export function renderOrder(
  order: OrderView,
  _ticket: { ticket: string; expired: boolean },
): SafeHtml {
  const summary = order.paymentConfirmed ? order.summary : null;
  const refund = refundLabel(order);
  const email = emailLabel(order);
  // `data-order-items` carries the purchased lines for cart clearing, and
  // only once payment is confirmed; `data-order-pending` tells the browser
  // to keep polling. Both are written as value attributes so the template
  // never chooses attribute names from data.
  return html`<div
    class="result"
    data-order-result
    data-order-id="${order.orderId}"
    data-order-items="${summary ? json(order.items) : ""}"
    data-order-pending="${orderPending(order) ? "true" : ""}"
    data-order-fingerprint="${order.fingerprint}"
  >
    <p class="status" role="status" data-order-status>${statusLabel(order)}</p>
    ${statusLine(refund, refund === "", "order-refund", "refund")}
    ${
      summary
        ? html`<section
            class="panel"
            data-order-summary
            data-testid="order-summary"
            aria-label="Order confirmation"
          >
            <p class="eyebrow">ORDER NUMBER</p>
            <h2 data-order-reference data-testid="order-reference">
              ${summary.reference}
            </h2>
            <p data-order-date>${placed(summary.placedAt)}</p>
            <div data-order-lines>
              ${summary.items.map(
                (item) =>
                  html`<article class="order-line" data-testid="order-item">
                    <div>
                      <h3>${item.title}</h3>
                      <p>
                        Quantity: ${item.quantity} · ${money(item.price)} each
                      </p>
                    </div>
                    <strong>${money(item.price * item.quantity)}</strong>
                  </article>`,
              )}
            </div>
            <dl class="totals">
              <div>
                <dt>Subtotal</dt>
                <dd data-order-subtotal>${money(summary.subtotal)}</dd>
              </div>
              <div>
                <dt>Shipping</dt>
                <dd data-order-shipping>
                  ${money(summary.shipping)} · ${summary.shippingService}
                </dd>
              </div>
              <div>
                <dt>Tax</dt>
                <dd data-order-tax>
                  ${
                    summary.tax === null
                      ? "See Stripe receipt"
                      : money(summary.tax)
                  }
                </dd>
              </div>
              <div class="total">
                <dt data-order-total-label>
                  ${summary.total === null ? "Total before tax" : "Total paid"}
                </dt>
                <dd data-order-total>
                  ${money(summary.total ?? summary.subtotal + summary.shipping)}
                </dd>
              </div>
            </dl>
            <p class="muted">All amounts in USD.</p>
          </section>`
        : ""
    }
    ${statusLine(email, email === "", "order-email", "email")}
    <div data-shipments>${(order.shipments ?? []).map(shipmentLine)}</div>
    ${help} ${actions(summary !== null)}
  </div>`;
}
