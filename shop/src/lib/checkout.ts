import { findVariant, type Product, type Variant } from "./catalog.ts";
import countries from "../../catalog/countries.json" with { type: "json" };
import {
  ShopError,
  body,
  enabled,
  sameOrigin,
  now,
  orderToken,
  rateLimit,
  json,
  type Env,
} from "./platform.ts";
import { cents, printful, stripe } from "./providers.ts";
import { qualifiesForFreeShipping } from "./free-shipping.ts";
import {
  placements,
  shippingPlacements,
  type PrintfulPlacement,
  type PrintfulShippingPlacement,
} from "./printful-design.ts";

export interface Recipient {
  name: string;
  email: string;
  address1: string;
  address2: string;
  city: string;
  state_code: string;
  country_code: string;
  zip: string;
}
interface ItemDetails {
  variantId: string;
  quantity: number;
  price: number;
  title: string;
  variant_id: number;
}
export type Item = ItemDetails &
  (
    | {
        product_template_id: number;
        shipping_placements: PrintfulShippingPlacement[];
        placements?: never;
      }
    | {
        product_template_id?: never;
        shipping_placements?: never;
        placements: PrintfulPlacement[];
      }
  );
export interface Rate {
  id: string;
  name: string;
  amount: number;
  currency: string;
}
export interface Quote {
  items: Item[];
  recipient: Recipient;
  rates: Rate[];
  subtotal: number;
}
export interface Order {
  id: string;
  quote_id: string;
  shipping_id: string;
  snapshot: string;
  status: string;
  stripe_session: string | null;
  printful_id: number | null;
  shipments: string;
  token_revoked: number;
  created_at: number;
  updated_at: number;
  lease_until: number;
  attempts: number;
  retry_at: number;
  payment_tax: number | null;
  payment_total: number | null;
  last_error: string | null;
  printful_status: string | null;
  stripe_payment_intent: string | null;
  refund_amount: number;
  refund_state: string;
  refund_checked_at: number;
  reconciliation_attempts: number;
  reconciliation_lease: number;
  reconciliation_at: number;
  cancellation_at: number | null;
}
export function recipient(value: unknown): Recipient {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ShopError("Enter your delivery details.");
  const data = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of [
    "name",
    "email",
    "address1",
    "address2",
    "city",
    "state_code",
    "country_code",
    "zip",
  ]) {
    const text = data[key] ?? "";
    if (
      typeof text !== "string" ||
      text.length > 200 ||
      /[\u0000-\u001f]/.test(text)
    )
      throw new ShopError("Invalid delivery details.");
    result[key] = text.trim();
  }
  result.country_code = result.country_code.toUpperCase();
  // Stripe omits the city input for Singapore, a city-state.
  if (result.country_code === "SG" && !result.city) result.city = "Singapore";
  for (const key of ["name", "email", "address1", "city", "country_code"])
    if (!result[key])
      throw new ShopError("Complete all required delivery fields.");
  if (
    !/^[A-Z]{2}$/.test(result.country_code) ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result.email)
  )
    throw new ShopError("Enter a valid country and email address.");
  if (
    ["US", "CA", "AU"].includes(result.country_code) &&
    (!result.state_code || !result.zip)
  )
    throw new ShopError(
      "State/province and postal code are required for this country.",
    );
  if (result.country_code === "SG" && !result.zip)
    throw new ShopError("Postal code is required for Singapore.");
  const region = countries.find(
    (country) => country.code === result.country_code,
  );
  if (result.state_code && region?.states?.length) {
    const input = result.state_code.toLocaleLowerCase("en");
    const state = region.states.find(
      (state) =>
        state.code.toLocaleLowerCase("en") === input ||
        state.name.toLocaleLowerCase("en") === input,
    );
    if (!state)
      throw new ShopError(
        `Enter a valid state/province name or code for ${region.name}.`,
      );
    result.state_code = state.code;
  }
  return {
    name: result.name,
    email: result.email,
    address1: result.address1,
    address2: result.address2,
    city: result.city,
    state_code: result.state_code,
    country_code: result.country_code,
    zip: result.zip,
  };
}
export function cartItems(
  value: unknown,
): { product: Product; variant: Variant; quantity: number }[] {
  if (!Array.isArray(value) || !value.length || value.length > 24)
    throw new ShopError("Add at least one product to your cart.");
  const seen = new Set<string>();
  let total = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.variantId !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10 ||
      seen.has(item.variantId)
    )
      throw new ShopError("Invalid cart. Choose up to 10 of each variant.");
    seen.add(item.variantId);
    total += item.quantity;
    if (total > 20)
      throw new ShopError("Please order at most 20 items at a time.");
    const match = findVariant(item.variantId);
    if (!match) throw new ShopError("That product is not in this collection.");
    return { ...match, quantity: item.quantity };
  });
}
export const printfulItems = (quote: Quote) =>
  quote.items.map((item) => {
    if (
      item.product_template_id !== undefined &&
      (!Number.isSafeInteger(item.product_template_id) ||
        item.product_template_id <= 0)
    )
      throw new ShopError("Invalid Printful template reference.", 503);
    return {
      catalog_variant_id: item.variant_id,
      ...(item.product_template_id !== undefined
        ? {
            source: "product_template",
            product_template_id: item.product_template_id,
          }
        : { source: "catalog", placements: placements(item.placements) }),
      quantity: item.quantity,
      retail_price: (item.price / 100).toFixed(2),
    };
  });
