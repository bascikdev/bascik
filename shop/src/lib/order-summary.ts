import type { Order, Quote } from "./checkout.ts";

export function orderReference(id: string) {
  return `BASCIK-${id.toUpperCase()}`;
}

export function orderSummary(order: Order, quote: Quote) {
  const shipping = quote.rates.find((rate) => rate.id === order.shipping_id);
  if (!shipping) throw new Error("Order shipping service missing");
  return {
    reference: orderReference(order.id),
    placedAt: new Date(order.created_at * 1000).toISOString(),
    items: quote.items.map((item) => ({
      variantId: item.variantId,
      title: item.title,
      quantity: item.quantity,
      price: item.price,
    })),
    subtotal: quote.subtotal,
    shipping: shipping.amount,
    shippingService: shipping.name,
    tax: order.payment_tax ?? null,
    total: order.payment_total ?? null,
  };
}

export type OrderSummary = ReturnType<typeof orderSummary>;
