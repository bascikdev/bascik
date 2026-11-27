import fc from "fast-check";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptWebSocket,
  encodeFrame,
  refuseUpgrade,
  type AcceptOptions,
  type ServerSocket,
} from "./ws.ts";

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

describe("the frame codec", () => {
  /** The payload of the close frame the server ended with. */
  const closePayload = (ended: Buffer[]): Buffer | undefined => {
    const frame = ended[0];
    if (!frame || (frame[0]! & 0x0f) !== 0x8) return undefined;
    return frame.subarray(2);
  };
  const closeWith = (code: number, reason = ""): Buffer => {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    return clientFrame(body, 0x8);
  };

  it("reads a close frame the same at every place it can be split", () => {
    const frame = closeWith(1000, "bye");
    for (let at = 1; at < frame.length; at++) {
      const { socket, ended, connection } = open();
      socket.emit("data", frame.subarray(0, at));
      expect(connection.open, `split at ${at}`).toBe(true);
      socket.emit("data", frame.subarray(at));
      expect(connection.open, `split at ${at}`).toBe(false);
      // The answer is the code alone.
      expect(ended, `split at ${at}`).toEqual([
        Buffer.from([0x88, 0x02, 0x03, 0xe8]),
      ]);
    }
  });

  it("answers a ping the same at every place it can be split", () => {
    const frame = clientFrame(Buffer.from("hi"), 0x9);
    for (let at = 1; at < frame.length; at++) {
      const { socket, sent } = open();
      sent.length = 0;
      socket.emit("data", frame.subarray(0, at));
      expect(sent, `split at ${at}`).toEqual([]);
      socket.emit("data", frame.subarray(at));
      expect(sent, `split at ${at}`).toEqual([
        encodeFrame(Buffer.from("hi"), 0xa),
      ]);
    }
  });

  it("answers a close that has one byte of payload with 1002, not with that byte", () => {
    const { socket, ended } = open();
    socket.emit("data", clientFrame(Buffer.from([0x03]), 0x8));
    expect(closeCode(ended)).toBe(1002);
  });

  it("answers a close with no payload with one of its own", () => {
    const { socket, ended } = open();
    socket.emit("data", clientFrame(Buffer.alloc(0), 0x8));
    expect(ended).toEqual([Buffer.from([0x88, 0x00])]);
  });

  it.each([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 3000, 4999])(
    "answers close code %i with the same code",
    (code) => {
      const { socket, ended } = open();
      socket.emit("data", closeWith(code, "why"));
      expect(closeCode(ended)).toBe(code);
      expect(closePayload(ended)).toHaveLength(2);
    },
  );

  it.each([0, 999, 1004, 1005, 1006, 1012, 1015, 2999, 5000, 65_535])(
    "answers close code %i, which may not be sent, with 1002",
    (code) => {
      const { socket, ended } = open();
      socket.emit("data", closeWith(code));
      expect(closeCode(ended)).toBe(1002);
    },
  );

  it("answers a close whose reason is not UTF-8 with 1007", () => {
    const { socket, ended } = open();
    socket.emit(
      "data",
      clientFrame(Buffer.from([0x03, 0xe8, 0xff, 0xfe]), 0x8),
    );
    expect(closeCode(ended)).toBe(1007);
  });

  it.each([
    ["a byte no character has", [0xff]],
    ["a character cut short", [0x68, 0xc3]],
    ["half of a surrogate pair", [0xed, 0xa0, 0x80]],
    ["an overlong slash", [0xc0, 0xaf]],
  ])("closes with 1007 on text with %s", (_name, bytes) => {
    const { socket, ended, messages } = open();
    socket.emit("data", clientFrame(Buffer.from(bytes)));
    expect(messages).toEqual([]);
    expect(closeCode(ended)).toBe(1007);
  });

  it("reads a character split between two pieces of a message", () => {
    for (const text of ["café", "日本語", "a 😀 b"]) {
      const bytes = Buffer.from(text);
      for (let at = 1; at < bytes.length; at++) {
        const { socket, ended, messages } = open();
        socket.emit(
          "data",
          Buffer.concat([
            clientFrame(bytes.subarray(0, at), 0x1, false),
            clientFrame(bytes.subarray(at), 0x0, true),
          ]),
        );
        expect(messages, `${text} split at ${at}`).toEqual([text]);
        expect(ended).toEqual([]);
      }
    }
  });

  it("closes with 1007 when the pieces of a text message are not UTF-8 together", () => {
    const { socket, ended, messages } = open();
    socket.emit(
      "data",
      Buffer.concat([
        clientFrame(Buffer.from([0xe6, 0x97]), 0x1, false),
        clientFrame(Buffer.from("x"), 0x0, true),
      ]),
    );
    expect(messages).toEqual([]);
    expect(closeCode(ended)).toBe(1007);
  });

  it.each([
    ["a frame with no mask", () => encodeFrame(Buffer.from("plain")), 1002],
    [
      "a reserved bit",
      () => {
        const frame = clientFrame(Buffer.from("x"));
        frame[0]! |= 0x40;
        return frame;
      },
      1002,
    ],
    [
      "a 64-bit length over the cap",
      () => {
        const header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(2n ** 40n, 2);
        return header;
      },
      1009,
    ],
    [
      "a 64-bit length with its top bit set",
      () => {
        const header = Buffer.alloc(14);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(2n ** 63n, 2);
        return header;
      },
      1009,
    ],
  ])("closes on %s", (_name, frame, code) => {
    const { socket, ended, messages } = open();
    socket.emit("data", frame());
    expect(messages).toEqual([]);
    expect(closeCode(ended)).toBe(code);
  });

  it("sends no code it may not send, and a reason that fits a close frame", () => {
    const none = open();
    none.connection.close(1005, "nothing");
    expect(none.ended).toEqual([Buffer.from([0x88, 0x00])]);

    const long = open();
    long.connection.close(1000, "é".repeat(100));
    const payload = closePayload(long.ended)!;
    expect(payload.length).toBeLessThanOrEqual(125);
    expect(payload.readUInt16BE(0)).toBe(1000);
    // Cut on a whole character.
    expect(payload.subarray(2).toString()).toBe("é".repeat(61));
  });

  it("reads the same messages however the bytes are cut into reads", () => {
    const message = fc.oneof(
      fc.string(),
      fc.constantFrom("", "café", "日本語", "a 😀 b", "x".repeat(300)),
    );
    /** One message, as the pieces it is sent in and the pings between them. */
    const sending = fc.record({
      text: message,
      cuts: fc.array(fc.nat(), { maxLength: 3 }),
      ping: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(sending, { maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1 }),
        (sendings, sizes) => {
          const frames: Buffer[] = [];
          let pings = 0;
          for (const { text, cuts, ping } of sendings) {
            const bytes = Buffer.from(text);
            const at = [
              ...new Set(cuts.map((cut) => cut % (bytes.length + 1))),
            ].sort((a, b) => a - b);
            const edges = [0, ...at, bytes.length];
            for (let index = 0; index + 1 < edges.length; index++) {
              const last = index + 2 === edges.length;
              frames.push(
                clientFrame(
                  bytes.subarray(edges[index], edges[index + 1]),
                  index === 0 ? 0x1 : 0x0,
                  last,
                ),
              );
              if (ping && !last) {
                frames.push(clientFrame(Buffer.from("p"), 0x9));
                pings++;
              }
            }
          }
          const stream = Buffer.concat(frames);
          const { socket, sent, ended, messages } = open();
          sent.length = 0;
          let offset = 0;
          for (let turn = 0; offset < stream.length; turn++) {
            const size = sizes[turn % sizes.length]!;
            socket.emit("data", stream.subarray(offset, offset + size));
            offset += size;
          }
          expect(messages).toEqual(sendings.map(({ text }) => text));
          expect(sent).toHaveLength(pings);
          expect(ended).toEqual([]);
        },
      ),
    );
  });
});

