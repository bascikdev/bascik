# @bascik/adapter-cloudflare

[![Unit lines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.lines.pct&label=unit%20lines&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)
[![Unit functions](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbascikdev%2Fbascik%2Fmain%2Fadapters%2Fcloudflare%2Ftest-coverage.json&query=%24.total.functions.pct&label=unit%20functions&suffix=%25&color=brightgreen)](https://github.com/bascikdev/bascik/blob/main/adapters/cloudflare/test-coverage.json)

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
