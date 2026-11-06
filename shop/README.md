# Bascik Shop

Independent Bascik storefront for `shop.bascik.dev`. The docs application is not imported or deployed by this app.

## Status

**Prelaunch. Payments and fulfillment are disabled by default.** Do not cancel Shopify or attach its hostname yet.

The owned catalog contains two $30 shirts and two $25 hats, with 24 variants and 52 captured image views. Original image bytes are preserved outside the published directory. Optimized images, descriptions, variants, and existing product URLs are independent of Shopify.

Stripe-hosted Checkout follows a shop-owned delivery step. Printful quotes the actual cart/address. Stripe uses a separate Customer per order with that shipping address, calculates tax, and does not recollect a different shipping destination. Browser cart prices and shipping amounts are never authoritative.

### Provider audit performed

- Read-only Stripe API checks confirmed the provided secret is sandbox-only.
- The authenticated sandbox account ID ends in **ZAC7**, while the configured `STRIPE_ACCOUNT` ends in **4ucM**. A sandbox can have a different account ID from its parent; ownership must be confirmed before changing either account. **No Stripe products, prices, webhooks, customers, tax settings, or payments were created.**
- Stripe Tax reports `pending` because its head-office configuration is missing. Do not invent a business address or tax registrations. Configure these in the Bascik sandbox before an actual hosted-checkout test.
- The CLI was not available on the agent process PATH or in standard executable locations. The setup scripts use the Stripe API directly with the same sandbox credentials instead.
- Read-only Printful inspection found a single Bascik store of type `shopify`. All four products and 24 print-ready variant mappings were exported privately to `.local/printful-shopify.json`. **No store, webhook, or order was changed.**
- The current local Printful key is named `PRINTFUL_TOEKN`. The audit accepts that spelling with a warning; the application requires the correctly named `PRINTFUL_TOKEN`.

These are launch blockers, not successful setup substitutes. Local provider audits are ignored by Git and contain no customer orders.

## Commands

From the monorepo root, on Node 24:

```sh
yarn install
yarn pkg:build
yarn adapter:cf:build
yarn shop:build
yarn shop:typecheck
yarn shop:unit
yarn shop:integration
yarn shop:e2e
```

`shop:build` generates page shells, browser JavaScript, the Bascik deployment, and an application-owned Worker entry point with fetch, queue, and scheduled handlers. Original product images and the checked-in normalized catalog are build inputs; normal builds never call Shopify.

`yarn shop:dev` builds and starts Wrangler locally. For a credential-free preview of the actual emitted Worker, run `yarn workspace bascik-shop exec node scripts/serve-tests.ts`. Stop a local server before running E2E, which owns port 8790. The test server never loads `.env` or remote bindings.

Refresh the original four listings only while Shopify remains available:

```sh
yarn shop:import
```

The import validates the allowlist, prices, variant count, image downloads/dimensions, and Printful country metadata. It fails on upstream catalog drift. Review the diff, exact image associations, and browser layout before accepting a refresh. Original inputs stay under `image-originals/`; only optimized assets are published.

Read-only provider checks use the ignored `shop/.env`:

```sh
yarn workspace bascik-shop printful:audit
yarn workspace bascik-shop stripe:check
```

After confirming that `STRIPE_ACCOUNT` names the authenticated Bascik **sandbox**, selecting the correct apparel tax codes, and configuring sandbox tax settings:

```sh
yarn workspace bascik-shop stripe:setup
```

This command refuses live keys and mismatched account IDs. It creates or reuses only app-tagged sandbox products and exclusive-tax USD prices, recording their IDs in `.local/stripe-readiness.json`. The checkout implementation currently creates equivalent inline price data from the owned catalog; the setup inventory is for dashboard administration, not a second source of prices. It does not alter the other business's Stripe objects or create tax registrations or webhook endpoints.

## Configuration and owner-controlled provisioning

Use `.dev.vars.example` as the variable-name reference. Keep local secrets ignored and production secrets in Cloudflare. Do not copy secret files into generated output or CI artifacts.

Required before enabling checkout:

