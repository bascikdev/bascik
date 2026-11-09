import { cart, save } from "../../browser/cart.ts";
import type { CartItem } from "../../browser/cart.ts";
import { api, componentElements } from "../../browser/dom.ts";
/**
 * The order section is rendered on the server from a short-lived ticket. The
 * browser only clears the cart once, polls while the order is still moving,
 * and keeps the private URL out of print headers.
 */
const RESULT = "[data-order-result]";
export function initOrderConfirmation(root: HTMLElement) {
  const { element, status } = componentElements(root);
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  const printing = () => {
    const printButton = element<HTMLButtonElement>("[data-order-print]");
    printButton?.addEventListener("click", () => window.print());
  };
  let privatePrintUrl: string | undefined;
  window.addEventListener("beforeprint", () => {
    if (!location.search && !location.hash) return;
    privatePrintUrl = location.href;
    history.replaceState(history.state, "", location.pathname);
  });
  window.addEventListener("afterprint", () => {
    if (!privatePrintUrl) return;
    history.replaceState(history.state, "", privatePrintUrl);
    privatePrintUrl = undefined;
  });
  const clearCart = (result: HTMLElement) => {
    const orderId = result.dataset.orderId;
    const purchased = result.dataset.orderItems;
    if (!orderId || !purchased) return;
    try {
      const marker = `bascik-shop-cart-cleared:${orderId}`;
      if (localStorage.getItem(marker)) return;
      const bought: CartItem[] = JSON.parse(purchased);
      const items = cart()
        .map((entry) => {
          const item = bought.find((b) => b.variantId === entry.variantId);
          return { ...entry, quantity: entry.quantity - (item?.quantity ?? 0) };
        })
        .filter((entry) => entry.quantity > 0);
      save(items);
      localStorage.setItem(marker, "true");
    } catch (error) {
      console.error("Could not update the cart after payment", error);
    }
  };
  // The exchange in <head> failed (a bad or revoked link): say so in place.
  const exchangeError = document.documentElement.dataset.orderError;
  const settle = (result: HTMLElement | null) => {
    if (!result) return;
    clearCart(result);
    printing();
    if (result.dataset.orderPending === "true") poll(result);
  };
  // The server stamps the result with the same fingerprint the API computes,
  // so the first poll already compares against what is on screen.
  const poll = (result: HTMLElement) => {
    if (!token) return;
    let attempts = 0;
    let last = result.dataset.orderFingerprint;
    const check = async () => {
      try {
        const order = await api("/api/order", { token });
        const changed = order.fingerprint !== last;
        last = order.fingerprint;
        if (changed) {
          const url = `/order?ticket=${encodeURIComponent(order.ticket)}${location.hash}`;
          const response = await fetch(url, {
            headers: { Accept: "text/html" },
          });
          if (!response.ok) throw new Error("Order lookup failed.");
          // Data attributes are not scoped, so the fresh document is queried
          // the same way `element()` queries the live one.
          const parsed = new DOMParser().parseFromString(
            await response.text(),
            "text/html",
          );
          const fresh = componentElements(parsed.body).element<HTMLElement>(
            RESULT,
          );
          if (!fresh) throw new Error("Order lookup failed.");
          const live = element(RESULT);
          live?.replaceWith(fresh);
          history.replaceState(history.state, "", url);
          last = fresh.dataset.orderFingerprint;
          clearCart(fresh);
          printing();
          if (fresh.dataset.orderPending !== "true") return;
        }
        if (++attempts < 60)
          setTimeout(check, Math.min(30000, attempts * 3000));
        else
          status(
            "[data-order-status]",
            `${element("[data-order-status]")?.textContent?.trim() ?? ""} Processing is still underway. Refresh this page to check again.`,
          );
      } catch (error) {
        status(
          "[data-order-status]",
          error instanceof Error ? error.message : "Order lookup failed.",
          true,
        );
      }
    };
    void check();
  };
  const ready = () => {
    const result = element(RESULT);
    if (exchangeError && result?.dataset.orderNotice === "no-ticket") {
      status("[data-order-status]", exchangeError, true);
      return;
    }
    settle(result);
  };
  // The result streams in after the shell; wait for it when it is not here yet.
  if (element(RESULT) || document.readyState === "complete") ready();
  else window.addEventListener("load", ready, { once: true });
}
