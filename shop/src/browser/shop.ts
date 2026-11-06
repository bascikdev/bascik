import { products, findVariant, money } from "../lib/catalog.ts";
import countries from "../../catalog/countries.json" with { type: "json" };

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
const initialColor = form && new FormData(form).get("color");
if (typeof initialColor === "string") showColor(initialColor);
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
  } catch (error) {
    console.error(error);
    status(
      "[data-product-status]",
      "Your browser could not save the cart. Check storage permissions.",
      true,
    );
  }
});
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
    img.src = match.product.images[0].src;
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
  for (const item of [...countries].sort((a, b) =>
    a.name.localeCompare(b.name),
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
    if (zip) zip.required = ["US", "CA", "AU"].includes(country.value);
  });
}
let quoteId: string | undefined;
shippingForm?.addEventListener("input", () => {
  quoteId = undefined;
  const section = element("[data-rates-section]");
  if (section) section.hidden = true;
});
shippingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = shippingForm.querySelector("button");
  if (button) button.disabled = true;
  status("[data-checkout-status]", "Checking availability and shipping...");
  try {
    const result = await api("/api/quote", {
      items: cart(),
      recipient: Object.fromEntries(new FormData(shippingForm)),
    });
    quoteId = result.quoteId;
    const rates = element("[data-rates]");
    rates?.replaceChildren();
    for (const [index, rate] of result.rates.entries()) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "shippingId";
      radio.value = rate.id;
      radio.checked = index === 0;
      label.append(radio, `${rate.name} · ${money(rate.amount)}`);
      rates?.append(label);
    }
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
    if (!quoteId || !shippingId)
      return status(
        "[data-checkout-status]",
        "Request a fresh shipping quote first.",
        true,
      );
    target.disabled = true;
    try {
      const result = await api("/api/checkout", { quoteId, shippingId });
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
          failed: "Your order needs attention. Our team has been notified.",
          shipped: "Your order has shipped.",
          cancelled: "Your order was cancelled.",
        };
        status(
          "[data-order-status]",
          labels[order.status] ?? "Checking fulfillment status.",
        );
        if (order.paymentConfirmed === true) {
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
          ["pending", "paid", "submitting"].includes(order.status) &&
          ++attempts < 30
        )
          setTimeout(check, 3000);
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
