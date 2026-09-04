/**
 * @module response-sink
 *
 * Backpressure-aware writer over a `BascikResponse` for streamed
 * server-script responses (prompt 66). Protocol-neutral: `server-scripts.ts`
 * only sees `{ write(buf): Promise<void> }`.
 *
 * - A `false` return from `res.write()` means Node queued the chunk; the
 *   next write waits for `drain` (or `close`) instead of growing the queue
 *   without bound under a slow reader.
 * - Client disconnect (`close`) aborts the shared AbortController so every
 *   unfinished script job is cancelled through `ScriptRegistry.invoke`'s
 *   `options.signal`, and all further writes become no-ops.
 * - `dispose()` removes the `close` listener so a long-lived response object
 *   does not accumulate listeners across requests.
 */
import type { BascikResponse } from "./server.ts";
import type { ResponseSink } from "./server-scripts.ts";

export interface DisposableResponseSink extends ResponseSink {
  dispose(): void;
}

export const createResponseSink = (
  res: BascikResponse,
  abort: AbortController,
): DisposableResponseSink => {
  const onClose = (): void => {
    if (!abort.signal.aborted) abort.abort(new Error("client disconnected"));
  };
  res.on("close", onClose);

  return {
    async write(buf: Buffer): Promise<void> {
      if (res.destroyed || abort.signal.aborted) return;
      if (res.write(buf)) return;
      // Queued past highWaterMark: pause production until the socket drains.
      // Also resolve on close so a disconnected client never leaves this
      // promise pending.
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    },
    dispose(): void {
      res.off("close", onClose);
    },
  };
};
