/**
 * Waiting, the two ways the live turns need: a plain sleep, and a promise's
 * result unless it takes longer than a deadline.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`'s result, or undefined when it takes longer than `ms`. The promise is left running. */
export const within = <T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
