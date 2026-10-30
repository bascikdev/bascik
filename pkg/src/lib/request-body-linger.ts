/**
 * @module request-body-linger
 *
 * Lingering close for rejected request bodies
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * When a body is rejected (over `http.maxBodySize`) while the client is still
 * uploading, closing at once makes the client's next write fail with
 * EPIPE/ECONNRESET and it never reads the 413. Like nginx's lingering close,
 * the transport keeps reading and discarding the rest of the body, bounded
 * by a byte cap, an idle cap and a total time cap, and closes only after
 * that.
 */
import type { Readable } from "node:stream";

/**
 * Most bytes the server reads and discards after rejecting a body. It only
 * needs to cover the rest of an upload that overshot the limit by a few
 * multiples (e2e sends 2 MiB against the 1 MiB default); a client still
 * sending past it is not going to stop, so the server stops paying bandwidth
 * for it and closes. On a link too slow to move 8 MiB quickly the time cap
 * below ends the drain first.
 */
export const LINGER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Longest the drain waits for the next chunk; every chunk restarts it. A
 * client that stalls (or declared a length it never sends, or is waiting
 * politely after a 413 it got before uploading) is closed after this much
 * silence. 5 s is nginx's `lingering_timeout` default, the same idle wait.
 * Restarting it per chunk, not timing the whole drain, is what lets a real
 * client on a slow uplink finish: 2 MiB over the limit at 2 Mbit/s takes
 * about 8 s, but never goes quiet for 5.
 */
export const LINGER_IDLE_MS = 5_000;

/**
 * Longest the server keeps reading a rejected body in total, however
 * steadily it trickles. It is what stops a slowloris that sends a byte
 * just inside every idle window. It is its own bound rather than the
 * server's `requestTimeout` (`http.timeouts.request`, 30 s by default but
 * configurable, see `nodeServerTimeouts` in server-lifecycle.ts), so raising
 * that timeout for slow legitimate uploads never lets a rejected body hold
 * the socket longer. 30 s is nginx's `lingering_time` default, the same
 * total bound, and covers a slow client finishing several MiB.
 */
export const LINGER_MAX_MS = 30_000;

export type DrainOutcome = "end" | "cap" | "gone";

/**
 * Reads and discards the rest of a request body, then reports why it
 * stopped: `end` (the body finished per its framing), `cap` (the byte, idle
 * or total cap was hit; the body is paused, never finished), or `gone` (the client
 * aborted). Calls `onSettled` exactly once.
 */
export const drainRequestBody = (
  body: Readable,
  onSettled: (outcome: DrainOutcome) => void,
  limits: { maxBytes: number; idleMs: number; maxMs: number } = {
    maxBytes: LINGER_MAX_BYTES,
    idleMs: LINGER_IDLE_MS,
    maxMs: LINGER_MAX_MS,
  },
): void => {
  if (body.readableEnded) {
    onSettled("end");
    return;
  }
  if (body.destroyed) {
    onSettled("gone");
    return;
  }
  let discarded = 0;
  let settled = false;
  const settle = (outcome: DrainOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    body.off("data", onData);
    body.off("end", onEnd);
    body.off("close", onGone);
    body.off("error", onGone);
    // Stop pulling bytes nobody will read; the close that follows a cap
    // releases whatever is still buffered.
    if (outcome === "cap") body.pause();
    onSettled(outcome);
  };
  const onData = (chunk: Buffer): void => {
    discarded += chunk.length;
    if (discarded > limits.maxBytes) settle("cap");
    else idleTimer.refresh();
  };
  const onEnd = (): void => settle("end");
  // `close` without a prior `end` is an aborted upload; `error` is the same
  // client going away mid-body.
  const onGone = (): void => settle("gone");
  const idleTimer = setTimeout(() => settle("cap"), limits.idleMs);
  const totalTimer = setTimeout(() => settle("cap"), limits.maxMs);
  // A lingering drain must never keep a shutting-down process alive.
  idleTimer.unref?.();
  totalTimer.unref?.();
  body.on("data", onData);
  body.once("end", onEnd);
  body.once("close", onGone);
  body.once("error", onGone);
  // The body's reader (the API runtime's pipe into a web stream) gave up at
  // the limit, but a pipe still attached would pause the body again on its
  // backpressure and the drain would read nothing until the time cap.
  body.unpipe();
  body.resume();
};

/**
 * Sockets whose request body was rejected and that close once the drain
 * settles. A request pipelined behind a rejected body is never served: the
 * connection is already promised closed (`Connection: close`), so running
 * its handler would be a side effect whose response can never be delivered.
 */
const lingeringSockets = new WeakSet<object>();

export const markLingeringSocket = (socket: object): void => {
  lingeringSockets.add(socket);
};

export const isLingeringSocket = (socket: object | null | undefined): boolean =>
  socket != null && lingeringSockets.has(socket);
