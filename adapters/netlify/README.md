# @bascik/adapter-netlify

Netlify Functions hosting adapter for [Bascik](https://bascik.dev).

## Overview

This adapter serves a Bascik site from Netlify: the CDN serves every static file, and one Netlify Function (Functions API v2, streaming) runs the `data-bascik-server` and `data-bascik-stream` scripts, the component tags they return (rendered with the component's markup and scoped CSS), and the API routes in `src/api/`. Install it in a Bascik project that deploys to Netlify (Node.js 24.21 or newer), or start one with `npm create bascik my-site -- --template netlify`:

```sh
npm install --save-dev @bascik/adapter-netlify
```

See the [Netlify deployment guide](https://bascik.dev/deployment/netlify) for the full workflow.

## Quickstart

Develop with Netlify Dev, source watching, and browser live reload:

```sh
bascik --target netlify
```

Open `http://127.0.0.1:8888`; use `--port` and `--host` to override the public address. Bascik runs full production adapter builds, installs the generated output for Netlify, starts Netlify Dev, and proxies the runtime over local HTTP. Source edits rebuild and reload connected browsers. Requests can receive 503 while rebuilding or after a failed build; the watcher stays alive and retries after the next edit. The proxy is HTTP only, regardless of the Node server's TLS configuration. Live reload is injected by the local proxy, never written into production artifacts. Bare `bascik` remains the Node development server.

Build, then copy the output to the places Netlify reads:

```sh
bascik --build --target netlify && bascik-netlify-install
```

Bascik only accepts adapter output inside `dist/.bascik/<target>/`, so `bascik-netlify-install` is a separate step. It replaces `publish/` with the static files and writes the function to `.netlify/v1/functions/bascik-pages.mjs`, where Netlify's Frameworks API picks it up next to your own `netlify/functions/`.

The installer reads `directory.out` from your project's build configuration (`dist` by default), never falling back to an old `dist/` build when a custom output is missing. If the build uses `--config <path>`, pass the same flag to `bascik-netlify-install`. Before changing either destination, it refuses overlap with configured pages, component roots, API sources, `scripts.importRoot`, or the adapter build itself, including symlink aliases. Keep `publish/` and the generated function outside those source roots.

```toml
# netlify.toml
[build]
  command = "npm run build"   # the two commands above
  publish = "publish"

[build.environment]
  BASCIK_SITE_URL = "https://example.com"
```

Add `publish/` and `.netlify/` to `.gitignore`.

## What the Function Serves

- **Routes:** the function's `config.path` lists each dynamic page's clean, `.html` and trailing-slash URL, and each API route as a URLPattern path (`/api/items/[id]` is `/api/items/:id`, a final `[...rest]` is `*`), with `preferStatic: false`.
- **Parity:** pages, streamed pages, rendered components and API routes produce the same status, body bytes and headers as `bascik --server`; `src/parity.integration.test.ts` compares the two on every change.
- **Responses:** `private, no-store` on dynamic pages, the build's security headers and opt-in Content-Security-Policy, and `X-Bascik-Handler: bascik-pages` on everything the function answers.
- **Static headers:** the build writes `publish/_headers` with the security headers and each static page's Content-Security-Policy. An authored `_headers` is kept as written (Netlify combines matching rules and cannot remove a header), and the build warns. HSTS is left to Netlify.
- **Request context:** scripts and API routes get `context.platform` as `{ name: "netlify", context, waitUntil }`, where `context` is Netlify's request Context, and `context.remoteIp` is the client address Netlify reports.
- **Errors:** follow `scripts.onServerScriptError`. With `"error"`, a server script failure is your `500.html` or a plain 500 page; a stream script failure after the shell is sent leaves its slot empty.

## Logs

The function writes JSON lines that `netlify logs --function bascik-pages` shows:

| `event`                           | When                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `module.loaded`                   | The function starts cold.                                                     |
| `request.start`                   | First statement of every invocation, before graph setup or any script import. |
| `script.start`, `script.complete` | Each server and stream script, with its id, mode and duration.                |
| `script.error`, `request.error`   | A failure, with the message and stack.                                        |

One more line per request (no `event` field) records the method, path, status, duration, `buffered` or `stream`, the `x-nf-request-id`, and each cookie's name and size. Cookie values, query strings and headers other than the request id are never logged. Streamed requests are logged when the stream finishes, through `context.waitUntil`.

Netlify delivers log text several minutes after a request; until then the CLI shows the record with an empty message. Wait before treating a blank message as missing logs.

To trace a failing request, take the browser's `x-nf-request-id` and look for its `request.start`. If it is still missing after logs arrive, check the selected deploy and time window. A platform failure before invocation is one possibility, but absent logs alone do not prove that the function never ran; Netlify support can investigate the request id.

## Netlify Identity: Keep Tokens Small

Netlify decodes Identity tokens (the `nf_jwt` cookie, or an `Authorization` header) into function context. Large metadata has been associated with platform `Internal Error. ID: ...` responses across functions. No exact Netlify token-size limit or underlying platform mechanism has been established from this observation; do not treat AWS Lambda's context limit as a verified Netlify limit.

Google sign-in is the common cause. It stores a long `avatar_url` (often over 1 kB) in `user_metadata`, and the token carries all of `user_metadata`. On a deployed site, a Google-created account failed on every function with 1,171 bytes of `user_metadata`, while email accounts with 29 bytes worked; dropping the avatar fixed it.

If you do not display the avatar, drop it on signup and on every login with Identity event functions:

```ts
// netlify/lib/identity-metadata.ts
export function compactUserMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (metadata?.avatar_url == null) return null;
  // null, not omission: Identity deletes null keys when it merges metadata.
  return { ...metadata, avatar_url: null };
}
```

```ts
// netlify/functions/identity-login.ts
import { compactUserMetadata } from "../lib/identity-metadata.ts";

export default async (req: Request): Promise<Response> => {
  const { user } = await req.json();
  const userMetadata = compactUserMetadata(user.user_metadata);
  return userMetadata
    ? Response.json({ user_metadata: userMetadata })
    : new Response(null, { status: 200 });
};
```

Return the same `user_metadata` from `identity-signup` for new users. An affected user is fixed after signing out and back in. Keep other large data out of `app_metadata` and `user_metadata` too.

## Developing and testing this adapter

The permanent fixture in `e2e/fixture/` deploys to
[netlify-adapter.bascik.dev](https://netlify-adapter.bascik.dev/).
It is independent of application projects and contains synthetic data only.
Run these commands from the monorepo root on Node 24:

```sh
yarn adapter:nf:unit          # Runtime, installer and real-build/Node parity tests
yarn adapter:nf:e2e           # Build and test through offline Netlify Dev + Chromium
yarn adapter:nf:e2e:dev       # Real watched platform runtime and browser reload tests
yarn adapter:nf:demo:dev      # Watched adapter dev with browser reload on port 9877
yarn adapter:nf:demo:deploy   # Build and deploy ONLY the dedicated test project
yarn adapter:nf:demo:test     # Run the same suite against the deployed HTTPS origin
yarn adapter:nf:demo:logs     # Dedicated project's recent bascik-pages JSON logs
```

Install Chromium once with `yarn workspace @bascik/adapter-netlify exec playwright install chromium`.
The CLI and browser runner are workspace dev dependencies; no global CLI is required.
Before the watched lane, run `yarn pkg:build && yarn adapter:nf:build`. It uses `adapters/e2e/playwright.dev.config.ts` and real Netlify Dev; CI runs it separately from production acceptance. `yarn adapter:e2e:dev` runs both platforms after building both adapters.
`demo:dev` runs from the fixture root. The E2E lane instead builds once and runs the workspace's `demo:serve` script, the direct offline Netlify Dev preview, so acceptance tests exercise production responses without proxy live-reload injection.
`NETLIFY_ADAPTER_TEST_URL=https://<alias>--bascik-netlify-adapter.netlify.app yarn adapter:nf:e2e`
tests a dedicated-project preview without starting a local server. Other projects' hosts
are rejected by the test config.

The suite covers CDN/static bypass, scoped client scripts, request-time components
(props, slots, nested scripts, CSS), SSR aliases and escaping, actual streaming with
JavaScript disabled, API methods/params/catch-all precedence, Netlify context/cookie
transport, native-function coexistence, security/CSP headers, errors, timeouts, and
private-path handling. Error routes intentionally generate diagnostics.

Both adapters also run one [shared demo browser contract](https://github.com/bascikdev/bascik/blob/main/adapters/e2e/demo-contract.test.ts)
against their real runtimes. The canonical routes and titles match Cloudflare:
`/`, `/server?name=collin`, `/stream`, `/stream-append`, `/mixed`, `/catalog`,
`/catalog-stream`, `/api-demo`, `/errors`, and `/static`. The `/static` page
demonstrates scoped client scripts and independent counters; the overview only
links to the demos. The legacy `/components` fixture
remains available for existing links. Netlify context, cookies, and native
functions retain their separate platform-specific assertions.

Netlify Dev collapses repeated URL slashes before invoking the function. The
shared contract verifies that `/api/files/a//b` either rejects the malformed path
or resolves exactly as the normalized `/api/files/a/b`; encoded separators,
invalid encoding, and null bytes must still be rejected with HTTP 400.

One assertion is hosted-only: Netlify Dev 27.14.2 retries function 403 responses as
static-file candidates and ultimately returns 404. The suite explicitly skips the
exact foreign-origin 403 check locally and runs it against Netlify. CLI versions
follow the repository's seven-day release-age gate.

`bascik --check` reports one intentional CSP warning: the static-only counter
uses per-instance IDs. Its compiled static script hashes are covered and tested;
it is never returned from server/stream script output. The runtime-rendered card
uses stable class-only scripts.

This is **not** an Identity, database, OAuth or payment-service test. Those services
are application integrations and need their own isolated resources and credentials
if added later. Never reuse an application's users, secrets, or database here.
See [the deployment runbook](https://github.com/bascikdev/bascik/blob/main/DEPLOYMENT.md#netlify-adapter-acceptance-project).
