# Bascik Shop

Independent Bascik storefront for `shop.bascik.dev`. The docs application is not imported or deployed by this app.

## Status

**Production:** the owner approved the cutover to `shop.bascik.dev`. Validated main pushes deploy the live shop with checkout and fulfillment enabled. Sandbox and PR environments remain separate and draft-only. Keep the Shopify account until its outstanding orders and rollback needs are resolved.

The owned catalog contains two $30 shirts, two $45 organic sweatshirts, two $25 hats, and two $5 kiss-cut vinyl decals, in that order, with 46 variants and 84 captured image views. Sweatshirts list Black first and default to its front photo, followed by Desert Dust. Original image bytes are preserved outside the published directory. Every product image is a local, responsive WebP. Descriptions, variants, and existing product URLs are independent of Shopify.

The shop collects delivery details to calculate exact Printful shipping, then redirects to Stripe-hosted Checkout for billing and payment. Stripe calculates applicable tax and manages eligible payment methods. Browser cart prices and shipping amounts are never authoritative. Cart thumbnails use the selected variant's image and color, including after reloads and quantity changes.

### Component architecture

The checked-in `src/pages/` files are small page shells composed of Bascik tags. `products/[slug].html` expands the owned catalog with a routes script, so builds never generate HTML into `src/`. Prettier formats authored pages and components normally; Bascik still minifies production output.

Component names describe their jobs without a redundant `shop-` prefix: `navigation`, `not-found`, `checkout-form`, and `policy-content`. `page-head` and `site-footer` avoid native HTML names. Existing `data-testid` hooks remain stable. The CLI/editor still recommend a hyphenated name for `navigation`; it is a build-time component, not a browser custom element.

Contact and privacy choices live at `src/pages/contact.html` and `src/pages/data-sharing-opt-out.html`. Their old Shopify `/pages/*` URLs redirect permanently through the authored `_redirects` file. Policy URLs under `/policies/` remain unchanged.

Every button has an explicit type: Add to cart and the shipping-quote form use `submit`; gallery, navigation, removal, payment, and print actions use `button`. VS Code uses Prettier on save for whole TypeScript and TSX files, including `src/api/`, rather than formatting only modified lines.

Each component owns its semantic HTML, companion CSS, and TypeScript. `product-card` contains the card, image controls, and a cloneable color-button template; `product-detail` owns the gallery and purchase form. Cart rows and shipping options are cloned from authored templates, preserving Bascik's scoped styles on browser-created content. Page-aware catalog helpers live beside `product-detail`; `product-grid` prints card tags with props, not copies of card markup. Build helpers use `html` and `json` from `@bascik/bascik/html`.

Component entry scripts obtain their own compiler-scoped root with `getElementById`. They import typed initializers from `/assets/shop.js`, bundled once by `scripts/build-assets.ts` through `pipeline.exec`. The initializers live in each component's `behavior.ts`, query only the supplied root, and use stable data hooks because the external bundle is not rewritten by the scoping engine. `src/browser/` holds only the shared cart store, root-bound DOM/API helpers, and bundle exports. Cart, delivery eligibility, and checkout-summary updates use custom events instead of querying another component's DOM.

The global stylesheet contains design tokens, document defaults, and deliberately shared primitives such as buttons, panels, responsive photos, totals, and order lines. Card, product, cart-row, promotion, and checkout layout styles live alongside their owning components.

The delivery component deliberately keeps its address fields and shipping-choice lifecycle together. Formatting puts its markup just above the component-audit size guideline; splitting individual fields into single-use components would obscure the form rather than improve reuse.

### Free standard shipping

New shipping quotes offer free **standard** shipping when the merchandise subtotal is **strictly over $50**, before tax and shipping, to one of the contiguous 48 states. Exactly $50 does not qualify. Alaska, Hawaii, Washington DC (not one of the 48 states), territories, military addresses, and international destinations retain their quoted shipping charges. The lowest-cost available service is free; all other services retain their full quoted price. If services tie for the lowest price, `STANDARD` is preferred, otherwise the first tied service is used.

The shared policy in `src/lib/free-shipping.ts` drives compact, unboxed shipping notes: a quiet line above the homepage collection, an inline product note beside purchase details, and live progress below the cart subtotal. Checkout also shows delivery-aware progress. Each note links to `/shipping` for the full terms rather than repeating them on shopping pages. The server computes eligibility from its own catalog prices and validated delivery state, not browser totals. Printful must return valid shipping rates; only the cheapest service's customer-facing price in a **new quote** becomes zero. We still pay Printful's normal fulfillment/shipping costs and submit the original service ID.

The promotion does not rewrite existing quotes, pending Checkout sessions, paid orders, receipts, or fulfillment records. Checkout, payment verification, emails, and order summaries continue to use each order's immutable saved shipping snapshot. No D1 migration or live-order mutation is needed. Quote expiry and address changes still require a fresh shipping quote. The cart's action is labeled **Checkout**.

Collection image and title links carry the selected color to the product page through a `color` URL parameter. The color selector and gallery keep that choice after reload; unrecognized colors retain the default selection. Product pages show a “View cart & checkout” link after adding an item, and when returning with a saved cart. The delivery page keeps the order summary alongside a grouped address form (stacked on mobile), with an edit-cart link and the selected shipping amount in its before-tax total. Empty carts hide the delivery form. Editing the address invalidates the quote and resets the displayed shipping amount.

Cart changes, including edits in another tab, refresh checkout's supported countries. A selected country stays selected only while every cart product supports it; otherwise checkout asks for a new country and refreshes state/postal-code requirements. Existing shipping quotes are invalidated in either case.

