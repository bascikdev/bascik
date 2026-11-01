/**
 * Restarts the language client one at a time. A settings change restarts the server so it reads the new
 * settings, and changes can come close together (two settings updated one after the other): a second
 * `restart()` while the client is still starting rejects ("Client is not running and can't be stopped") and its
 * change is lost. Here a change made while a restart runs asks for one more restart after it, however many
 * changes there were, and a failed restart is logged instead of becoming an unhandled rejection.
 */
export class RestartQueue {
  private running: Promise<void> | undefined;
  /** The restart that will run after the current one, shared by every change made meanwhile. */
  private next: Promise<void> | undefined;
  private disposed = false;

  /**
   * `ready` is the client's first start: a restart asked for while it still runs would reject the same way
   * and lose its change, so every restart waits for it first.
   */
  constructor(
    private readonly restart: () => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly ready?: Promise<unknown>,
  ) {}

  /** Asks for a restart that starts after this call; resolves once it has finished (or failed, and been logged). */
  request(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    this.next ??= this.running.then(() => {
      this.next = undefined;
      return this.request();
    });
    return this.next;
  }

  /** Settles once the running restart and the one queued after it (if any) have finished. */
  async settled(): Promise<void> {
    while (this.running || this.next) await (this.next ?? this.running);
  }

  /** Prevents pending restarts from starting; a restart already in progress may finish. */
  dispose(): void {
    this.disposed = true;
  }

  private async run(): Promise<void> {
    try {
      if (this.ready) await this.ready;
      if (this.disposed) return;
      await this.restart();
    } catch (error) {
      this.log(
        `Bascik could not restart its language server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
