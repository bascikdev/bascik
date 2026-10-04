/**
 * example.ts: fetch one folder of a GitHub repository into a new project directory.
 *
 * The archive is streamed from codeload.github.com and read with tar's parser, which only reads. This
 * module writes the files itself, so every destination path passes through `safeRelativePath` first and
 * no link of any kind is ever created. Entries outside the chosen folder are skipped without being
 * written. Everything is extracted into a staging directory that only moves into place after the folder
 * has been validated, and that this module removes on every failure.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { Parser, type ReadEntry } from "tar";
import type { ExampleSource } from "./catalog.js";

export class ExampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExampleError";
  }
}

export interface Limits {
  /** Time allowed for the whole download and extraction. */
  timeoutMs: number;
  /** Compressed bytes read from the network. */
  maxDownloadBytes: number;
  /** Uncompressed bytes of every entry in the archive, selected or not (guards against zip bombs). */
  maxArchiveBytes: number;
  /** Uncompressed bytes written to disk. */
  maxWrittenBytes: number;
  maxFileBytes: number;
  /** Entries read from the archive, selected or not. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 180_000,
  maxDownloadBytes: 256 * 1024 * 1024,
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxWrittenBytes: 200 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxEntries: 50_000,
};

export const DEFAULT_ARCHIVE_BASE = "https://codeload.github.com";

export interface DownloadOptions {
  /** Replaces the codeload host. For tests; the CLI reads it from CREATE_BASCIK_ARCHIVE_BASE. */
  archiveBase?: string;
  fetchImpl?: typeof fetch;
  limits?: Partial<Limits>;
}

export interface ExtractResult {
  files: number;
  bytes: number;
}

export function archiveUrl(source: ExampleSource, base: string = DEFAULT_ARCHIVE_BASE): string {
  const parts = [source.owner, source.repo, "tar.gz", source.ref ?? "HEAD"].map(encodeURIComponent);
  return `${base.replace(/\/+$/, "")}/${parts.join("/")}`;
}

/**
 * Split an archive entry path into safe segments, or throw. Rejects absolute paths, drive letters,
 * backslashes, NUL, and `..`. `.` and empty segments are dropped.
 */
export function safeSegments(entryPath: string): string[] {
  if (entryPath.includes("\0")) throw new ExampleError("The archive contains a path with a NUL character.");
  if (entryPath.includes("\\")) throw new ExampleError(`The archive contains a path with a backslash: "${entryPath}".`);
  if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
    throw new ExampleError(`The archive contains an absolute path: "${entryPath}".`);
  }
  const segments: string[] = [];
  for (const segment of entryPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new ExampleError(`The archive contains a path that climbs out of its folder: "${entryPath}".`);
    segments.push(segment);
  }
  return segments;
}

function describeStatus(status: number, source: ExampleSource): string {
  if (status === 404) {
    return (
      `GitHub has no archive for ${source.owner}/${source.repo}${source.ref ? ` at "${source.ref}"` : ""}. ` +
      "Check the spelling. Private repositories are not supported" +
      (source.kind === "official" ? ", and the example may not be published yet." : ".")
    );
  }
  if (status === 403 || status === 429) return `GitHub refused the download (HTTP ${status}). You may be rate limited; try again later.`;
  return `GitHub answered HTTP ${status}.`;
}

