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
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
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

  let buffered: Buffer = Buffer.alloc(0);
  let pieces: Buffer[] = [];
  let size = 0;
  socket.on("data", (chunk: Buffer) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (open) {
      if (buffered.length < 2) return;
      const opcode = buffered[0]! & 0x0f;
      const final = (buffered[0]! & 0x80) !== 0;
      const masked = (buffered[1]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const long = buffered.readBigUInt64BE(2);
        if (long > BigInt(MAX_MESSAGE_BYTES)) {
          connection.close(1009, "Message too big");
          return;
        }
        length = Number(long);
        at = 10;
      }
      // A client has to mask what it sends; one that does not is not a browser.
      if (!masked) {
        connection.close(1002, "Unmasked frame");
        return;
      }
      if (size + length > MAX_MESSAGE_BYTES) {
        connection.close(1009, "Message too big");
        return;
      }
      if (buffered.length < at + 4 + length) return;
      const mask = buffered.subarray(at, at + 4);
      const payload = Buffer.from(buffered.subarray(at + 4, at + 4 + length));
      for (let index = 0; index < payload.length; index++) {
        payload[index]! ^= mask[index % 4]!;
      }
      buffered = buffered.subarray(at + 4 + length);
      if (opcode === 0x8) {
        socket.end(encodeFrame(payload.subarray(0, 2), 0x8));
        shut();
        return;
      }
      if (opcode === 0x9) socket.write(encodeFrame(payload, 0xa));
      if (opcode > 0x2) continue;
      pieces.push(payload);
      size += payload.length;
      if (final) {
        const text = Buffer.concat(pieces).toString("utf8");
        pieces = [];
        size = 0;
        connection.onMessage(text);
      }
    }
  });
  socket.on("close", shut);
  socket.on("error", shut);
  return connection;
}
