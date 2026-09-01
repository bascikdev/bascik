/**
 * Format a duration in milliseconds into a concise, human-readable string.
 * - Sub-millisecond (ms < 1): e.g. "0.4ms", "0.09ms", "<0.01ms"
 * - Fast operations (1 <= ms < 10): e.g. "1.2ms", "9.8ms", "1ms"
 * - Milliseconds (10 <= ms < 1000): e.g. "12ms", "350ms"
 * - Seconds (ms >= 1000): e.g. "1.25s", "3s"
 */
export const formatDuration = (ms: number): string => {
  if (ms <= 0) return "0ms";
  if (ms < 1) {
    const fixed = +ms.toFixed(2);
    return `${fixed === 0 ? "<0.01" : fixed}ms`;
  }
  if (ms < 10) {
    return `${+ms.toFixed(1)}ms`;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${+(ms / 1000).toFixed(2)}s`;
};
