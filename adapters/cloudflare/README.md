# @bascik/adapter-cloudflare

Cloudflare Pages and Workers Static Assets hosting adapter for [Bascik](https://bascik.dev).

## Overview

This adapter compiles Bascik request-time scripts and API routes into a Cloudflare Workers deployment bundle with asset routing.

See the [Cloudflare deployment guide](https://bascik.dev/how-to/cloudflare) for setup instructions, recipes, and limits.

## Variants

- `cloudflare-pages`: Outputs `public/_worker.js` and `public/_routes.json` for Cloudflare Pages.
- `cloudflare-workers`: Outputs `worker.js`, `wrangler.jsonc`, and `public/` for Cloudflare Workers with Static Assets.

## Compatibility Date

The adapter pins a supported Cloudflare compatibility date and `nodejs_compat` compatibility flag to ensure local workerd testing parity.
