import { products, findVariant, money } from "../lib/catalog.ts";
import countries from "../../catalog/countries.json" with { type: "json" };
import { shippingCountries } from "../lib/shipping-countries.ts";
import type { OrderSummary } from "../lib/order-summary.ts";
import { freeShippingProgress } from "../lib/free-shipping.ts";

interface CartItem {
  variantId: string;
  quantity: number;
}
const key = "bascik-shop-cart";
const element = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
function cart(): CartItem[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("Invalid saved cart");
    return data.filter(
      (item): item is CartItem =>
        typeof item === "object" &&
        item !== null &&
        typeof item.variantId === "string" &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0 &&
        item.quantity <= 10 &&
        Boolean(findVariant(item.variantId)),
    );
  } catch (error) {
    console.error("Could not read the saved cart", error);
    element("[data-cart-status]")?.append(
      "Your saved cart could not be read. Please add your items again.",
    );
    return [];
  }
}
function save(items: CartItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
  for (const badge of document.querySelectorAll("[data-cart-count]"))
    badge.textContent = String(
      items.reduce((total, item) => total + item.quantity, 0),
    );
  renderFreeShipping();
}
function renderFreeShipping() {
  const subtotal = cart().reduce(
    (sum, item) =>
      sum + (findVariant(item.variantId)?.product.price ?? 0) * item.quantity,
    0,
  );
  const form = element("[data-shipping-form]");
  const country =
    element<HTMLSelectElement>("[name=country_code]")?.value ?? "";
  const state = element<HTMLInputElement>("[name=state_code]")?.value ?? "";
  for (const message of document.querySelectorAll(
    "[data-free-shipping-progress]",
  ))
    message.textContent = freeShippingProgress(
      subtotal,
      form ? { country, state } : undefined,
    );
}
try {
  save(cart());
  const theme = localStorage.getItem("bascik-theme");
  if (theme === "light") document.documentElement.dataset.theme = theme;
} catch (error) {
  console.error("Browser storage unavailable", error);
}
for (const toggle of document.querySelectorAll("[data-theme-toggle]"))
  toggle.addEventListener("click", () => {
    const theme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("bascik-theme", theme);
    } catch (error) {
      console.error("Could not save theme", error);
    }
  });
const menu = element<HTMLButtonElement>("[data-testid='shop-nav-menu']");
menu?.addEventListener("click", () => {
  menu.setAttribute(
    "aria-expanded",
    String(menu.getAttribute("aria-expanded") !== "true"),
  );
});
for (const card of document.querySelectorAll<HTMLElement>(
  "[data-card-product]",
)) {
  const item = products.find((entry) => entry.id === card.dataset.cardProduct);
  const image = card.querySelector<HTMLImageElement>("[data-card-image]");
  const controls = card.querySelectorAll<HTMLElement>("[data-card-controls]");
  if (!item || !image || !controls.length) continue;
  let color = item.images[0].color;
  let position = 0;
  const show = () => {
    const images = item.images.filter((entry) => entry.color === color);
    const selected = images[position];
    if (!selected) return;
    image.src = selected.src;
    image.srcset = selected.srcset;
    image.alt = selected.alt;
    for (const link of card.querySelectorAll<HTMLAnchorElement>(
      `a[href^="/products/${item.slug}"]`,
    )) {
      const url = new URL(`/products/${item.slug}`, location.origin);
      url.searchParams.set("color", color);
      link.href = url.pathname + url.search;
    }
    for (const button of card.querySelectorAll<HTMLButtonElement>(
      "[data-card-color]",
    ))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.cardColor === color),
      );
  };
  for (const button of card.querySelectorAll<HTMLButtonElement>(
    "[data-card-color]",
  ))
    button.addEventListener("click", () => {
      if (!button.dataset.cardColor) return;
      color = button.dataset.cardColor;
      position = 0;
      show();
    });
  for (const [selector, direction] of [
    ["[data-card-previous]", -1],
    ["[data-card-next]", 1],
  ] as const)
    card.querySelector(selector)?.addEventListener("click", () => {
      const count = item.images.filter((entry) => entry.color === color).length;
      if (!count) return;
      position = (position + direction + count) % count;
      show();
    });
  for (const control of controls) control.hidden = false;
  show();
}
function status(selector: string, message: string, error = false) {
  const target = element(selector);
  if (target) {
    target.textContent = message;
    target.classList.toggle("error", error);
  }
}
const detail = element("[data-product]");
const product = products.find((entry) => entry.id === detail?.dataset.product);
const form = element<HTMLFormElement>("[data-product-form]");
function showImage(index: number) {
  const image = product?.images[index];
  const target = element<HTMLImageElement>("[data-main-image]");
  if (!image || !target) return;
  target.src = image.src;
  target.srcset = image.srcset;
  target.alt = image.alt;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-gallery]",
  ))
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.gallery) === index),
    );
}
function showColor(color: string) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-gallery]",
  )) {
    const image = product?.images[Number(button.dataset.gallery)];
    button.hidden = image?.color !== color;
  }
  const index =
    product?.images.findIndex((image) => image.color === color) ?? -1;
  if (index >= 0) showImage(index);
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-gallery]",
))
  button.addEventListener("click", () =>
    showImage(Number(button.dataset.gallery)),
  );
