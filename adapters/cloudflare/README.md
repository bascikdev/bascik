# @bascik/adapter-cloudflare

Cloudflare Workers with Static Assets and Cloudflare Pages hosting adapter for [Bascik](https://bascik.dev).

## Overview

This adapter compiles Bascik request-time scripts and API routes into a Cloudflare Workers deployment bundle with static asset routing.

See the [Cloudflare deployment guide](https://bascik.dev/deployment/cloudflare) for setup instructions, recipes, and limits.

## Targets and Variants

- `cloudflare` / `cloudflare-workers` (Default): Outputs `worker.js`, `wrangler.jsonc`, and `public/` for Cloudflare Workers with Static Assets.
- `cloudflare-pages` (Legacy): Outputs `public/_worker.js` and `public/_routes.json` for Cloudflare Pages.

## Quickstart

Build for Cloudflare Workers with Static Assets:

```sh
bascik --build --target cloudflare
```

Preview locally with Wrangler from the emitted target directory:

```sh
cd dist/.bascik/cloudflare
npx wrangler dev
```

Deploy with Wrangler:

```sh
cd dist/.bascik/cloudflare
npx wrangler deploy
```

## Compatibility Date

The adapter pins a supported Cloudflare compatibility date and `nodejs_compat` compatibility flag to ensure local workerd testing parity.
