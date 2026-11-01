/**
 * The engine the language server asks for TypeScript diagnostics, behind a small asynchronous interface.
 *
 * The language server never waits on TypeScript to publish its own diagnostics, and TypeScript's first check of a
 * project (a few seconds: parsing the DOM library and, in a project with `@types/node`, Node's types) must not
 * hold up a completion or another file's diagnostics. So the editor runs the engine in a worker thread (`createWorkerTypeScriptEngine`); tests and
 * hosts without a worker file run it on the main thread after the current turn (`createInProcessTypeScriptEngine`).
 * The interface is also the seam for swapping TypeScript's JavaScript LanguageService for TypeScript 7's native
 * API later.
 *
 * Cancellation: every edit makes the project's requests stale by bumping its epoch in shared memory. A queued
 * request that is stale is dropped before it starts, and one that is running stops at TypeScript's next
 * cancellation check, so typing never builds a queue.
 */
import { Worker } from "node:worker_threads";
import type { ComponentSource } from "./project.js";
import type {
  TypeScriptFeatureKind,
  TypeScriptFeatureQuery,
} from "./typescript-features.js";
import {
  TypeScriptProjects,
  type TypeScriptDiagnosticsResult,
  type TypeScriptFeatureResult,
  type TypeScriptPagesRequest,
} from "./typescript-service.js";

export type {
  TypeScriptDiagnosticsResult,
  TypeScriptFeatureResult,
  TypeScriptPagesRequest,
  TypeScriptPageText,
} from "./typescript-service.js";
export type * from "./typescript-features.js";

export interface TypeScriptCheckRequest {
  projectRoot: string;
  /** `scripts.importRoot`, resolved. */
  importRoot: string;
  htmlPath: string;
  /** The page's current text, which may be unsaved. */
  text: string;
  /** Each client block runs in its own scope (a scoped component); otherwise, as in a page, they share one. */
  isolatedClientBlocks?: boolean;
  /** The HTML of the components whose client scripts run in the page's scope (see `PageCheckOptions`). */
  pageScopeHtml?: string[];
  /** The components with TypeScript blocks the page uses, whose global additions hold on it (see `PageCheckOptions`). */
  usedComponents?: ComponentSource[];
}

/** A language feature at an offset of a page, with the page's current text. */
export type TypeScriptFeatureRequest<
  K extends TypeScriptFeatureKind = TypeScriptFeatureKind,
> = TypeScriptCheckRequest & { query: TypeScriptFeatureQuery<K> };

export interface TypeScriptEngine {
  diagnostics(
    request: TypeScriptCheckRequest,
  ): Promise<TypeScriptDiagnosticsResult>;
  /**
   * Hover, definition, completion or signature help inside the page's TypeScript blocks. It goes stale, like a
   * check, when the project's next edit arrives first.
   */
  feature<K extends TypeScriptFeatureKind>(
    request: TypeScriptFeatureRequest<K>,
  ): Promise<TypeScriptFeatureResult<K>>;
  /**
   * Gives the engine the current text of several pages before they are checked one by one, so TypeScript builds
   * its programs once for all of them rather than once per page.
   */
  preparePages(request: TypeScriptPagesRequest): void;
  /** Makes every running or queued request for the project stale. */
  cancel(projectRoot: string): void;
  /** Records (or, with `undefined`, drops) an editor buffer of a file the blocks may import. */
  setOpenFile(fsPath: string, text: string | undefined): void;
  /** A file the blocks may import, or a `tsconfig.json` or `package.json`, changed on disk. */
  fileChanged(fsPath: string): void;
  /** An HTML file closed: its blocks leave the programs. */
  closePage(projectRoot: string, htmlPath: string): void;
  /** The project's settings may have changed (its Bascik config): it is made again on the next request. */
  forgetProject(projectRoot: string): void;
  /**
   * Frees TypeScript's memory while no page needs it: every project is dropped and a worker ends. The next
   * request starts again (with the open buffers it was given), so a release is never a crash.
   */
  release(): Promise<void>;
  dispose(): Promise<void>;
}