export const printfulShippingItems = (quote: Quote) =>
  quote.items.map((item) => ({
    source: "catalog",
    catalog_variant_id: item.variant_id,
    quantity: item.quantity,
    retail_price: (item.price / 100).toFixed(2),
    placements:
      item.product_template_id !== undefined
        ? shippingPlacements(item.shipping_placements)
        : placements(item.placements),
  }));
export async function quoteRequest(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  await rateLimit(request, env);
  const data = await body(request);
  const address = recipient(data.recipient);
  const cart = cartItems(data.items);
  console.info("Shop shipping quote requested", {
    requestId: request.headers.get("cf-ray"),
    country: address.country_code,
    state: address.state_code,
    items: cart.map((item) => ({
      productId: item.product.id,
      variantId: item.variant.id,
      variant: item.variant.title,
      quantity: item.quantity,
    })),
  });
  const items: Item[] = [];
  for (const entry of cart) {
    const template = await env.DB.prepare(
      "SELECT catalog_variant_id,product_template_id,shipping_placements FROM printful_template_mappings WHERE variant_id=? AND store_id=? AND verified=1",
    )
      .bind(entry.variant.id, Number(env.PRINTFUL_STORE_ID))
      .first<{
        catalog_variant_id: number;
        product_template_id: number;
        shipping_placements: string;
      }>();
    if (template) {
      if (
        !Number.isSafeInteger(template.catalog_variant_id) ||
        template.catalog_variant_id <= 0 ||
        !Number.isSafeInteger(template.product_template_id) ||
        template.product_template_id <= 0
      )
        throw new ShopError("Invalid Printful template mapping.", 503);
      items.push({
        variantId: entry.variant.id,
        quantity: entry.quantity,
        price: entry.product.price,
        title: `${entry.product.title} / ${entry.variant.title}`,
        variant_id: template.catalog_variant_id,
        product_template_id: template.product_template_id,
        shipping_placements: shippingPlacements(
          JSON.parse(template.shipping_placements),
        ),
      });
      continue;
    }
    const mapping = await env.DB.prepare(
      "SELECT placements, catalog_variant_id FROM printful_v2_mappings WHERE variant_id=? AND verified=1",
    )
      .bind(entry.variant.id)
      .first<{ placements: string; catalog_variant_id: number }>();
    if (
      !mapping ||
      !Number.isSafeInteger(mapping.catalog_variant_id) ||
      mapping.catalog_variant_id <= 0
    )
      throw new ShopError("This item is not ready for ordering yet.", 503);
    items.push({
      variantId: entry.variant.id,
      quantity: entry.quantity,
      price: entry.product.price,
      title: `${entry.product.title} / ${entry.variant.title}`,
      variant_id: mapping.catalog_variant_id,
      placements: placements(JSON.parse(mapping.placements)),
    });
  }
  const quote: Quote = {
    recipient: address,
    items,
    rates: [],
    subtotal: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
  };
  const rates = await printful<
    {
      shipping: string;
      shipping_method_name: string;
      rate: string;
      currency: string;
    }[]
  >(env, "/shipping-rates", {
    recipient: address,
    order_items: printfulShippingItems(quote),
    currency: "USD",
  });
  if (!Array.isArray(rates) || !rates.length)
    throw new ShopError("Printful cannot ship this cart to that address.");
  const shippingRates = rates.map((rate) => {
    if (
      rate.currency !== "USD" ||
      typeof rate.shipping !== "string" ||
      typeof rate.shipping_method_name !== "string"
    )
      throw new ShopError("Invalid shipping response.", 502);
    const amount = cents(rate.rate);
    return {
      id: rate.shipping,
      name: rate.shipping_method_name,
      amount,
      currency: "usd",
    };
  });
  const cheapest = shippingRates.reduce((cheapest, rate) =>
    rate.amount < cheapest.amount ||
    (rate.amount === cheapest.amount && rate.id === "STANDARD")
      ? rate
      : cheapest,
  );
  const eligible = qualifiesForFreeShipping(
    quote.subtotal,
    address.country_code,
    address.state_code,
  );
  quote.rates = shippingRates.map((rate) =>
    eligible && rate === cheapest
      ? { ...rate, amount: 0, name: `Free shipping - ${rate.name}` }
      : rate,
  );
  const id = crypto.randomUUID();
  const expiresAt = now() + 900;
  await env.DB.prepare(
    "INSERT INTO quotes(id,snapshot,expires_at) VALUES (?,?,?)",
  )
    .bind(id, JSON.stringify(quote), expiresAt)
    .run();
  return json({
    quoteId: id,
    expiresAt,
    rates: quote.rates,
    subtotal: quote.subtotal,
    currency: "usd",
  });
}
export async function checkoutRequest(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  await rateLimit(request, env);
  const data = await body(request);
  if (typeof data.quoteId !== "string" || typeof data.shippingId !== "string")
    throw new ShopError("Choose a shipping quote.");
  const row = await env.DB.prepare(
    "SELECT snapshot,expires_at FROM quotes WHERE id=?",
  )
    .bind(data.quoteId)
    .first<{ snapshot: string; expires_at: number }>();
  if (!row || row.expires_at <= now())
    throw new ShopError("Shipping quote expired. Request a new quote.");
  const quote: Quote = JSON.parse(row.snapshot);
  const rate = quote.rates.find((entry) => entry.id === data.shippingId);
  if (!rate) throw new ShopError("Invalid shipping selection.");
  // Printful external references have a 32-character limit.
  const id = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO orders(id,quote_id,shipping_id,snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, data.quoteId, rate.id, row.snapshot, now(), now())
    .run();
  const order = await env.DB.prepare("SELECT * FROM orders WHERE quote_id=?")
    .bind(data.quoteId)
    .first<Order>();
  if (!order || order.shipping_id !== rate.id)
    throw new ShopError(
      "Request a new quote to change the shipping service.",
      409,
    );
  if (order.status !== "pending")
    throw new ShopError("This checkout has already been paid.", 409);
  if (order.stripe_session) {
    const session = await stripe<{ url: string | null; status: string }>(
      env,
      `/checkout/sessions/${encodeURIComponent(order.stripe_session)}`,
    );
    if (session.status !== "open" || !session.url)
      throw new ShopError(
        "Checkout expired or completed. Request a new quote.",
      );
    return json({ url: session.url });
  }
  const address = quote.recipient;
  const customerParams = new URLSearchParams({
    email: address.email,
    name: address.name,
    "shipping[name]": address.name,
    "shipping[address][line1]": address.address1,
    "shipping[address][line2]": address.address2,
    "shipping[address][city]": address.city,
    "shipping[address][state]": address.state_code,
    "shipping[address][country]": address.country_code,
    "shipping[address][postal_code]": address.zip,
    "metadata[app]": "bascik-shop",
    "metadata[order_id]": order.id,
  });
  const customer = await stripe<{ id: string }>(
    env,
    "/customers",
    customerParams,
    `customer:${order.id}`,
  );
  const token = await orderToken(env, order.id);
  const params = new URLSearchParams({
    mode: "payment",
    customer: customer.id,
    success_url: `${env.SHOP_ORIGIN}/order#token=${encodeURIComponent(token)}`,
    cancel_url: `${env.SHOP_ORIGIN}/checkout`,
    expires_at: String(order.created_at + 3600),
    "automatic_tax[enabled]": "true",
    "metadata[app]": "bascik-shop",
    "metadata[order_id]": order.id,
    "metadata[shop_origin]": env.SHOP_ORIGIN,
    "payment_intent_data[receipt_email]": address.email,
    "payment_intent_data[metadata][app]": "bascik-shop",
    "payment_intent_data[metadata][order_id]": order.id,
    "custom_text[submit][message]": `Deliver to ${address.name}, ${address.address1}, ${address.address2}, ${address.city}, ${address.state_code} ${address.zip}, ${address.country_code}. Return to the shop to change delivery details.`,
    "shipping_options[0][shipping_rate_data][type]": "fixed_amount",
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]": String(
      rate.amount,
    ),
    "shipping_options[0][shipping_rate_data][fixed_amount][currency]": "usd",
    "shipping_options[0][shipping_rate_data][display_name]": rate.name,
    "shipping_options[0][shipping_rate_data][tax_behavior]": "exclusive",
    "shipping_options[0][shipping_rate_data][tax_code]": "txcd_92010001",
  });
  quote.items.forEach((item, index) => {
    params.set(`line_items[${index}][price_data][currency]`, "usd");
    params.set(
      `line_items[${index}][price_data][unit_amount]`,
      String(item.price),
    );
    params.set(`line_items[${index}][price_data][tax_behavior]`, "exclusive");
    params.set(
      `line_items[${index}][price_data][product_data][name]`,
      item.title,
    );
    params.set(
      `line_items[${index}][price_data][product_data][tax_code]`,
      findVariant(item.variantId)?.product.taxCode ??
        (findVariant(item.variantId)?.product.slug.includes("hat")
          ? env.TAX_CODE_HAT
          : env.TAX_CODE_SHIRT),
    );
    params.set(`line_items[${index}][quantity]`, String(item.quantity));
  });
  const session = await stripe<{ id: string; url: string }>(
    env,
    "/checkout/sessions",
    params,
    `checkout:${order.id}`,
  );
  if (!session.url?.startsWith("https://checkout.stripe.com/"))
    throw new ShopError("Invalid checkout response.", 502);
  await env.DB.prepare("UPDATE orders SET stripe_session=? WHERE id=?")
    .bind(session.id, order.id)
    .run();
  return json({ url: session.url });
}
