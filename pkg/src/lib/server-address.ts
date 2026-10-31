/**
 * @module server-address
 *
 * The one rule for a server hostname, shared by `http.hostname`, the
 * `--host` flag and `BASCIK_SERVER_HOST`, and the one rule for a port given
 * as text, shared by `--port`, `BASCIK_SERVER_PORT` and `PORT`. It imports
 * nothing, so the CLI parser, the config validator, the config module and
 * the server can all use it.
 */

/** Letters, digits, dots, hyphens, underscores and colons (IPv6). */
const PLAUSIBLE_HOSTNAME = /^[a-zA-Z0-9._:-]+$/;

/** What a hostname must look like, as error messages say it. */
export const HOSTNAME_EXPECTATION =
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
  hasPortSuffix(value)
    ? `expected a hostname without a port, like "localhost"; set the port with ${portSetting}`
    : HOSTNAME_EXPECTATION;

/**
 * True for a bare hostname or IP address; false for a URL, path, blank, or
 * a host with a port (`localhost:3000` would reach server.listen as a raw
 * getaddrinfo ENOTFOUND).
 */
export const isPlausibleHostname = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("://") &&
  PLAUSIBLE_HOSTNAME.test(value) &&
  !hasPortSuffix(value);

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