- Confirm the Bascik sandbox identity, then separately configure live credentials at launch. `SHOP_MODE=test` only accepts test keys; `SHOP_MODE=live` requires live keys. Keep shared-account webhook objects tagged `app=bascik-shop` and scoped by `SHOP_ORIGIN`.
- Configure `STRIPE_WEBHOOK_SECRET` for `/api/webhooks/stripe`, receiving `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Stripe receipts need a receipt email; the code supplies one.
- Set a random, private `ORDER_TOKEN_SECRET` of at least 32 characters. Keep it stable; rotating it invalidates existing order links. Links expire after 90 days and can be individually revoked in D1.
- Set `TAX_CODE_SHIRT` and `TAX_CODE_HAT` to owner-reviewed Stripe tax codes. Configure Stripe Tax origin and applicable registrations; international service sales on the same Stripe account do not automatically settle physical-goods tax obligations. Product price, customer tax, Printful's charges to the business, and recipient customs duties are separate.
- Create a separate Printful **Manual/API store** in the dashboard. Preserve all exact artwork placements, print files, embroidery options, and blank product variant IDs from the private source audit. Store IDs from the Shopify store cannot simply be reused in the new store.
- Obtain appropriate new-store credentials, set `PRINTFUL_TOKEN` and `PRINTFUL_STORE_ID`, verify funding, and verify all 24 variants using estimates/drafts without submitting production.
- Populate `variant_mappings` with the shop variant ID, new store sync variant ID, and blank catalog variant ID. Set `verified=1` only after inspecting the exact artwork and size/color match. Never seed guessed IDs.
- Create D1, the `bascik-shop-jobs` queue and `bascik-shop-dead` dead-letter queue. Replace the local-only D1 placeholder in authored configuration. Apply `migrations/` to the intended database before enabling requests.
- Enable Cloudflare Email Sending on Workers Paid, verify sender-domain access and external delivery, and configure `EMAIL_FROM`, monitored `SUPPORT_EMAIL`, and `ALERT_EMAIL`. Preserve Gmail's existing MX. Review bounce-domain, SPF, DKIM, and DMARC additions rather than replacing incoming routing.
- Configure `/api/webhooks/printful?key=<private random token>` on the **new** store only, setting `PRINTFUL_WEBHOOK_TOKEN`. Treat the token as a secret and redact its query string in platform logs. A callback is only a hint; its content never directly changes fulfillment state without an authenticated Printful re-fetch.
- Approve and publish actual seller/support, sizing, shipping, refund/return, privacy, retention, customs, and terms information. The current policy pages explicitly say they are pending. Remove the checkout prelaunch notice only after these gates pass.

`SHOP_ENABLED=true` opens quote/payment creation. `SHOP_FULFILLMENT_ENABLED=true` separately permits Printful submissions. Do not enable either on generic previews. Use separate sandbox D1, queues, webhook secrets, and sender restrictions for every preview that tests checkout. Stripe test mode alone does not prevent real Printful production.

The authored `wrangler.jsonc` deliberately contains no custom-domain route. Packaging rebases the generated deployment paths and preserves Bascik's selective static-asset routing and security headers. Production resource IDs and domain ownership remain owner-controlled.

Builds default to `SHOP_BUILD_MODE=test` and send a global noindex header.
An owner-approved `SHOP_BUILD_MODE=live yarn shop:build` creates indexable
public catalog pages; private pages remain noindex. This only selects the
artifact's mode, not checkout enablement, credentials, provisioning, or deployment.

## Reliability and order handling

- Quantities are limited to 10 per variant and 20 total items; quotes expire after 15 minutes. A created Stripe Session is valid for one hour. Prices and the destination/service are snapshotted. Request a new quote to change the destination or service.
- Stripe's signature is checked against the exact payload with a five-minute timestamp tolerance. A server-to-server retrieval then checks app, origin, environment, order, subtotal, shipping, tax state, and final total before payment is accepted.
- D1 transactions persist payment and notification intent before acknowledgment. Queue deliveries are hints; the five-minute scheduled sweep recovers paid work even if enqueueing fails and reconciles pending sessions if a payment webhook never arrives. Expired unpaid sessions never clear the cart. A short database lease prevents concurrent submissions.
- Printful orders use a stable external reference and are created as drafts before confirmation. On ambiguous submission, the worker queries that reference. If it cannot prove the result, it alerts an operator rather than blindly creating another order.
- Transient failures back off, honoring provider `Retry-After` seconds or HTTP dates. After bounded failures, the order or notification is marked for operator attention. Successful Printful polls reset the transient-attempt counter. Monitor `failed` orders, `failed` notifications, dead-letter messages, and structured logs independently of email.
- Orders are not fulfilled from the return page, and unpaid/delayed payments do not authorize production. Unrelated shared-account Stripe payments are ignored.
- Shipments may be partial; each distinct shipment gets a notification. Stripe sends receipts; Cloudflare sends shop confirmations, tracking links, and failure alerts.
- Email is not an exactly-once protocol. The app deduplicates normal notification work, but an ambiguous provider acceptance followed by a crash may require delivery reconciliation.
- Order access uses an unguessable HMAC link in a URL fragment, not a public checkout ID. The browser POSTs it for status so it does not appear in ordinary request URLs. Responses expose only order state, purchased variant quantities, and shipment tracking, with no-store headers.

### Operator recovery

For a failed order, compare the D1 order ID, Stripe payment/session, and Printful external reference before any replay. A confirmed duplicate payment must be refunded in Stripe; never create a second physical order to hide a mismatch. For an ambiguous Printful draft, verify the existing order and reconcile its ID before confirming it. Do not reset a failed row to `paid` until a human has proved there is no existing order or has repaired the original.

Use Stripe for refunds and Printful for production cancellation; one does not automatically undo the other. Check production status before promising cancellation. There is intentionally no public admin/replay endpoint.

Private checkout quotes without orders are removed after expiry plus one day. Order snapshots and notification records currently remain until an owner-approved retention procedure is implemented. Do not open the shop before the policy and cleanup process are agreed.

## Validation and deployment

The Shop workflow runs typechecks, unit tests, real-D1 integration tests, the production build, and desktop/mobile Playwright tests against local workerd. It deploys nothing. Shop-only pushes and pull requests skip the monorepo CI and CodeQL workflows; mixed changes still run them. The Shop workflow also runs for shared compiler, adapter, dependency, and workflow changes. Scheduled CodeQL remains unaffected. Root validation aggregators also include the shop.

Before launch, additionally test actual hosted sandbox Checkout, Stripe Tax destination behavior, failed/delayed payments, real external email delivery, and new-store Printful estimates/drafts. Local provider fixtures do not certify live integrations.

Only the owner or approved CI should deploy, upload previews, provision resources, or switch DNS. Build and dry-run validation do not transfer the hostname. A future deployment workflow must use an approved production environment and tested merged-PR gates, not silently add the shop to the docs deploy.

Keep Shopify active until all assets/artwork are independent, provider and policy gates pass, old orders have a handling plan, and a rollback route is documented. Rollback must not discard D1 orders or stop reconciliation of already accepted payments.

Closing `SHOP_ENABLED` stops new checkouts, not signed payment callbacks. Leave the Worker, scheduled trigger, email binding, database, and fulfillment setting available to process previously accepted orders, even if the public hostname is rolled back.