Hosted Checkout cannot dynamically call Printful when its address changes. The quoted delivery address is therefore fixed for each Session and shown before payment; customers return to the shop to change it and request a fresh quote. The browser rejects expired quotes and delivery or cart changes while requests are pending. Card details never pass through the shop, and no Stripe iframe or SDK is loaded on the storefront. The existing Stripe API version remains `2025-02-24.acacia`. No additional migration or publishable key is required.

### Provider audit performed

- Read-only Stripe API checks confirmed the provided secret is sandbox-only.
- The owner confirmed that sandbox **ZAC7** belongs to Bascik account **4ucM**. The local `STRIPE_ACCOUNT` still names the parent; provisioning used the API-returned, owner-confirmed sandbox ID as a process-only override. Set `STRIPE_ACCOUNT` to the full sandbox account ID when rerunning sandbox setup; do not use the parent ID to bypass the script's account guard.
- Stripe Tax is now `active`, with a configured head-office address and exclusive-tax pricing. No sandbox registrations exist yet, so this does not demonstrate tax collection. The account-wide default remains general tangible goods. The owner approved `txcd_30011000` (Clothing & Footwear) for both shirts and hats; configure `TAX_CODE_SHIRT` and `TAX_CODE_HAT` to that value for sandbox checkout.
- Created or reused four app-tagged sandbox products with $30 shirt and $25 hat USD prices, all exclusive of tax and classified as Clothing & Footwear. Re-fetched every product and price to verify mode, ownership metadata, amounts, and classification; IDs are recorded privately in `.local/stripe-readiness.json`. No live products, webhook endpoints, customers, tax registrations, or payments were created. No account-wide tax settings were changed by the agent.
- The CLI was not available on the agent process PATH or in standard executable locations. The setup scripts use the Stripe API directly with the same sandbox credentials instead.
- Printful access now includes the original Shopify store `18630655` and the owner-created Manual/API store `19022802` (Shop Bascik). The refreshed token was verified against both through v2. All four original products and 24 print-ready variant references were exported privately to `.local/printful-shopify.json`. **No Shopify product, webhook, or order was changed.**
- The current local Printful key is named `PRINTFUL_TOEKN`. The audit accepts that spelling with a warning; the application requires the correctly named `PRINTFUL_TOKEN`.

The initial preparation audit below is historical. Production verification and launch controls are described separately. Local provider audits are ignored by Git and are never published.

### Provisioned sandbox infrastructure

The authenticated Cloudflare account `8572c3fcc06b71dbf05fe590e8b3f74e` now has:

| Resource           | Name / ID                                                     |
| ------------------ | ------------------------------------------------------------- |
| D1                 | `bascik-shop-sandbox`, `17c831f5-82a4-4094-ad10-5489830c6ae2` |
| Processing queue   | `bascik-shop-sandbox-jobs`                                    |
| Dead-letter queue  | `bascik-shop-sandbox-dead`                                    |
| GitHub environment | `shop-sandbox`, restricted to branch `main`                   |

All three checked-in migrations have been applied to the sandbox database. All 24 owner-approved saved-template mappings have been installed for API store `19022802`. The authored configuration targets these isolated resources and the dedicated Printful API store, and explicitly disables checkout and fulfillment. Cloudflare Email Sending is now enabled for `bascik.dev`; the owner confirmed inbox delivery of a one-time local CLI test from `no-reply@bascik.dev`. The sandbox and PR previews deliberately have no email binding; this test does not certify the production notification worker.

The separate PR Worker has been deployed as described below. Production resources are provisioned separately. The owner activated the email sender in Cloudflare and attached `shop.bascik.dev` to the production Worker. Stripe sandbox inventory provisioning and the unconfirmed Printful validation draft are recorded here. To remove the unused disabled-commerce sandbox infrastructure, delete these three named Cloudflare resources and the `shop-sandbox` GitHub environment. Never delete an active order database.

### Provisioned production prelaunch

Production is prepared independently from all sandbox/PR infrastructure:

| Resource           | Name / ID                                                           |
| ------------------ | ------------------------------------------------------------------- |
| Worker             | `bascik-shop-production`                                            |
| D1                 | `bascik-shop-production-db`, `6789dbf6-f32f-400b-ad4a-d5b590b7438d` |
| Processing queue   | `bascik-shop-production-jobs`, `21e16a4e63194d4692b8cb7a232eeb45`   |
| Dead-letter queue  | `bascik-shop-production-dead`, `d8b7818212714394ade8795aa8226e6c`   |
| GitHub environment | `shop-production`, only branch `main`                               |
| Pre-cutover origin | `https://bascik-shop-production.collin-inbox.workers.dev`           |

All three migrations and all 24 fingerprint-validated template mappings are installed in production D1: ten variants per shirt and two per hat. Production verification left one explicitly labeled, expired, unpaid audit order and one sent email notification, with its private link revoked. It has no payment events or Printful order. Validation draft `185223395`, reference `bascik-audit-326d2c36db57936aadd`, contains the exact four owner-prepared templates, passed cost/shipping checks, and remains **unconfirmed**. Printful returned blank placement statuses, not explicit artwork approval; owner-approved saved templates remain the design source.

The live restricted Stripe key was verified against the expected Bascik account. Charges and payouts are enabled. All four copied, active live products have apparel tax code `txcd_30011000`, with exact $30/$25 USD exclusive-tax prices. The owner configured an active Arizona tax registration. A live calculation for $55 of apparel at the public Arizona State Capitol address returned $5.06 exclusive tax (9.2%), with `standard_rated` taxability. No registration or account-wide tax setting was changed by the agent. A live unpaid Checkout Session was created and expired solely to verify provider-originated callbacks; no charge or merchandise confirmation occurred. The owner confirmed Printful has a valid billing method or funded wallet; this is an owner confirmation, not an API balance verification.

