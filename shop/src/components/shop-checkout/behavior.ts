import { findVariant, money } from "../../lib/catalog.ts";
import { cart } from "../../browser/cart.ts";
import { api, componentElements } from "../../browser/dom.ts";
import countries from "../../../catalog/countries.json" with { type: "json" };
import { shippingCountries } from "./shipping-countries.ts";
export function initShopCheckout(root: HTMLElement) {
  const { element, status } = componentElements(root);

  function checkoutTotals(shipping?: number) {
    document.dispatchEvent(
      new CustomEvent("shop:checkout-shipping", { detail: { shipping } }),
    );
  }
  const shippingForm = element<HTMLFormElement>("[data-shipping-form]");
  if (shippingForm) shippingForm.hidden = !cart().length;
  const country = element<HTMLSelectElement>("[name=country_code]");
  if (country) {
    for (const item of shippingCountries(
      cart().flatMap((item) => {
        const match = findVariant(item.variantId);
        return match ? [match.product.id] : [];
      }),
    )) {
      const option = document.createElement("option");
      option.value = item.code;
      option.textContent = item.name;
      country.append(option);
    }
    country.addEventListener("change", () => {
      const region = countries.find((entry) => entry.code === country.value);
      const state = element<HTMLInputElement>("[name=state_code]");
      if (state) {
        state.required = ["US", "CA", "AU"].includes(country.value);
        state.setAttribute(
          "placeholder",
          region?.states
            ?.map((entry) => entry.code)
            .slice(0, 6)
            .join(", ") ?? "",
        );
      }
      const zip = element<HTMLInputElement>("[name=zip]");
      if (zip) zip.required = ["US", "CA", "AU", "SG"].includes(country.value);
    });
  }
  let quoteId: string | undefined;
  let quoteKey = "";
  let quoteExpiresAt = 0;
  const deliveryKey = () =>
    JSON.stringify({
      items: cart(),
      recipient: shippingForm && Object.fromEntries(new FormData(shippingForm)),
    });
  function invalidateQuote() {
    quoteId = undefined;
    quoteKey = "";
    const section = element("[data-rates-section]");
    if (section) section.hidden = true;
    checkoutTotals();
    document.dispatchEvent(
      new CustomEvent("shop:destination-changed", {
        detail: {
          country: country?.value ?? "",
          state: element<HTMLInputElement>("[name=state_code]")?.value ?? "",
        },
      }),
    );
  }
  shippingForm?.addEventListener("input", invalidateQuote);
  shippingForm?.addEventListener("change", invalidateQuote);
  document.addEventListener("shop:cart-changed", () => {
    invalidateQuote();
    if (shippingForm) shippingForm.hidden = !cart().length;
  });
  shippingForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    invalidateQuote();
    if (!cart().length)
      return status(
        "[data-checkout-status]",
        "Add at least one product to your cart.",
        true,
      );
    const requestedKey = deliveryKey();
    const button = shippingForm.querySelector("button");
    if (button) button.disabled = true;
    status("[data-checkout-status]", "Checking availability and shipping...");
    try {
      const result = await api("/api/quote", {
        items: cart(),
        recipient: Object.fromEntries(new FormData(shippingForm)),
      });
      if (deliveryKey() !== requestedKey)
        throw new Error(
          "Your delivery details or cart changed. Request a fresh shipping quote.",
        );
      quoteId = result.quoteId;
      quoteKey = requestedKey;
      quoteExpiresAt = result.expiresAt;
      const rates = element("[data-rates]");
      rates?.replaceChildren();
      const template = element<HTMLTemplateElement>("[data-rate-template]");
      if (!template) throw new Error("Shipping rate template is missing.");
      for (const [index, rate] of result.rates.entries()) {
        const fragment = template.content.cloneNode(true) as DocumentFragment;
        const radio = fragment.querySelector<HTMLInputElement>("input")!;
        radio.value = rate.id;
        radio.checked = index === 0;
        radio.addEventListener("change", () => checkoutTotals(rate.amount));
        const name = fragment.querySelector("span")!;
        name.textContent = rate.name;
        const price = fragment.querySelector("strong")!;
        price.textContent = rate.amount === 0 ? "Free" : money(rate.amount);
        rates?.append(fragment);
      }
      checkoutTotals(result.rates[0]?.amount);
      const section = element("[data-rates-section]");
      if (section) section.hidden = false;
      status(
        "[data-checkout-status]",
        `Items ${money(result.subtotal)}. Choose shipping below.`,
      );
    } catch (error) {
      status(
        "[data-checkout-status]",
        error instanceof Error ? error.message : "Shipping lookup failed.",
        true,
      );
    } finally {
      if (button) button.disabled = false;
    }
  });
  element<HTMLButtonElement>("[data-pay]")?.addEventListener(
    "click",
    async (event) => {
      const target = event.currentTarget as HTMLButtonElement;
      const shippingId = element<HTMLInputElement>(
        "[name=shippingId]:checked",
      )?.value;
      if (
        !quoteId ||
        !shippingId ||
        quoteKey !== deliveryKey() ||
        quoteExpiresAt <= Date.now() / 1000
      )
        return status(
          "[data-checkout-status]",
          "Request a fresh shipping quote first.",
          true,
        );
      target.disabled = true;
      try {
        const requestedKey = quoteKey;
        const result = await api("/api/checkout", { quoteId, shippingId });
        if (requestedKey !== deliveryKey())
          throw new Error(
            "Your delivery details or cart changed. Request a fresh shipping quote.",
          );
        const url = new URL(result.url);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
          throw new Error("Invalid payment destination.");
        location.assign(url.href);
      } catch (error) {
        status(
          "[data-checkout-status]",
          error instanceof Error ? error.message : "Checkout failed.",
          true,
        );
        target.disabled = false;
      }
    },
  );
}
