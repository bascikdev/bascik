/**
 * The server side of a WebSocket, for text messages, with no dependency:
 * the handshake and the framing (RFC 6455). It is what a voice relay needs
 * to accept a browser, and what a stand-in provider needs in a test. It is
 * not a general WebSocket server: no extensions, no compression, and a
 * binary message is read as text.
 */
import { isUtf8 } from "node:buffer";
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
/**
 * The least room a payload gets once its first bytes arrive; it then
 * doubles as more arrive. Nothing is set aside before that, so a header
 * that declares a large frame and sends nothing more costs its 14 bytes.
 */
const FIRST_ROOM_BYTES = 4096;
/** The room of a frame none of whose payload has arrived yet. */
const NO_ROOM = Buffer.alloc(0);
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** `AcceptOptions.idleMs` when it is not given. */
const IDLE_MS = 45_000;
/** `AcceptOptions.maxUnsentBytes` when it is not given. */
const MAX_BACKLOG_BYTES = 8_000_000;
/** `AcceptOptions.closeGraceMs` when it is not given, and how long a refused upgrade is kept. */
const CLOSE_GRACE_MS = 2000;
/** A close frame's payload is at most 125 bytes: the code and this much reason. */
const MAX_REASON_BYTES = 123;

export interface AcceptOptions {
  /**
   * How long the other side may send nothing, not even the pong that
   * answers a ping, before the connection is ended (default 45 000). 0
   * turns the guard off.
   */
  idleMs?: number;
  /** How often the server pings (default a third of `idleMs`). */
  pingMs?: number;
  /**
   * How much may wait to be sent before the connection is ended: the other
   * side has stopped reading (default 8 000 000).
   */
  maxUnsentBytes?: number;
  /**
   * How long the other side has to hang up after a close before the socket
   * is destroyed (default 2000).
   */
  closeGraceMs?: number;
}

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

/**
 * The close codes one side may send (RFC 6455, section 7.4): not the ones
 * kept for "no code" and "no close frame" (1005, 1006, 1015), and nothing
 * under 1000.
 */
const sendableCloseCode = (code: number): boolean =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1011) ||
  (code >= 3000 && code <= 4999);

/** A close frame's payload: the code, and a reason cut to fit, on a whole character. */
function closeBody(code: number, reason: string): Buffer {
  // A code that may not be sent is left out: a close with no payload is valid.
  if (!sendableCloseCode(code)) return NO_ROOM;
  let said = Buffer.from(reason.slice(0, 100), "utf8");
  if (said.length > MAX_REASON_BYTES) {
    let end = MAX_REASON_BYTES;
    while (end > 0 && (said[end]! & 0xc0) === 0x80) end--;
    said = said.subarray(0, end);
  }
  const body = Buffer.alloc(2 + said.length);
  body.writeUInt16BE(code, 0);
  said.copy(body, 2);
  return body;
}

/**
 * Destroy a socket that was ended, once the other side has had `graceMs` to
 * hang up. An ended socket stays open until the other side closes too, and
 * one that never does would be held for ever.
 */
function destroyAfter(socket: Duplex, graceMs: number): void {
  if (socket.destroyed) return;
  const timer = setTimeout(() => socket.destroy(), graceMs);
  // Some hosts hand back a plain number, which has nothing to unref.
  (timer as { unref?: () => void }).unref?.();
  socket.once("close", () => clearTimeout(timer));
}

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

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

/**
 * Refuse an upgrade request with a plain HTTP answer. The socket is
 * destroyed `graceMs` later if the client has not closed it by then.
 */
export function refuseUpgrade(
  socket: Duplex,
  status: number,
  graceMs: number = CLOSE_GRACE_MS,
): void {
  if (socket.destroyed) return;
  const text = STATUS_TEXT[status] ?? "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  destroyAfter(socket, graceMs);
}