The live Stripe webhook is app-tagged `bascik-shop-production` and points to the stable Workers.dev origin. The live deployment verifies its identity and enabled event list, then enables it before opening commerce. Its ID and signing secret are held in the production environment. Printful v2 order/shipment callbacks remain at that same stable origin with their real one-time signing secret and public key: **do not rotate or move callbacks merely because the public shop domain changes**. Checkout metadata and private order links use `https://shop.bascik.dev`; callbacks remain independent of public DNS. Real Stripe expiration and Printful draft-update callbacks returned HTTP 200, with signature verification and no errors. The deployed production cron sent one labeled email in one attempt; the owner confirmed inbox receipt. Printful permits one v2 configuration **per token/app**, not one per store header. Setup verified the token's configuration was empty before creating it and refuses to overwrite any unrelated configuration. Original Shopify v1 webhooks were not changed. Scheduled authenticated reconciliation remains required. PR previews still use their own sandbox Stripe callbacks and do not trust the production Printful signature.

`shop/.env.prd` and all `.env.*` files are ignored. Private signing evidence lives in `.local/production-webhooks.json`; never commit, publish, or upload that directory. Secrets are installed in `shop-production`, not repository-wide or preview environments. The order-token secret is random and stable across reruns.

The dedicated Stripe restricted key needs Customers, Checkout Sessions, Payment Intents, Products, and Prices Write; Account, Balance, Tax Settings, Tax Registrations and Tax Codes Read; and Webhook Endpoints / Event Destinations Write for setup. Webhook access was tested successfully after the owner updated it. Other businesses' products, webhooks, payouts and transfers are untouched.

Local rechecks and safe mapping preparation:

```sh
cd shop
node --env-file=.env.prd scripts/check-live-providers.ts
node --env-file=.env.prd scripts/setup-production-webhooks.ts
node scripts/package-production.ts
PRINTFUL_STORE_ID=19022802 node --env-file=.env.prd scripts/validate-printful-draft.ts
```

The webhook setup command requires the `shop-production` environment to exist and authenticated `gh`; it never confirms orders or creates payments. Rerunning it verifies saved webhook identity, keeps the Stripe endpoint disabled, and reinstalls stable secrets. It refuses to disable an already enabled saved endpoint, so it cannot silently disrupt an active shop. Missing signing evidence requires operator review, not silent rotation.

To repeat the production mapping import, set `CLOUDFLARE_API_TOKEN` from the dedicated shop token in the process environment and run `node scripts/setup-printful-mappings.ts --write --production`. Without `--production`, writes remain restricted to the original sandbox database. Both the packager and production import enforce the exact account, database, queues, API store, Workers.dev origin, restricted email sender, and closed commerce flags.

The disabled prelaunch deployment was completed after #129 merged:

```sh
gh workflow run shop.yml --ref main -f deploy_production_prelaunch=true
```

The authored `wrangler.production.json` remains a disabled baseline for isolated prelaunch verification and mapping imports. The launch packager (`node scripts/package-production.ts --launch`) derives the exact live configuration from that baseline: only `shop.bascik.dev` is attached, `SHOP_ORIGIN` becomes `https://shop.bascik.dev`, both commerce flags become **true**, and the global noindex header and checkout prelaunch notice are removed without removing private-page robots metadata, cache rules, or security headers. Sandbox and draft-only previews retain their own checkout warnings. Both shapes have strict isolation guards. Production D1, queues, signing keys, email sender, and Printful store stay unchanged.

Main pushes run Shop validation and then `deploy-production` automatically. For an explicit redeploy of the current main:

```sh
gh workflow run shop.yml --ref main -f deploy_production=true
```

Live deployment requires an active tax registration, verifies the exact owned Stripe callback, enables it, installs stable secrets, and deploys through CI only. Smoke checks verify the custom domain is indexable, malformed quote input reaches normal validation rather than the closed gate, and both correctly signed no-order callbacks are accepted. No smoke check charges a card or confirms an audit draft. Do not request the historical disabled-prelaunch lane on an active store.

For emergency containment, close **new checkout** with `SHOP_ENABLED=false` while leaving the same database, signing keys, webhook receiver, scheduled recovery, and fulfillment available for accepted payments. Pause fulfillment separately only when necessary. Do not disable Stripe callbacks or destroy D1 to roll back the public storefront. Returning the public hostname to Shopify requires owner-managed removal of the Worker custom domain and restoration of the prior Shopify DNS record; the owner performed the original DNS cutover. Keep the Shopify account and its legacy fulfillment pipeline until its outstanding orders are complete. Never confirm the 24-item audit draft as a launch test.

### Printful v2

Shipping, draft creation, external-reference lookup, confirmation, shipment polling, and callback verification use v2 contracts from `printful-v2-openapi.json`. The read-only Shopify artwork export still uses v1 sync-product endpoints because v2 does not provide them. It is an import-time tool, not a runtime fallback.

Runtime orders support `source: "product_template"` with saved Printful designs, or `source: "catalog"` with explicit print placements. Migration `0002_printful_v2.sql` adds explicit-design mappings; `0003_printful_templates.sql` adds store-scoped template mappings. The old `variant_mappings` table remains for historical audit only. Unverified templates and templates for another store cannot enable checkout.

#### Why are no products published in the Printful store?

