# 42: Server-sent events

Read `.github/prompts/00-README.md` first.

**Scope:** `pkg/src/lib/server.ts` (the SSE branch), `pkg/src/lib/live-reload.ts`,
`pkg/src/lib/watch.ts`, `pkg/src/lib/events.ts`, `pkg/src/lib/serve.ts`.

This is the live-reload transport. Everything here affects developer experience, not production
traffic, with one exception noted in part 5.

---

## Bug 1: there is no heartbeat

`server.ts#L283-L349` writes `data: connected` once and then **nothing until a rebuild**.

Any proxy, VPN, or corporate firewall with an idle timeout silently drops the connection, and
**live reload stops working with no visible error**. The developer saves a file, nothing happens,
and there is no way to tell why.

Worse: `.github/skills/bascik-server-architecture/SKILL.md` **documents a 15 to 30 second comment
heartbeat that does not exist in the code**. An agent reading that file will confidently describe
behavior Bascik does not have.

### Fix

Implement the heartbeat. Then the documentation becomes true.

A comment line is the conventional mechanism, since it is ignored by `EventSource` and keeps the
connection warm. Pick an interval in the documented range.

`logAccess` skips the SSE path (`#L148`) with a comment about "noisy SSE keep-alive pings",
describing pings that do not exist. After this fix the comment becomes accurate.

---

## Bug 2: backpressure is ignored

`res.write()`'s return value is ignored at `#L308` and `#L334`.

A wedged client that stops reading causes **unbounded kernel and Node buffering**, with no
backpressure handling and no forced close. One stuck browser tab can grow the server's memory
indefinitely.

### Fix

Honor the return value. When a write returns `false`, wait for `drain`. If a client stays
un-drained past a threshold, **close it**. A live-reload client that cannot keep up with a
handful of small messages is not a client worth keeping.

---

## Bug 3: no connection cap

Cleanup is correct for the normal path: `#L343-L348` removes all three listeners and untracks the
open page, and `setMaxListeners(0)` (`events.ts#L8`) is the right call for an unbounded fan-out.

But a client that **half-closes without emitting `close`** retains three closures plus the
response object **indefinitely**. N tabs multiplied by M reloads with a failing `close` retains
N times M response objects.

### Fix

Add a **connection cap** and an **idle timeout**. The heartbeat from bug 1 gives you a natural
liveness signal: a connection whose heartbeat write fails is dead.

---

## Bug 4: there is no error channel

Every watch handler ends in `.catch(onWatchError)` and a `console.error` (`watch.ts#L29`). The
watcher survives, which is good, but:

- **The previous successful HTML stays in memory**, so the browser continues serving the old page.
- SSE only ever transmits `data: reload` (`#L322-L336`). There is **no `data: error` channel and
  no build-error overlay**.

So the developer saves a broken file, sees the **unchanged** page, and must watch the terminal to
learn why. That is the single worst thing about the current developer experience.

Prompt 12 made the dev server **survive** a bad page and recover on the next save. This prompt
makes the failure **visible**.

### Fix

Add an error event. Send the error message, the file, and the position when available.

Add a **minimal overlay** in the injected client script. Keep it small: this ships to every dev
page and must not become a framework. A fixed-position panel with the message and a dismiss
control is enough. It must disappear on the next successful build.

Reuse `cleanStackTrace` from `pkg/src/lib/stack-trace.ts` so the message is readable.

**Do not leak paths to a production client.** This is dev-only by construction, but assert it.

---

## Bug 5: `HEAD` opens a full stream

`HEAD /bascik-live-reload` opens a full SSE stream, because the `isHead` check at `#L157` does not
short-circuit this branch.

A `HEAD` request should return headers and end. As written, a monitoring tool probing with `HEAD`
holds a stream open forever.

---

## What is already correct: do not break it

**The live-reload script does not ship to production.** `processing.ts#L974-L976` gates injection
on `!isBuild`, and the endpoint 404s when `isProdServer` (`#L285-L289`). This is covered by
`processing.test.ts#L955` and `server.test.ts#L999`.

