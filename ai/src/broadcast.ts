/**
 * One stream, many readers, each from the start.
 *
 * A reply is written once, by a task that does not belong to any request.
 * Every page that shows the reply subscribes: it gets what was written so
 * far, then the rest as it comes. So a reader who reloads, or opens the
 * conversation in a second tab, joins the same reply instead of starting
 * another, and a reply is finished and stored even when nobody is watching.
 */
export interface Broadcast<T> {
  push(value: T): void;
  /** No more values. Readers finish once they have caught up. */
  end(): void;
  readonly ended: boolean;
  /** Everything from the first value on. Safe to stop reading at any time. */
  subscribe(): AsyncGenerator<T, void, undefined>;
}

export function createBroadcast<T>(): Broadcast<T> {
  const values: T[] = [];
  const waiting = new Set<() => void>();
  let ended = false;
  const wake = (): void => {
    for (const resolve of waiting) resolve();
    waiting.clear();
  };
  return {
    push(value) {
      if (ended) return;
      values.push(value);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    get ended() {
      return ended;
    },
    async *subscribe() {
      let resolve = (): void => {};
      try {
        for (let at = 0; ;) {
          while (at < values.length) yield values[at++]!;
          if (ended) return;
          await new Promise<void>((done) => {
            resolve = done;
            waiting.add(done);
          });
        }
      } finally {
        waiting.delete(resolve);
      }
    },
  };
}
