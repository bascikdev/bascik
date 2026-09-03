export const GET = async (_req: Request, _ctx: any, { signal }: { signal: AbortSignal }) => {
  return new Promise<Response>((_resolve) => {
    // Hangs until signal aborts
    signal.addEventListener("abort", () => {
      // Aborted by timeout
    });
  });
};