describe("a connection's end, over a real socket", () => {
  const HANDSHAKE =
    "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
  let server: Server;
  const upgraded: Duplex[] = [];
  const clients: Socket[] = [];

  /** A server that hands each upgrade to `onUpgrade`; answers its port. */
  async function serving(
    onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): Promise<number> {
    server = createServer();
    server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => {});
      upgraded.push(socket);
      onUpgrade(request, socket, head);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as AddressInfo).port;
  }

  /** A server that accepts every upgrade; answers its port and its connections. */
  async function accepting(
    options?: AcceptOptions,
  ): Promise<{ port: number; accepted: ServerSocket[]; closes: number[] }> {
    const accepted: ServerSocket[] = [];
    const closes: number[] = [];
    const port = await serving((request, socket, head) => {
      const connection = acceptWebSocket(request, socket, head, options)!;
      connection.onClose = () => closes.push(Date.now());
      accepted.push(connection);
    });
    return { port, accepted, closes };
  }

  /**
   * A client that has shaken hands. It stays half open when the server
   * ends its side, as a client that has stopped paying attention does.
   */
  async function shaken(
    port: number,
  ): Promise<{ client: Socket; received: Buffer[]; closed: Promise<void> }> {
    const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    clients.push(client);
    client.on("error", () => {});
    const closed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(HANDSHAKE);
    const answer = await new Promise<Buffer>((resolve) =>
      client.once("data", resolve),
    );
    const received: Buffer[] = [];
    // Frames can follow the handshake's answer in one read.
    const rest = answer.subarray(answer.indexOf("\r\n\r\n") + 4);
    if (rest.length) received.push(rest);
    client.on("data", (chunk: Buffer) => received.push(chunk));
    return { client, received, closed };
  }

  /** Whether the server's `close` finishes, which it does once no socket is left. */
  const serverCloses = (): Promise<boolean> =>
    Promise.race([
      new Promise<boolean>((resolve) => server.close(() => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    for (const socket of upgraded.splice(0)) socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("notices a client that ends its side with no close frame", async () => {
    const { port, accepted, closes } = await accepting();
    const { client, closed } = await shaken(port);
    await expect.poll(() => accepted.length).toBe(1);
    client.end();
    await expect.poll(() => accepted[0]!.open, { timeout: 2000 }).toBe(false);
    expect(closes).toHaveLength(1);
    // The server's side is gone too, so the client's socket closes.
    await closed;
    expect(upgraded[0]!.destroyed).toBe(true);
  });

  it("pings, and ends a connection that sends nothing back", async () => {
    const { port, accepted, closes } = await accepting({
      idleMs: 200,
      pingMs: 40,
    });
    const started = Date.now();
    const { client, received } = await shaken(port);
    // This client holds its own side open, so it sees the server's end.
    await new Promise((resolve) => client.once("end", resolve));
    expect(accepted[0]!.open).toBe(false);
    expect(upgraded[0]!.destroyed).toBe(true);
    expect(closes).toHaveLength(1);
    expect(closes[0]! - started).toBeGreaterThanOrEqual(150);
    const all = Buffer.concat(received);
    // Pings first, then a close that says why.
    expect(all.subarray(0, 2)).toEqual(Buffer.from([0x89, 0x00]));
    expect(all.includes(Buffer.from("Idle"))).toBe(true);
  });

  it("keeps a connection that answers its pings", async () => {
    const { port, accepted } = await accepting({ idleMs: 200, pingMs: 40 });
    const { client } = await shaken(port);
    let pongs = 0;
    client.on("data", (chunk: Buffer) => {
      // Each read here is whole ping frames, two bytes each.
      for (let at = 0; at + 1 < chunk.length; at += 2) {
        if (chunk[at] === 0x89) {
          client.write(clientFrame(Buffer.alloc(0), 0xa));
          pongs++;
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(pongs).toBeGreaterThan(2);
    expect(accepted[0]!.open).toBe(true);
  });

  it("sets no timer for a connection with the idle guard off", async () => {
    const { port, accepted } = await accepting({ idleMs: 0 });
    const { received } = await shaken(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    expect(accepted[0]!.open).toBe(true);
  });

  it("destroys a refused upgrade the client never closes, so the server can stop", async () => {
    const port = await serving((_request, socket) =>
      refuseUpgrade(socket, 401, 50),
    );
    const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    clients.push(client);
    client.on("error", () => {});
    const answer = new Promise<string>((resolve) =>
      client.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    client.write(HANDSHAKE);
    expect(await answer).toContain("401 Unauthorized");
    // The client does nothing more, and holds its side open.
    expect(await serverCloses()).toBe(true);
    expect(upgraded[0]!.destroyed).toBe(true);
  });

  it("destroys a closed connection the client never closes, so the server can stop", async () => {
    const { port, accepted } = await accepting({ closeGraceMs: 50 });
    const { received } = await shaken(port);
    await expect.poll(() => accepted.length).toBe(1);
    accepted[0]!.close(1000, "Done");
    await expect
      .poll(() => Buffer.concat(received).includes(Buffer.from("Done")))
      .toBe(true);
    expect(await serverCloses()).toBe(true);
    expect(upgraded[0]!.destroyed).toBe(true);
  });

  it("destroys a connection whose client closed it and never hung up", async () => {
    const { port, accepted } = await accepting({ closeGraceMs: 50 });
    const { client } = await shaken(port);
    const body = Buffer.from([0x03, 0xe8]);
    client.write(clientFrame(body, 0x8));
    await expect.poll(() => accepted[0]?.open).toBe(false);
    expect(await serverCloses()).toBe(true);
  });

  it("ends a connection whose client stops reading, before much is kept for it", async () => {
    const { port, accepted } = await accepting({ maxUnsentBytes: 1_000_000 });
    const { client } = await shaken(port);
    await expect.poll(() => accepted.length).toBe(1);
    client.pause();
    const connection = accepted[0]!;
    const socket = upgraded[0]!;
    const piece = "a".repeat(64_000);
    let most = 0;
    // Up to 190 MB, were it all kept.
    for (let count = 0; count < 3000 && connection.open; count++) {
      connection.send(piece);
      most = Math.max(most, socket.writableLength);
      if (count % 20 === 0) await settle();
    }
    expect(connection.open).toBe(false);
    expect(socket.destroyed).toBe(true);
    // One message past the cap at most.
    expect(most).toBeLessThan(1_000_000 + 2 * 64_010);
  });

  it("gives no socket for a client that reset the connection before it was accepted", async () => {
    let answered: ServerSocket | null | undefined;
    const port = await serving((request, socket, head) => {
      // The caller was busy, as a relay is while it looks a ticket up.
      socket.once("close", () => {
        answered = acceptWebSocket(request, socket, head);
      });
    });
    const client = connect(port, "127.0.0.1");
    clients.push(client);
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write(HANDSHAKE);
    await expect.poll(() => upgraded.length).toBe(1);
    client.resetAndDestroy();
    await expect.poll(() => answered, { timeout: 2000 }).toBe(null);
  });
});
