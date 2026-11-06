# Bascik Shop

Independent Bascik storefront for `shop.bascik.dev`. The docs application is not imported or deployed by this app.

## Status

**Prelaunch. Payments and fulfillment are disabled by default.** Do not cancel Shopify or attach its hostname yet.

The owned catalog contains two $30 shirts and two $25 hats, with 24 variants and 52 captured image views. Original image bytes are preserved outside the published directory. Optimized images, descriptions, variants, and existing product URLs are independent of Shopify.

Stripe-hosted Checkout follows a shop-owned delivery step. Printful quotes the actual cart/address. Stripe uses a separate Customer per order with that shipping address, calculates tax, and does not recollect a different shipping destination. Browser cart prices and shipping amounts are never authoritative.

### Provider audit performed

- Read-only Stripe API checks confirmed the provided secret is sandbox-only.
- The owner confirmed that sandbox **ZAC7** belongs to Bascik account **4ucM**. The local `STRIPE_ACCOUNT` still names the parent; provisioning used the API-returned, owner-confirmed sandbox ID as a process-only override. Set `STRIPE_ACCOUNT` to the full sandbox account ID when rerunning sandbox setup; do not use the parent ID to bypass the script's account guard.
- Stripe Tax is now `active`, with a configured head-office address and exclusive-tax pricing. No sandbox registrations exist yet, so this does not demonstrate tax collection. The account-wide default remains general tangible goods. The owner approved `txcd_30011000` (Clothing & Footwear) for both shirts and hats; configure `TAX_CODE_SHIRT` and `TAX_CODE_HAT` to that value for sandbox checkout.
- Created or reused four app-tagged sandbox products with $30 shirt and $25 hat USD prices, all exclusive of tax and classified as Clothing & Footwear. Re-fetched every product and price to verify mode, ownership metadata, amounts, and classification; IDs are recorded privately in `.local/stripe-readiness.json`. No live products, webhook endpoints, customers, tax registrations, or payments were created. No account-wide tax settings were changed by the agent.
- The CLI was not available on the agent process PATH or in standard executable locations. The setup scripts use the Stripe API directly with the same sandbox credentials instead.
- Printful access now includes the original Shopify store `18630655` and the owner-created Manual/API store `19022802` (Shop Bascik). The refreshed token was verified against both through v2. All four original products and 24 print-ready variant references were exported privately to `.local/printful-shopify.json`. **No Shopify product, webhook, or order was changed.**
- The current local Printful key is named `PRINTFUL_TOEKN`. The audit accepts that spelling with a warning; the application requires the correctly named `PRINTFUL_TOKEN`.

The remaining provider, deployment, and policy gates below still block launch. Local provider audits are ignored by Git and contain no customer orders.

### Provisioned sandbox infrastructure

The authenticated Cloudflare account `8572c3fcc06b71dbf05fe590e8b3f74e` now has:

| Resource           | Name / ID                                                     |
| ------------------ | ------------------------------------------------------------- |
| D1                 | `bascik-shop-sandbox`, `17c831f5-82a4-4094-ad10-5489830c6ae2` |
| Processing queue   | `bascik-shop-sandbox-jobs`                                    |
| Dead-letter queue  | `bascik-shop-sandbox-dead`                                    |
| GitHub environment | `shop-sandbox`, restricted to branch `main`                   |

All three checked-in migrations have been applied to the sandbox database. All 24 owner-approved saved-template mappings have been installed for API store `19022802`. The authored configuration targets these isolated resources and the dedicated Printful API store, and explicitly disables checkout and fulfillment. Cloudflare Email Sending is now enabled for `bascik.dev`; the owner confirmed inbox delivery of a one-time local CLI test from `no-reply@bascik.dev`. The sandbox and PR previews deliberately have no email binding; this test does not certify the production notification worker.

The separate PR Worker has been deployed as described below; no production shop resources or hostname cutover have been performed. The owner activated the email sender in Cloudflare. Stripe sandbox inventory provisioning and the unconfirmed Printful validation draft are recorded here. To remove the unused disabled-commerce sandbox infrastructure, delete these three named Cloudflare resources and the `shop-sandbox` GitHub environment. Never delete an active order database.

