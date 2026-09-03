import { nativeClock, type FrameworkClock, type TimeoutHandle } from './clock.ts';

export interface DebounceOptions {
  clock?: FrameworkClock;
}

export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  cancel(): void;
  flush(): void;
}

/**
 * Shared debounce helper for filesystem and exec watcher triggers.
 */
export const debounce = <T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number = 50,
  options?: DebounceOptions,
): DebouncedFunction<T> => {
  const clock = options?.clock ?? nativeClock;
  let timer: TimeoutHandle | null = null;
  let lastArgs: Parameters<T> | null = null;

  const debounced = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timer !== null) {
      clock.clearTimeout(timer);
    }
    timer = clock.setTimeout(() => {
      timer = null;
      const argsToRun = lastArgs;
      lastArgs = null;
      if (argsToRun) {
        fn(...argsToRun);
      }
    }, delayMs);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  debounced.flush = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
      const argsToRun = lastArgs;
      lastArgs = null;
      if (argsToRun) {
        fn(...argsToRun);
      }
    }
  };

  return debounced;
};
