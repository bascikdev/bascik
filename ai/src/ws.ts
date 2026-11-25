/**
 * The server side of a WebSocket, for text messages, with no dependency:
 * the handshake and the framing (RFC 6455). It is what a voice relay needs
 * to accept a browser, and what a stand-in provider needs in a test. It is
 * not a general WebSocket server: no extensions, no compression, and a
 * binary message is read as text.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Messages a relay passes are audio in pieces; nothing honest is larger than this. */
const MAX_MESSAGE_BYTES = 4_000_000;
/**
 * How much the server may have written that the other side has not taken
 * before it stops reading from that side, until the backlog drains.
 */
const MAX_UNSENT_BYTES = 1_000_000;
/**
 * How many frames one message may come in. A browser sends a message in
 * one frame; the cap counts empty frames, which add nothing to the size.
 */
const MAX_PIECES = 1024;
/** Room set aside for a payload before its bytes arrive; it grows as they do. */
const FIRST_ROOM_BYTES = 65_536;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface ServerSocket {
  /**
   * Send one message. `binary` sends the same text in a binary frame, as
   * some providers do. Nothing is sent once the socket has closed.
   */
  send(text: string, binary?: boolean): void;
  /** Close, with a status code and a short reason the other side can read. */
  close(code?: number, reason?: string): void;
  /** Set these to hear from the other side. */
  onMessage: (text: string) => void;
  onClose: () => void;
  readonly open: boolean;
}

