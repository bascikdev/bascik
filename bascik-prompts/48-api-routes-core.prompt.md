# 48: API routes, core

Read `.github/prompts/00-README.md` first.

**Scope:** new `pkg/src/lib/api-routes.ts` and `pkg/src/lib/api-runtime.ts`, plus
`pkg/src/lib/server.ts`, `http.ts`, `http2.ts`, `watch.ts`.

**Depends on prompt 46** for the registry and **prompt 47** for the wiring pattern.

**Security requirements are prompt 49.** This prompt is routing, the contract, and dispatch.

---

## Scope and honest framing

Before prompt 37, the production server answered `405 Method Not Allowed` to every non-GET
request. There is **no way to accept a form POST, return JSON, set a status code, or set a
response header.**

For anyone evaluating Bascik as a replacement for Next.js, that is a hard stop: almost every real
site has at least one endpoint.

### The tradeoff, stated plainly

After prompts 46, 47, and this one, Bascik is **also an application server that executes user
code in-process on every request**. That means an ongoing security posture. Prompt 49 is not
optional polish; it is the other half of this feature.

---

## Why this design fits

Check it against `docs/content/faq.md` before starting. Three things make it fit rather than
fight:

**1. It is already the stated model.** The FAQ says: "By default the output is fully static and
can be hosted anywhere. If you need per-request dynamic content, the production server lets you
run server-side scripts." A dynamic server mode already exists and is already documented.

**2. The API surface is a web standard Bascik does not own.** Handlers take a WHATWG `Request`
and return a WHATWG `Response`. Under the no-2.0-ever constraint this is the **safest possible
choice**: the contract is defined by the platform, so it cannot drift and cannot need a major
version. It is also the same contract as Cloudflare Workers, Deno Deploy, Bun, and Hono, so a
handler lifts into any of them unchanged. **That portability is a feature.**

**3. There is no trickery.** A route is a `.ts` file that exports a function. No decorators, no
context soup, no registration step, no codegen. You can unit test it by calling it with a
`Request` and asserting on the `Response`, with **zero mocking and without starting a server**.

---

## The handler contract

```ts
// src/api/contact.ts
export const POST = async (request: Request): Promise<Response> => {
  const { name, email } = await request.json();
  if (!email) {
    return Response.json({ error: "email is required" }, { status: 400 });
  }
  await sendEmail({ name, email });
  return Response.json({ ok: true }, { status: 201 });
};
```

Recognized exports: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`.

### The context argument

```ts
export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string },
): Promise<Response> => { … };
```

- `params`: route parameters from `[param]` segments. Empty object for static routes.
- `remoteIp`: **use the trust-proxy-aware value from prompt 40**, not the raw socket address, so
  a handler behind a CDN sees the real client.

**Nothing else.** No `env`, since this is Node and `process.env` exists. No `next`. No response
object to mutate. Adding a field later is additive; removing one is not.

### Method dispatch

- **The set of exported methods is the allowlist.**
- An unexported method gets **405 with a correct `Allow` header**. This falls out of the module
  shape with no configuration.
- **`HEAD` derives from `GET`** when not exported: run `GET`, send status and headers, discard
  the body. An explicit `HEAD` export wins.
- **`OPTIONS` auto-responds 204** with `Allow` when not exported. **Do not add any CORS
  headers.** Cross-origin policy is the author's decision.

### Response handling

- Return any `Response`. Status, headers, and body come from it.
- A `ReadableStream` body is **piped through**, so streaming and server-sent events work with no
  extra API.
- Security headers apply **first**, then handler headers **overwrite** them. The author must be
  able to set `content-type`, `cache-control`, `set-cookie`, or a route-specific CSP without
  fighting the framework.
- **`set-cookie` must survive as multiple header lines.** `Headers.getSetCookie()` is the correct
  accessor; **do not flatten it** into one comma-joined value.
- Returning a non-`Response` is a programming error: log it and respond 500.

### Do not compress API responses

Prompt 39 added static asset compression and page compression. **Do not extend either here.**

Compressing responses that mix attacker-influenced input with secrets is the **BREACH attack
class**, and doing it correctly requires per-route judgment. A handler that wants compression
sets `content-encoding` itself.

Prompt 39 was told to leave a marker for this exclusion. **Find it and make it real.**

---

## Routing

### File-based, in its own directory

`directory.api`, default `'src/api'`, declared by prompt 03.

```
src/api/health.ts            → /api/health
src/api/contact.ts           → /api/contact
src/api/users/index.ts       → /api/users
src/api/users/[id].ts        → /api/users/:id
src/api/[org]/repos/[id].ts  → /api/:org/repos/:id
```

**The URL prefix is `/api` regardless of the directory name**, so the public contract does not
change if someone renames the folder.

**Compose with `base` from prompt 23.** Under `base: '/sub/'` the routes live at `/sub/api/...`.
Test it.

### Reuse the `[param]` convention

Use the same bracket syntax and parsing helpers as `pkg/src/lib/routes.ts`. **One convention** for
dynamic segments across the whole tool.

Prompt 30 fixed route param URL-safety and defined a single slugification rule. **Reuse it**; do
not invent a second.

### Precedence and collisions

Static segments beat dynamic ones: `src/api/users/me.ts` wins over `src/api/users/[id].ts` for
`/api/users/me`.

**Two files resolving to the same route is an error**, consistent with prompt 25's duplicate
component names and prompt 30's route collisions. Name both files.

### Where dispatch goes in the pipeline

**After** rate limiting, path presence, `decodeURIComponent`, the traversal guard, prompt 10's
dot-segment guard, and prompt 23's base strip.

**Before** the GET/HEAD method guard, since accepting other methods is the entire point.

**Re-read the current guard order** rather than trusting any line numbers; prompts 10, 23, 40,
and 43 all touched it.

Note prompt 43 added body draining on rejected methods. Coordinate so API paths, which **do** read
bodies, are not drained out from under the handler.

### Zero cost when unused

If `directory.api` does not exist: **no scanning, no module loading, no added latency.** Assert
with a test comparing handler behavior with and without the directory.

---

## Execution

**Consume prompt 46's registry.** Do not build a second execution model.

If the registry's interface does not fit, **extend the shared runtime rather than forking it**. A
security fix in one must apply to the other.

**Already decided in prompt 46, do not reopen:** a child process per request and a
`worker_threads` pool were both rejected, with recorded reasoning.

### The consequence to document

In-process means a handler shares the process with the server. An infinite loop blocks the event
loop for every other request; a native crash takes the process down.

Prompt 47 documented this for server scripts. **Cross-link rather than duplicating.**

---

## Build and dev behavior

### `bascik --build`

API routes cannot exist in static output. When `directory.api` contains route files, **warn once**
at the end of the build:

```text
warning: 3 API routes found in src/api/ but static builds cannot serve them.
  Deploy with `bascik --server`, or port them to your host's function runtime.
  Routes: /api/health, /api/contact, /api/users/[id]
