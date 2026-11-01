import { describe, expect, it, vi } from "vitest";
import { RestartQueue } from "./restart-queue";

/** A restart that stays running until `finish` is called, like a language client starting up. */
function controlledRestart() {
  const finishes: ((error?: Error) => void)[] = [];
  const restart = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finishes.push((error) => (error ? reject(error) : resolve()));
      }),
  );
  return {
    restart,
    finish: (error?: Error) => finishes.shift()!(error),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RestartQueue", () => {
  it("restarts once for a change, and once more for changes made while it ran, never two at a time", async () => {
    const { restart, finish } = controlledRestart();
    const queue = new RestartQueue(restart, vi.fn());
    void queue.request();
    await settle();
    expect(restart).toHaveBeenCalledTimes(1);
    // Two more setting changes while the client is still starting: one restart follows, after this one.
    void queue.request();
    void queue.request();
    await settle();
    expect(restart).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(restart).toHaveBeenCalledTimes(2);
    // A change during the second restart: a third follows it, and resolves when that one has finished.
    const done = queue.request();
    finish();
    await settle();
    expect(restart).toHaveBeenCalledTimes(3);
    let finished = false;
    void done.then(() => (finished = true));
    await settle();
    expect(finished).toBe(false);
    finish();
    await done;
    expect(restart).toHaveBeenCalledTimes(3);
  });

  it("misuse: a failed restart is logged, not left as an unhandled rejection, and the next change still restarts", async () => {
    const { restart, finish } = controlledRestart();
    const log = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const queue = new RestartQueue(restart, log);
      const first = queue.request();
      void queue.request();
      finish(
        new Error(
          "Client is not running and can't be stopped. It's current state is: starting",
        ),
      );
      await settle();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Client is not running"),
      );
      // The change made during the failed restart is not dropped.
      expect(restart).toHaveBeenCalledTimes(2);
      finish();
      await first;
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("settles once the running restart and the one queued after it have finished", async () => {
    const { restart, finish } = controlledRestart();
    const queue = new RestartQueue(restart, vi.fn());
    await queue.settled();
    void queue.request();
    void queue.request();
    let settled = false;
    void queue.settled().then(() => (settled = true));
    finish();
    await settle();
    expect(settled).toBe(false);
    finish();
    await settle();
    await settle();
    expect(settled).toBe(true);
  });

  it("does nothing after it is disposed", async () => {
    const { restart } = controlledRestart();
    const queue = new RestartQueue(restart, vi.fn());
    queue.dispose();
    await queue.request();
    expect(restart).not.toHaveBeenCalled();
  });
});
