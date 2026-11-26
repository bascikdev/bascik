/**
 * Who is asking, and about what: the `Session` a request belongs to, the
 * `ChatSessions` contract a sign-in replaces, and the default anonymous
 * sessions kept in two HttpOnly cookies.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** One request's place in the app: which reader, and which of their conversations is open. */
export interface Session {
  /** Who is asking. A store keeps each reader's conversations apart. */
  reader: string;
  /** The reader's open conversation, when the request names one. */
  conversationId: string | undefined;
}

/**
 * How a request says who the reader is and which conversation is open, and
 * how a response remembers it. Replace it with your sign-in: `identify`
 * answers from the request, and `remember` returns the headers (cookies, for
 * example) that make the next request say the same.
 */
export interface ChatSessions {
  identify(request: Request): Session;
  remember(session: Session, conversationId: string): Headers;
}

/** An id as `randomUUID` writes it. */
const COOKIE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) {
      return pair.slice(at + 1).trim();
    }
  }
  return undefined;
}

const cookieId = (value: string | undefined): string | undefined =>
  value !== undefined && COOKIE_ID.test(value) ? value : undefined;

export interface CookieSessionOptions {
  /**
   * Default true: both cookies are Secure, on every response. Chrome and
   * Firefox keep a Secure cookie on http://localhost and http://127.0.0.1
   * too. False is the opt-out, for development on a browser that drops them
   * (Safari on plain http) or from another device over plain http. It is
   * never guessed from the request: behind a proxy, a public https site's
   * requests can look like plain http to 127.0.0.1.
   */
  secure?: boolean;
  /**
   * Signs the reader id this server issues with an HMAC, and refuses a
   * `visitor` cookie it did not sign (a new reader is made instead). This
   * stops an id the server never issued. It does not stop one the server did
   * issue (to an attacker, say) being planted in someone else's browser.
   */
  secret?: string;
  /**
   * Default false. True names both cookies with the `__Host-` prefix
   * (`__Host-visitor`, `__Host-chat_<id>`) and reads only those. A browser
   * accepts a `__Host-` cookie only from a secure origin, with Secure,
   * `Path=/` and no Domain, so a sibling subdomain or a plain-http response
   * cannot plant one. Turning it on starts every existing reader over, and
   * it needs `secure` left on.
   */
  hostPrefix?: boolean;
  /**
   * How long the `visitor` cookie lasts, in seconds (its `Max-Age`). Default
   * one year, 31 536 000. The open conversation's cookie lasts the browser
   * session either way.
   */
  maxAgeSeconds?: number;
}

/** `CookieSessionOptions.maxAgeSeconds` when it is not given: one year. */
const VISITOR_MAX_AGE = 31_536_000;

/**
 * The default sessions: an anonymous reader and an open conversation, each in
 * an HttpOnly cookie (`visitor`, and `chat_<id>` so apps on one site keep
 * their own). Readers never see each other's conversations, and a reader who
 * clears cookies starts over. See `CookieSessionOptions` for Secure, for
 * signing the reader id, and for the `__Host-` prefix.
 */
export function cookieSessions(
  id = "chat",
  options: CookieSessionOptions = {},
): ChatSessions {
  const {
    secret,
    secure = true,
    hostPrefix = false,
    maxAgeSeconds = VISITOR_MAX_AGE,
  } = options;
  if (secret === "") throw new Error("cookieSessions: the secret is empty.");
  // 0 would tell the browser to drop the visitor cookie at once: every
  // request would be a new reader, and no conversation could be found again.
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error(
      "cookieSessions: maxAgeSeconds is a whole number of seconds, 1 or more.",
    );
  }
  if (hostPrefix && !secure) {
    throw new Error(
      "cookieSessions: hostPrefix needs Secure cookies; a browser drops a __Host- cookie without it.",
    );
  }
  const prefix = hostPrefix ? "__Host-" : "";
  const visitorName = `${prefix}visitor`;
  const chatName = `${prefix}chat_${id}`;
  const tail = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const sign = (reader: string): string =>
    createHmac("sha256", secret!)
      .update(`visitor:${reader}`)
      .digest("base64url");
  const readerOf = (value: string | undefined): string | undefined => {
    if (secret === undefined) return cookieId(value);
    const dot = value?.indexOf(".") ?? -1;
    const reader = cookieId(value?.slice(0, dot));
    if (dot < 0 || reader === undefined) return undefined;
    const given = Buffer.from(value!.slice(dot + 1));
    const expected = Buffer.from(sign(reader));
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? reader
      : undefined;
  };
  return {
    identify(request) {
      return {
        reader: readerOf(cookieValue(request, visitorName)) ?? randomUUID(),
        conversationId: cookieId(cookieValue(request, chatName)),
      };
    },
    remember(session, conversationId) {
      const visitor =
        secret === undefined
          ? session.reader
          : `${session.reader}.${sign(session.reader)}`;
      const headers = new Headers();
      headers.append("set-cookie", `${chatName}=${conversationId}; ${tail}`);
      headers.append(
        "set-cookie",
        `${visitorName}=${visitor}; Max-Age=${maxAgeSeconds}; ${tail}`,
      );
      return headers;
    },
  };
}
