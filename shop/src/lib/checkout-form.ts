import {
  body,
  digest,
  enabled,
  equal,
  json,
  now,
  orderToken,
  rateLimit,
  sameOrigin,
  ShopError,
  type Env,
} from "./platform.ts";
import {
  cartItems,
  quoteRequest,
  recipient,
  type Order,
  type Quote,
} from "./checkout.ts";
import { shippingCountries } from "./shipping-countries.ts";
import { stripe } from "./providers.ts";
const stripeUnsupportedCountries = new Set(["CX", "CC", "HM", "NF"]);
export const checkoutShippingCountries = (productIds: string[]) =>
  shippingCountries(productIds).filter(
    (country) => !stripeUnsupportedCountries.has(country.code),
  );

export const FORM_API_VERSION = "2026-10-28.endive";
interface FormSession {
  id: string;
  client_secret: string | null;
  status: string;
  payment_status: string;
  metadata: Record<string, string>;
  shipping_options: { shipping_rate: string }[];
  payment_intent?: string | null;
}
interface FormOrder extends Order {
  revision: number;
  address_hash: string;
  quote_expires_at: number;
}
export function formRecipient(value: unknown) {
  if (!value || typeof value !== "object")
    throw new ShopError("Complete your shipping address in Stripe.");
  const form = value as Record<string, unknown>;
  const shipping = form.shippingAddress;
  const customer = form.customerDetails;
  if (
    !shipping ||
    typeof shipping !== "object" ||
    !customer ||
    typeof customer !== "object"
  )
    throw new ShopError(
      "Complete your contact and shipping details in Stripe.",
    );
  const contact = shipping as Record<string, unknown>;
  if (!contact.address || typeof contact.address !== "object")
    throw new ShopError("Complete your shipping address in Stripe.");
  const address = contact.address as Record<string, unknown>;
  return recipient({
    name: contact.name,
    email: (customer as Record<string, unknown>).email,
    address1: address.line1,
    address2: address.line2 ?? "",
    city: address.city,
    state_code: address.state ?? "",
    country_code: address.country,
    zip: address.postal_code ?? "",
  });
}
export async function createFormRequest(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  await rateLimit(request, env);
  const publishable = env.STRIPE_PUBLISHABLE_KEY;
  if (
    !publishable ||
    !new RegExp(`^pk_${env.SHOP_MODE === "live" ? "live" : "test"}_`).test(
      publishable,
    )
  )
    throw new ShopError("Secure checkout is not configured.", 503);
  const data = await body(request);
  const cart = cartItems(data.items);
  const countries = checkoutShippingCountries(
    cart.map((item) => item.product.id),
  );
  if (!countries.length)
    throw new ShopError("These products cannot ship together.");
  const id = crypto.randomUUID().replaceAll("-", "");
  const quoteId = crypto.randomUUID();
  const time = now();
  const quote: Quote = {
    checkoutForm: true,
    recipient: {
      name: "",
      email: "",
      address1: "",
      address2: "",
      city: "",
      state_code: "",
      country_code: "",
      zip: "",
    },
    rates: [],
    items: cart.map((item) => ({
      variantId: item.variant.id,
      quantity: item.quantity,
      title: `${item.product.title} / ${item.variant.title}`,
      price: item.product.price,
      variant_id: 0,
      placements: [],
    })),
    subtotal: cart.reduce(
      (sum, item) => sum + item.product.price * item.quantity,
      0,
    ),
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO quotes(id,snapshot,expires_at) VALUES (?,?,?)",
    ).bind(quoteId, JSON.stringify(quote), time + 3600),
    env.DB.prepare(
      "INSERT INTO orders(id,quote_id,shipping_id,snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(id, quoteId, "", JSON.stringify(quote), time, time),
    env.DB.prepare("INSERT INTO checkout_forms(order_id) VALUES (?)").bind(id),
  ]);
  const token = await orderToken(env, id);
  const params = new URLSearchParams({
    mode: "payment",
    ui_mode: "form",
    return_url: `${env.SHOP_ORIGIN}/order#token=${encodeURIComponent(token)}`,
    expires_at: String(time + 3600),
    "automatic_tax[enabled]": "true",
    "adaptive_pricing[enabled]": "false",
    "metadata[app]": "bascik-shop",
    "metadata[order_id]": id,
    "metadata[shop_origin]": env.SHOP_ORIGIN,
    "payment_intent_data[metadata][app]": "bascik-shop",
    "payment_intent_data[metadata][order_id]": id,
    "shipping_options[0][shipping_rate_data][type]": "fixed_amount",
    "shipping_options[0][shipping_rate_data][display_name]":
      "Enter your address to calculate shipping",
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]": "0",
    "shipping_options[0][shipping_rate_data][fixed_amount][currency]": "usd",
    "shipping_options[0][shipping_rate_data][tax_behavior]": "exclusive",
    "shipping_options[0][shipping_rate_data][tax_code]": "txcd_92010001",
  });
  countries.forEach((country, index) =>
    params.set(
      `shipping_address_collection[allowed_countries][${index}]`,
      country.code,
    ),
  );
  cart.forEach((item, index) => {
    const prefix = `line_items[${index}]`;
    params.set(`${prefix}[price_data][currency]`, "usd");
    params.set(
      `${prefix}[price_data][unit_amount]`,
      String(item.product.price),
    );
    params.set(`${prefix}[price_data][tax_behavior]`, "exclusive");
    params.set(
      `${prefix}[price_data][product_data][name]`,
      `${item.product.title} / ${item.variant.title}`,
    );
    params.set(
      `${prefix}[price_data][product_data][tax_code]`,
      item.product.slug.includes("hat") ? env.TAX_CODE_HAT : env.TAX_CODE_SHIRT,
    );
    params.set(`${prefix}[quantity]`, String(item.quantity));
  });
  try {
    const session = await stripe<FormSession>(
      env,
      "/checkout/sessions",
      params,
      `form:${id}`,
      FORM_API_VERSION,
    );
    if (!session.id || !session.client_secret)
      throw new ShopError("Invalid secure checkout response.", 502);
    await env.DB.prepare(
      "UPDATE orders SET stripe_session=? WHERE id=? AND status='pending'",
    )
      .bind(session.id, id)
      .run();
    return json({
      clientSecret: session.client_secret,
      publishableKey: publishable,
      token,
    });
  } catch (error) {
    await env.DB.prepare(
      "UPDATE orders SET status='expired',updated_at=? WHERE id=? AND status='pending'",
    )
      .bind(now(), id)
      .run();
    throw error;
  }
}
async function formOrder(env: Env, data: Record<string, unknown>) {
  const token = data.token;
  if (typeof token !== "string" || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token))
    throw new ShopError("Checkout not found.", 404);
  const id = token.split(".")[0];
  if (!equal(token, await orderToken(env, id)))
    throw new ShopError("Checkout not found.", 404);
  const order = await env.DB.prepare(
    "SELECT orders.*,checkout_forms.revision,checkout_forms.address_hash,quotes.expires_at AS quote_expires_at FROM orders JOIN checkout_forms ON checkout_forms.order_id=orders.id JOIN quotes ON quotes.id=orders.quote_id WHERE orders.id=? AND token_revoked=0",
  )
    .bind(id)
    .first<FormOrder>();
  if (!order || !order.stripe_session)
    throw new ShopError("Checkout not found.", 404);
  if (order.status !== "pending" || order.created_at + 3600 <= now())
    throw new ShopError(
      "Checkout expired or completed. Return to your cart.",
      409,
    );
  return order;
}
async function lock(env: Env, order: FormOrder) {
  const lease = await env.DB.prepare(
    "UPDATE checkout_forms SET lease_until=? WHERE order_id=? AND lease_until<=? RETURNING order_id",
  )
    .bind(now() + 60, order.id, now())
    .first();
  if (!lease)
    throw new ShopError("Shipping is updating. Please try again.", 409);
}
async function openSession(env: Env, order: FormOrder) {
  const session = await stripe<FormSession>(
    env,
    `/checkout/sessions/${order.stripe_session}`,
    undefined,
    undefined,
    FORM_API_VERSION,
  );
  if (
    session.id !== order.stripe_session ||
    session.status !== "open" ||
    session.payment_status !== "unpaid" ||
    session.metadata?.order_id !== order.id ||
    session.metadata.app !== "bascik-shop" ||
    session.metadata.shop_origin !== env.SHOP_ORIGIN
  )
    throw new ShopError(
      "Checkout expired or completed. Return to your cart.",
      409,
    );
  if (session.payment_intent) {
    const intent = await stripe<{ status: string }>(
      env,
      `/payment_intents/${session.payment_intent}`,
      undefined,
      undefined,
      FORM_API_VERSION,
    );
    if (
      !["requires_payment_method", "requires_confirmation"].includes(
        intent.status,
      )
    )
      throw new ShopError(
        "Payment is already processing. Check your order status.",
        409,
      );
  }
  return session;
}
export async function updateFormShipping(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  const data = await body(request);
  const order = await formOrder(env, data);
  if (
    !Number.isSafeInteger(data.revision) ||
    Number(data.revision) <= order.revision
  )
    throw new ShopError("Shipping update is stale. Please try again.", 409);
  const address = formRecipient(data.value);
  const prior: Quote = JSON.parse(order.snapshot);
  const cart = prior.items.map((item) => ({
    variantId: item.variantId,
    quantity: item.quantity,
  }));
  if (
    !checkoutShippingCountries(
      cartItems(cart).map((item) => item.product.id),
    ).some((country) => country.code === address.country_code)
  )
    throw new ShopError("This checkout cannot ship this cart to that country.");
  await lock(env, order);
  try {
    const fresh = await formOrder(env, data);
    if (Number(data.revision) <= fresh.revision || fresh.shipping_id)
      throw new ShopError(
        "Checkout is confirming or this shipping update is stale.",
        409,
      );
    await openSession(env, order);
    const response = await quoteRequest(
      new Request(`${env.SHOP_ORIGIN}/api/quote`, {
        method: "POST",
        headers: {
          origin: env.SHOP_ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip":
            request.headers.get("cf-connecting-ip") ?? "local",
          "cf-ray": request.headers.get("cf-ray") ?? "",
        },
        body: JSON.stringify({ items: cart, recipient: address }),
      }),
      env,
    );
    const result = (await response.json()) as { quoteId: string };
    const row = await env.DB.prepare("SELECT snapshot FROM quotes WHERE id=?")
      .bind(result.quoteId)
      .first<{ snapshot: string }>();
    if (!row) throw new ShopError("Shipping quote was not saved.", 503);
    const quote: Quote = JSON.parse(row.snapshot);
    quote.checkoutForm = true;
    quote.items = quote.items.map((item) => {
      const frozen = prior.items.find(
        (original) =>
          original.variantId === item.variantId &&
          original.quantity === item.quantity,
      );
      if (!frozen)
        throw new ShopError("Checkout cart changed. Return to your cart.", 409);
      return { ...item, price: frozen.price, title: frozen.title };
    });
    quote.subtotal = prior.subtotal;
    const params = new URLSearchParams();
    quote.rates.slice(0, 5).forEach((rate, index) => {
      const prefix = `shipping_options[${index}][shipping_rate_data]`;
      params.set(`${prefix}[type]`, "fixed_amount");
      params.set(`${prefix}[display_name]`, rate.name);
      params.set(`${prefix}[fixed_amount][amount]`, String(rate.amount));
      params.set(`${prefix}[fixed_amount][currency]`, "usd");
      params.set(`${prefix}[tax_behavior]`, "exclusive");
      params.set(`${prefix}[tax_code]`, "txcd_92010001");
    });
    const session = await stripe<FormSession>(
      env,
      `/checkout/sessions/${order.stripe_session}`,
      params,
      `shipping:${order.id}:${data.revision}`,
      FORM_API_VERSION,
    );
    quote.rates = quote.rates.slice(0, 5).map((rate, index) => {
      const stripeRateId = session.shipping_options?.[index]?.shipping_rate;
      if (!stripeRateId || !/^shr_/.test(stripeRateId))
        throw new ShopError("Invalid Stripe shipping options.", 502);
      return { ...rate, stripeRateId };
    });
    const hash = await digest(JSON.stringify(address));
    await env.DB.batch([
      env.DB.prepare("UPDATE quotes SET snapshot=? WHERE id=?").bind(
        JSON.stringify(quote),
        result.quoteId,
      ),
      env.DB.prepare(
        "UPDATE orders SET quote_id=?,snapshot=?,shipping_id='',updated_at=? WHERE id=? AND status='pending'",
      ).bind(result.quoteId, JSON.stringify(quote), now(), order.id),
      env.DB.prepare(
        "UPDATE checkout_forms SET revision=?,address_hash=? WHERE order_id=?",
      ).bind(data.revision, hash, order.id),
    ]);
    console.info("Shop shipping options updated", {
      orderId: order.id,
      revision: data.revision,
      rateCount: quote.rates.length,
    });
    return json({ revision: data.revision });
  } finally {
    await env.DB.prepare(
      "UPDATE checkout_forms SET lease_until=0 WHERE order_id=?",
    )
      .bind(order.id)
      .run();
  }
}
export async function resetFormRequest(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  await rateLimit(request, env);
  const data = await body(request);
  const order = await formOrder(env, data);
  await lock(env, order);
  try {
    await openSession(env, order);
    await env.DB.prepare(
      "UPDATE orders SET shipping_id='' WHERE id=? AND status='pending'",
    )
      .bind(order.id)
      .run();
    return json({ reset: true });
  } finally {
    await env.DB.prepare(
      "UPDATE checkout_forms SET lease_until=0 WHERE order_id=?",
    )
      .bind(order.id)
      .run();
  }
}
export async function confirmFormRequest(request: Request, env: Env) {
  sameOrigin(request, env);
  enabled(env);
  await rateLimit(request, env);
  const data = await body(request);
  const order = await formOrder(env, data);
  await lock(env, order);
  try {
    const fresh = await formOrder(env, data);
    const address = formRecipient(data.value);
    if (
      data.revision !== fresh.revision ||
      fresh.revision === 0 ||
      fresh.quote_expires_at <= now() ||
      (await digest(JSON.stringify(address))) !== fresh.address_hash
    )
      throw new ShopError(
        "Your address changed. Wait for a fresh shipping quote.",
        409,
      );
    const session = await openSession(env, order);
    const quote: Quote = JSON.parse(fresh.snapshot);
    const rate = quote.rates.find(
      (rate) => rate.stripeRateId === data.shippingRateId,
    );
    if (
      !rate ||
      !session.shipping_options?.some(
        (option) => option.shipping_rate === rate.stripeRateId,
      )
    )
      throw new ShopError("Choose a current shipping option.", 409);
    await env.DB.prepare(
      "UPDATE orders SET shipping_id=?,updated_at=? WHERE id=? AND status='pending'",
    )
      .bind(rate.id, now(), order.id)
      .run();
    console.info("Shop checkout ready for confirmation", {
      orderId: order.id,
      revision: data.revision,
      shippingId: rate.id,
    });
    return json({ ready: true });
  } finally {
    await env.DB.prepare(
      "UPDATE checkout_forms SET lease_until=0 WHERE order_id=?",
    )
      .bind(order.id)
      .run();
  }
}