**Do not change that.** But add one backstop:

`--server` reads output produced by `--build`, so the guard holds. However `BASCIK_BUILD` is
env-overridable at `config.ts#L7`, so a mismatched invocation could in principle ship the script.
**Add a runtime strip in `serve.ts`** as defense in depth, with a test.

---

## TDD steps

Write each failing test first.

1. A heartbeat is written on the documented interval.
2. The heartbeat is a comment line and does not trigger the client's message handler.
3. A write returning `false` causes a wait for `drain` rather than more writes.
4. A client that stays un-drained past the threshold is closed.
5. The connection cap is enforced; a connection beyond it is rejected cleanly.
6. An idle connection with no successful heartbeat is reaped.
7. A build error produces a `data: error` event carrying a readable message.
8. The overlay renders on error and clears on the next successful build.
9. `HEAD /bascik-live-reload` returns headers and ends, without opening a stream.
10. The live-reload script is **absent** from `--build` output.
11. The endpoint 404s under `--server`.
12. `serve.ts` strips the script even if a page somehow contains it.

## Testing

**Unit:** all of the above that can be tested without a browser.

**E2E:** this is the prompt where dev E2E does the real work.

- `playwright.dev.config.ts`: **the primary config.**
  - Edit a source file and assert the page reloads. That is the baseline that must keep working.
  - **Introduce a syntax error and assert the overlay appears with a readable message.** Then fix
    the file and assert the overlay clears and the page updates. That is the bug-4 proof and
    pairs with prompt 12's recovery test.
  - Open several tabs, close them, and assert the server does not retain connections. If
    observing retention from Playwright is impractical, cover it at the unit level and say so.
- `playwright.config.ts` (static build): assert the live-reload client script and the endpoint
  reference are **absent** from every page in the output.
- `playwright.server.config.ts` and `playwright.server-http2.config.ts`: assert the endpoint
  returns 404 and no page contains the client script.

Use `data-testid` on the overlay so it can be asserted without depending on class names.

## Documentation

| File                                                 | Change                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docs/content/developer-experience.md`               | The build-error overlay and what it shows. The heartbeat, so someone behind a corporate proxy knows why reload works now |
| `docs/content/internals/server.md`                   | The SSE lifecycle: heartbeat, backpressure, cap, idle reaping, and the error channel                                     |
| `.github/skills/bascik-server-architecture/SKILL.md` | **The heartbeat it documents now exists.** Correct any remaining claims about behavior that does not exist               |
| `docs/content/faq.md`                                | "Why did live reload stop working?" covering the proxy idle-timeout case                                                 |
| `docs/src/pages/assets/SKILL.md`                     | Build errors surface in the browser in dev. The live-reload script never ships. Sync `create/assets/SKILL.md`            |

## Acceptance criteria

- [ ] All twelve tests failed before their fixes and pass after.
- [ ] A heartbeat fires on the documented interval and keeps a connection alive.
- [ ] Backpressure is honored; a wedged client is closed.
- [ ] A connection cap and idle reaping exist.
- [ ] **A build error surfaces in the browser as an overlay** and clears on the next success,
      proven by a dev E2E.
- [ ] `HEAD` does not open a stream.
- [ ] The live-reload script is absent from build output, the endpoint 404s under `--server`, and
      `serve.ts` strips it as a backstop.
- [ ] The overlay ships **only** in dev.
- [ ] `yarn unit:all`, `yarn typecheck:all`, `yarn check:spelling` pass.
- [ ] E2E added to all four configs; the user has run `yarn e2e:all`.
- [ ] The server architecture skill file no longer documents a heartbeat that does not exist.

## Do not do

- Do not build a large error overlay. Keep it minimal; it ships to every dev page.
- Do not ship the overlay or the client script to production.
- Do not remove the existing production guards.
- Do not change the watcher itself. **Prompt 44.**
- Do not run Playwright, bind a port, or `curl` in the sandbox.
