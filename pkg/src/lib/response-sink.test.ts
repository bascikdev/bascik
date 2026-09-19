/**
 * Packet R1: response sink ownership and repetition tests.
 *
 * Scope: `createResponseSink` listener ownership on a synthetic
 * `BascikResponse` fixture only (synthetic transport).
 * This is not a real network transport test and makes no claim about real
 * socket backpressure, HTTP/1.1 or HTTP/2 wire semantics, or whole-process
 * memory bounds.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createResponseSink } from "./response-sink.ts";
import type { BascikResponse } from "./server.ts";

/** Asserts the synthetic response left no `close`/`drain` listener behind, naming whichever is retained. */
const assertReleased = (emitter: EventEmitter, context?: string): void => {
  const prefix = context ? `${context}: ` : "";
  expect(emitter.listenerCount("close"), `${prefix}retained "close" listener`).toBe(0);
  expect(emitter.listenerCount("drain"), `${prefix}retained "drain" listener`).toBe(0);
};

/** Makes a typed synthetic `BascikResponse` fixture backed by a real `EventEmitter`. */
const makeSyntheticResponse = (writeReturns: boolean): { response: BascikResponse; emitter: EventEmitter; written: Buffer[] } => {
  const emitter = new EventEmitter();
  const written: Buffer[] = [];
  const response: BascikResponse = {
    headersSent: false,
    destroyed: false,
    writable: emitter as unknown as NodeJS.WritableStream,
    respond: () => {},
    write: (chunk: string | Buffer): boolean => {
      written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
      return writeReturns;
    },
    end: () => {},
    close: () => {},
    on: (event, cb) => {
      emitter.on(event, cb);
    },
    off: (event, cb) => {
      emitter.off(event, cb);
    },
  };
  return { response, emitter, written };
};

describe("synthetic response sink ownership (R1)", () => {
  it("ownership oracle: rejects omitted sink disposal (retains close listener)", () => {
    // Failing oracle verification first: this test expects assertReleased to FAIL when disposal is omitted.
    const { response, emitter } = makeSyntheticResponse(true);
    const abort = new AbortController();
    const sink = createResponseSink(response, abort);
    try {
      // Intentionally omitting sink.dispose() here: assertReleased MUST throw because "close" listener is retained.
      expect(() => assertReleased(emitter)).toThrow(/retained "close" listener/);
    } finally {
      sink.dispose();
      assertReleased(emitter);
    }
  });

  it("ownership oracle: rejects retained test-owned listener (negative control)", () => {
    const { response, emitter } = makeSyntheticResponse(true);
    const abort = new AbortController();
    const sink = createResponseSink(response, abort);
    sink.dispose();

    // Injected retained test-owned listener: verify rejection
    const testListener = () => {};
    emitter.on("close", testListener);
    try {
      expect(() => assertReleased(emitter)).toThrow(/retained "close" listener/);
    } finally {
      emitter.off("close", testListener);
      assertReleased(emitter);
    }
  });

  it.each(["completed", "drain", "disconnect"] as const)(
    "100 sink cycles on synthetic transport release listeners and exact bytes (%s)",
    async (kind) => {
      for (let cycle = 0; cycle < 100; cycle++) {
        const label = `kind=${kind} cycle=${cycle}`;
        const { response, emitter, written } = makeSyntheticResponse(kind === "completed");
        const abort = new AbortController();
        const sink = createResponseSink(response, abort);
        let completedNormally = false;
        const pending = sink.write(Buffer.from("exact"));

        try {
          if (kind !== "completed") {
            expect(emitter.listenerCount("drain"), `${label}: expected one drain listener`).toBe(1);
            if (kind === "disconnect") {
              response.destroyed = true;
              emitter.emit("close");
            } else {
              emitter.emit("drain");
            }
          }
          await pending;

          // Assert actual settled drain ownership on intended path before artificial cleanup
          expect(emitter.listenerCount("drain"), `${label}: drain listener must be released on settled write`).toBe(0);

          expect(Buffer.concat(written).toString("utf8"), `${label}: expected exact bytes written`).toBe("exact");
          expect(abort.signal.aborted, `${label}: abort state`).toBe(kind === "disconnect");
          if (kind === "disconnect") {
            const before = written.length;
            await sink.write(Buffer.from("more"));
            expect(written.length, `${label}: expected no additional bytes written after disconnect`).toBe(before);
            // On disconnect, the response close event was already emitted; dispose removes the listener
            sink.dispose();
            assertReleased(emitter, label);
          } else {
            // On completed and drain paths, assert close ownership and dispose cleanly
            expect(emitter.listenerCount("close"), `${label}: expected close listener retained prior to disposal`).toBe(1);
            sink.dispose();
            assertReleased(emitter, label);
          }
          completedNormally = true;
        } finally {
          if (!completedNormally) {
            // Forced close and cleanup reserved strictly for test failure cleanup
            if (emitter.listenerCount("drain") > 0) {
              emitter.emit("drain");
            }
            emitter.emit("close");
            try {
              await pending;
            } finally {
              sink.dispose();
            }
          }
        }
      }
    },
  );
});