### Printful v2

Shipping, draft creation, external-reference lookup, confirmation, shipment polling, and callback verification use v2 contracts from `printful-v2-openapi.json`. The read-only Shopify artwork export still uses v1 sync-product endpoints because v2 does not provide them. It is an import-time tool, not a runtime fallback.

Runtime orders support `source: "product_template"` with saved Printful designs, or `source: "catalog"` with explicit print placements. Migration `0002_printful_v2.sql` adds explicit-design mappings; `0003_printful_templates.sql` adds store-scoped template mappings. The old `variant_mappings` table remains for historical audit only. Unverified templates and templates for another store cannot enable checkout.

The read-only template audit found all four original templates accessible to store `19022802`:

| Product          | Template    | Technique / placements       |
| ---------------- | ----------- | ---------------------------- |
| Logo shirt       | `109921208` | DTG, front                   |
| Insignia shirt   | `109921207` | DTG, front and outside label |
| Logo dad hat     | `109921204` | DTF, `front_dtf_hat`         |
| Insignia dad hat | `109921206` | DTF, `front_dtf_hat`         |

The hats are printed, not embroidered; unused embroidery options in the legacy sync response must not override the template's actual DTF technique. Saved templates retain the provider's design positioning. The legacy sync export lacks that positioning, so reconstructing catalog designs from its image dimensions would be unreliable.

Run the read-only audit with the refreshed local token:

```sh
cd shop
PRINTFUL_STORE_ID=19022802 node --env-file=.env scripts/audit-templates.ts
```

It checks each template's title, variant membership, original sync variant IDs, size/color, and shipping techniques, and saves all 24 proposed mappings privately to `.local/printful-template-mappings.json`. The audit itself never marks mappings verified. The owner confirmed the prepared templates are the exact approved designs; all 24 validated references have now been installed in sandbox D1 with `verified=1`, scoped to store `19022802`.

```sh
cd shop
node scripts/setup-printful-mappings.ts --write
```

This checks the saved draft evidence and the exact sandbox database ID before importing mappings. It does not enable checkout or fulfillment. Runtime v2 orders use the original account-level product templates directly in the API store; there is no need to recreate artwork or duplicate sync-product listings. The v1 store-product API has no template-to-product copy field, and rebuilding from its incomplete artwork data would not preserve the exact saved design.

The owner-approved draft validation uses Printful's public documentation example address, not a customer destination:

```sh
cd shop
PRINTFUL_STORE_ID=19022802 node --env-file=.env scripts/validate-printful-draft.ts
```

This created draft **`185170769`**, external reference `bascik-v2-audit-19022802`, in store `19022802`. It contains all 24 variants, with one of each, labelled **VALIDATION ONLY**. Costs calculated successfully; item catalog IDs, quantities, placement/technique sets, and preserved inch positions were checked. Standard and carbon-offset standard shipping were available for the sample destination. Rerunning reconciles the same external reference rather than creating another draft; the script contains no confirmation call.

Printful returns blank status fields, artwork URLs, and file IDs for these template-derived placements. These are not explicit artwork approvals or files that can safely be reconstructed into catalog designs. The script reports all 34 unspecified placement statuses; it validates template references, quantities, techniques, positions, and calculated costs rather than claiming a provider artwork-status approval. The owner-prepared templates are the source of truth, not a request to redesign or reapprove artwork. Detailed responses remain private in `.local/printful-validation-draft.json`.

**Do not confirm or pay for this validation draft.** It has not been charged, submitted to production, or shipped. After review, the owner may delete this uncharged draft through Printful; never use the v2 deletion endpoint as a substitute for canceling a paid production order.

For explicit catalog designs, do not reuse sync variant IDs or translate pixel placement coordinates to inches by guessing. Every reviewed mapping must include the exact technique, HTTPS artwork, positioning in inches, and any embroidery thread/layer or placement options. Missing positioning is rejected instead of silently centering the design.

