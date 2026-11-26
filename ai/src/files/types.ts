/**
 * The shapes file storage works with: what is known about a stored file, the
 * file with its bytes, the store interface, and the limits once resolved.
 */

/** What is known about a stored file. */
export interface FileMeta {
  /** A display name, already cleaned: never a path, and never used as one. */
  name: string;
  /** The type the bytes were checked to be. */
  mediaType: string;
  size: number;
}

export interface StoredFile extends FileMeta {
  bytes: Uint8Array;
}

/**
 * What the chat needs from file storage. A reader and a file id are keys the
 * library made (an id is a generated UUID, never taken from an upload), and a
 * store refuses any other shape before it uses one as a key or a path.
 * `get` and `put` hand over copies, like a conversation store does.
 */
export interface FileStore {
  put(reader: string, id: string, file: StoredFile): Promise<void>;
  /** The reader's file with that id, or null when there is none. */
  get(reader: string, id: string): Promise<StoredFile | null>;
  remove(reader: string, id: string): Promise<void>;
}

export interface ResolvedFileLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxAttachedBytes: number;
  types: readonly string[];
}
