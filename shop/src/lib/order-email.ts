import { esc as e } from "@bascik/bascik/html";
import { money } from "./catalog.ts";
import type { OrderSummary } from "./order-summary.ts";

export function orderEmail(
  summary: OrderSummary,
  link: string,
  supportEmail: string,
  shipment: boolean,
) {
  const logo = new URL("/assets/bascik-email-logo.png", link).href;
  const title = shipment ? "Shipment update" : "Thank you for your order.";
  const subject = shipment
    ? `Shipment update for ${summary.reference}`
    : `Order confirmation: ${summary.reference}`;
  const totals = [
    ["Subtotal", money(summary.subtotal)],
    [`Shipping (${summary.shippingService})`, money(summary.shipping)],
    ...(summary.tax === null || summary.total === null
      ? [["Tax and final payment total", "See your Stripe receipt"]]
      : [
          ["Tax", money(summary.tax)],
          ["Total paid", money(summary.total)],
        ]),
  ];
  const text = `${title}\n\nOrder number: ${summary.reference}\nPlaced: ${summary.placedAt}\n\n${summary.items.map((item) => `${item.quantity} x ${item.title}: ${money(item.price * item.quantity)}`).join("\n")}\n\n${totals.map(([label, value]) => `${label}: ${value}`).join("\n")}\nAll amounts in USD.\n\nOrder status, printable confirmation, and tracking: ${link}\n\nKeep this private link for your order only. Stripe payment receipts are separate; contact us if you need a copy.\n\nQuestions? ${supportEmail}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title></head><body style="margin:0;padding:0;background-color:#f2f3f0;color:#18191b;font-family:Arial,Helvetica,sans-serif;line-height:1.6"><table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f2f3f0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#ffffff"><tr><td style="padding:28px;background-color:#18191b"><img src="${e(logo)}" alt="Bascik" width="228" height="56" style="display:block;max-width:100%;height:auto;border:0;color:#d3ff8d"><p style="margin:12px 0 0;color:#f0f1f2;font-size:13px;letter-spacing:1px">THE BASCIK COLLECTION</p></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 12px;font-size:26px;line-height:1.3">${e(title)}</h1><p style="margin:0 0 20px;color:#4a505b">${shipment ? "Check your private order page for the latest fulfillment and tracking details." : "Your payment is confirmed. You can check your order status using the link below."}</p><p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:1px;color:#4a505b">ORDER NUMBER</p><p style="margin:4px 0 20px;font-family:monospace;font-size:13px;overflow-wrap:anywhere;word-break:break-all">${e(summary.reference)}</p><p style="margin:0 0 20px;font-size:13px;color:#4a505b">Placed ${e(new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(summary.placedAt)))}</p><table aria-label="Purchased items" style="width:100%;border-collapse:collapse">${summary.items.map((item) => `<tr><td style="padding:16px 0;border-bottom:1px solid #dce0d7;font-size:14px"><strong>${e(item.title)}</strong><br><span style="color:#4a505b">Quantity: ${item.quantity} &middot; ${e(money(item.price))} each</span></td><td style="padding:16px 0 16px 12px;border-bottom:1px solid #dce0d7;text-align:right;vertical-align:top;white-space:nowrap;font-size:14px">${e(money(item.price * item.quantity))}</td></tr>`).join("")}</table><table aria-label="Order totals" style="width:100%;border-collapse:collapse;margin-top:12px">${totals.map(([label, value]) => `<tr><th scope="row" style="padding:6px 0;text-align:left;font-size:14px;font-weight:${label === "Total paid" ? "bold" : "normal"}">${e(label)}</th><td style="padding:6px 0 6px 12px;text-align:right;font-size:14px;font-weight:${label === "Total paid" ? "bold" : "normal"}">${e(value)}</td></tr>`).join("")}</table><p style="margin:8px 0 24px;font-size:12px;color:#4a505b">All amounts in USD.</p><a href="${e(link)}" style="display:inline-block;padding:12px 20px;border-radius:4px;background-color:#d3ff8d;color:#18191b;font-size:15px;font-weight:bold;text-decoration:none">View order &amp; print confirmation</a><p style="margin:20px 0 0;font-size:12px;color:#4a505b">This link is private. Keep it to check your order and tracking. Stripe payment receipts are separate.</p></td></tr><tr><td style="padding:20px 28px;border-top:1px solid #dce0d7;background-color:#f2f3f0;font-size:13px;color:#4a505b">Questions about your order? <a href="mailto:${e(supportEmail)}" style="color:#35550c">${e(supportEmail)}</a><br>Thanks for supporting Bascik.</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}
