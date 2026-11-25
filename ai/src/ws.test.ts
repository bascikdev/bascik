import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptWebSocket, type ServerSocket } from "./ws.ts";

/** A masked frame, as a browser sends it. */
function clientFrame(payload: Buffer, opcode = 0x1, final = true): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = (final ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (final ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) {
    masked[index]! ^= mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * A socket the test drives: what it pushes is what the client sent, and
 * `sent` is what the server wrote. With `reading: false` the client never
 * reads, so whatever the server writes stays queued.
 */
function fakeSocket(reading = true): {
  socket: Duplex;
  sent: Buffer[];
  ended: Buffer[];
} {
  const sent: Buffer[] = [];
  const ended: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      sent.push(chunk);
      if (reading) callback();
    },
    final(callback) {
      callback();
    },
  });
  const end = socket.end.bind(socket);
  socket.end = ((chunk?: unknown) => {
    if (Buffer.isBuffer(chunk)) ended.push(chunk);
    return end();
  }) as typeof socket.end;
  return { socket, sent, ended };
}

function open(reading = true): {
  connection: ServerSocket;
  socket: Duplex;
  sent: Buffer[];
  ended: Buffer[];
  messages: string[];
} {
  const fake = fakeSocket(reading);
  const request = {
    headers: {
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      upgrade: "websocket",
    },
  } as unknown as IncomingMessage;
  const connection = acceptWebSocket(request, fake.socket)!;
  const messages: string[] = [];
  connection.onMessage = (text) => messages.push(text);
  return { connection, messages, ...fake };
}

/** The close code in the frame the server ended with. */
const closeCode = (ended: Buffer[]): number | undefined => {
  const frame = ended[0];
  if (!frame || (frame[0]! & 0x0f) !== 0x8) return undefined;
  return frame.readUInt16BE(2);
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptWebSocket", () => {
  it("reads a message whole, however it is split", () => {
    const { socket, messages } = open();
    const frame = clientFrame(Buffer.from("hello, reader"));
    for (const byte of frame) socket.emit("data", Buffer.from([byte]));
    socket.emit(
      "data",
      Buffer.concat([
        clientFrame(Buffer.from("one "), 0x1, false),
        clientFrame(Buffer.from("two"), 0x0, true),
        clientFrame(Buffer.from("three")),
      ]),
    );
    expect(messages).toEqual(["hello, reader", "one two", "three"]);
  });

  it("copies the bytes of a large frame a bounded number of times, however small the pieces", () => {
    const { socket, messages } = open();
    const size = 1_000_000;
    const frame = clientFrame(Buffer.alloc(size, 0x41));
    let copied = 0;
    const concat = Buffer.concat;
    vi.spyOn(Buffer, "concat").mockImplementation(((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      const joined = concat(list, totalLength);
      copied += joined.length;
      return joined;
    }) as typeof Buffer.concat);
    for (let at = 0; at < frame.length; at += 500) {
      socket.emit("data", frame.subarray(at, at + 500));
    }
    vi.restoreAllMocks();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.length).toBe(size);
    // Linear: a few copies of the frame, not one per piece received.
    expect(copied).toBeLessThan(size * 4);
  });

  it("answers a ping with a pong of the same payload", () => {
    const { socket, sent } = open();
    sent.length = 0;
    socket.emit("data", clientFrame(Buffer.from("are you there"), 0x9));
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(0x8a);
    expect(sent[0]!.subarray(2).toString()).toBe("are you there");
  });

  it("closes with 1002 on a control frame over 125 bytes", () => {
    const { socket, sent, ended, connection } = open();
    sent.length = 0;
    socket.emit("data", clientFrame(Buffer.alloc(126, 0x50), 0x9));
    expect(sent).toEqual([]);
    expect(closeCode(ended)).toBe(1002);
    expect(connection.open).toBe(false);
  });

  it("closes with 1002 on a fragmented control frame", () => {
    const { socket, sent, ended } = open();
    sent.length = 0;
    socket.emit("data", clientFrame(Buffer.from("ping"), 0x9, false));
    expect(sent).toEqual([]);
    expect(closeCode(ended)).toBe(1002);
  });

  it("stops reading while what it has to send is not taken", async () => {
    const { socket } = open(false);
    const ping = clientFrame(Buffer.alloc(125, 0x50), 0x9);
    // About 2.6 MB of pongs, if every ping were answered.
    for (let round = 0; round < 200; round++) {
      socket.push(Buffer.concat(Array.from({ length: 100 }, () => ping)));
    }
    for (let round = 0; round < 20; round++) await settle();
    expect(socket.writableLength).toBeLessThan(1_500_000);
    expect(socket.isPaused()).toBe(true);
  });

  it("reads again once the other side takes what was sent", async () => {
    // The other side holds each write until the test lets it through.
    const pending: (() => void)[] = [];
    const socket = new Duplex({
      read() {},
      write(_chunk: Buffer, _encoding, callback) {
        pending.push(callback);
      },
    });
    const request = {
      headers: { "sec-websocket-key": "a2V5", upgrade: "websocket" },
    } as unknown as IncomingMessage;
    const connection = acceptWebSocket(request, socket)!;
    const messages: string[] = [];
    connection.onMessage = (text) => messages.push(text);
    const ping = clientFrame(Buffer.alloc(125, 0x50), 0x9);
    for (let round = 0; round < 100; round++) {
      socket.push(Buffer.concat(Array.from({ length: 100 }, () => ping)));
    }
    socket.push(clientFrame(Buffer.from("after the pings")));
    for (let round = 0; round < 20; round++) await settle();
    expect(messages).toEqual([]);
    // The other side reads everything.
    while (pending.length) {
      for (const callback of pending.splice(0)) callback();
      await settle();
    }
    await expect
      .poll(() => messages, { timeout: 2000 })
      .toEqual(["after the pings"]);
  });
});
