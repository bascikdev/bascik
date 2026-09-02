/**
 * Shared debounce helper for filesystem and exec watcher triggers.
 */
export const debounce = <T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number = 50,
): ((...args: Parameters<T>) => void) => {
  let timer: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
};
