/**
 * Stress the demo server. Start it first (see "What the stress tests found"
 * in the package's NOTES.md), then: node stress/load.ts [http://127.0.0.1:4477]
 *
 * It measures, against the offline models (so the numbers are Bascik and the
 * renderer, not a model API):
 *   1. many replies streaming at once,
 *   2. reloading a long conversation,
 *   3. one reply with more components than Bascik's per-output budget,
 *   4. visitors who leave in the middle of a reply.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:4477";
const DATA = join(import.meta.dirname, "..", "demo", ".data");

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? 0
  );
};
const ms = (value: number): string => `${value.toFixed(0)}ms`;

interface Turn {
  ok: boolean;
  firstByte: number;
  firstReply: number;
  total: number;
  bytes: number;
  chunks: number;
  body: string;
}

/** Post a message, then read the streamed page, timing its milestones. */
async function turn(
  path: string,
  app: string,
  text: string,
  cookie = "",
  abortAfter = 0,
): Promise<Turn & { cookie: string }> {
  const sent = await fetch(`${BASE}/api/send`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ app, text }),
  });
  const set =
    sent.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ") || cookie;
  const result = await read(path, set, abortAfter);
  return { ...result, cookie: set };
}

async function read(
  path: string,
  cookie: string,
  abortAfter = 0,
): Promise<Turn> {
  const started = performance.now();
  const controller = new AbortController();
  let firstByte = 0;
  let firstReply = 0;
  let bytes = 0;
  let chunks = 0;
  let body = "";
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    for await (const piece of response.body!) {
      const now = performance.now() - started;
      firstByte ||= now;
      chunks++;
      bytes += (piece as Uint8Array).length;
      body += decoder.decode(piece as Uint8Array, { stream: true });
      if (!firstReply && /data-testid="?turn-live"?[^>]*>[^<\s]/.test(body))
        firstReply = now;
      if (abortAfter && chunks >= abortAfter) controller.abort();
    }
    return {
      ok: response.ok && body.includes("turn-done"),
      firstByte,
      firstReply,
      total: performance.now() - started,
      bytes,
      chunks,
      body,
    };
  } catch {
    return {
      ok: false,
      firstByte,
      firstReply,
      total: performance.now() - started,
      bytes,
      chunks,
      body,
    };
  }
}

async function seed(
  app: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const id = randomUUID();
  const visitor = randomUUID();
  await mkdir(join(DATA, app, visitor), { recursive: true });
  await writeFile(
    join(DATA, app, visitor, `${id}.json`),
    JSON.stringify({ id, title: "stress", updatedAt: Date.now(), messages }),
  );
  return `visitor=${visitor}; chat_${app}=${id}`;
}

const CASES: [string, string, string][] = [
  ["/", "books", "Recommend a book"],
  ["/data", "data", "What are the top selling books?"],
  ["/docs", "docs", "How do I stream rows from a slow source?"],
];

console.log(`\n1. Replies streaming at once (${BASE})`);
console.log(
  "   clients  ok    first byte p50/p95   first reply text p50/p95   whole reply p50/p95   chunks/reply",
);
for (const clients of [1, 25, 100, 250, 500]) {
  const results = await Promise.all(
    Array.from({ length: clients }, (_, index) =>
      turn(...CASES[index % CASES.length]!),
    ),
  );
  const good = results.filter((result) => result.ok);
  const column = (pick: (result: Turn) => number): string =>
    `${ms(percentile(good.map(pick), 50))} / ${ms(percentile(good.map(pick), 95))}`;
  console.log(
    `   ${String(clients).padEnd(8)} ${String(good.length).padEnd(5)} ${column((r) => r.firstByte).padEnd(20)} ${column((r) => r.firstReply).padEnd(26)} ${column((r) => r.total).padEnd(21)} ${Math.round(good.reduce((sum, r) => sum + r.chunks, 0) / Math.max(1, good.length))}`,
  );
}

console.log(
  "\n2. Reloading a long conversation (history is rendered again on every page load)",
);
console.log("   turns  components   time     HTML size   complete");
const cards = (count: number): string =>
  `Here you go.\n\n<card-grid>\n${Array.from({ length: count }, (_, i) => `<book-card title="Book ${i}" author="Author ${i}" rating="4.${i % 10}">A blurb for book ${i}.</book-card>`).join("\n")}\n</card-grid>`;
for (const turns of [10, 50, 100, 200, 400]) {
  const perReply = 4; // 1 grid + 3 cards
  const messages = Array.from({ length: turns }, (_, index) => [
    { role: "user", content: `Question ${index}` },
    { role: "assistant", content: cards(3) },
  ]).flat();
  const result = await read("/?all", await seed("books", messages));
  const rendered = (result.body.match(/data-testid="?book-card"?[ >]/g) ?? [])
    .length;
  console.log(
    `   ${String(turns).padEnd(6)} ${String(turns * perReply).padEnd(12)} ${ms(result.total).padEnd(8)} ${`${(result.bytes / 1024).toFixed(0)} KB`.padEnd(11)} ${rendered === turns * 3 ? "yes" : `NO: ${rendered} of ${turns * 3} cards rendered`}`,
  );
}

console.log(
  "\n3. One reply with many components (Bascik allows 1,000 instances per script output)",
);
console.log("   cards in one grid   time     rendered");
for (const count of [100, 500, 990, 1100, 3000]) {
  const result = await read(
    "/",
    await seed("books", [
      { role: "user", content: "Many" },
      { role: "assistant", content: cards(count) },
    ]),
  );
  const rendered = (result.body.match(/data-testid="?book-card"?[ >]/g) ?? [])
    .length;
  console.log(
    `   ${String(count).padEnd(19)} ${ms(result.total).padEnd(8)} ${rendered === count ? "all" : `${rendered} of ${count}`}`,
  );
}

console.log("\n4. Visitors who leave mid-reply");
const leavers = await Promise.all(
  Array.from({ length: 100 }, () =>
    turn("/", "books", "Recommend a book", "", 3),
  ),
);
await new Promise((resolve) => setTimeout(resolve, 1500));
const after = await turn("/", "books", "Recommend a book");
console.log(
  `   100 clients disconnected after 3 chunks; a new visitor afterwards: ${after.ok ? `ok in ${ms(after.total)}` : "FAILED"}`,
);
const saved = await read("/", leavers[0]!.cookie);
console.log(
  `   the first leaver's conversation on reload: ${saved.body.includes("turn-assistant") ? "has the reply, which was finished without them" : "has no saved reply yet"}`,
);
