/**
 * ReaderData: one SQLite-backed Durable Object per reader (named
 * `reader:<readerId>`), holding their conversations, memories, and attached
 * files. `src/lib/cf-stores.ts` turns its methods into the ConversationStore,
 * MemoryStore, and FileStore that `createChat` takes.
 *
 * Everything is kept 24 hours after the reader's last write: every write
 * moves the alarm, and the alarm deletes the object's storage. Reads never
 * write, so a visitor who only looks keeps nothing. A reader's first write
 * (the object has no alarm yet) is counted against the day's cap on new
 * readers, in the Budget object for the day.
 *
 * Ids arrive over RPC from this Worker's own code, but they came from a
 * request first, so each one is checked again here.
 */
import { DurableObject } from "cloudflare:workers";
import type { Conversation } from "@bascik/ai/app";
import { searchMemories, type Memory } from "@bascik/ai/memory";
import type { StoredFile } from "@bascik/ai/files";
import {
  DEMO_FULL,
  numberVar,
  RETENTION_MS,
  utcDay,
  type Env,
} from "../src/lib/env.ts";

/** A conversation without its messages. */
export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "updatedAt"
>;

/**
 * Backstops. The chat itself keeps a reader to 20 conversations of 256 KB
 * (`maxConversations`, `maxConversationBytes` in src/lib/chat.ts), so these
 * only stop a write that got past it.
 */
export const MAX_CONVERSATIONS = 25;
export const MAX_CONVERSATION_BYTES = 512 * 1024;
export const MAX_MEMORIES = 50;
export const MAX_READER_FILE_BYTES = 3 * 1024 * 1024;
/** Files are stored in pieces, so no row comes near SQLite's 2 MB limit. */
export const CHUNK_BYTES = 512 * 1024;

/** Readers per day when `GENUI_DAILY_READERS` is not set. */
const DAILY_READERS = 2000;