/** How the engine finds TypeScript; see `typescript-loader.ts`. */
export interface TypeScriptEngineSettings {
  /** A `typescript` package folder the client passes (VS Code passes the `bascik.typescript.path` setting). */
  clientPath?: string;
  /** The editor's own `typescript` package folder, tried after `clientPath` (VS Code passes its bundled copy). */
  editorPath?: string;
  /** Where to resolve an installed peer `typescript` after the project. */
  fallbackFrom?: string;
}

/** How many projects get their own cancellation slot; more share slots, which only cancels a little more often. */
const EPOCH_SLOTS = 64;

/** Per-project request epochs, in memory a worker can read while it checks. */
class Epochs {
  readonly buffer = new SharedArrayBuffer(EPOCH_SLOTS * 4);
  private readonly values = new Int32Array(this.buffer);
  private readonly slots = new Map<string, number>();

  slot(projectRoot: string): number {
    let slot = this.slots.get(projectRoot);
    if (slot === undefined) {
      slot = this.slots.size % EPOCH_SLOTS;
      this.slots.set(projectRoot, slot);
    }
    return slot;
  }

  current(slot: number): number {
    return Atomics.load(this.values, slot);
  }

  bump(projectRoot: string): void {
    Atomics.add(this.values, this.slot(projectRoot), 1);
  }
}

/** Reads the epochs in a worker, from the buffer the main thread shares. */
export function readEpoch(buffer: SharedArrayBuffer, slot: number): number {
  return Atomics.load(new Int32Array(buffer), slot);
}

const failure = (error: unknown): { status: "failed"; message: string } => ({
  status: "failed",
  message:
    error instanceof Error ? (error.stack ?? error.message) : String(error),
});

/** Runs the engine on the main thread, after the current turn, so the caller's own work goes first. */
export function createInProcessTypeScriptEngine(
  settings: TypeScriptEngineSettings = {},
): TypeScriptEngine {
  const epochs = new Epochs();
  let running: { slot: number; epoch: number } | undefined;
  // Projects are dropped on release; the open buffers are kept, as a restarted worker gets them again.
  const projects = new TypeScriptProjects({
    clientPath: settings.clientPath,
    editorPath: settings.editorPath,
    fallbackFrom: settings.fallbackFrom,
    isCancellationRequested: () =>
      running !== undefined && epochs.current(running.slot) !== running.epoch,
  });
  return {
    async diagnostics(request) {
      const slot = epochs.slot(request.projectRoot);
      const epoch = epochs.current(slot);
      await new Promise((resolve) => setImmediate(resolve));
      if (epochs.current(slot) !== epoch) return { status: "cancelled" };
      running = { slot, epoch };
      try {
        return projects.diagnostics(request);
      } catch (error) {
        return failure(error);
      } finally {
        running = undefined;
      }
    },
    async feature(request) {
      const slot = epochs.slot(request.projectRoot);
      const epoch = epochs.current(slot);
      await new Promise((resolve) => setImmediate(resolve));
      if (epochs.current(slot) !== epoch) return { status: "cancelled" };
      running = { slot, epoch };
      try {
        return projects.feature(request, request.query);
      } catch (error) {
        return failure(error);
      } finally {
        running = undefined;
      }
    },
    preparePages: (request) => projects.preparePages(request),
    cancel: (projectRoot) => epochs.bump(projectRoot),
    setOpenFile: (fsPath, text) => projects.setOpenFile(fsPath, text),
    fileChanged: (fsPath) => projects.fileChanged(fsPath),
    closePage: (projectRoot, htmlPath) =>
      projects.closePage(projectRoot, htmlPath),
    forgetProject: (projectRoot) => projects.forgetProject(projectRoot),
    async release() {
      projects.dispose();
    },
    async dispose() {
      projects.dispose();
    },
  };
}

