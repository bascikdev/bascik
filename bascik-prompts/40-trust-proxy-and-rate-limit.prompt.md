# 40: Trust proxy and rate limiting

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts`, `pkg/src/lib/http.ts`, `pkg/src/lib/http2.ts`. Implements
`http.trustProxy` and the `http.rateLimit` object form, which prompt 03 declared without
behavior.

---

## Part 1: trust proxy

`http.trustProxy`, default `false`. It governs **two** things, and both are currently wrong.

### 1a. The rate-limit key

`remoteIp` comes from `reqMsg.socket.remoteAddress` (`http.ts#L14`) or
`stream.session.socket.remoteAddress` (`http2.ts#L20`).

**Behind any CDN, load balancer, or reverse proxy, every client shares one key.** The limiter
becomes a global cap that trivially self-DoSes the whole site: one busy visitor exhausts the
budget for everyone.

### Fix

When `trustProxy` is **on**, derive the client IP from `X-Forwarded-For`.

When it is **off**, **ignore that header entirely**. Never read it by default; that is how
spoofing gets in. A client can send any `X-Forwarded-For` it likes, and a limiter that trusts it
unconditionally is no limiter at all.

Decide how many proxy hops to trust. `X-Forwarded-For` is a comma-separated list appended to by
each hop, so the rightmost entries are the most trustworthy. A boolean `trustProxy` implies
"trust the immediate proxy", which means taking the **last** entry, not the first. If you want to
support a hop count, say so; if not, document the single-hop assumption explicitly, because
getting this backwards is a common and silent mistake.

### 1b. HSTS

`server.ts#L26-L35`:

```ts
const isHttps =
  req && req.headers
    ? req.headers[":scheme"] === "https" ||
      req.headers["x-forwarded-proto"] === "https"
    : false;
```

`x-forwarded-proto` is **fully client-controlled** when there is no proxy. **Any client can force
a one-year `includeSubDomains` HSTS header out of a cleartext server.**

Browsers ignore HSTS delivered over plain HTTP, so real-world impact is low, but the pattern is
wrong and it is the kind of thing a security review flags.

### Fix

Gate the `x-forwarded-proto` read on `trustProxy`. The `:scheme` pseudo-header from HTTP/2 comes
from the protocol itself and is trustworthy; it can stay ungated.

### While you are here

`getSecurityHeaders(req?)` takes an **optional** request but the fallback silently produces
**different headers**, which is an easy source of inconsistency between the normal path and the
`onError` path. Make the parameter required, or make the two paths provably identical.

---

## Part 2: rate limiting

`server.ts#L47-L73`.

| Problem                                | Detail                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixed window, not sliding**          | Two full bursts of 500 straddling a window boundary allow **1000 requests in about a millisecond**                                                 |
| **Not configurable**                   | `rateLimit` is boolean only; window and max are module constants. A docs site serving 40 subresources per page hits 500 in about **12 page loads** |
| **Unbounded memory between sweeps**    | An IPv6 /64 gives an attacker effectively unlimited distinct keys; 10 seconds of a spoofed-source flood grows the Map significantly                |
| **The sweep interval is module-scope** | It also runs during `bascik --build`, where it is dead weight. It is `unref`'d so it is harmless, but it should not be there                       |
| **No separate budget for SSE**         | The live-reload stream shares the page budget                                                                                                      |

### Fixes

**A sliding window.** A simple approach is a small ring of sub-windows, so the boundary burst is
smoothed without storing every timestamp.

**`http.rateLimit` as `boolean | { window?, max? }`**, using prompt 03's shared normalizer.
Preserve today's 500 per 10 seconds as the defaults, so behavior does not change for someone who
does not configure it.

**Bound the tracking structure** with an eviction policy. An attacker must not be able to grow it
without limit between sweeps. Decide what happens when the bound is hit: rejecting new keys
fails closed and is safer than evicting an existing one.

**Move the sweep interval** so it does not run during a build.

