import { spawnSync } from "node:child_process";
import type { Order } from "../src/lib/checkout.ts";
import { refundPayment, canceledPrintfulOrder } from "../src/lib/refunds.ts";
import { stripe } from "../src/lib/providers.ts";
import { now } from "../src/lib/platform.ts";

const args = process.argv.slice(2);
const [flag, id, applyFlag, confirmFlag, confirmed] = args;
const apply = args.length === 5 && applyFlag === "--apply";
if (
  flag !== "--order" ||
  !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(id ?? "") ||
  !(
    args.length === 2 ||
    (apply && confirmFlag === "--confirm" && confirmed === id)
  )
)
  throw new Error(
    "Usage: --order ID [--apply --confirm ID]. Dry-run is the default.",
  );
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PRINTFUL_TOKEN = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
const expectedAccount = process.env.STRIPE_ACCOUNT;
if (
  !STRIPE_SECRET_KEY ||
  !/^(sk|rk)_live_/.test(STRIPE_SECRET_KEY) ||
  !PRINTFUL_TOKEN ||
  !expectedAccount
)
  throw new Error(
    "Load the production environment with live Stripe, Printful and expected account credentials.",
  );
const env = {
  STRIPE_SECRET_KEY,
  PRINTFUL_TOKEN,
  PRINTFUL_STORE_ID: "19022802",
  SHOP_ORIGIN: "https://shop.bascik.dev",
};
if ((await stripe<{ id: string }>(env, "/account")).id !== expectedAccount)
  throw new Error("Wrong production Stripe account.");
function execute(command: string) {
  const result = spawnSync(
    "yarn",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--config",
      ".output/wrangler.production.json",
      "--command",
      command,
      "--json",
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      "Production D1 reconciliation command failed. Inspect Wrangler authentication and migration status.",
    );
  const response: {
    success: boolean;
    results: Order[];
    meta: { changes: number };
  }[] = JSON.parse(result.stdout);
  if (
    !Array.isArray(response) ||
    response.some((entry) => entry.success !== true)
  )
    throw new Error("Invalid production D1 response.");
  return response;
}
const order = execute(`SELECT * FROM orders WHERE id='${id}'`)[0]?.results[0];
if (
  !order ||
  order.id !== id ||
  !order.stripe_session ||
  order.refund_amount === undefined ||
  order.reconciliation_attempts === undefined
)
  throw new Error("Order not found or refund migration has not been applied.");
const evidence = await refundPayment(env, order);
const remote = await canceledPrintfulOrder(env, order);
if (
  !evidence.full ||
  !remote ||
  !["canceled", "cancelled"].includes(remote.status)
)
  throw new Error(
    "A matching canceled Printful order and full successful Stripe refund are both required. Nothing was changed.",
  );
if (apply) {
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const updates = execute(
    `UPDATE orders SET status='cancelled',printful_status=${quoted(remote.status)},printful_id=${remote.id},stripe_payment_intent=${quoted(evidence.intent.id)},refund_amount=${evidence.charge.amount_refunded},refund_state='refunded',refund_checked_at=${now()},cancellation_at=COALESCE(cancellation_at,${now()}),last_error=NULL,lease_until=0,reconciliation_lease=0,reconciliation_attempts=0,reconciliation_at=${now() + 86400},updated_at=${now()} WHERE id=${quoted(id)} AND stripe_session=${quoted(order.stripe_session)} AND snapshot=${quoted(order.snapshot)} AND status=${quoted(order.status)} AND updated_at=${order.updated_at} AND lease_until<${now()} AND reconciliation_lease<${now()} AND refund_amount<=${evidence.charge.amount_refunded}`,
  );
  if (updates[0]?.meta.changes !== 1)
    throw new Error(
      "Order changed or is leased. Refusing concurrent reconciliation.",
    );
  execute(
    `UPDATE notifications SET status='resolved',lease_until=0 WHERE order_id='${id}' AND kind='alert' AND EXISTS (SELECT 1 FROM orders WHERE id='${id}' AND status='cancelled' AND refund_state='refunded' AND last_error IS NULL)`,
  );
  execute(
    `INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) SELECT '${id}:cancellation-refund','${id}','cancellation-refund',${now()} WHERE EXISTS (SELECT 1 FROM orders WHERE id='${id}' AND status='cancelled' AND refund_state='refunded' AND last_error IS NULL)`,
  );
}
console.log(
  JSON.stringify({
    orderId: id,
    fullyRefunded: true,
    fulfillmentCanceled: true,
    applied: apply,
  }),
);
