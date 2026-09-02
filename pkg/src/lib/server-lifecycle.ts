export type ServerHealthState = "booting" | "ready" | "draining";

let serverHealthState: ServerHealthState = "ready";

export const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
export const MAX_PORT_INCREMENTS = 20;

export const setServerHealthState = (state: ServerHealthState): void => {
  serverHealthState = state;
};

export const getServerHealthState = (): ServerHealthState => {
  return serverHealthState;
};

export const isHealthEndpoint = (pathname: string): boolean => {
  return pathname === "/_health" || pathname === "/_health/ready" || pathname === "/_health/live";
};

export const handleHealthCheck = (pathname: string = "/_health"): {
  status: number;
  headers: Record<string, string>;
  body: string;
} => {
  const isLiveCheck = pathname === "/_health/live";
  // For liveness, as long as process is up, return 200
  if (isLiveCheck) {
    return {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
      },
      body: JSON.stringify({ status: "alive" }),
    };
  }

  // Readiness / general health check: returns 200 only when ready
  const isReady = serverHealthState === "ready";
  const status = isReady ? 200 : 503;
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
    body: JSON.stringify({
      status: isReady ? "ok" : serverHealthState,
      ready: isReady,
    }),
  };
};
