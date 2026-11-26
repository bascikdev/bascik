/**
 * The checks that answer a request before the chat reads it: the method,
 * the declared body size, which client an address counts as, and the
 * answers for a client that sent too much. Nothing here reads a body or
 * touches storage; src/lib/limits.ts charges the counters.
 */

/** The largest body `/api/*` accepts: two 1 MB files, the message, and the form around them. */
export const MAX_BODY_BYTES = 2.3 * 1024 * 1024;

/** How long one send window lasts. */
export const SEND_WINDOW_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The methods `/api/*` answers. */
const METHODS = new Set(["GET", "HEAD", "POST"]);

const plain = (status: number, text: string, headers: HeadersInit = {}) =>
  new Response(`${text}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

/**
 * The answer to a request `/api/*` must not take, or null when it may go
 * on. Checks the method (405), then for a POST that it declares its length
 * (411) and that the length fits (413).
 */
export function checkRequest(request: Request): Response | null {
  if (!METHODS.has(request.method)) {
    return plain(405, "Method not allowed.", { allow: "GET, HEAD, POST" });
  }
  if (request.method !== "POST") return null;
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) {
    return plain(411, "A request body needs a Content-Length.");
  }
  if (Number(declared) > MAX_BODY_BYTES) {
    return plain(413, "That is more than this demo takes in one message.");
  }
  return null;
}

/**
 * Whether a send carries files: a multipart form with more than a message
 * in it. A media type is case-insensitive, and `Request.formData()` reads
 * `Multipart/Form-Data` as readily as the lowercase form.
 */
export const carriesFiles = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "")
    .trim()
    .toLowerCase()
    .startsWith("multipart/form-data") &&
  Number(request.headers.get("content-length") ?? 0) > 16 * 1024;

/** The 429 for an address that sent too much in the current window. */
export function tooMany(now = Date.now()): Response {
  const retry = Math.ceil((SEND_WINDOW_MS - (now % SEND_WINDOW_MS)) / 1000);
  return plain(429, "Too many messages from your address. Try again soon.", {
    "retry-after": String(retry),
  });
}

/** The 429 for an address that started too many new readers today (UTC). */
export function tooManyReaders(now = Date.now()): Response {
  const retry = Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);
  return plain(
    429,
    "Too many new visitors from your address today. Try again tomorrow.",
    { "retry-after": String(retry) },
  );
}

/** The 429 for an address over the Worker's per-minute request cap. */
export const tooManyRequests = (): Response =>
  plain(429, "Too many requests from your address. Try again in a minute.", {
    "retry-after": "60",
  });

/** The 404 for a request that needs a reader this server issued. */
export const notFound = (): Response => plain(404, "Not found.");

/** The window a moment falls in, as a number: what names a send counter. */
export const sendWindow = (now = Date.now()): number =>
  Math.floor(now / SEND_WINDOW_MS);

const HEXTET = /^[0-9a-f]{1,4}$/;
const DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv6 address as eight numbers, or null for text that is not one. */
function hextets(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const split = (half: string) => (half === "" ? [] : half.split(":"));
  const head = split(halves[0]!);
  const rest = halves.length === 2 ? split(halves[1]!) : [];
  // An IPv4 address may end it (`::ffff:192.0.2.1`): two hextets' worth.
  const last = rest.length > 0 ? rest : head;
  const dotted = DOTTED.exec(last.at(-1) ?? "");
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    last.splice(
      -1,
      1,
      ((bytes[0]! << 8) | bytes[1]!).toString(16),
      ((bytes[2]! << 8) | bytes[3]!).toString(16),
    );
  }
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(missing).fill("0"), ...rest];
  if (!all.every((part) => HEXTET.test(part))) return null;
  return all.map((part) => parseInt(part, 16));
}

/**
 * What one client's counters are keyed by: an IPv4 address whole, an IPv6
 * address by its /64. A client on IPv6 usually holds a whole /64 (often
 * more), so counting each of its addresses apart would give it a window per
 * address. An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) counts as
 * that IPv4 address; text that is not an address is used as it is.
 */
export function addressKey(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!address.includes(":")) return address;
  const parts = hextets(address);
  if (!parts) return address;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    const [high, low] = [parts[6]!, parts[7]!];
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  const prefix = parts.slice(0, 4).map((part) => part.toString(16));
  return `${prefix.join(":")}::/64`;
}

/**
 * A client as a short hex hash of its `addressKey`, salted, so no
 * counter's name holds an address.
 */
export async function addressHash(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\n${addressKey(ip)}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
