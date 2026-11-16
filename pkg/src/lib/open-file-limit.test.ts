import { describe, expect, it } from "vitest";
import {
  createOpenFileLimiter,
  OPEN_FILE_SLOTS,
  withOpenFileSlot,
} from "./open-file-limit.ts";

const tick = () => new Promise((done) => setTimeout(done, 0));

describe("createOpenFileLimiter", () => {
  it("never runs more tasks at once than it has slots", async () => {
    const limit = createOpenFileLimiter(3);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
          return index;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(limit.active).toBe(0);
  });

  it("starts waiting tasks in the order they asked", async () => {
    const limit = createOpenFileLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        limit(async () => {
          order.push(index);
          await tick();
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  // The misuse that would leak slots: a task that throws or rejects.
  it("frees the slot when a task throws or rejects", async () => {
    const limit = createOpenFileLimiter(2);
    const failures = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        limit(async () => {
          await tick();
          if (index % 2) throw new Error(`EMFILE ${index}`);
          return Promise.reject(new Error(`ENOENT ${index}`));
        }),
      ),
    );
    expect(failures.every(({ status }) => status === "rejected")).toBe(true);
    expect(limit.active).toBe(0);
    await expect(limit(async () => "still works")).resolves.toBe("still works");
  });

  it("the shared limiter stays well under a 64-file limit", () => {
    expect(OPEN_FILE_SLOTS).toBeLessThanOrEqual(32);
    expect(withOpenFileSlot.active).toBe(0);
  });
});
