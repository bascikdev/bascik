/**
 * Files a reader attaches to a message: where they are kept, what is let in,
 * and how they are served back.
 *
 * Everything an upload could do to the app is decided here, not in a route:
 * the limits, which types are accepted and how a type is told, the name that
 * is kept, and the headers a file is served with. An app passes a `FileStore`
 * (two are here; a consumer backs one with object storage) and, if it wants,
 * its own limits. A file is only ever stored for the reader who sent it and
 * only ever served back to them.
 */
export type {
  FileMeta,
  FileStore,
  ResolvedFileLimits,
  StoredFile,
} from "./files/types.ts";
export { diskFiles, inMemoryFiles } from "./files/stores.ts";
export {
  DEFAULT_FILE_TYPES,
  DEFAULT_MAX_ATTACHED_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  resolveLimits,
} from "./files/limits.ts";
export type { FileLimits } from "./files/limits.ts";
export {
  cleanName,
  formatSize,
  isImageType,
  isTextType,
  storedName,
} from "./files/names.ts";
export {
  claimsMarkup,
  sniffBinary,
  sniffFile,
  strictText,
} from "./files/sniff.ts";
export type { Sniffed } from "./files/sniff.ts";
export { checkUploads, refusals } from "./files/uploads.ts";
export type { CheckedFile, UploadCheck } from "./files/uploads.ts";
export { fileResponse, refusedPage } from "./files/responses.ts";
