import { expect, test, vi } from "vitest";
import {
  type Env,
  equal,
  orderTicket,
  orderToken,
  now,
  verifyTicket,
  TICKET_LIFETIME_SECONDS,
} from "../src/lib/platform.ts";
import { orderGate } from "../src/lib/order-gate.ts";

const env = {
  ORDER_TOKEN_SECRET: "fixture-order-token-secret-long-enough",
} as Env;
const id = "32ce1859bfe24c8fa5c68863b425379f";
const legacyId = "32ce1859-bfe2-4c8f-a5c6-8863b425379f";
/** Changes the last hex digit, so the result always differs from the input. */
const flipLastHex = (text: string) =>
  `${text.slice(0, -1)}${text.endsWith("0") ? "1" : "0"}`;

test("a ticket round-trips, carries its expiry in plain text, and lasts ten minutes", async () => {
  const issued = now();
  const ticket = await orderTicket(env, id);
  const [ticketId, exp, hmac] = ticket.split(".");
  expect(ticketId).toBe(id);
  expect(Number(exp)).toBeGreaterThanOrEqual(issued + TICKET_LIFETIME_SECONDS);
  expect(Number(exp)).toBeLessThanOrEqual(issued + TICKET_LIFETIME_SECONDS + 1);
  expect(hmac).toMatch(/^[a-f0-9]{64}$/);
  expect(TICKET_LIFETIME_SECONDS).toBe(600);
  expect(await verifyTicket(env, ticket)).toEqual({ id, expired: false });
  expect(await verifyTicket(env, await orderTicket(env, legacyId))).toEqual({
    id: legacyId,
    expired: false,
  });
});
test("an expired ticket still verifies, flagged as expired", async () => {
  const ticket = await orderTicket(env, id);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + (TICKET_LIFETIME_SECONDS + 1) * 1000);
    expect(await verifyTicket(env, ticket)).toEqual({ id, expired: true });
  } finally {
    vi.useRealTimers();
  }
});
test.each([
  ["a tampered id", (t: string[]) => [flipLastHex(t[0]), t[1], t[2]]],
  ["a tampered exp", (t: string[]) => [t[0], String(Number(t[1]) + 1), t[2]]],
  ["a tampered hmac", (t: string[]) => [t[0], t[1], flipLastHex(t[2])]],
  ["uppercase hex", (t: string[]) => [t[0], t[1], t[2].toUpperCase()]],
  ["a truncated hmac", (t: string[]) => [t[0], t[1], t[2].slice(0, -1)]],
  ["a truncated exp", (t: string[]) => [t[0], t[1].slice(0, -1), t[2]]],
  ["a missing part", (t: string[]) => [t[0], t[2]]],
  ["an extra part", (t: string[]) => [...t, "x"]],
  ["a non-numeric exp", (t: string[]) => [t[0], "soon", t[2]]],
])("rejects %s", async (_label, mutate) => {
  const parts = (await orderTicket(env, id)).split(".");
  expect(await verifyTicket(env, mutate(parts).join("."))).toBeNull();
});
test.each(["", ".", "..", "a", " ", `${id}..`, `${id}.1.`, "\u0000"])(
  "rejects malformed input %j",
  async (input) => {
    expect(await verifyTicket(env, input)).toBeNull();
  },
);
test("a token is not a ticket and a ticket is not a token", async () => {
  const token = await orderToken(env, id);
  expect(await verifyTicket(env, token)).toBeNull();
  // A ticket's id.exp prefix must not verify as a token for the same order.
  const ticket = await orderTicket(env, id);
  const [ticketId, exp, ticketHmac] = ticket.split(".");
  expect(equal(`${ticketId}.${ticketHmac}`, token)).toBe(false);
  expect(equal(`${ticketId}.${exp}.${ticketHmac}`, token)).toBe(false);
  // Nor can the token's hmac be reused as a ticket's by appending an exp.
  expect(
    await verifyTicket(env, `${id}.${Number(exp)}.${token.split(".")[1]}`),
  ).toBeNull();
});
test("verifyTicket does not throw on a missing secret", async () => {
  const ticket = await orderTicket(env, id);
  expect(await verifyTicket({} as Env, ticket)).toBeNull();
});

const request = (url: string, method = "GET") =>
  new Request(`http://127.0.0.1:8790${url}`, { method });
test("the gate answers 404 for a bad ticket before anything renders", async () => {
  const ticket = await orderTicket(env, id);
  const tampered = flipLastHex(ticket);
  for (const method of ["GET", "HEAD"]) {
    expect(
      await orderGate(
        request(`/order?ticket=${encodeURIComponent(tampered)}`, method),
        env,
      ),
    ).toBe("not-found");
  }
  expect(await orderGate(request("/order?ticket=garbage"), env)).toBe(
    "not-found",
  );
  expect(await orderGate(request("/order?ticket="), env)).toBe("not-found");
  expect(await orderGate(request("/order?ticket=&x=1"), env)).toBe("not-found");
});
test("the gate passes a good ticket through, expired or not", async () => {
  const ticket = await orderTicket(env, id);
  expect(
    await orderGate(
      request(`/order?ticket=${encodeURIComponent(ticket)}`),
      env,
    ),
  ).toBe("pass");
  expect(
    await orderGate(
      request(`/order/?ticket=${encodeURIComponent(ticket)}`),
      env,
    ),
  ).toBe("pass");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + (TICKET_LIFETIME_SECONDS + 60) * 1000);
    expect(
      await orderGate(
        request(`/order?ticket=${encodeURIComponent(ticket)}`),
        env,
      ),
    ).toBe("pass");
  } finally {
    vi.useRealTimers();
  }
});
test("the gate ignores requests without a ticket, other paths, and other methods", async () => {
  expect(await orderGate(request("/order"), env)).toBe("pass");
  expect(await orderGate(request("/order#token=abc"), env)).toBe("pass");
  expect(await orderGate(request("/order?other=1"), env)).toBe("pass");
  expect(await orderGate(request("/orders?ticket=garbage"), env)).toBe("pass");
  expect(await orderGate(request("/api/order?ticket=garbage"), env)).toBe(
    "pass",
  );
  expect(await orderGate(request("/?ticket=garbage"), env)).toBe("pass");
  expect(await orderGate(request("/order?ticket=garbage", "POST"), env)).toBe(
    "pass",
  );
});