/** Messages from the main thread to the worker. */
export type TypeScriptWorkerRequest =
  | ({
      type: "diagnostics";
      id: number;
      slot: number;
      epoch: number;
    } & TypeScriptCheckRequest)
  | ({
      type: "feature";
      id: number;
      slot: number;
      epoch: number;
    } & TypeScriptFeatureRequest)
  | ({ type: "preparePages" } & TypeScriptPagesRequest)
  | { type: "openFile"; fsPath: string; text: string | undefined }
  | { type: "fileChanged"; fsPath: string }
  | { type: "closePage"; projectRoot: string; htmlPath: string }
  | { type: "forgetProject"; projectRoot: string }
  /** Ends the worker: it drops its projects and closes its port, so its thread exits on its own. */
  | { type: "stop" };

export interface TypeScriptWorkerResponse {
  id: number;
  result: TypeScriptDiagnosticsResult | TypeScriptFeatureResult;
}

/** What the worker is started with. The flag tells a bundle that holds both entry points which one to run. */
export interface TypeScriptWorkerData {
  bascikTypeScriptWorker: true;
  settings: TypeScriptEngineSettings;
  epochs: SharedArrayBuffer;
}

/** After this many crashes the worker is not started again, and TypeScript checks stay off. */
const MAX_WORKER_CRASHES = 3;

/**
 * How long a worker asked to stop has to exit before it is terminated. An external `terminate()` stops a thread
 * wherever it is, which Node 24's V8 can abort the process for (see the page worker pool), so it is the fallback.
 */
const STOP_GRACE_MS = 3000;

/**
 * Runs the engine in a worker thread started from `workerFile`: `typescript-worker.js`, or a bundle that runs it
 * when its `workerData` says so. The worker starts on the first request, so a project without TypeScript blocks
 * never loads TypeScript, and ends on `release`, which gives its memory back. A crashed or released worker is
 * started again (with the open buffers sent again) on the next request.
 */