/** The ids a store accepts: what `isSafeKey` in @bascik/ai accepts. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeKey = (value: unknown): value is string =>
  typeof value === "string" && SAFE_KEY.test(value);

type Row = Record<string, SqlStorageValue>;

export class ReaderData extends DurableObject<Env> {
  /** Whether the tables exist in this instance. The alarm's deleteAll drops them. */
  private ready = false;

  /** Run a statement, making the tables first in a new or emptied object. */
  private cursor(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<Row> {
    if (!this.ready) {
      const { sql } = this.ctx.storage;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER, conversation_id TEXT)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL)",
      );
      sql.exec(
        "CREATE TABLE IF NOT EXISTS file_chunks (id TEXT NOT NULL, n INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (id, n))",
      );
      this.ready = true;
    }
    return this.ctx.storage.sql.exec<Row>(query, ...bindings);
  }

  private sql(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.cursor(query, ...bindings).toArray();
  }

  /**
   * Before a write: a reader with no data yet is counted against the day's
   * cap, and refused when it is reached. After it, `kept` moves the alarm.
   */
  private async admit(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    const budget = this.env.BUDGET.get(
      this.env.BUDGET.idFromName(`day:${utcDay()}`),
    );
    const limit = numberVar(this.env.GENUI_DAILY_READERS, DAILY_READERS);
    if (!(await budget.charge("readers", limit, 2 * RETENTION_MS))) {
      throw new Error(DEMO_FULL);
    }
  }

  private async kept(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
  }

  /** 24 hours after the last write: forget the reader. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }

  /* ---- Conversations ---- */

  async load(id: string): Promise<Conversation | null> {
    if (!isSafeKey(id)) return null;
    const row = this.sql("SELECT body FROM conversations WHERE id = ?", id)[0];
    return row ? (JSON.parse(String(row.body)) as Conversation) : null;
  }

  async save(conversation: Conversation): Promise<void> {
    if (!isSafeKey(conversation.id)) {
      throw new Error("That conversation id cannot be stored.");
    }
    const body = JSON.stringify(conversation);
    if (new TextEncoder().encode(body).byteLength > MAX_CONVERSATION_BYTES) {
      throw new Error("This conversation is full.");
    }
    await this.admit();
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR REPLACE INTO conversations (id, title, updated_at, body) VALUES (?, ?, ?, ?)",
        conversation.id,
        conversation.title,
        conversation.updatedAt,
        body,
      );
      const count = Number(
        this.sql("SELECT COUNT(*) AS c FROM conversations")[0]!.c,
      );
      if (count > MAX_CONVERSATIONS) {
        this.sql(
          "DELETE FROM conversations WHERE id IN (SELECT id FROM conversations WHERE id != ? ORDER BY updated_at ASC LIMIT ?)",
          conversation.id,
          count - MAX_CONVERSATIONS,
        );
      }
    });
    await this.kept();
  }

  /** Every conversation, newest first, with its messages: search reads them. */
  async list(): Promise<Conversation[]> {
    return this.sql(
      "SELECT body FROM conversations ORDER BY updated_at DESC",
    ).map((row) => JSON.parse(String(row.body)) as Conversation);
  }

  async summaries(): Promise<ConversationSummary[]> {
    return this.sql(
      "SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC",
    ).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      updatedAt: Number(row.updated_at),
    }));
  }

  async delete(id: string): Promise<void> {
    if (!isSafeKey(id)) return;
    const removed = this.cursor(
      "DELETE FROM conversations WHERE id = ?",
      id,
    ).rowsWritten;
    if (removed > 0) await this.kept();
  }

  /* ---- Memories ---- */

  private memories(): Memory[] {
    return this.sql(
      "SELECT id, text, created, updated, conversation_id FROM memories ORDER BY created DESC",
    ).map((row) => {
      const memory: Memory = {
        id: String(row.id),
        text: String(row.text),
        created: Number(row.created),
      };
      if (row.updated !== null) memory.updated = Number(row.updated);
      if (row.conversation_id !== null) {
        memory.conversationId = String(row.conversation_id);
      }
      return memory;
    });
  }

  async listMemories(): Promise<Memory[]> {
    return this.memories();
  }

  async addMemory(memory: Memory): Promise<void> {
    if (!isSafeKey(memory.id))
      throw new Error("That memory id cannot be stored.");
    if (
      memory.conversationId !== undefined &&
      !isSafeKey(memory.conversationId)
    ) {
      throw new Error("That conversation id cannot be stored.");
    }
    await this.admit();
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR REPLACE INTO memories (id, text, created, updated, conversation_id) VALUES (?, ?, ?, ?, ?)",
        memory.id,
        memory.text,
        memory.created,
        memory.updated ?? null,
        memory.conversationId ?? null,
      );
      const count = Number(
        this.sql("SELECT COUNT(*) AS c FROM memories")[0]!.c,
      );
      if (count > MAX_MEMORIES) {
        this.sql(
          "DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE id != ? ORDER BY created ASC LIMIT ?)",
          memory.id,
          count - MAX_MEMORIES,
        );
      }
    });
    await this.kept();
  }

  async removeMemory(id: string): Promise<boolean> {
    if (!isSafeKey(id)) return false;
    const removed = this.cursor(
      "DELETE FROM memories WHERE id = ?",
      id,
    ).rowsWritten;
    if (removed === 0) return false;
    await this.kept();
    return true;
  }

  /** At most 50 rows: ranked by the library's own word matching. */
  async searchMemories(query: string, limit: number): Promise<Memory[]> {
    return searchMemories(this.memories(), query, limit);
  }

  /* ---- Files ---- */

  async putFile(id: string, file: StoredFile): Promise<void> {
    if (!isSafeKey(id)) throw new Error("That file id cannot be stored.");
    const bytes = file.bytes;
    if (bytes.byteLength > MAX_READER_FILE_BYTES) {
      throw new Error("That file is too large to keep.");
    }
    await this.admit();
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM file_chunks WHERE id = ?", id);
      this.sql("DELETE FROM files WHERE id = ?", id);
      // Make room: the oldest files go first.
      let total = Number(
        this.sql("SELECT COALESCE(SUM(size), 0) AS s FROM files")[0]!.s,
      );
      while (total + bytes.byteLength > MAX_READER_FILE_BYTES) {
        const oldest = this.sql(
          "SELECT id, size FROM files ORDER BY created ASC LIMIT 1",
        )[0];
        if (!oldest) break;
        this.sql("DELETE FROM file_chunks WHERE id = ?", oldest.id!);
        this.sql("DELETE FROM files WHERE id = ?", oldest.id!);
        total -= Number(oldest.size);
      }
      this.sql(
        "INSERT INTO files (id, name, media_type, size, created) VALUES (?, ?, ?, ?, ?)",
        id,
        file.name,
        file.mediaType,
        bytes.byteLength,
        Date.now(),
      );
      for (let n = 0, at = 0; at < bytes.byteLength; n++, at += CHUNK_BYTES) {
        // A copy of exactly this piece: the caller's view may share a larger buffer.
        const piece = bytes.slice(at, at + CHUNK_BYTES);
        this.sql(
          "INSERT INTO file_chunks (id, n, bytes) VALUES (?, ?, ?)",
          id,
          n,
          piece.buffer,
        );
      }
    });
    await this.kept();
  }

  async getFile(id: string): Promise<StoredFile | null> {
    if (!isSafeKey(id)) return null;
    const meta = this.sql(
      "SELECT name, media_type, size FROM files WHERE id = ?",
      id,
    )[0];
    if (!meta) return null;
    const size = Number(meta.size);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const row of this.sql(
      "SELECT bytes FROM file_chunks WHERE id = ? ORDER BY n ASC",
      id,
    )) {
      const piece = new Uint8Array(row.bytes as ArrayBuffer);
      bytes.set(piece, at);
      at += piece.byteLength;
    }
    return {
      name: String(meta.name),
      mediaType: String(meta.media_type),
      size,
      bytes,
    };
  }

  async removeFile(id: string): Promise<void> {
    if (!isSafeKey(id)) return;
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM file_chunks WHERE id = ?", id);
      removed = this.cursor("DELETE FROM files WHERE id = ?", id).rowsWritten;
    });
    if (removed > 0) await this.kept();
  }
}