form?.addEventListener("change", (event) => {
  if (
    !(event.target instanceof HTMLSelectElement) ||
    event.target.name !== "color"
  )
    return;
  const data = new FormData(form);
  const color = data.get("color");
  if (typeof color === "string") showColor(color);
});
const requestedColor = new URLSearchParams(location.search).get("color");
const colorSelect = form?.querySelector<HTMLSelectElement>(
  "select[name='color']",
);
if (
  requestedColor !== null &&
  colorSelect &&
  product?.variants.some((variant) => variant.color === requestedColor)
)
  colorSelect.value = requestedColor;
const initialColor = form && new FormData(form).get("color");
if (typeof initialColor === "string") showColor(initialColor);
function showCartLink() {
  if (!form || form.querySelector("[data-testid=product-view-cart]")) return;
  const link = document.createElement("a");
  link.href = "/cart";
  link.className = "button";
  link.dataset.testid = "product-view-cart";
  link.textContent = "View cart & checkout";
  form.append(link);
}
if (cart().length) showCartLink();
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const variant = product?.variants.find(
    (variant) =>
      variant.color === data.get("color") &&
      (!variant.size || variant.size === data.get("size")),
  );
  if (!variant)
    return status(
      "[data-product-status]",
      "Choose an available size and color.",
      true,
    );
  const quantity = Number(data.get("quantity"));
  const items = cart();
  const existing = items.find((item) => item.variantId === variant.id);
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity + (existing?.quantity ?? 0) > 10
  )
    return status(
      "[data-product-status]",
      "Please choose up to 10 of each item.",
      true,
    );
  if (existing) existing.quantity += quantity;
  else items.push({ variantId: variant.id, quantity });
  try {
    save(items);
    status("[data-product-status]", "Added to your cart.");
    showCartLink();
  } catch (error) {
    console.error(error);
    status(
      "[data-product-status]",
      "Your browser could not save the cart. Check storage permissions.",
      true,
    );
  }
});
function variantImage(match: NonNullable<ReturnType<typeof findVariant>>) {
  return (
    match.product.images.find(
      (image) =>
        image.sourceId === match.variant.imageId &&
        image.color === match.variant.color,
    ) ??
    match.product.images.find((image) => image.color === match.variant.color)
  );
}
function renderCart() {
  const container = element("[data-cart-lines]");
  if (!container) return;
  container.replaceChildren();
  let total = 0;
  const items = cart();
  if (!items.length)
    container.textContent =
      "Your cart is empty. Find your everyday favorite in the collection.";
  for (const item of items) {
    const match = findVariant(item.variantId);
    if (!match) continue;
    total += match.product.price * item.quantity;
    const line = document.createElement("article");
    line.className = "cart-line";
    line.dataset.testid = "cart-line";
    const img = document.createElement("img");
    const image = variantImage(match);
    if (image) {
      img.src = image.src;
      img.srcset = image.srcset;
      img.sizes = "80px";
    } else {
      console.error("Cart variant image is missing", {
        variantId: match.variant.id,
        color: match.variant.color,
      });
    }
    img.dataset.testid = "cart-image";
    img.alt = "";
    img.width = img.height = 80;
    const description = document.createElement("div");
    const heading = document.createElement("h2");
    const link = document.createElement("a");
    link.href = `/products/${match.product.slug}`;
    link.textContent = match.product.title;
    heading.append(link);
    const detail = document.createElement("p");
    detail.textContent = `${match.variant.title} · ${money(match.product.price)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.dataset.testid = "cart-remove";
    remove.addEventListener("click", () => {
      save(cart().filter((entry) => entry.variantId !== item.variantId));
      renderCart();
    });
    description.append(heading, detail, remove);
    const label = document.createElement("label");
    label.textContent = "Quantity";
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.min = "1";
    quantity.max = "10";
    quantity.value = String(item.quantity);
    quantity.dataset.testid = "cart-quantity";
    quantity.addEventListener("change", () => {
      const count = Number(quantity.value);
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        quantity.value = String(item.quantity);
        return status(
          "[data-cart-status]",
          "Choose a quantity between 1 and 10.",
          true,
        );
      }
      save(
        cart().map((entry) =>
          entry.variantId === item.variantId
            ? { ...entry, quantity: count }
            : entry,
        ),
      );
      renderCart();
    });
    label.append(quantity);
    line.append(img, description, label);
    container.append(line);
  }
  const subtotal = element("[data-cart-total]");
  if (subtotal) subtotal.textContent = money(total);
  const checkout = element<HTMLAnchorElement>("[data-testid=cart-checkout]");
  if (checkout) checkout.hidden = !items.length;
}
renderCart();
function checkoutTotals(shipping?: number) {
  const subtotal = cart().reduce(
    (sum, item) =>
      sum + (findVariant(item.variantId)?.product.price ?? 0) * item.quantity,
    0,
  );
  const entries = [
    ["[data-checkout-subtotal]", money(subtotal)],
    [
      "[data-checkout-shipping]",
      shipping === undefined ? "Calculated next" : money(shipping),
    ],
    ["[data-checkout-total]", money(subtotal + (shipping ?? 0))],
  ];
  for (const [selector, text] of entries) {
    const target = element(selector);
    if (target) target.textContent = text;
  }
}
function renderCheckoutSummary() {
  const container = element("[data-checkout-lines]");
  if (!container) return;
  container.replaceChildren();
  const items = cart();
  const shippingForm = element("[data-shipping-form]");
  if (shippingForm) shippingForm.hidden = !items.length;
  for (const item of items) {
    const match = findVariant(item.variantId);
    if (!match) continue;
    const line = document.createElement("article");
    line.className = "order-line";
    line.dataset.testid = "checkout-line";
    const image = variantImage(match);
    if (image) {
      const img = document.createElement("img");
      img.src = image.src;
      img.srcset = image.srcset;
      img.sizes = "64px";
      img.alt = "";
      img.width = img.height = 64;
      line.append(img);
    }
    const description = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = match.product.title;
    const details = document.createElement("p");
    details.textContent = `${match.variant.title} · Qty ${item.quantity}`;
    const price = document.createElement("p");
    price.textContent = money(match.product.price * item.quantity);
    description.append(title, details, price);
    line.append(description);
    container.append(line);
  }
  if (!items.length) {
    container.textContent =
      "Your cart is empty. Add an item before choosing shipping.";
  }
  checkoutTotals();
}
renderCheckoutSummary();
async function api(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const json = await response.json();
  if (!response.ok)
    throw new Error(json.error ?? "The request failed. Please try again.");
  return json;
}
const shippingForm = element<HTMLFormElement>("[data-shipping-form]");
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
  renderFreeShipping();
}
shippingForm?.addEventListener("input", invalidateQuote);
shippingForm?.addEventListener("change", invalidateQuote);
window.addEventListener("storage", (event) => {
  if (event.key === key) {
    invalidateQuote();
    renderCheckoutSummary();
  }
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
    for (const [index, rate] of result.rates.entries()) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "shippingId";
      radio.value = rate.id;
      radio.checked = index === 0;
      radio.addEventListener("change", () => checkoutTotals(rate.amount));
      const name = document.createElement("span");
      name.textContent = rate.name;
      const price = document.createElement("strong");
      price.textContent = rate.amount === 0 ? "Free" : money(rate.amount);
      label.append(radio, name, price);
      rates?.append(label);
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
    const shippingId = document.querySelector<HTMLInputElement>(
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
      "total-label": summary.total === null ? "Total before tax" : "Total paid",
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