```

**Do not fail the build.** A mixed project that builds statically for previews and serves
dynamically in production is legitimate.

### Dev

API routes must work in dev **exactly** as in production, including method dispatch and params.
Environment parity is a stated design property.

Adding, editing, or deleting a route file must take effect **without a restart**, using prompt
46's dev invalidation. Watch `directory.api` in `watch.ts`.

---

## Non-goals: do not build these

Each is an opinion that belongs to the author, not the tool.

- **Middleware.** No `_middleware.ts`, no chains, no `next()`. Compose plain functions.
- **Body parsers and validation.** No schema layer, no automatic parsing.
- **CORS configuration.** Return the headers you want.
- **Authentication or sessions.** Read the cookie header.
- **Database or ORM integration.** Import your own client.
- **A typed RPC client or codegen.** No build artifacts, no generated types, no client SDK.
- **Route groups, layouts, or nested config files.** One file, one route.
- **Automatic response compression.** See above.
- **Serverless adapters.** Handlers are already portable because they are standard `Request` and
  `Response`; that portability **is** the adapter.
- **An `env` argument.** `process.env` exists.
- **Extending `data-bascik-server` to handle POST.** Wrong tool. Server scripts return HTML
  fragments and cannot set status or headers.

If a user needs one of these, they write ten lines of ordinary TypeScript. That is the point.

---

## TDD steps

Write each failing test first.

1. **Route matching, pure, no I/O.** `health.ts` maps to `/api/health`; `index.ts` maps to the
   directory path; single and multiple `[param]` segments with params extracted in order; static
   beats dynamic; **duplicate routes error** naming both files; non-matching paths return no
   route; trailing slashes, encoded segments, Windows separators, nested directories.
2. Composition with `base`.
3. **Request construction:** method, URL, and headers map correctly; **HTTP/2 pseudo-headers are
   excluded**; `context.params` and `context.remoteIp` populated, with `remoteIp` respecting
   `trustProxy`.
4. Each exported method routes correctly.
5. An unexported method returns **405 with an accurate `Allow` header**.
6. **`HEAD` derives from `GET`**: correct status and headers, empty body. An explicit `HEAD`
   export wins.
7. **`OPTIONS` auto-responds 204** with `Allow` and **no CORS headers**.
8. Status, headers, and body are written from the returned `Response`.
9. Handler headers **override** security headers.
10. **Multiple `set-cookie` values survive as separate headers.**
11. A `ReadableStream` body streams through.
12. A non-`Response` return yields 500 and a server-side log.
13. **No automatic `content-encoding`** is added, and prompt 39's negotiation does not catch this
    path.
14. Dispatch runs **before** the method guard, so `POST /api/x` reaches the handler.
15. A non-API POST still returns 405.
16. A path matching no API route **falls through to page handling unchanged**.
17. **With no `src/api/` directory, behavior is byte-identical to before this prompt.**
18. `--build` warns and does not fail.
19. Adding, editing, and deleting a route file take effect in dev without a restart.

## Testing

**Unit:** all of the above. Keep route matching **pure** so it tests without disk.

**E2E:** run against **all four** configs.

- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: **the primary configs.**
  POST JSON and get JSON back with a custom status; 405 with `Allow` on a wrong method; a cookie
  round-trip with **two** `set-cookie` headers; a streaming response; identical behavior on both
  protocols; routes work under `base`.
- `playwright.dev.config.ts`: the same set, proving parity, plus hot reload of a route file.
- `playwright.config.ts` (static build): assert the **build warning** appears and the build
  succeeds. Assert no route file appears in the output; prompt 49 owns the deeper source-leak
  assertions.

## Documentation

| File                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/content/api-routes.md` **(new page)** | Plus `docs/src/pages/api-routes.html` and a sidebar entry. In this order: (1) a complete working example in the first screen, lead with code; (2) file-based routing and `[param]`; (3) method exports, the automatic `Allow` header, `HEAD` and `OPTIONS`; (4) the `Request` and `Response` contract and **the portability argument**; (5) the context argument; (6) errors and what the client sees; (7) **testing a handler by calling it directly with a `Request`, no server and no mocks**, which is a genuine selling point and deserves real estate; (8) the static-build limitation; (9) **what Bascik deliberately does not provide**, from the non-goals, with the ten-line workarounds |
| `docs/content/server.md`                    | How API routes and `data-bascik-server` differ and when to use each, now that they share a runtime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/content/configuration.md`             | `directory.api`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `docs/content/deploying.md`                 | Static hosting cannot serve API routes; deploy with `--server` or port handlers to a function runtime, **which is easy precisely because they are standard `Request` and `Response`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/content/switch.md`                    | A Next.js API route to Bascik comparison. **This is where the migration argument lands**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/content/compatibility.md`             | **Required by repo policy.** Supported methods, streaming, `set-cookie`, and the **non-goals marked unsupported with reasons**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `docs/content/faq.md`                       | "Can Bascik handle form submissions?", "Do I need a separate backend?", "Why no middleware?"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/content/testing/*.md`                 | Testing handlers without a server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/content/internals/server.md`          | Where dispatch sits and how it rides on prompt 46's registry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/src/pages/assets/SKILL.md`            | Default-first: a route is a `.ts` file exporting `GET` or `POST`. Gotchas: no middleware, no CORS by default, static builds cannot serve routes, handlers run in-process. Sync `create/assets/SKILL.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**Naming:** prompt 53 requires a page h1 to equal its sidebar label. **Match from the start.**

## VS Code extension

Scoped to files under `directory.api`, see `.github/skills/bascik-vscode-extension/SKILL.md`:

- **error**: no recognized method export.
- **warning**: a lowercase or mixed-case export that looks like a method (`post`, `Get`).
- **warning**: a handler whose return type is not `Response` or `Promise<Response>`.

A test for each.

## Acceptance criteria

- [ ] All nineteen tests failed before their fixes and pass after.
- [ ] A `.ts` file exporting `GET` or `POST` under `src/api/` is served with **no registration
      step**.
- [ ] Handlers receive a standard `Request` and return a standard `Response`.
- [ ] `context.remoteIp` respects `trustProxy`.
- [ ] 405 carries an accurate `Allow`; `HEAD` derives; `OPTIONS` auto-responds with **no CORS**.
- [ ] Handler headers override security headers; **multiple `set-cookie` values survive**.
- [ ] `ReadableStream` bodies stream; **no automatic compression**.
- [ ] Duplicate routes **error**, naming both files.
- [ ] Routes compose with `base`.
- [ ] Dispatch is before the method guard and after every other guard.
- [ ] **With no `src/api/` directory, behavior is byte-identical to before.**
- [ ] `--build` warns and does not fail; routes hot-reload in dev.
- [ ] Handlers run through **prompt 46's registry**, not a second model.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] **No npm dependency was added.** `Request`, `Response`, `Headers`, and `Readable.toWeb` are
      built into Node 24.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] The new page's h1 matches its sidebar label; `compatibility.md` updated; both SKILL.md
      copies in sync.
- [ ] The extension has three passing diagnostic tests.
- [ ] **Nothing from the non-goals list was implemented.**

## Do not do

- Do not implement anything in the non-goals list.
- Do not build a second execution model.
- Do not compress API responses or add CORS headers.
- Do not add npm dependencies.
- Do not implement body limits, timeouts, or source protection. **Prompt 49.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