The v2 shipping quote receives the saved template's actual shipping placements/techniques, or the explicit design's placements. The shipping endpoint accepts catalog items, not template items; fulfillment uses template references to preserve the saved design. There is no v2 `/orders/estimate-costs` call. A shipping quote is not artwork or production-cost verification: inspect unconfirmed v2 drafts for all 24 variants in the dedicated API store before marking mappings verified or enabling checkout. No prepayment draft is created for each browser quote. New artwork or production errors after payment are routed to operator review; reconcile/refund rather than submitting blindly.

Draft costs may be `calculating`: the worker releases its lease and retries the same external reference before confirmation. Failed calculations and exhausted attempts require operator attention. Shipments are fetched separately with pagination. v2 DELETE deletes eligible uncharged orders, so it is not used as a cancellation substitute.

v2 webhooks require Printful's one-time `secret_key` and its `public_key`. Configure them as `PRINTFUL_WEBHOOK_SECRET` (hexadecimal) and `PRINTFUL_WEBHOOK_PUBLIC_KEY`. The handler verifies `x-pf-webhook-public-key` and an HMAC-SHA256 `x-pf-webhook-signature` over the raw JSON using the hex-decoded secret. Reformatting the body invalidates the signature. Signed `store_id` callbacks only schedule an authenticated re-fetch. The old query-string token mechanism is no longer used.

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

Imported description HTML is parsed into plain text, excluding script/style/template content and preserving paragraph and line-break spacing. That text is still HTML-escaped when rendered; extraction is not a substitute for output escaping.

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
- The separate Printful **Manual/API store** `19022802` is created and accessible. Preserve exact saved templates, artwork placements, print files, applicable options, and blank product variant IDs. Store IDs from the Shopify store cannot simply be reused in the new store.
- Use the refreshed `PRINTFUL_TOKEN` and `PRINTFUL_STORE_ID=19022802`, verify funding, and validate all 24 variants using unconfirmed v2 drafts without submitting production.
- All 24 store-scoped `printful_template_mappings` are installed from the validated owner-approved templates. Keep them tied to store `19022802`; production needs its own reviewed mapping import. Never seed guessed IDs or rebuild these saved designs from incomplete legacy file metadata.
- Sandbox D1 and queues are provisioned above. Production needs its own D1 and processing/dead-letter queues, an explicitly reviewed production configuration, and all three migrations applied to the intended database.
- Enable Cloudflare Email Sending on Workers Paid, verify sender-domain access and external delivery, and configure `EMAIL_FROM`, monitored `SUPPORT_EMAIL`, and `ALERT_EMAIL`. Preserve Gmail's existing MX. Review bounce-domain, SPF, DKIM, and DMARC additions rather than replacing incoming routing.
- Configure `/api/webhooks/printful` through `/v2/webhooks` on the **new** store only, saving its one-time signature secret securely. Subscribe to order and shipment lifecycle events, including hold removal. Do not overwrite the Shopify store's webhook configuration. A callback is only a hint; its content never directly changes fulfillment state without an authenticated Printful re-fetch.
- Approve and publish actual seller/support, sizing, shipping, refund/return, privacy, retention, customs, and terms information. The current policy pages explicitly say they are pending. Remove the checkout prelaunch notice only after these gates pass.

`SHOP_ENABLED=true` opens quote/payment creation. `SHOP_FULFILLMENT_ENABLED=true` separately permits Printful submissions. Do not enable either on generic previews. Use separate sandbox D1, queues, webhook secrets, and sender restrictions for every preview that tests checkout. Stripe test mode alone does not prevent real Printful production.

### Draft-only PR commerce previews

Same-repository branch pushes with an open PR now deploy a dedicated shop Worker after Shop validation succeeds. PR events and forks never receive deployment secrets. The deployment verifies the PR head matches the pushed commit, creates `bascik-shop-pr-<number>` on Workers.dev with separate D1 and processing/dead-letter queues, imports the exact four template mappings, and registers a Stripe sandbox webhook at that PR's origin. Pushes without an open PR fail the preview gate rather than deploying an unassociated environment.

