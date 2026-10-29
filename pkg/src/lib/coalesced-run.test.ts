import { describe, it, expect, vi } from "vitest";
import { coalesceRuns } from "./coalesced-run.ts";

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const deferredJob = () => {
  const finishers: Array<(error?: Error) => void> = [];
  const job = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finishers.push((error) => (error ? reject(error) : resolve()));
      }),
  );
  const finish = async (error?: Error): Promise<void> => {
    finishers.shift()?.(error);
    await settle();
  };
  return { job, finish, finishers };
};

describe("coalesceRuns", () => {
  it("starts the first request at once, in the same tick", () => {
    const { job } = deferredJob();
    const request = coalesceRuns(job, vi.fn());
    void request();
    expect(job).toHaveBeenCalledOnce();
  });

  it("folds every request made during a run into one trailing run", async () => {
    const { job, finish, finishers } = deferredJob();
    const request = coalesceRuns(job, vi.fn());
    const all = Array.from({ length: 50 }, () => request());
    await settle();
    expect(job).toHaveBeenCalledOnce();
    await finish();
    expect(job).toHaveBeenCalledTimes(2);
    await finish();
    await Promise.all(all);
    expect(job).toHaveBeenCalledTimes(2);
    expect(finishers).toHaveLength(0);
  });

  it("resolves a request only after a run that started after it", async () => {
    const { job, finish } = deferredJob();
    const request = coalesceRuns(job, vi.fn());
    let firstDone = false;
    let laterDone = false;
    void request().then(() => (firstDone = true));
    void request().then(() => (laterDone = true));
    await finish();
    expect(firstDone).toBe(true);
    expect(laterDone).toBe(false);
    await finish();
    expect(laterDone).toBe(true);
  });

  it("starts a new run for a request made after the job went idle", async () => {
    const { job, finish } = deferredJob();
    const request = coalesceRuns(job, vi.fn());
    void request();
    await finish();
    void request();
    expect(job).toHaveBeenCalledTimes(2);
    await finish();
  });

  it("reports a failed run once and resolves every request that waited on it", async () => {
    const { job, finish } = deferredJob();
    const onError = vi.fn();
    const request = coalesceRuns(job, onError);
    const first = request();
    await finish(new Error("boom"));
    await expect(first).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({ message: "boom" });
  });

  it("reports a job that throws before returning a promise", async () => {
    const onError = vi.fn();
    const request = coalesceRuns(() => {
      throw new Error("sync");
    }, onError);
    await expect(request()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    // The failure leaves it idle, so the next request runs again.
    await request();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