/** One unmasked frame, as a server sends it. */
export function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Refuse an upgrade request with a plain HTTP answer. */
export function refuseUpgrade(socket: Duplex, status: number): void {
  const text = status === 401 ? "Unauthorized" : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * Answer an HTTP upgrade request and return the open socket, or null when
 * the request is not a WebSocket handshake (it is refused with a 400).
 * Pass the `head` of the server's `upgrade` event: frames a client sends
 * in the same read as its handshake arrive there, not as socket data.
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head?: Buffer,
): ServerSocket | null {
  const key = request.headers["sec-websocket-key"];
  if (
    typeof key !== "string" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    refuseUpgrade(socket, 400);
    return null;
  }
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let open = true;
  const shut = (): void => {
    if (!open) return;
    open = false;
    connection.onClose();
  };
  const connection: ServerSocket = {
    onMessage: () => {},
    onClose: () => {},
    get open() {
      return open;
    },
    send(text, binary = false) {
      if (open) {
        socket.write(
          encodeFrame(Buffer.from(text, "utf8"), binary ? 0x2 : 0x1),
        );
      }
    },
    close(code = 1000, reason = "") {
      if (!open) return;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason.slice(0, 100)));
      body.writeUInt16BE(code, 0);
      body.write(reason.slice(0, 100), 2);
      socket.end(encodeFrame(body, 0x8));
      shut();
    },
  };

  /** Stop reading while the other side is not taking what is sent to it. */
  const keepUp = (): void => {
    if (!open || socket.isPaused()) return;
    if (socket.writableLength <= MAX_UNSENT_BYTES) return;
    socket.pause();
    socket.once("drain", () => {
      if (open) socket.resume();
    });
  };

  /**
   * Reading copies bytes as they arrive, into a header of at most 14 bytes
   * and then into the frame's payload. No read is kept past its own event,
   * so what a connection holds is the bytes of its message, however small
   * the reads are.
   */
  const header = Buffer.alloc(14);
  let headerHave = 0;
  /** The frame whose payload is arriving, once its header is read. */
  let frame: {
    opcode: number;
    final: boolean;
    mask: Buffer;
    length: number;
    payload: Buffer;
    have: number;
  } | null = null;
  /** The pieces of a text or binary message that has not ended yet. */
  let pieces: Buffer[] = [];
  let size = 0;
  let inMessage = false;

  /** How long the header is, once its first two bytes are known. */
  const headerLength = (): number => {
    const short = header[1]! & 0x7f;
    return (short === 126 ? 4 : short === 127 ? 10 : 2) + 4;
  };

  /** Check a whole header and start its frame; false when the call ended. */
  const startFrame = (): boolean => {
    const first = header[0]!;
    const opcode = first & 0x0f;
    const final = (first & 0x80) !== 0;
    const short = header[1]! & 0x7f;
    let length: number;
    if (short === 126) length = header.readUInt16BE(2);
    else if (short === 127) {
      const long = header.readBigUInt64BE(2);
      if (long > BigInt(MAX_MESSAGE_BYTES)) {
        connection.close(1009, "Message too big");
        return false;
      }
      length = Number(long);
    } else length = short;
    // A client has to mask what it sends; one that does not is not a browser.
    if ((header[1]! & 0x80) === 0) {
      connection.close(1002, "Unmasked frame");
      return false;
    }
    // No extension is agreed, so no reserved bit may be set.
    if ((first & 0x70) !== 0) {
      connection.close(1002, "Reserved bits set");
      return false;
    }
    if (opcode >= 0x8) {
      // A control frame is short and whole (RFC 6455, section 5.5).
      if (opcode > 0xa || length > 125 || !final) {
        connection.close(1002, "Bad control frame");
        return false;
      }
    } else {
      // A message starts with text or binary and goes on with continuations.
      if (opcode > 0x2 || (opcode === 0x0) !== inMessage) {
        connection.close(1002, "Bad data frame");
        return false;
      }
      if (size + length > MAX_MESSAGE_BYTES) {
        connection.close(1009, "Message too big");
        return false;
      }
      // Each piece is counted, empty ones too, so a message cannot be made
      // of endless pieces that each add nothing to its size.
      if (pieces.length >= MAX_PIECES) {
        connection.close(1009, "Message in too many pieces");
        return false;
      }
    }
    const at = headerLength() - 4;
    frame = {
      opcode,
      final,
      mask: Buffer.from(header.subarray(at, at + 4)),
      length,
      // Room grows with what arrives, so a declared length alone sets
      // nothing aside.
      payload: Buffer.allocUnsafe(Math.min(length, FIRST_ROOM_BYTES)),
      have: 0,
    };
    headerHave = 0;
    return true;
  };

  /** Act on a frame whose payload has all arrived. */
  const endFrame = (): void => {
    const { opcode, final, payload, length } = frame!;
    frame = null;
    const body =
      payload.length === length ? payload : payload.subarray(0, length);
    if (opcode === 0x8) {
      socket.end(encodeFrame(body.subarray(0, 2), 0x8));
      shut();
      return;
    }
    if (opcode === 0x9) socket.write(encodeFrame(body, 0xa));
    if (opcode >= 0x8) return;
    pieces.push(body);
    size += length;
    inMessage = true;
    if (final) {
      const whole =
        pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, size);
      pieces = [];
      size = 0;
      inMessage = false;
      connection.onMessage(whole.toString("utf8"));
    }
  };

  /** Read one chunk, in as many frames or parts of frames as it holds. */
  const read = (chunk: Buffer): void => {
    let offset = 0;
    while (open) {
      if (!frame) {
        const need = headerHave < 2 ? 2 : headerLength();
        if (headerHave < need) {
          if (offset >= chunk.length) return;
          const count = Math.min(need - headerHave, chunk.length - offset);
          chunk.copy(header, headerHave, offset, offset + count);
          headerHave += count;
          offset += count;
          continue;
        }
        if (!startFrame()) return;
      }
      const current = frame!;
      if (current.have < current.length) {
        if (offset >= chunk.length) return;
        const count = Math.min(
          current.length - current.have,
          chunk.length - offset,
        );
        if (current.have + count > current.payload.length) {
          // Doubling keeps the copies linear in the frame's length.
          const room = Buffer.allocUnsafe(
            Math.min(
              current.length,
              Math.max(current.have + count, current.payload.length * 2),
            ),
          );
          current.payload.copy(room, 0, 0, current.have);
          current.payload = room;
        }
        const { payload, mask } = current;
        for (let index = 0; index < count; index++) {
          const place = current.have + index;
          payload[place] = chunk[offset + index]! ^ mask[place & 3]!;
        }
        current.have += count;
        offset += count;
        if (current.have < current.length) return;
      }
      endFrame();
    }
  };

  /**
   * Bytes that came in the same read as the handshake are read first, on
   * the next tick, once the caller has set `onMessage`, and always before
   * any later data.
   */
  let early: Buffer | undefined = head && head.length > 0 ? head : undefined;
  const readEarly = (): void => {
    if (!early) return;
    const bytes = early;
    early = undefined;
    read(bytes);
    keepUp();
  };
  if (early) process.nextTick(readEarly);
  socket.on("data", (chunk: Buffer) => {
    readEarly();
    read(chunk);
    keepUp();
  });
  socket.on("close", shut);
  socket.on("error", shut);
  return connection;
}