export function createWorkerTypeScriptEngine(
  workerFile: string | URL,
  settings: TypeScriptEngineSettings = {},
): TypeScriptEngine {
  const epochs = new Epochs();
  const openFiles = new Map<string, string>();
  const pending = new Map<
    number,
    (result: TypeScriptWorkerResponse["result"]) => void
  >();
  let worker: Worker | undefined;
  let crashes = 0;
  let disposed = false;
  let lastCrash = "";
  let nextId = 1;

  const settleAll = (
    result: Extract<
      TypeScriptDiagnosticsResult,
      { status: "failed" | "cancelled" }
    >,
  ) => {
    for (const resolve of pending.values()) resolve(result);
    pending.clear();
  };

  const start = (): Worker | undefined => {
    if (worker) return worker;
    if (disposed || crashes >= MAX_WORKER_CRASHES) return undefined;
    const data: TypeScriptWorkerData = {
      bascikTypeScriptWorker: true,
      settings,
      epochs: epochs.buffer,
    };
    const started = new Worker(workerFile, { workerData: data });
    // The language server's own process lifetime decides when the worker ends.
    started.unref();
    started.on("message", (response: TypeScriptWorkerResponse) => {
      pending.get(response.id)?.(response.result);
      pending.delete(response.id);
    });
    const stopped = (reason: string) => {
      // A worker that was released or disposed is not a crash.
      if (worker !== started) return;
      worker = undefined;
      crashes++;
      lastCrash = reason;
      settleAll({
        status: "failed",
        message: `The TypeScript worker stopped: ${reason}`,
      });
    };
    started.on("error", (error) => stopped(error.stack ?? error.message));
    started.on("exit", (code) => stopped(`it exited with code ${code}`));
    worker = started;
    for (const [fsPath, text] of openFiles)
      started.postMessage({
        type: "openFile",
        fsPath,
        text,
      } satisfies TypeScriptWorkerRequest);
    return started;
  };

  const post = (message: TypeScriptWorkerRequest) =>
    worker?.postMessage(message);

  /** Asks a worker to end itself, and terminates it only if it has not exited after `STOP_GRACE_MS`. */
  const stop = (stopping: Worker): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        void stopping.terminate().finally(resolve);
      }, STOP_GRACE_MS);
      timer.unref();
      stopping.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        stopping.postMessage({
          type: "stop",
        } satisfies TypeScriptWorkerRequest);
      } catch {
        clearTimeout(timer);
        void stopping.terminate().finally(resolve);
      }
    });

  /** Stops the worker without counting it as a crash; the next request starts a new one. */
  const end = async () => {
    const running = worker;
    worker = undefined;
    settleAll({ status: "cancelled" });
    if (running) await stop(running);
  };

  const unavailable = () =>
    Promise.resolve({
      status: "unavailable" as const,
      message: disposed
        ? "TypeScript checks are off: the language server is stopping"
        : `TypeScript checks are off: the TypeScript worker stopped ${MAX_WORKER_CRASHES} times (${lastCrash})`,
    });

  /** Sends a request the worker answers, stamped with the project's current epoch. */
  const ask = <Result>(
    running: Worker,
    request: TypeScriptCheckRequest,
    message: (
      id: number,
      slot: number,
      epoch: number,
      page: TypeScriptCheckRequest,
    ) => TypeScriptWorkerRequest,
  ): Promise<Result> => {
    const id = nextId++;
    const slot = epochs.slot(request.projectRoot);
    // Only the fields the worker reads: a caller's request may carry more, which must not be cloned across.
    const page: TypeScriptCheckRequest = {
      projectRoot: request.projectRoot,
      importRoot: request.importRoot,
      htmlPath: request.htmlPath,
      text: request.text,
      isolatedClientBlocks: request.isolatedClientBlocks,
      pageScopeHtml: request.pageScopeHtml,
      usedComponents: request.usedComponents,
    };
    return new Promise((resolve) => {
      pending.set(id, resolve as (result: unknown) => void);
      running.postMessage(message(id, slot, epochs.current(slot), page));
    });
  };

  return {
    diagnostics(request) {
      const running = start();
      if (!running) return unavailable();
      return ask(running, request, (id, slot, epoch, page) => ({
        type: "diagnostics",
        id,
        slot,
        epoch,
        ...page,
      }));
    },
    feature(request) {
      const running = start();
      if (!running) return unavailable();
      return ask(running, request, (id, slot, epoch, page) => ({
        type: "feature",
        id,
        slot,
        epoch,
        ...page,
        query: {
          kind: request.query.kind,
          offset: request.query.offset,
          crossFileOnly: request.query.crossFileOnly,
          triggerCharacter: request.query.triggerCharacter,
        },
      }));
    },
    preparePages(request) {
      // Started here too: the pages are the first thing a new worker parses.
      start()?.postMessage({
        type: "preparePages",
        projectRoot: request.projectRoot,
        importRoot: request.importRoot,
        pages: request.pages,
      } satisfies TypeScriptWorkerRequest);
    },
    cancel: (projectRoot) => epochs.bump(projectRoot),
    setOpenFile(fsPath, text) {
      if (text === undefined) openFiles.delete(fsPath);
      else openFiles.set(fsPath, text);
      post({ type: "openFile", fsPath, text });
    },
    fileChanged: (fsPath) => post({ type: "fileChanged", fsPath }),
    closePage: (projectRoot, htmlPath) =>
      post({ type: "closePage", projectRoot, htmlPath }),
    forgetProject: (projectRoot) =>
      post({ type: "forgetProject", projectRoot }),
    release: end,
    async dispose() {
      disposed = true;
      await end();
    },
  };
}
