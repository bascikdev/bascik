/**
 * Response sink listener ownership tests.
 *
 * Scope: `createResponseSink` listener ownership on a synthetic
 * `BascikResponse` fixture only (synthetic transport). This is not a real
 * network transport test and makes no claim about real socket backpressure,
 * HTTP/1.1 or HTTP/2 wire semantics, or whole-process memory bounds.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createResponseSink } from "./response-sink.ts";
import type { BascikResponse } from "./server.ts";

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

describe("response sink listener ownership", () => {
  it("dispose removes the close listener so a long-lived response does not accumulate listeners", () => {
    const { response, emitter } = makeSyntheticResponse(true);
    const sink = createResponseSink(response, new AbortController());
    expect(emitter.listenerCount("close")).toBe(1);
    sink.dispose();
    expect(emitter.listenerCount("close")).toBe(0);
  });

  it("releases the drain listener once a backpressured write settles", async () => {
    const { response, emitter, written } = makeSyntheticResponse(false);
    const sink = createResponseSink(response, new AbortController());
    const pending = sink.write(Buffer.from("exact"));
    expect(emitter.listenerCount("drain")).toBe(1);
    emitter.emit("drain");
    await pending;
    expect(emitter.listenerCount("drain")).toBe(0);
    expect(Buffer.concat(written).toString("utf8")).toBe("exact");
    sink.dispose();
  });

  it("aborts on client disconnect and stops writing further bytes", async () => {
    const { response, emitter, written } = makeSyntheticResponse(true);
    const abort = new AbortController();
    const sink = createResponseSink(response, abort);
    await sink.write(Buffer.from("exact"));
    response.destroyed = true;
    emitter.emit("close");
    expect(abort.signal.aborted).toBe(true);
    await sink.write(Buffer.from("more"));
    expect(Buffer.concat(written).toString("utf8")).toBe("exact");
    sink.dispose();
  });
});
