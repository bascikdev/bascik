/** The one thing the renderer needs from a model: its reply as slices of text. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export type Model = (request: ModelRequest) => AsyncIterable<string>;

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A model that needs no API key: it streams the text `reply` returns, a few
 * characters at a time. For demos, tests, and working on the UI offline.
 */
export function scriptedModel(
  reply: (request: ModelRequest) => string,
  options: { chunkSize?: number; delayMs?: number } = {},
): Model {
  const { chunkSize = 7, delayMs = 12 } = options;
  return async function* (request) {
    const text = reply(request);
    for (let at = 0; at < text.length; at += chunkSize) {
      if (request.signal?.aborted) return;
      if (delayMs > 0) await wait(delayMs, request.signal);
      yield text.slice(at, at + chunkSize);
    }
  };
}