This is intentional. The [Published tab for Shop Bascik](https://www.printful.com/dashboard/product-templates/published/19022802) lists templates published as store products, not every saved template available for fulfillment. Our storefront owns the eight listings, images, prices, and cart; Printful receives orders referencing the saved templates and selected catalog variants directly. Saved templates preserve the approved artwork, placement, techniques, colors, and sizes. They are not unfinished placeholder designs.

Printful [supports orders from saved templates without adding products to a store](https://developers.printful.com/docs/). An empty Published tab therefore does not indicate disconnected fulfillment. The API store was checked and had zero published products while all four approved templates remained accessible.

**Owner decision: keep the current v2 template-based fulfillment.** Publishing listings alone would not change how our shop submits orders. The checked-in v2 create-order contract supports `catalog` and `product_template` sources, not published sync variants; ordering by published variants would require a separately tested v1 fulfillment path. There is also no documented template-to-store copy field in the v1 product-creation API, so do not recreate the saved designs from incomplete artwork exports merely to populate this tab.

Template-based unconfirmed drafts have been validated. The owner subsequently placed a real paid order, and the matching live Printful order was confirmed and accepted for fulfillment. This verifies live submission, not completed manufacturing or delivery. Dashboard publication is not a substitute for those checks.

The read-only template audit found all four original templates accessible to store `19022802`:

| Product          | Template    | Technique / placements       |
| ---------------- | ----------- | ---------------------------- |
| Logo shirt       | `109921208` | DTG, front                   |
| Insignia shirt   | `109921207` | DTG, front and outside label |
| Logo dad hat     | `109921204` | DTF, `front_dtf_hat`         |
| Insignia dad hat | `109921206` | DTF, `front_dtf_hat`         |

The additional owner-supplied decals both sell for **$5**:

| Product              | Cut artwork dimensions | Template    | Catalog variant / backing sheet |
| -------------------- | ---------------------- | ----------- | ------------------------------- |
| Logo vinyl decal     | 4.5" x 1"              | `109978527` | `24972`, Satin, 4" x 6"         |
| Insignia vinyl decal | 2" x 2"                | `109978655` | `24971`, Satin, 3" x 4"         |

The storefront dimensions describe the cut artwork, not Printful's larger backing sheet. Both variants use catalog product `974` and the exact saved template, with no customer size selector. `scripts/product-templates.ts` is the shared approved template/variant configuration for auditing, shipping imports, and draft-only previews.

Both template metadata and the v2 catalog use `front` / `digital` for shipping; Printful's generated template draft instead labels the print technique `sticker`. Draft validation accepts that observed provider response only for these two approved templates, retaining file-layer, finite-position, positive-dimension, quantity, and exact catalog-variant checks. Negative artwork offsets are valid saved positions and are preserved. An uncharged fingerprinted draft containing all 26 variants was validated before adding the two verified mappings in migration `0005_vinyl_decals.sql`. Never confirm an audit draft.

Decals use Stripe's **General - Tangible Goods** tax code, `txcd_99999999`, through the catalog's per-product `taxCode`. Apparel retains its existing tax codes. Server-owned inline Checkout prices and app-tagged administrative Stripe inventory both use $5 exclusive-tax USD prices for the decals; shipping and tax are additional. Sandbox inventory is managed by the sandbox-only setup script; live decal inventory is created through the authenticated Bascik Dashboard because the live runtime key intentionally cannot create products. No payments or manufacturing orders are needed for this setup.

The hats are printed, not embroidered; unused embroidery options in the legacy sync response must not override the template's actual DTF technique. Saved templates retain the provider's design positioning. The legacy sync export lacks that positioning, so reconstructing catalog designs from its image dimensions would be unreliable.

Run the read-only audit with the refreshed local token:

```sh
cd shop
PRINTFUL_STORE_ID=19022802 node --env-file=.env scripts/audit-templates.ts
```

It checks each template's title, variant membership, original apparel sync variant IDs or explicitly approved catalog IDs, size/color, and shipping techniques, and saves all 46 proposed mappings privately to `.local/printful-template-mappings.json`. The audit itself never marks mappings verified. The owner confirmed the prepared templates are the exact approved designs. Validate the complete proposal before installing mappings with `verified=1`, scoped to store `19022802`.

```sh
cd shop
node scripts/setup-printful-mappings.ts --write
```

This checks the saved draft evidence and the exact sandbox database ID before importing mappings. It does not enable checkout or fulfillment. Runtime v2 orders use the original account-level product templates directly in the API store; there is no need to recreate artwork or duplicate sync-product listings. The v1 store-product API has no template-to-product copy field, and rebuilding from its incomplete artwork data would not preserve the exact saved design.

The owner-approved draft validation uses Printful's public documentation example address, not a customer destination. Each exact mapping proposal has a deterministic fingerprint and its own external order reference:

```sh
cd shop
PRINTFUL_STORE_ID=19022802 node --env-file=.env scripts/validate-printful-draft.ts
```

The initial audit created draft **`185170769`**, external reference `bascik-v2-audit-19022802`, in store `19022802`. It contains all 24 variants, with one of each, labelled **VALIDATION ONLY**. Costs calculated successfully; item catalog IDs, quantities, placement/technique sets, and preserved inch positions were checked. Standard and carbon-offset standard shipping were available for the sample destination. New validations use `bascik-audit-<fingerprint-prefix>` and save the complete proposal fingerprint in the evidence. Rerunning an unchanged proposal reconciles the same draft; changing a template requires its own draft validation. Mapping setup rejects legacy evidence without the fingerprint, changed templates, and mismatched placement sets before writing SQL. Rerun validation to refresh older evidence. The script contains no confirmation call.

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

The legacy import validates the original apparel allowlist, prices, variant count, image downloads/dimensions, and Printful country metadata. It fails on upstream catalog drift and preserves the existing collection order, independently added sweatshirts and decals, and their owner-supplied image records. Do not run it against the replacement storefront, which is not a Shopify export. Review the diff, exact image associations, and browser layout before accepting a refresh. Original inputs stay under `image-originals/`; only optimized assets are published.

Refresh the owner-supplied decal images deterministically without network access:

```sh
cd shop
node scripts/import-decals.ts
```

The four PNG inputs live in `image-originals/decals/`. Like the original apparel importer, this generates fingerprinted WebP files at quality 80 and widths 320, 640, 960, and 1600 only when the source is large enough; it never enlarges an image. The supplied 768-pixel images yield 320- and 640-pixel outputs, including the transparent front views and laptop previews. The manifest records dimensions, hashes, and output byte sizes. Rebuild the shop after importing images or catalog changes.

### Organic sweatshirts

Both sweatshirts are **$45**, with Black (`#0b0b0b`) followed by Desert Dust (`#dcccb4`), in sizes S, M, L, XL, and 2XL. The listings precede the hats and reuse the existing product/card/gallery/cart components. The description includes the regional organic cotton/recycled polyester blend, relaxed fit, fabric weight, and the provider's European sizing disclaimer.

| Design   | Owner-prepared template | Printful product | Black S–2XL     | Desert Dust S–2XL |
| -------- | ----------------------- | ---------------- | --------------- | ----------------- |
| Logo     | `109989489`             | `820`            | `20771`–`20775` | `20776`–`20780`   |
| Insignia | `109989447`             | `820`            | `20771`–`20775` | `20776`–`20780`   |

Template metadata, color hex values, all 20 color/size mappings, shipping destinations, and `front` / `dtg` placement were verified directly against Printful. Unconfirmed audit draft **185496939**, external reference `bascik-audit-6ec1b32a4fac03675d4`, successfully calculated costs and shipping with all 46 shop variants. Printful returned blank artwork-status fields, not explicit artwork approval; the owner's saved templates remain the design source. This draft is not a customer order and can be deleted after verification. Never confirm it.

Migration `0007_organic_sweatshirts.sql` adds only the 20 new verified mappings. It leaves existing mappings, quotes, payments, and orders untouched; `0006` is reserved for the separate refund/cancellation work. No production D1 write is performed locally. Main CI applies the migration and deploys after merge.

Sweatshirts use the existing owner-approved Clothing & Footwear tax code (`txcd_30011000`) and exclusive-tax USD pricing. A sweatshirt plus one $5 decal is exactly $50 and does not qualify for free shipping; two decals bring that merchandise subtotal to $55 and qualify in the lower 48. Existing paid-order prices and shipping snapshots are unchanged.

Matching $45 one-time product/price records were provisioned in both the isolated Bascik sandbox and the authenticated live Bascik Dashboard. The live runtime key intentionally cannot create products. Live API verification confirms all eight app-tagged catalog products, USD prices, exclusive-tax settings, the existing active tax registration, and the approved Printful store. No account-wide tax settings, existing prices, payments, or customer orders were changed.

| Design   | Live Stripe product   | Live $45 price                   |
| -------- | --------------------- | -------------------------------- |
| Logo     | `prod_VaWwGXQrTk2P6b` | `price_1UZLsUHv3b2E4ucMB9JAOJaX` |
| Insignia | `prod_VaWzYwiJgBK2C4` | `price_1UZLvtHv3b2E4ucMHmik9CWx` |

Regenerate the owner-supplied photos and listings offline:

```sh
cd shop
node scripts/import-sweatshirts.ts image-originals/sweatshirts
```

For a new download, pass the parent containing folders `109989489` and `109989447` instead. The importer preserves every supplied original PNG, uses the same shared image helper as the decals, and records hashes/dimensions/output bytes in the manifest. Each 1000×1000 source produces 320-, 640-, and 960-pixel WebP at quality 80 without upscaling, preserving transparency. All 28 gallery views are retained, with each color's flat front first. Repeated imports preserve existing product/variant IDs and yield identical catalog and manifest bytes.

Original-image cache filenames hash the complete source URL, including its version query. Reordering gallery entries cannot attach old cached bytes to new metadata; a replaced/versioned source gets its own cache file.

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

This command refuses live keys and mismatched account IDs. It paginates all products and each product's prices before creating missing app-tagged sandbox products or exclusive-tax USD prices, recording their IDs in `.local/stripe-readiness.json`. Incomplete pagination fails explicitly rather than treating missing results as permission to create duplicates. The checkout implementation currently creates equivalent inline price data from the owned catalog; the setup inventory is for dashboard administration, not a second source of prices. It does not alter the other business's Stripe objects or create tax registrations or webhook endpoints.

## Configuration and owner-controlled provisioning

Use `.dev.vars.example` as the variable-name reference. Keep local secrets ignored and production secrets in Cloudflare. Do not copy secret files into generated output or CI artifacts.

Required before enabling checkout:

- Confirm the Bascik sandbox identity, then separately configure live credentials at launch. `SHOP_MODE=test` only accepts test keys; `SHOP_MODE=live` requires live keys. Keep shared-account webhook objects tagged `app=bascik-shop` and scoped by `SHOP_ORIGIN`.
- Configure `STRIPE_WEBHOOK_SECRET` for `/api/webhooks/stripe`, receiving `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Stripe receipts need a receipt email; the code supplies one.
- Set a random, private `ORDER_TOKEN_SECRET` of at least 32 characters. Keep it stable; rotating it invalidates existing order links. Links expire after 90 days and can be individually revoked in D1.
- Set `TAX_CODE_SHIRT` and `TAX_CODE_HAT` to owner-reviewed Stripe tax codes. Configure Stripe Tax origin and applicable registrations; international service sales on the same Stripe account do not automatically settle physical-goods tax obligations. Product price, customer tax, Printful's charges to the business, and recipient customs duties are separate.
- Sandbox product setup rejects existing products whose tax code differs from the selected code instead of silently reusing them. Review and correct the tagged product before retrying.
- The separate Printful **Manual/API store** `19022802` is created and accessible. Preserve exact saved templates, artwork placements, print files, applicable options, and blank product variant IDs. Store IDs from the Shopify store cannot simply be reused in the new store.
- Use the refreshed `PRINTFUL_TOKEN` and `PRINTFUL_STORE_ID=19022802`, verify funding, and validate all 24 variants using unconfirmed v2 drafts without submitting production.
- All 24 store-scoped `printful_template_mappings` are installed independently in sandbox and production from the validated owner-approved templates. Keep them tied to store `19022802`. Never seed guessed IDs or rebuild these saved designs from incomplete legacy file metadata.
- Production D1 and processing/dead-letter queues are provisioned independently, with all three migrations and 24 validated template mappings installed. The production configuration remains commerce-disabled until the separate launch approval.
- Enable Cloudflare Email Sending on Workers Paid, verify sender-domain access and external delivery, and configure `EMAIL_FROM`, monitored `SUPPORT_EMAIL`, and `ALERT_EMAIL`. Preserve Gmail's existing MX. Review bounce-domain, SPF, DKIM, and DMARC additions rather than replacing incoming routing.
- Configure `/api/webhooks/printful` through `/v2/webhooks` on the **new** store only, saving its one-time signature secret securely. Subscribe to order and shipment lifecycle events, including hold removal. Do not overwrite the Shopify store's webhook configuration. A callback is only a hint; its content never directly changes fulfillment state without an authenticated Printful re-fetch.
- The owner-published refund, terms, and contact policies have been carried over from the existing Shopify shop, with privacy/platform disclosures updated for this implementation. Customer support and email replies use `shop@bascik.dev`; the owner confirmed this mailbox/alias is set up. Operator alerts retain their separate monitored address. No separate shipping policy existed at `/policies/shipping-policy`; `/shipping` combines the existing terms' delivery rules, real checkout quote behavior, and the published refund policy without adding delivery promises. The old `/policies/*`, `/pages/contact`, and `/pages/data-sharing-opt-out` URLs remain available. Source-of-truth policy text lives in `src/lib/policies.ts`, not generated pages. The privacy policy describes actual browser storage, provider sharing, no customer accounts/advertising, and order-link expiration without promising automatic record deletion. Remove the checkout prelaunch notice only after the remaining production gates pass.

`SHOP_ENABLED=true` opens quote/payment creation. `SHOP_FULFILLMENT_ENABLED=true` separately permits Printful submissions. Do not enable either on generic previews. Use separate sandbox D1, queues, webhook secrets, and sender restrictions for every preview that tests checkout. Stripe test mode alone does not prevent real Printful production.

### Draft-only PR commerce previews

Same-repository branch pushes with an open PR now deploy a dedicated shop Worker after Shop validation succeeds. PR events and forks never receive deployment secrets. The deployment verifies the PR head matches the pushed commit, creates `bascik-shop-pr-<number>` on Workers.dev with separate D1 and processing/dead-letter queues, imports the exact four template mappings, and registers a Stripe sandbox webhook at that PR's origin. Pushes without an open PR fail the preview gate rather than deploying an unassociated environment.

The `shop-preview` GitHub environment contains the dedicated Cloudflare token, sandbox Stripe key, Printful token, and an order-token seed. Runtime webhook secrets are generated separately per deployment; order-link signing keys are derived per PR. Secret files are temporary, never artifacts. Older Stripe webhook endpoints belonging to that same preview are retired only after successful replacement deployment; other businesses' endpoints are untouched.

These environments use real shipping quotes, Stripe sandbox Checkout, signed payment callbacks, and real **unconfirmed** Printful template drafts. The fulfilled test state is `test_draft`, displayed as “Nothing will be produced or shipped.” The scheduled reconciler handles missing payment callbacks; duplicate deliveries and concurrent consumers cannot create another draft.

New order references are 32-character hexadecimal UUIDs without separators, matching Printful's external ID limit. Older private order links remain readable.

Order pages keep polling through payment and asynchronous draft-cost calculation with a capped backoff, so the five-minute recovery sweep can finish without requiring a refresh. If the bounded polling window expires, the page explicitly asks the buyer to refresh.

**Production confirmation is blocked in test mode**, both in the order processor and the provider request helper. Only an explicitly live runtime may call Printful's confirmation endpoint. An unexpected production status on a test order raises an operator error. `SHOP_FULFILLMENT_ENABLED=true` on a test preview allows draft creation, never manufacturing. Test-mode notification sending is suppressed even if an email binding accidentally exists; no preview email binding is provisioned.

Printful has no documented order sandbox, and its Webhook Simulator does not support v2 webhooks. Shipment/tracking scenarios therefore use authenticated signed v2 events and simulated provider responses in automated tests, not an unsigned public test endpoint or changes to an actual draft's production status. Production tracking logic remains covered separately by live-mode fixtures.

CI comments the preview URL on the PR and records its D1/queue names and Stripe webhook ID in the run summary. The production hostname, live Stripe objects, and existing Shopify store are never changed. Preview resources persist across pushes to preserve test orders. After closing a PR, remove that PR's Worker, queues, D1 database, and tagged Stripe webhook endpoint; test drafts can be deleted while uncharged. Automatic teardown is not configured.

The authored `wrangler.jsonc` deliberately contains no custom-domain route. Packaging copies static assets and migrations into `.output/` with relative deployment paths and preserves Bascik's selective static-asset routing and security headers. This entire directory's deployable files, not just `worker.js`, travel through CI. Production resource IDs and domain ownership remain owner-controlled.

### Sandbox deployment through CI

The independent Shop workflow preserves shop-only CI filtering and always validates before deployment. Its separate disabled-commerce sandbox lane deploys when a maintainer manually runs the workflow on `main` with `deploy_sandbox=true`. Branch pushes with an open same-repository PR instead use the draft-only preview lane described above. Pull-request events do not deploy. The separate production prelaunch lane is documented above; no lane performs hostname cutover. Later branch pushes cancel older preview runs, but main runs cannot cancel an in-progress manual deployment between migration, secret installation, deployment, and safety probes.

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

- The shop collects delivery details for exact Printful shipping before redirecting to Stripe-hosted payment. The server accepts state names or codes, normalizes known names such as `Arizona` to Printful's required `AZ`, and rejects unknown states before contacting the provider. The shared validator supplies the canonical city for Singapore when omitted and still requires its postal code.
- Production Cloudflare Workers Logs persist shipping requests with cart product/variant IDs, variant descriptions, quantities, and destination country/state. Failures include the provider, HTTP status, provider path, and request correlation ID. Application logs exclude customer names, email, street addresses, postal codes, credentials, and raw provider responses. Printful address/cart rejections return an actionable 422 instead of a generic 502. Historical queries require Workers Observability Read permission; use the production Worker's Observability page to correlate requests and errors.
- Allowed countries use the intersection of Printful's product-specific shipping destinations for the items in the cart, excluding `CX`, `CC`, `HM`, and `NF`. The shop's country selector puts United States first after the placeholder. Refresh the committed destination snapshot from `shop/` with `node --env-file=.env.prd scripts/import-shipping-countries.ts`, then rebuild and test. Actual address and variant availability remain subject to the live Printful shipping quote.
- Quantities are limited to 10 per variant and 20 total items; quotes expire after 15 minutes. A created Stripe Session is valid for one hour. Prices and the destination/service are snapshotted. Address or cart edits invalidate the quote, including while a request is pending; customers request a fresh quote before paying. Processing or ambiguous payments go through authoritative order reconciliation.
- Stripe's signature is checked against the exact payload with a five-minute timestamp tolerance. A server-to-server retrieval then checks app, origin, environment, order, subtotal, shipping, tax state, and final total before payment is accepted.
- D1 transactions persist payment and notification intent before acknowledgment. Queue deliveries are hints; the five-minute scheduled sweep recovers paid work even if enqueueing fails and reconciles pending sessions if a payment webhook never arrives. Expired unpaid sessions never clear the cart. A short database lease prevents concurrent submissions.
- Printful orders use a stable external reference and are created as drafts before confirmation. On ambiguous submission, the worker queries that reference. If it cannot prove the result, it alerts an operator rather than blindly creating another order.
- Transient failures back off, honoring provider `Retry-After` seconds or HTTP dates. After bounded failures, the order or notification is marked for operator attention. Successful Printful polls reset the transient-attempt counter. Monitor `failed` orders, `failed` notifications, dead-letter messages, and structured logs independently of email.
- Orders are not fulfilled from the return page, and unpaid/delayed payments do not authorize production. Unrelated shared-account Stripe payments are ignored.
- Shipments may be partial; each distinct shipment gets a notification. Stripe receives `receipt_email`, but receipt availability does not prove inbox delivery or that automatic receipt emails are enabled. Cloudflare sends the shop's own confirmation, private status/print link, tracking updates, and failure alerts independently.
- Payment callbacks durably queue confirmation intent. Queue processing attempts customer email before manufacturing work, without waiting for the five-minute sweep; the sweep remains the retry and missed-queue fallback. Successful sends record the provider message ID and acceptance time, and log only those identifiers. A `sent` notification means provider acceptance, not proof of inbox delivery.
- Customer confirmations and shipment updates include branded HTML (dark Bascik masthead, actual Bascik logo, lime button, itemized purchase and payment summary), with a complete plain-text alternative. Packaging rasterizes the shared logo SVG to `/assets/bascik-email-logo.png` for email clients that do not support SVG; the image uses the order link's shop origin, explicit dimensions, and meaningful alternative text. There are no third-party images or tracking pixels, and purchase details remain readable when images are blocked. The sender display name is Bascik Shop, using `no-reply@bascik.dev` with replies directed to `shop@bascik.dev`. Dynamic text and links are HTML-escaped.
- The private order page displays a stable order number derived from the complete existing order ID, purchased items and variants, quantities, subtotal, selected shipping, and Stripe-verified tax and total paid. The same number appears in shop email. Migration `0004_order_confirmation.sql` adds verified payment totals and email acceptance metadata. Older paid orders acquire totals on their next authenticated payment reconciliation; until then, the page explicitly shows a before-tax total rather than inventing tax.
- Print confirmation hides navigation and private-link instructions, and removes the token fragment during native printing so browser headers do not expose the access token. The private URL is restored after printing.
- Email is not an exactly-once protocol. The app deduplicates normal notification work, but an ambiguous provider acceptance followed by a crash may require delivery reconciliation.
- JSON request bodies are streamed with a 16 KiB byte limit; signed webhook payloads use a 256 KiB byte limit. Oversized streams are cancelled before full buffering; signature verification retains the original accepted payload text.
- Shipped orders can receive later authenticated shipment updates without draft creation or confirmation. Signed callbacks schedule a provider re-fetch; recovery polling includes shipped orders for 90 days. New shipment IDs notify once, and already-shipped orders do not regress to submitted during reshipment.
- Order access uses an unguessable HMAC link in a URL fragment, not a public checkout ID. The browser POSTs it for status so it does not appear in ordinary request URLs. No-store responses expose order state, email status, purchased items, verified payment totals, and shipment tracking, but no customer address, email, payment identifiers, or artwork.

### First live order audit

The owner placed a real order on November 7, 2026. Read-only checks confirmed a paid live Stripe Session with matching shop metadata, verified merchandise/shipping/tax totals, and a payment receipt available. The matching Printful order was no longer a draft and was accepted for fulfillment; the shop recorded `submitted` with no fulfillment error. No duplicate order or charge was created by the audit. Customer details, live order IDs, and private access links are intentionally omitted here.

The shop confirmation was initially pending because email ran only in the scheduled sweep. The next five-minute sweep sent it successfully on its first attempt. This confirms provider acceptance, not mailbox delivery; check spam and provider delivery records if the customer cannot find it. Queue-triggered confirmation sending removes that normal initial delay. This audit does not yet certify completed manufacturing, shipping, or receipt of the parcel.

The owner subsequently confirmed receiving both the shop confirmation and Stripe receipt. Stripe's receipt used an outdated customer-facing support contact and default styling. Through the owner-authenticated Dashboard, **Settings > Business > Public details** was updated to `shop@bascik.dev` and `https://shop.bascik.dev/pages/contact`. **Settings > Business > Branding** now uses Bascik's colors (`#18191b` brand, `#d3ff8d` accent), the actual logo rasterized from the shared SVG, and a square icon containing that same logo. The logo preference and colors persisted after reloading, and the Email receipts preview showed the real logo. Unrelated legal, login, phone, and account details were unchanged. The Accounts update API rejects changes to your own account; it is for connected accounts, so use the Dashboard rather than creating a Connect account. Stripe owns its receipt layout; our HTML template does not replace it.

Inbound mail for `bascik.dev` uses Google (`smtp.google.com`). The owner confirmed `shop@bascik.dev` is set up. Maintain the mailbox/alias there, rather than replacing the MX records with Cloudflare Email Routing. Outbound Cloudflare Email Sending is independent of this incoming-mail setup.

### Operator recovery

For a failed order, compare the D1 order ID, Stripe payment/session, and Printful external reference before any replay. A confirmed duplicate payment must be refunded in Stripe; never create a second physical order to hide a mismatch. For an ambiguous Printful draft, verify the existing order and reconcile its ID before confirming it. Do not reset a failed row to `paid` until a human has proved there is no existing order or has repaired the original.

Use Stripe for refunds and Printful for production cancellation; one does not automatically undo the other. Check production status before promising cancellation. There is intentionally no public admin/replay endpoint.

Private checkout quotes without orders are removed after expiry plus one day. Order snapshots and notification records currently remain until an owner-approved retention procedure is implemented. Handle deletion requests through the published privacy policy and support process; do not delete records needed to reconcile accepted payments or outstanding fulfillment.

## Validation and deployment

The Shop workflow always typechecks and builds; a shared changed-workspace selector chooses the affected unit, real-D1 integration, and desktop/mobile Playwright suites. Schema migrations and unrecognized runtime configuration changes conservatively run every shop suite. After validation, trusted branch pushes deploy draft-only previews; main pushes deploy live production. Explicit main runs can redeploy production or the isolated disabled sandbox. The historical disabled-prelaunch option remains for prelaunch verification only. Shop-only changes avoid unrelated monorepo test suites and skip the CodeQL workflow; mixed changes run their affected suites. Shared compiler, adapter, dependency, and workflow changes also select the relevant shop suites. Scheduled CodeQL remains unaffected. Root validation aggregators include the shop.

Before launch, additionally test actual hosted sandbox Checkout, Stripe Tax destination behavior, failed/delayed payments, real external email delivery, and new-store Printful estimates/drafts. Local provider fixtures do not certify live integrations. Browser regressions cover shipping destination ordering, stale delivery details, provider errors, and safe Stripe redirects.

An embedded-form prototype was tested with real sandbox payments and Printful shipping, but was removed before merge in favor of the simpler hosted Checkout flow. It requires no beta form API, browser SDK, or additional checkout-state table. No live card charge or manufacturing confirmation was performed during that evaluation.

The final compiled hosted-checkout Worker was verified with ephemeral D1, real Printful shipping, and sandbox Stripe: a medium insignia shirt quoted successfully using `Arizona`, the Stripe Customer received `AZ`, the hosted Session used the exact selected Printful rate, and retrying reused the same unpaid Session. The Session was expired in cleanup. This check made no payment and had fulfillment, queues, and email disabled.

### Cloud sandbox failure and recovery verification

PR #129 was tested against its actual Cloudflare Worker and hosted Stripe sandbox Checkout:

- Decline card `4000 0000 0000 0002` displayed Stripe's declined-payment feedback. The order remained pending and unpaid.
- Returning through hosted Checkout's Back link preserved the browser cart. Explicit sandbox Session expiration delivered the real expiration callback; D1 marked the abandoned order expired, with no payment event, Printful order, or sent email.
- For one controlled test-card payment, the exact PR sandbox Stripe endpoint was temporarily disabled. Stripe reported paid while the shop still reported pending/unpaid. Cloudflare's scheduled sweep recovered it without the payment webhook, recorded one payment, and created unconfirmed Printful draft `185309465`. Its final state is `test_draft`, provider costs are done, and zero shop emails were sent. The PR endpoint was restored in cleanup and re-fetched as enabled. Production endpoints and commerce flags were not changed.

These checks used real sandbox provider responses, not mocked checkout pages. They demonstrate missed-webhook recovery after a card payment, not a real delayed-settlement bank payment. Unpaid completion followed by asynchronous success, asynchronous failure, and expiration are also covered by real-D1 integration tests with simulated provider responses. The separate no-charge production verification above covers real callbacks, email, and tax calculation. Actual paid manufacturing still requires an owner-approved real order, never the audit draft.

Only the owner or approved CI should deploy, upload previews, provision resources, or switch DNS. Build and dry-run validation do not transfer the hostname. The approved production environment is main-only, and the shop deploy remains separate from docs.

Keep Shopify active until all assets/artwork are independent, provider and policy gates pass, old orders have a handling plan, and a rollback route is documented. Rollback must not discard D1 orders or stop reconciliation of already accepted payments.

Closing `SHOP_ENABLED` stops new checkouts, not signed payment callbacks. Leave the Worker, scheduled trigger, email binding, database, and fulfillment setting available to process previously accepted orders, even if the public hostname is rolled back.
