let lastAbortObserved = false;
let lastAbortReason = "";

export const GET = async (_req: Request, _ctx: any, { signal }: { signal: AbortSignal }) => {
  lastAbortObserved = false;
  lastAbortReason = "";

  return new Promise<Response>((_resolve) => {
    // Hangs until signal aborts
    signal.addEventListener("abort", () => {
      lastAbortObserved = true;
      lastAbortReason = signal.reason?.message || String(signal.reason);
    });
  });
};

export const POST = async () => {
  // Check the state of the last abort observation
  return Response.json({
    aborted: lastAbortObserved,
    reason: lastAbortReason,
  });
};
