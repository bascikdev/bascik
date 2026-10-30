/**
 * Coalesce overlapping requests for the same idempotent job, such as a full
 * rebuild of every page.
 *
 * The first request starts the job. Requests made while it runs share one
 * trailing run, which starts when the running one ends, so whatever changed
 * during the running job is still seen, and a burst of N requests costs at
 * most two runs instead of N overlapping ones. A request made once the
 * trailing run has started queues a new trailing run behind it.
 *
 * Every request resolves when a run that started after the request ends. A
 * failed run is reported to `onError` once, not once per request, and its
 * requests still resolve, so a burst of events never repeats the same error.
 */
export const coalesceRuns = (
  job: () => Promise<unknown>,
  onError: (error: unknown) => void,
): (() => Promise<void>) => {
  let running: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const run = (async () => {
      try {
        await job();
      } catch (error) {
        onError(error);
      }
    })().finally(() => {
      running = null;
    });
    running = run;
    return run;
  };

  return () => {
    if (!running) return start();
    trailing ??= running.then(() => {
      trailing = null;
      return start();
    });
    return trailing;
  };
};
