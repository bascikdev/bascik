import { money } from "../../lib/catalog.ts";
import { cart, save } from "../../browser/cart.ts";
import type { CartItem } from "../../browser/cart.ts";
import { api, componentElements } from "../../browser/dom.ts";
import type { OrderSummary } from "../../lib/order-summary.ts";
export function initOrderConfirmation(root: HTMLElement) {
  const { element, status } = componentElements(root);
  if (element("[data-order-status]")) {
    const printButton = element<HTMLButtonElement>("[data-order-print]");
    printButton?.addEventListener("click", () => window.print());
    let privatePrintUrl: string | undefined;
    window.addEventListener("beforeprint", () => {
      if (!location.hash) return;
      privatePrintUrl = location.href;
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    });
    window.addEventListener("afterprint", () => {
      if (!privatePrintUrl) return;
      history.replaceState(history.state, "", privatePrintUrl);
      privatePrintUrl = undefined;
    });
    const renderConfirmation = (summary: OrderSummary) => {
      const container = element("[data-order-lines]");
      container?.replaceChildren();
      for (const item of summary.items) {
        const line = document.createElement("article");
        line.className = "order-line";
        line.dataset.testid = "order-item";
        const details = document.createElement("div");
        const heading = document.createElement("h3");
        heading.textContent = item.title;
        const quantity = document.createElement("p");
        quantity.textContent = `Quantity: ${item.quantity} · ${money(item.price)} each`;
        details.append(heading, quantity);
        const amount = document.createElement("strong");
        amount.textContent = money(item.price * item.quantity);
        line.append(details, amount);
        container?.append(line);
      }
      const values: Record<string, string> = {
        reference: summary.reference,
        date: `Placed ${new Intl.DateTimeFormat("en-US", {
          dateStyle: "long",
          timeZone: "UTC",
        }).format(new Date(summary.placedAt))}`,
        subtotal: money(summary.subtotal),
        shipping: `${money(summary.shipping)} · ${summary.shippingService}`,
        tax: summary.tax === null ? "See Stripe receipt" : money(summary.tax),
        total: money(summary.total ?? summary.subtotal + summary.shipping),
        "total-label":
          summary.total === null ? "Total before tax" : "Total paid",
      };
      for (const [name, value] of Object.entries(values)) {
        const target = element(`[data-order-${name}]`);
        if (target) target.textContent = value;
      }
      const panel = element("[data-order-summary]");
      if (panel) panel.hidden = false;
      if (printButton) printButton.hidden = false;
    };
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("token");
    if (!token)
      status(
        "[data-order-status]",
        "Use the private link from your order confirmation.",
        true,
      );
    else {
      let attempts = 0;
      const check = async () => {
        try {
          const order = await api("/api/order", { token });
          const labels: Record<string, string> = {
            pending: "Waiting for payment confirmation.",
            expired:
              "This checkout expired without payment. Your cart is unchanged.",
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
          status(
            "[data-order-status]",
            labels[order.status] ?? "Checking fulfillment status.",
          );
          const refund = element("[data-order-refund]");
          if (refund) {
            const amount = money(order.refund?.amount ?? 0);
            const refundLabels: Record<string, string> = {
              refunded: `Your full refund of ${amount} has been issued. Bank processing may take several days.`,
              partial: `A partial refund of ${amount} has been issued. Your original purchase totals are shown below.`,
              pending: `A refund is processing.${order.refund?.amount ? ` ${amount} has already been refunded.` : ""}`,
              failed: `A refund needs attention.${order.refund?.amount ? ` ${amount} has already been refunded.` : ""} Please contact us.`,
              none:
                order.status === "cancelled"
                  ? "Your order was canceled. A full refund has not yet been confirmed."
                  : "",
            };
            refund.textContent =
              refundLabels[order.refund?.state ?? "none"] ?? "";
            refund.hidden = !refund.textContent;
          }
          if (order.paymentConfirmed === true) {
            if (order.summary) renderConfirmation(order.summary);
            const emailLabels: Record<string, string> = {
              pending:
                "Your confirmation email is queued. Keep this private order link while it is sent.",
              sent: "Your confirmation email has been sent. If it has not arrived, check spam or contact us.",
              failed:
                "We could not send your confirmation email. Keep this private link and contact us for help.",
              disabled: "Confirmation emails are disabled for test orders.",
            };
            status(
              "[data-order-email]",
              emailLabels[order.confirmationEmail] ?? "",
            );
            try {
              const marker = `bascik-shop-cart-cleared:${order.orderId}`;
              if (!localStorage.getItem(marker)) {
                const items = cart()
                  .map((entry) => {
                    const purchased = order.items.find(
                      (item: CartItem) => item.variantId === entry.variantId,
                    );
                    return {
                      ...entry,
                      quantity: entry.quantity - (purchased?.quantity ?? 0),
                    };
                  })
                  .filter((entry) => entry.quantity > 0);
                save(items);
                localStorage.setItem(marker, "true");
              }
            } catch (error) {
              console.error("Could not update the cart after payment", error);
            }
          }
          const container = element("[data-shipments]");
          container?.replaceChildren();
          for (const shipment of order.shipments ?? []) {
            const paragraph = document.createElement("p");
            paragraph.textContent = `${shipment.carrier ?? "Carrier"}: ${shipment.tracking_number ?? "Tracking pending"}`;
            if (shipment.tracking_url) {
              const url = new URL(shipment.tracking_url);
              if (url.protocol === "https:") {
                const link = document.createElement("a");
                link.href = url.href;
                link.textContent = " Track shipment";
                link.rel = "noreferrer noopener";
                paragraph.append(link);
              }
            }
            container?.append(paragraph);
          }
          if (
            ["pending", "paid", "submitting"].includes(order.status) ||
            (order.paymentConfirmed === true &&
              order.confirmationEmail === "pending")
          ) {
            if (++attempts < 60)
              setTimeout(check, Math.min(30000, attempts * 3000));
            else
              status(
                "[data-order-status]",
                `${labels[order.status]} Processing is still underway. Refresh this page to check again.`,
              );
          }
        } catch (error) {
          status(
            "[data-order-status]",
            error instanceof Error ? error.message : "Order lookup failed.",
            true,
          );
        }
      };
      void check();
    }
  }
}
