/**
 * Budget: one small counter per object, named for what it counts and when
 * (`day:<date>` for new readers, `ip:<hash>:<window>` for sends). Each
 * object answers for its own name only, so no counter is a global hot spot,
 * and each deletes itself by alarm once its window is over.
 *
 * A Durable Object runs one call at a time, and these calls await nothing
 * but its own storage, so a charge is a read and a write with nothing in
 * between: 50 charges at once count exactly 50.
 */
import { DurableObject } from "cloudflare:workers";

export class Budget extends DurableObject {
  /**
   * Count one of `counter` if fewer than `limit` were counted, and keep the
   * object for `ttlMs` from its first count. True when it was counted.
   */
  async charge(
    counter: string,
    limit: number,
    ttlMs: number,
  ): Promise<boolean> {
    const used = (await this.ctx.storage.get<number>(counter)) ?? 0;
    if (used >= limit) return false;
    await this.ctx.storage.put(counter, used + 1);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ttlMs);
    }
    return true;
  }

  /** How many of `counter` were counted. */
  async count(counter: string): Promise<number> {
    return (await this.ctx.storage.get<number>(counter)) ?? 0;
  }

  /** The window is over: forget every counter. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