async function openArchive(source: ExampleSource, options: DownloadOptions, signal: AbortSignal): Promise<Response> {
  const base = options.archiveBase ?? DEFAULT_ARCHIVE_BASE;
  const url = archiveUrl(source, base);
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, { signal, redirect: "follow", headers: { "user-agent": "create-bascik", accept: "application/gzip" } });
  } catch (error) {
    if (signal.aborted) throw new ExampleError("The download timed out. Check your connection and try again.");
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new ExampleError(`Could not reach ${new URL(url).host}: ${reason}. This command needs an internet connection.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => { });
    throw new ExampleError(describeStatus(response.status, source));
  }
  // A repository that moved redirects, but only ever to GitHub's archive host.
  if (!options.archiveBase) {
    const finalHost = new URL(response.url || url).hostname;
    if (finalHost !== "codeload.github.com") {
      await response.body?.cancel().catch(() => { });
      throw new ExampleError(`The download was redirected to an unexpected host (${finalHost}) and was refused.`);
    }
  }
  if (!response.body) throw new ExampleError("GitHub sent an empty response.");
  return response;
}

/**
 * Stream the archive into `stagingDir`, writing only files under `source.path`. Throws ExampleError
 * for network failures, limit violations, unsafe entries, and a folder that is not in the archive.
 */
export async function extractExample(source: ExampleSource, stagingDir: string, options: DownloadOptions = {}): Promise<ExtractResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const response = await openArchive(source, options, signal);
  const prefix = source.path === "" ? [] : source.path.split("/");
  const root = resolve(stagingDir);

  let failure: Error | undefined;
  let entries = 0;
  let archiveBytes = 0;
  let downloaded = 0;
  let files = 0;
  let written = 0;
  let sawFolder = false;
  const writes: Promise<void>[] = [];
  const made = new Set<string>();

  const input = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    input.destroy();
  };

  // Synchronous on purpose: an entry's data starts flowing as soon as the handler returns, so the
  // write stream must be attached in the same turn or the first bytes are lost.
  const ensureDir = (directory: string): void => {
    if (made.has(directory)) return;
    mkdirSync(directory, { recursive: true });
    made.add(directory);
  };

  const destinationFor = (relative: string[]): string => {
    const target = resolve(root, ...relative);
    if (target !== root && !target.startsWith(root + sep)) throw new ExampleError(`The archive tried to write outside the project: "${relative.join("/")}".`);
    return target;
  };

  const parser = new Parser({
    // Anything that is not a plain file or folder in the chosen folder is an error. Everything else
    // is read and discarded without being written.
    onReadEntry: (entry: ReadEntry) => {
      if (failure) return void entry.resume();
      try {
        entries++;
        if (entries > limits.maxEntries) throw new ExampleError(`The archive has more than ${limits.maxEntries} entries and was refused.`);
        archiveBytes += entry.size ?? 0;
        if (archiveBytes > limits.maxArchiveBytes) throw new ExampleError("The archive expands to more than 1 GiB and was refused.");

        const type = entry.type;
        if (type === "GlobalExtendedHeader" || type === "ExtendedHeader") return void entry.resume();
        const full = safeSegments(entry.path);
        // The first segment is the folder GitHub wraps every archive in (`repo-branch/`).
        const inside = full.slice(1);
        const underPrefix = prefix.length <= inside.length && prefix.every((part, index) => inside[index] === part);
        if (!underPrefix) return void entry.resume();
        const relative = inside.slice(prefix.length);

        if (relative.length === 0) {
          if (type !== "Directory") throw new ExampleError(`"${source.path}" is a ${type === "File" ? "file" : "link"}, not a folder.`);
          sawFolder = true;
          return void entry.resume();
        }
        sawFolder = true;
        if (type === "SymbolicLink" || type === "Link") {
          throw new ExampleError(`The example contains a ${type === "Link" ? "hard link" : "symbolic link"} ("${relative.join("/")}"), which is not allowed.`);
        }
        const target = destinationFor(relative);
        if (type === "Directory") {
          ensureDir(target);
          return void entry.resume();
        }
        if (type !== "File" && type !== "OldFile" && type !== "ContiguousFile") {
          throw new ExampleError(`The example contains an unsupported entry ("${relative.join("/")}", ${type}).`);
        }
        const size = entry.size ?? 0;
        if (size > limits.maxFileBytes) throw new ExampleError(`"${relative.join("/")}" is larger than ${limits.maxFileBytes / 1024 / 1024} MiB and was refused.`);
        written += size;
        if (written > limits.maxWrittenBytes) throw new ExampleError(`The example is larger than ${limits.maxWrittenBytes / 1024 / 1024} MiB and was refused.`);
        files++;
        const executable = ((entry.mode ?? 0) & 0o111) !== 0;
        ensureDir(dirname(target));
        const done = new Promise<void>((accept, reject) => {
          // 'wx' refuses to follow or replace anything that already exists at the destination.
          const out = createWriteStream(target, { flags: "wx", mode: executable ? 0o755 : 0o644 });
          out.once("error", reject);
          out.once("close", accept);
          entry.pipe(out);
        });
        done.catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
        writes.push(done);
      } catch (error) {
        fail(error as Error);
        entry.resume();
      }
    },
  });

  try {
    await new Promise<void>((accept, reject) => {
      parser.once("close", accept);
      parser.once("error", reject);
      input.once("error", reject);
      input.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (downloaded > limits.maxDownloadBytes) {
          fail(new ExampleError(`The download is larger than ${limits.maxDownloadBytes / 1024 / 1024} MiB and was refused.`));
          return;
        }
        if (failure) return;
        if (!parser.write(chunk)) {
          input.pause();
          parser.once("drain", () => input.resume());
        }
      });
      input.once("end", () => parser.end());
      input.once("close", () => {
        if (failure) reject(failure);
      });
    });
    await Promise.allSettled(writes);
  } catch (error) {
    await Promise.allSettled(writes);
    if (failure) throw failure;
    if (signal.aborted) throw new ExampleError("The download timed out. Check your connection and try again.");
    const message = error instanceof Error ? error.message : String(error);
    throw new ExampleError(`The archive could not be read (${message}). It may be corrupted or incomplete.`);
  }
  if (failure) throw failure;
  if (signal.aborted) throw new ExampleError("The download timed out. Check your connection and try again.");

  if (!sawFolder) {
    throw new ExampleError(
      source.path
        ? `The folder "${source.path}" does not exist in ${source.owner}/${source.repo}${source.ref ? ` at "${source.ref}"` : ""}.`
        : `The repository ${source.owner}/${source.repo} is empty.`,
    );
  }
  if (files === 0) throw new ExampleError(`The folder "${source.path}" contains no files.`);
  return { files, bytes: written };
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

export interface TemplateInfo {
  license?: string;
  requirements: string[];
  /** Minimum Node version from `requires.node` when written as `>=X.Y.Z`. */
  minNode?: string;
  /** Raw `requires.bascik` range, shown to the user. */
  bascikRange?: string;
}

/** `true` when `version` (like `v24.1.0`) is at least `minimum` (like `24.0.0`). */
export function nodeSatisfies(version: string, minimum: string): boolean {
  const parse = (value: string): number[] => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version);
  const need = parse(minimum);
  for (let index = 0; index < 3; index++) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}

/** Read `template.json` if present. Unknown or malformed fields are ignored, never trusted. */
export async function readTemplateInfo(directory: string): Promise<TemplateInfo> {
  let text: string;
  try {
    text = await readFile(join(directory, "template.json"), "utf8");
  } catch {
    return { requirements: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ExampleError("template.json in the example is not valid JSON.");
  }
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const requires = (record.requires && typeof record.requires === "object" ? record.requires : {}) as Record<string, unknown>;
  const info: TemplateInfo = {
    requirements: Array.isArray(record.requirements) ? record.requirements.filter((item): item is string => typeof item === "string") : [],
  };
  if (typeof record.license === "string") info.license = record.license;
  if (typeof requires.bascik === "string") info.bascikRange = requires.bascik;
  if (typeof requires.node === "string") {
    const match = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(requires.node.trim());
    if (match) info.minNode = match[1];
  }
  return info;
}

/** The selected folder must be a project: a package.json that parses to an object. */
export async function readProjectManifest(directory: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(directory, "package.json"), "utf8");
  } catch {
    throw new ExampleError(
      "The selected folder has no package.json, so it is not a project. " +
      "If the example lives in a subfolder, pass it in the link (.../tree/main/folder) or with --example-path.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ExampleError("The example's package.json is not a valid JSON object.");
}

// ── destination and staging ───────────────────────────────────────────────────────────────────

/** Throws unless `directory` does not exist or is an empty folder. Nothing is created or changed. */
export async function assertDestinationFree(directory: string): Promise<void> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) throw new ExampleError(`"${directory}" already exists and is not a folder.`);
    if ((await readdir(directory)).length > 0) {
      throw new ExampleError(`"${directory}" already exists and is not empty. Choose another name or empty it first.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export interface InstallOptions extends DownloadOptions {
  /** Node version to check `template.json` against. Defaults to this process. */
  nodeVersion?: string;
  /** Called with the staging directory right after it is created, so a signal handler can remove it. */
  onStaging?: (directory: string) => void;
}

export interface InstalledExample {
  directory: string;
  files: number;
  info: TemplateInfo;
}

/**
 * Download `source` into `destination`. The destination is created only after everything has been
 * validated; on any failure it is left exactly as it was and the staging directory is removed.
 */
export async function installExample(
  source: ExampleSource,
  destination: string,
  packageName: string,
  options: InstallOptions = {},
): Promise<InstalledExample> {
  await assertDestinationFree(destination);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".create-bascik-"));
  options.onStaging?.(staging);
  try {
    const { files } = await extractExample(source, staging, options);
    const manifest = await readProjectManifest(staging);
    const info = await readTemplateInfo(staging);
    const nodeVersion = options.nodeVersion ?? process.version;
    if (info.minNode && !nodeSatisfies(nodeVersion, info.minNode)) {
      throw new ExampleError(`This example needs Node ${info.minNode} or later, and you are running ${nodeVersion}.`);
    }
    // The project takes the name the user chose; the rest of the example's package.json is untouched.
    if (typeof manifest.name === "string") {
      manifest.name = packageName;
      await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    // Checked again because the pre-check ran before a possibly long download.
    await assertDestinationFree(destination);
    await rmdir(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(staging, destination);
    return { directory: destination, files, info };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