The `shop-preview` GitHub environment contains the dedicated Cloudflare token, sandbox Stripe key, Printful token, and an order-token seed. Runtime webhook secrets are generated separately per deployment; order-link signing keys are derived per PR. Secret files are temporary, never artifacts. Older Stripe webhook endpoints belonging to that same preview are retired only after successful replacement deployment; other businesses' endpoints are untouched.

These environments use real shipping quotes, real hosted Stripe sandbox Checkout, signed payment callbacks, and real **unconfirmed** Printful template drafts. The fulfilled test state is `test_draft`, displayed as “Nothing will be produced or shipped.” The scheduled reconciler handles missing payment callbacks; duplicate deliveries and concurrent consumers cannot create another draft.

New order references are 32-character hexadecimal UUIDs without separators, matching Printful's external ID limit. Older private order links remain readable.

Order pages keep polling through payment and asynchronous draft-cost calculation with a capped backoff, so the five-minute recovery sweep can finish without requiring a refresh. If the bounded polling window expires, the page explicitly asks the buyer to refresh.

**Production confirmation is blocked in test mode**, both in the order processor and the provider request helper. Only an explicitly live runtime may call Printful's confirmation endpoint. An unexpected production status on a test order raises an operator error. `SHOP_FULFILLMENT_ENABLED=true` on a test preview allows draft creation, never manufacturing. Test-mode notification sending is suppressed even if an email binding accidentally exists; no preview email binding is provisioned.

Printful has no documented order sandbox, and its Webhook Simulator does not support v2 webhooks. Shipment/tracking scenarios therefore use authenticated signed v2 events and simulated provider responses in automated tests, not an unsigned public test endpoint or changes to an actual draft's production status. Production tracking logic remains covered separately by live-mode fixtures.

CI comments the preview URL on the PR and records its D1/queue names and Stripe webhook ID in the run summary. The production hostname, live Stripe objects, and existing Shopify store are never changed. Preview resources persist across pushes to preserve test orders. After closing a PR, remove that PR's Worker, queues, D1 database, and tagged Stripe webhook endpoint; test drafts can be deleted while uncharged. Automatic teardown is not configured.

The authored `wrangler.jsonc` deliberately contains no custom-domain route. Packaging copies static assets and migrations into `.output/` with relative deployment paths and preserves Bascik's selective static-asset routing and security headers. This entire directory's deployable files, not just `worker.js`, travel through CI. Production resource IDs and domain ownership remain owner-controlled.

### Sandbox deployment through CI

The independent Shop workflow preserves shop-only CI filtering and always validates before deployment. Its separate disabled-commerce sandbox lane deploys when a maintainer manually runs the workflow on `main` with `deploy_sandbox=true`. Branch pushes with an open same-repository PR instead use the draft-only preview lane described above. Pull-request events do not deploy. There is no production deployment lane or hostname cutover.

Create a dedicated Cloudflare API token for this account with Workers Scripts edit, D1 edit, and Queues edit permissions (plus Account Settings read for discovery). Store it as environment secret `SHOP_CLOUDFLARE_API_TOKEN` in the GitHub `shop-sandbox` environment. The existing shared docs token is documented with Workers permissions only, so it is not reused or replaced. The agent's Wrangler OAuth session is not a CI credential and has not been copied into GitHub.

The owner-supplied dedicated token has now been verified active and securely installed as `SHOP_CLOUDFLARE_API_TOKEN` in the GitHub `shop-sandbox` environment. Read-only access checks for Workers Scripts, D1, and Queues succeeded. No token value was logged or committed; the shared docs token was not changed.

After these changes are merged:

```sh
gh workflow run shop.yml --ref main -f deploy_sandbox=true
```

CI reapplies migrations and deploys the disabled-commerce sandbox to its Workers hostname. It rejects commerce-enabled, email-enabled, or custom-domain configurations. No Stripe or Printful secrets are needed for this storefront-only preview. Verify the resulting URL before any later sandbox-commerce configuration. Real checkout testing also requires setting `SHOP_ORIGIN` to that exact deployed origin.

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
