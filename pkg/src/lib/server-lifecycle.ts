import { nativeClock, type FrameworkClock, type TimeoutHandle } from './clock.ts';
import { runShutdownHandlers } from './events.ts';

export type ServerHealthState = "booting" | "ready" | "draining";

let serverHealthState: ServerHealthState = "ready";

export const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
export const MAX_PORT_INCREMENTS = 20;

export interface GracefulShutdownOptions {
  server: {
    close: (cb?: (err?: Error) => void) => void;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  drainTimeout?: number;
  onShutdown?: () => void;
  runShutdownHandlers?: () => Promise<void>;
  exit?: (code: number) => void;
  clock?: FrameworkClock;
}

export const createGracefulShutdownHandler = (options: GracefulShutdownOptions): ((signal: string) => void) => {
  let shuttingDown = false;
  let exitSettled = false;
  let forceExitTimer: TimeoutHandle | null = null;
  const clock = options.clock ?? nativeClock;
  const drainTimeout = options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  const shutdownHandlersRunner = options.runShutdownHandlers ?? runShutdownHandlers;

  const performExit = (code: number) => {
    if (exitSettled) return;
    exitSettled = true;
    if (forceExitTimer !== null) {
      clock.clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    exitFn(code);
  };

  return (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    setServerHealthState("draining");
    console.log(`\nReceived ${signal}, shutting down gracefully…`);

    // 1. Stop accepting new connections
    if (typeof options.server.closeIdleConnections === "function") {
      try {
        options.server.closeIdleConnections();
      } catch { }
    }

    // 2. Custom protocol cleanup callback (sockets/sessions)
    if (options.onShutdown) {
      try {
        options.onShutdown();
      } catch { }
    }

    if (typeof options.server.closeAllConnections === "function") {
      try {
        options.server.closeAllConnections();
      } catch { }
    }

    // 3. Await registered shutdown handlers (watchers, exec children)
    shutdownHandlersRunner().catch((err) => {
      console.error("[bascik] Error running shutdown handlers:", err);
    });

    options.server.close((err) => {
      if (err) console.error("Error closing server:", err);
      performExit(0);
    });

    // Force exit if server close hangs past configured drain timeout
    forceExitTimer = clock.setTimeout(() => {
      console.error("Graceful shutdown timeout: forcing exit");
      performExit(1);
    }, drainTimeout);

    if (typeof (forceExitTimer as any)?.unref === 'function') {
      (forceExitTimer as any).unref();
    }
  };
};

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
