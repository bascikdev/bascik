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

/** True for a bare hostname or IP address; false for a URL, path or blank. */
export const isPlausibleHostname = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("://") &&
  PLAUSIBLE_HOSTNAME.test(value);

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
