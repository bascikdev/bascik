/**
 * What the wrapper Worker checks before Bascik sees a request to `/api/*`:
 * the method, the declared body size, and how often one address sends.
 * Each check answers with the status a client can act on, and nothing here
 * reads a body.
 */

/** The largest body `/api/*` accepts: two 1 MB files, the message, and the form around them. */
export const MAX_BODY_BYTES = 2.3 * 1024 * 1024;

/** How long one send window lasts. */
export const SEND_WINDOW_MS = 10 * 60 * 1000;

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

/** Whether a send carries files: a multipart form with more than a message in it. */
export const carriesFiles = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "").startsWith(
    "multipart/form-data",
  ) && Number(request.headers.get("content-length") ?? 0) > 16 * 1024;

/** The 429 for an address that sent too much in the current window. */
export function tooMany(now = Date.now()): Response {
  const retry = Math.ceil((SEND_WINDOW_MS - (now % SEND_WINDOW_MS)) / 1000);
  return plain(429, "Too many messages from your address. Try again soon.", {
    "retry-after": String(retry),
  });
}

/** The window a moment falls in, as a number: what names a send counter. */
export const sendWindow = (now = Date.now()): number =>
  Math.floor(now / SEND_WINDOW_MS);

/**
 * A client address as a short hex hash, salted, so no counter's name holds
 * an address.
 */
export async function addressHash(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}\n${ip}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
