import { createServer, type IncomingMessage } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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

function open(
  reading = true,
  head?: Buffer,
): {
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
  const connection = acceptWebSocket(request, fake.socket, head)!;
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

  it("holds about one copy of a frame's bytes, however many reads it comes in", () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const { socket, messages } = open();
    // A frame declared at 4 MB, whose body then arrives a byte per read.
    const declared = 3_999_000;
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(declared), 2);
    socket.emit("data", header);
    const reads = 200_000;
    const body = Buffer.alloc(reads, 0x41);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let at = 0; at < reads; at++) {
      socket.emit("data", body.subarray(at, at + 1));
    }
    gc();
    const grown = process.memoryUsage().heapUsed - before;
    expect(messages).toEqual([]);
    // Every read kept as its own piece would hold over 200 bytes each.
    expect(grown).toBeLessThan(10_000_000);
  });

  it("does not set aside the whole declared length before the bytes arrive", () => {
    const { socket } = open();
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(3_999_000n, 2);
    const alloc = vi.spyOn(Buffer, "allocUnsafe");
    const allocated = (): number =>
      alloc.mock.calls.reduce((sum, [size]) => sum + Number(size), 0);
    socket.emit("data", header);
    socket.emit("data", Buffer.alloc(10, 0x41));
    expect(allocated()).toBeLessThan(100_000);
  });

  it("sets nothing aside for a declared length until its bytes arrive, and little for the first few", () => {
    const { socket, messages } = open();
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(4_000_000n, 2);
    const unsafe = vi.spyOn(Buffer, "allocUnsafe");
    const unsafeSlow = vi.spyOn(Buffer, "allocUnsafeSlow");
    const zeroed = vi.spyOn(Buffer, "alloc");
    const allocated = (): number =>
      [unsafe, unsafeSlow, zeroed].reduce(
        (sum, spy) =>
          sum +
          spy.mock.calls.reduce((total, [size]) => total + Number(size), 0),
        0,
      );
    // A header on its own: 14 bytes on the wire must not hold kilobytes.
    socket.emit("data", header);
    expect(allocated()).toBeLessThan(64);
    // One byte of payload sets aside a small first room, not 64 KB.
    socket.emit("data", Buffer.from([0x41]));
    expect(allocated()).toBeLessThanOrEqual(4096 + 64);
    vi.restoreAllMocks();
    expect(messages).toEqual([]);
  });

  it("still reads small and large frames whole after the room grows from nothing", () => {
    const { socket, messages } = open();
    socket.emit("data", clientFrame(Buffer.alloc(0)));
    socket.emit("data", clientFrame(Buffer.from("z")));
    const big = clientFrame(Buffer.alloc(70_000, 0x42));
    for (let at = 0; at < big.length; at += 3) {
      socket.emit("data", big.subarray(at, at + 3));
    }
    expect(messages).toEqual(["", "z", "B".repeat(70_000)]);
  });

  it("closes a message split into too many pieces, empty ones counted", () => {
    for (const piece of [Buffer.alloc(0), Buffer.from("a")]) {
      const { socket, ended, connection } = open();
      socket.emit("data", clientFrame(Buffer.from("start"), 0x1, false));
      const continuation = clientFrame(piece, 0x0, false);
      socket.emit(
        "data",
        Buffer.concat(Array.from({ length: 5000 }, () => continuation)),
      );
      expect(closeCode(ended)).toBe(1009);
      expect(connection.open).toBe(false);
    }
  });

  it("still reads a message split into a few hundred pieces", () => {
    const { socket, messages } = open();
    const parts = Array.from({ length: 300 }, (_, index) =>
      clientFrame(Buffer.from("x"), index === 0 ? 0x1 : 0x0, index === 299),
    );
    socket.emit("data", Buffer.concat(parts));
    expect(messages).toEqual(["x".repeat(300)]);
  });

  it("closes with 1002 on pieces of a message out of order", () => {
    const cases: Buffer[] = [
      // A continuation with no message started.
      clientFrame(Buffer.from("lost"), 0x0, true),
      // A new message before the last one ended.
      Buffer.concat([
        clientFrame(Buffer.from("one"), 0x1, false),
        clientFrame(Buffer.from("two"), 0x1, true),
      ]),
      // An opcode RFC 6455 reserves.
      clientFrame(Buffer.from("odd"), 0x3, true),
      clientFrame(Buffer.from("odd"), 0xb, true),
    ];
    for (const input of cases) {
      const { socket, ended, messages } = open();
      socket.emit("data", input);
      expect(closeCode(ended)).toBe(1002);
      expect(messages).toEqual([]);
    }
    // Reserved bits, set without an extension that defines them.
    const { socket, ended } = open();
    const frame = clientFrame(Buffer.from("rsv"));
    frame[0]! |= 0x40;
    socket.emit("data", frame);
    expect(closeCode(ended)).toBe(1002);
  });

  it("answers a ping between the pieces of a message", () => {
    const { socket, sent, messages } = open();
    sent.length = 0;
    socket.emit(
      "data",
      Buffer.concat([
        clientFrame(Buffer.from("one "), 0x1, false),
        clientFrame(Buffer.from("hi"), 0x9),
        clientFrame(Buffer.from("two"), 0x0, true),
      ]),
    );
    expect(messages).toEqual(["one two"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(0x8a);
  });

  it("reads frames that came with the handshake, before what follows", async () => {
    const both = Buffer.concat([
      clientFrame(Buffer.from("first")),
      clientFrame(Buffer.from("second")),
    ]);
    // The second frame is cut, and the rest arrives as the socket's data.
    const { socket, messages } = open(true, both.subarray(0, both.length - 3));
    socket.emit("data", both.subarray(both.length - 3));
    await settle();
    expect(messages).toEqual(["first", "second"]);
  });

  it("reads a frame sent in the same write as the handshake, over a real socket", async () => {
    const server = createServer();
    const received: string[] = [];
    const upgraded: Duplex[] = [];
    server.on("upgrade", (request, socket, head) => {
      upgraded.push(socket);
      const accepted = acceptWebSocket(request, socket, head)!;
      accepted.onMessage = (text) => received.push(text);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const client = connect(port, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => client.once("connect", resolve));
      client.write(
        Buffer.concat([
          Buffer.from(
            "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
          ),
          clientFrame(Buffer.from("with the handshake")),
        ]),
      );
      await expect
        .poll(() => received, { timeout: 2000 })
        .toEqual(["with the handshake"]);
    } finally {
      client.destroy();
      // An upgraded socket is no longer the HTTP server's to close.
      for (const socket of upgraded) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
