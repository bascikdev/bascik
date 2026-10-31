/**
 * @module server-address
 *
 * The one rule for a server hostname, shared by `http.hostname`, the
 * `--host` flag and `BASCIK_SERVER_HOST`, and the one rule for a port given
 * as text, shared by `--port`, `BASCIK_SERVER_PORT` and `PORT`. It imports
 * nothing, so the CLI parser, the config validator, the config module and
 * the server can all use it.
 */

/** A DNS name or IPv4 address: letters, digits, dots, hyphens and underscores. */
const PLAUSIBLE_NAME = /^[a-zA-Z0-9._-]+$/;

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const ZONE = /^[\w.-]+$/;

/**
 * A bare IPv6 address as `server.listen` takes it (`::`, `::1`,
 * `2001:db8::1`, `::ffff:127.0.0.1`), with an optional `%zone` naming the
 * interface of a link-local address (`fe80::1%en0`): eight hex groups, or
 * fewer with one `::`, the last two of which may be an IPv4 address.
 * Brackets belong in URLs only.
 */
const isIpv6Address = (value: string): boolean => {
  const [address, zone, ...more] = value.split("%");
  if (more.length > 0 || (zone !== undefined && !ZONE.test(zone))) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((half) => (half === "" ? [] : half.split(":")));
  const all = groups.flat();
  const last = all.at(-1);
  const embedsIpv4 = last !== undefined && last.includes(".");
  if (embedsIpv4 && !IPV4.test(last)) return false;
  const hexGroups = embedsIpv4 ? all.slice(0, -1) : all;
  if (!hexGroups.every((group) => HEX_GROUP.test(group))) return false;
  const count = hexGroups.length + (embedsIpv4 ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
};

/**
 * A bracketed IPv6 address as a URL writes it (`[::1]`, `[::1]:3000`): a
 * colon somewhere inside the brackets. The part before the first colon
 * excludes `:`, so only one split exists and an unclosed `[:::` fails in
 * linear time.
 */
const BRACKETED_IPV6 = /^\[[^\]:]*:[^\]]*\](?::\d*)?$/;

/** What a hostname must look like, as error messages say it. */
const HOSTNAME_EXPECTATION =
  'expected a hostname like "localhost" or "example.com", not a URL or path';

/**
 * A host with a port: one colon, then digits or nothing (`localhost:3000`,
 * `0.0.0.0:8080`, `localhost:`). An IPv6 address has two colons or more.
 */
const HOST_WITH_PORT = /^[^:]+:\d*$/;

/** True for a host written with a port, such as `localhost:3000`. */
export const hasPortSuffix = (value: unknown): boolean =>
  typeof value === "string" && HOST_WITH_PORT.test(value);

/**
 * What a hostname must look like, for the value received: a host:port gets
 * a message naming the setting that takes the port (`--port`,
 * `BASCIK_SERVER_PORT` or `http.port`), anything else HOSTNAME_EXPECTATION.
 */
export const hostnameExpectation = (
  value: unknown,
  portSetting: string,
): string =>
  typeof value === "string" && BRACKETED_IPV6.test(value)
    ? `${HOSTNAME_EXPECTATION}; write an IPv6 address without brackets, like "::1"${value.endsWith("]") ? "" : `, and set the port with ${portSetting}`}`
    : hasPortSuffix(value)
      ? `expected a hostname without a port, like "localhost"; set the port with ${portSetting}`
      : HOSTNAME_EXPECTATION;

/**
 * True for a bare hostname, IPv4 address or IPv6 address; false for a URL,
 * path, blank, bracketed IPv6, or a host with a port (`localhost:3000` would
 * reach server.listen as a raw getaddrinfo ENOTFOUND).
 */
export const isPlausibleHostname = (value: unknown): value is string =>
  typeof value === "string" &&
  (value.includes(":") ? isIpv6Address(value) : PLAUSIBLE_NAME.test(value));

/**
 * The URL a server bound to `hostname` answers on: an IPv6 address goes in
 * brackets, with every `%` written `%25` (RFC 6874 encodes the zone
 * separator and any `%` in the zone alike), so
 * `http://[::1]:8080` opens where `http://::1:8080` would not.
 */
export const formatServerOrigin = (
  protocol: string,
  hostname: string,
  port: number,
): string =>
  `${protocol}://${hostname.includes(":") ? `[${hostname.replaceAll("%", "%25")}]` : hostname}:${port}`;

/**
 * A port written as text: whole digits (surrounding whitespace allowed) from
 * 1 to 65535, or undefined. `8080abc`, `3000 4000` and `80.5` are not ports;
 * Number.parseInt would read them as 8080, 3000 and 80.
 */
export const parsePort = (raw: string | undefined): number | undefined => {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
};