**Give SSE its own budget**, or exclude it. A developer with ten tabs open should not exhaust the
page budget.

### What stays

Dev remains unlimited (`server.ts#L154` guards on `isProdServer`). That is correct, but it means
the limiter is **never exercised locally**, which is why it has drifted. Cover it thoroughly in
tests.

---

## TDD steps

Write each failing test first.

1. **Off by default:** `X-Forwarded-For` is ignored, and the socket address is used.
2. **Off by default:** `x-forwarded-proto: https` does **not** produce an HSTS header.
3. **A spoofing attempt cannot influence the off case.** Send a forged header and assert the key
   is unchanged.
4. **On:** the rate-limit key comes from the forwarded header, taking the documented entry.
5. **On:** HSTS is emitted for a forwarded HTTPS request.
6. `:scheme` from HTTP/2 produces HSTS regardless of `trustProxy`.
7. `getSecurityHeaders` produces identical headers with and without a request, or the parameter
   is required.
8. **Sliding window:** two bursts straddling a boundary are limited, where a fixed window would
   allow them.
9. `http.rateLimit` object form honors `window` and `max`.
10. The tracking structure is bounded; a flood of distinct keys does not grow it without limit.
11. The documented behavior at the bound is correct.
12. The sweep interval does not run during a build.
13. SSE has its own budget, or is excluded.
14. Dev is unlimited.

## Testing

**Unit:** all of the above. Most of this is testable without a real server; keep it there.

**E2E:**

- `playwright.server.config.ts`: **the primary config.** Drive enough requests to trip the
  limiter and assert a 429, then assert recovery after the window. Then, with `trustProxy` on and
  two different forwarded addresses, assert one client tripping the limit does **not** affect the
  other. That second assertion is the whole point of trust proxy.
- `playwright.server-http2.config.ts`: the same limiter behavior, confirming parity.
- `playwright.dev.config.ts`: assert dev is **not** rate limited, since a developer refreshing
  rapidly must not be blocked.
- `playwright.config.ts` (static build): no new tests. No Bascik process. State that reasoning.

Prompt 37 and prompt 47 both add concurrency E2E work. Coordinate so the load-generation helper
is shared rather than written three times.

## Documentation

| File                               | Change                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/configuration.md`    | `http.trustProxy` and `http.rateLimit` object form, with defaults                                                                                                                           |
| `docs/content/deploying.md`        | **Behind a CDN or load balancer, set `trustProxy`.** Explain what breaks if you do not: the limiter becomes a global cap. Explain what breaks if you set it without a proxy: spoofable keys |
| `docs/content/internals/server.md` | The sliding window, the key derivation, the bound and its policy, and the SSE budget                                                                                                        |
| `docs/content/faq.md`              | "Why is my rate limit blocking everyone behind my CDN?"                                                                                                                                     |
| `docs/src/pages/assets/SKILL.md`   | Set `trustProxy` behind a proxy. Gotcha: do **not** set it otherwise. Sync `create/assets/SKILL.md`                                                                                         |

## Acceptance criteria

- [ ] All fourteen tests failed before their fixes and pass after.
- [ ] **`X-Forwarded-For` and `x-forwarded-proto` are ignored unless `trustProxy` is on.**
- [ ] A forged header cannot influence the off case.
- [ ] The trusted entry is documented and correct; the single-hop assumption is explicit.
- [ ] `getSecurityHeaders` is consistent with and without a request.
- [ ] The limiter is sliding, configurable, and bounded, with a documented policy at the bound.
- [ ] The sweep does not run during a build.
- [ ] SSE has its own budget or is excluded.
- [ ] Dev is unlimited.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E proves two forwarded clients are limited independently; the user has run `yarn e2e:all`.

## Do not do

- Do not read forwarded headers by default.
- Do not store every request timestamp. A ring of sub-windows is enough.
- Do not change compression or caching. Prompt 39.
- Do not add other security headers. **Prompt 45.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
