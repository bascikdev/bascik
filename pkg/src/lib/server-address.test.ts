/**
 * The hostname and port rules `--host`, `BASCIK_SERVER_HOST`,
 * `http.hostname`, `--port`, `BASCIK_SERVER_PORT` and `PORT` share. A
 * hostname is what Node's `server.listen(port, host)` resolves: a DNS name,
 * an IPv4 address, or a bare IPv6 address (with a `%zone` for a link-local
 * one). The bracketed form belongs in URLs only.
 */
import { describe, expect, it } from "vitest";
import {
  formatServerOrigin,
  hasPortSuffix,
  hostnameExpectation,
  isPlausibleHostname,
  parsePort,
} from "./server-address.ts";

describe("isPlausibleHostname", () => {
  it.each([
    "localhost",
    "0.0.0.0",
    "127.0.0.1",
    "example.com",
    "my-host.internal",
    "under_score",
    "::",
    "::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "fe80::1%en0",
    "fe80::1%eth0.100",
    "FE80::ABCD",
    "2001:db8:0:0:0:0:0:1",
    "64:ff9b::192.0.2.1",
  ])("accepts %j", (host) => {
    expect(isPlausibleHostname(host)).toBe(true);
  });

  it.each([
    ["", "blank"],
    [" ", "whitespace"],
    [" localhost", "padded"],
    ["[::1]", "bracketed IPv6"],
    ["[::1]:3000", "bracketed IPv6 with a port"],
    ["host:3000", "a host with a port"],
    ["localhost:", "a host with an empty port"],
    ["http://host", "a URL"],
    ["host/path", "a path"],
    ["a:b", "one colon that is not a port"],
    ["fe80::1%", "an empty zone"],
    ["fe80::1%en0%en1", "two zones"],
    ["example.com%en0", "a zone on a name"],
    ["::g", "a non-hex IPv6 group"],
    ["::1:", "a trailing colon"],
    ["1::2::3", "two ::"],
    ["1:2:3:4:5:6:7", "seven groups and no ::"],
    ["1:2:3:4:5:6:7:8:9", "nine groups"],
    ["12345::1", "a five-digit group"],
    ["::ffff:300.0.0.1", "a bad embedded IPv4"],
    [42, "a number"],
    [undefined, "nothing"],
  ] as Array<[unknown, string]>)("rejects %j (%s)", (host) => {
    expect(isPlausibleHostname(host)).toBe(false);
  });
});

describe("hostnameExpectation", () => {
  it("names the port setting for a host with a port", () => {
    expect(hasPortSuffix("localhost:3000")).toBe(true);
    expect(hostnameExpectation("localhost:3000", "--port")).toMatch(
      /without a port.*--port/,
    );
  });

  it("tells a bracketed IPv6 address to drop the brackets", () => {
    for (const host of ["[::1]", "[fe80::1%en0]", "[::1]:8080"])
      expect(hostnameExpectation(host, "--port")).toMatch(
        /without brackets, like "::1"/,
      );
  });

  it("needs a colon inside the brackets and a closing bracket", () => {
    for (const host of ["[:]", "[a:b]:", "[::]:"])
      expect(hostnameExpectation(host, "--port")).toMatch(/without brackets/);
    for (const host of [
      "[]",
      "[localhost]",
      "[::1",
      "[:::::",
      "[::1]x",
      "[::1]:80a",
    ])
      expect(hostnameExpectation(host, "--port")).not.toMatch(
        /without brackets/,
      );
  });

  it("says what a hostname looks like for anything else", () => {
    expect(hostnameExpectation("http://host", "--port")).toMatch(
      /hostname like "localhost"/,
    );
    expect(hostnameExpectation("::1:", "--port")).toMatch(/hostname like/);
  });
});

describe("formatServerOrigin", () => {
  it("brackets an IPv6 host, encoding its zone, so the URL opens", () => {
    expect(formatServerOrigin("http", "localhost", 8080)).toBe(
      "http://localhost:8080",
    );
    expect(formatServerOrigin("https", "0.0.0.0", 8443)).toBe(
      "https://0.0.0.0:8443",
    );
    expect(formatServerOrigin("http", "::1", 8080)).toBe("http://[::1]:8080");
    expect(formatServerOrigin("http", "::", 8080)).toBe("http://[::]:8080");
    expect(formatServerOrigin("http", "fe80::1%en0", 8080)).toBe(
      "http://[fe80::1%25en0]:8080",
    );
    expect(new URL(formatServerOrigin("http", "::1", 8080)).port).toBe("8080");
  });

  it("encodes every % in the host, not only the first (RFC 6874)", () => {
    // A validated host has one zone separator, but the function is exported:
    // a host that reached it unvalidated must not leave a raw % in the URL.
    expect(formatServerOrigin("http", "fe80::1%en%0", 8080)).toBe(
      "http://[fe80::1%25en%250]:8080",
    );
    expect(formatServerOrigin("http", "fe80::1%%", 8080)).toBe(
      "http://[fe80::1%25%25]:8080",
    );
  });
});

describe("parsePort", () => {
  it.each([
    ["8080", 8080],
    [" 3000 ", 3000],
    ["1", 1],
    ["65535", 65535],
    ["0", undefined],
    ["65536", undefined],
    ["8080abc", undefined],
    ["80.5", undefined],
    ["3000 4000", undefined],
    ["-1", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("reads %j as %j", (raw, port) => {
    expect(parsePort(raw)).toBe(port);
  });
});