/**
 * Answer an HTTP upgrade request and return the open socket, or null when
 * the request is not a WebSocket handshake (it is refused with a 400) or the
 * client has already gone. Pass the `head` of the server's `upgrade` event:
 * frames a client sends in the same read as its handshake arrive there, not
 * as socket data.
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head?: Buffer,
  options: AcceptOptions = {},
): ServerSocket | null {
  const {
    idleMs = IDLE_MS,
    maxUnsentBytes = MAX_BACKLOG_BYTES,
    closeGraceMs = CLOSE_GRACE_MS,
  } = options;
  const pingMs = options.pingMs ?? Math.max(1, Math.floor(idleMs / 3));
  // A client that reset the connection while the caller was deciding gets
  // no socket: there is no one to answer.
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    return null;
  }
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
  let heardAt = Date.now();
  let beat: ReturnType<typeof setInterval> | undefined;
  const shut = (): void => {
    if (!open) return;
    open = false;
    clearInterval(beat);
    connection.onClose();
  };
  /** Send a close frame, end this side, and give the other side a moment to end its own. */
  const finish = (body: Buffer): void => {
    socket.end(encodeFrame(body, 0x8));
    shut();
    // Reading goes on, so the other side's own end is seen.
    socket.resume();
    destroyAfter(socket, closeGraceMs);
  };
  const connection: ServerSocket = {
    onMessage: () => {},
    onClose: () => {},
    get open() {
      return open;
    },
    send(text, binary = false) {
      if (!open) return;
      socket.write(encodeFrame(Buffer.from(text, "utf8"), binary ? 0x2 : 0x1));
      // The other side has stopped reading: nothing more is kept for it.
      if (socket.writableLength > maxUnsentBytes) {
        socket.destroy();
        shut();
      }
    },
    close(code = 1000, reason = "") {
      if (open) finish(closeBody(code, reason));
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
   * the reads are, and a payload's room is made only as its bytes arrive.
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
  /** Whether the message arriving is text, which has to be valid UTF-8. */
  let isText = false;

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
      // Room is made only as bytes arrive, so a declared length alone sets
      // nothing aside.
      payload: NO_ROOM,
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
      // A close says nothing, or a code it may send and a reason in UTF-8
      // (RFC 6455, sections 5.5.1 and 7.4). The answer is the code alone.
      if (length === 1) {
        connection.close(1002, "Bad close frame");
      } else if (length >= 2 && !sendableCloseCode(body.readUInt16BE(0))) {
        connection.close(1002, "Bad close code");
      } else if (length > 2 && !isUtf8(body.subarray(2))) {
        connection.close(1007, "Invalid UTF-8");
      } else {
        finish(Buffer.from(body.subarray(0, 2)));
      }
      return;
    }
    if (opcode === 0x9) socket.write(encodeFrame(body, 0xa));
    if (opcode >= 0x8) return;
    if (!inMessage) isText = opcode === 0x1;
    pieces.push(body);
    size += length;
    inMessage = true;
    if (final) {
      const whole =
        pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, size);
      pieces = [];
      size = 0;
      inMessage = false;
      // Checked on the whole message, so a character split between two
      // pieces is read as the one character it is.
      if (isText && !isUtf8(whole)) {
        connection.close(1007, "Invalid UTF-8");
        return;
      }
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
          // Doubling keeps the copies linear in the frame's length, and the
          // first room is small, so what is held tracks what has arrived.
          const room = Buffer.allocUnsafe(
            Math.min(
              current.length,
              Math.max(
                current.have + count,
                current.payload.length * 2,
                FIRST_ROOM_BYTES,
              ),
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
    heardAt = Date.now();
    readEarly();
    read(chunk);
    keepUp();
  });
  socket.on("close", shut);
  socket.on("error", shut);
  // An upgraded socket stays half open when the client ends its side with
  // no close frame: that is the end of the connection too.
  socket.on("end", () => {
    shut();
    socket.destroy();
  });
  if (idleMs > 0) {
    // A client that vanished sends nothing, not even the pong a ping asks for.
    beat = setInterval(() => {
      if (Date.now() - heardAt >= idleMs) {
        connection.close(1001, "Idle");
        socket.destroy();
      } else {
        socket.write(encodeFrame(NO_ROOM, 0x9));
      }
    }, pingMs);
    (beat as { unref?: () => void }).unref?.();
  }
  return connection;
}
