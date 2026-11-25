import { describe, expect, it } from "vitest";
import { createBroadcast } from "./broadcast.ts";

const read = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const values: string[] = [];
  for await (const value of stream) values.push(value);
  return values;
};

describe("createBroadcast", () => {
  it("gives every reader everything, whenever it joined", async () => {
    const broadcast = createBroadcast<string>();
    const early = read(broadcast.subscribe());
    broadcast.push("a");
    broadcast.push("b");
    const late = read(broadcast.subscribe());
    await Promise.resolve();
    broadcast.push("c");
    broadcast.end();
    const after = read(broadcast.subscribe());
    expect(await early).toEqual(["a", "b", "c"]);
    expect(await late).toEqual(["a", "b", "c"]);
    expect(await after).toEqual(["a", "b", "c"]);
    expect(broadcast.ended).toBe(true);
  });

  it("goes on when a reader leaves, and ignores values after the end", async () => {
    const broadcast = createBroadcast<string>();
    const leaving = broadcast.subscribe();
    broadcast.push("a");
    expect((await leaving.next()).value).toBe("a");
    // A reader that leaves while it waits is let go at the next value.
    const waiting = leaving.next();
    const left = leaving.return();
    const staying = read(broadcast.subscribe());
    broadcast.push("b");
    broadcast.end();
    broadcast.push("late");
    expect(await staying).toEqual(["a", "b"]);
    await waiting;
    expect((await left).done).toBe(true);
  });
});
