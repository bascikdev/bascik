import type { BascikResponse } from "./server.ts";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_MAX_SSE_CONNECTIONS = 200;

export interface SseBuildError {
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface SseClient {
  id: number;
  res: BascikResponse;
  openPagePath?: string | null;
  isDraining: boolean;
  lastActive: number;
}

export interface SseManagerOptions {
  heartbeatIntervalMs?: number;
  maxConnections?: number;
}

export class SseManager {
  private heartbeatIntervalMs: number;
  private maxConnections: number;
  private clients = new Map<number, SseClient>();
  private nextClientId = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(options: SseManagerOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_SSE_CONNECTIONS;
    this.startHeartbeat();
  }

  public getNextGeneration(): number {
    return ++this.generation;
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public addClient(res: BascikResponse, openPagePath?: string | null): SseClient | null {
    if (this.clients.size >= this.maxConnections) {
      try {
        res.respond(503, { "content-type": "text/plain" });
        res.end("Too Many SSE Connections");
      } catch { }
      return null;
    }

    const client: SseClient = {
      id: this.nextClientId++,
      res,
      openPagePath: openPagePath ?? null,
      isDraining: false,
      lastActive: Date.now(),
    };

    this.clients.set(client.id, client);

    // Send initial connected payload
    this.send(client, "data: connected\n\n");

    return client;
  }

  public removeClient(id: number): void {
    const client = this.clients.get(id);
    if (client) {
      this.clients.delete(id);
    }
  }

  public send(client: SseClient, data: string): boolean {
    if (client.res.destroyed) {
      this.removeClient(client.id);
      return false;
    }
    try {
      const ok = client.res.write(data);
      client.lastActive = Date.now();
      if (!ok) {
        client.isDraining = true;
        // Wait for drain event
        if (client.res.writable && typeof (client.res.writable as any).once === "function") {
          (client.res.writable as any).once("drain", () => {
            client.isDraining = false;
          });
        }
      }
      return ok;
    } catch {
      this.removeClient(client.id);
      try { client.res.close(); } catch { }
      return false;
    }
  }

  public broadcastReload(relativePagePath?: string, matchHttpPath?: (openPage: string, targetPage: string) => boolean): void {
    const gen = this.getNextGeneration();
    for (const client of this.clients.values()) {
      if (client.res.destroyed) {
        this.removeClient(client.id);
        continue;
      }
      if (relativePagePath && client.openPagePath && matchHttpPath) {
        if (!matchHttpPath(client.openPagePath, relativePagePath)) {
          continue;
        }
      }
      this.send(client, `data: reload ${gen}\n\n`);
    }
  }

  public broadcastError(error: SseBuildError): void {
    const payload = JSON.stringify(error);
    const message = `event: build-error\ndata: ${payload}\n\n`;
    for (const client of this.clients.values()) {
      this.send(client, message);
    }
  }

  public heartbeat(): void {
    const comment = ": ping\n\n";
    for (const client of this.clients.values()) {
      if (client.res.destroyed) {
        this.removeClient(client.id);
        continue;
      }
      // If client is still stalled in drain for multiple heartbeats, close it
      if (client.isDraining && Date.now() - client.lastActive > this.heartbeatIntervalMs * 2) {
        try { client.res.close(); } catch { }
        this.removeClient(client.id);
        continue;
      }
      this.send(client, comment);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  public get activeClientCount(): number {
    return this.clients.size;
  }

  public destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients.values()) {
      try { client.res.close(); } catch { }
    }
    this.clients.clear();
  }
}
