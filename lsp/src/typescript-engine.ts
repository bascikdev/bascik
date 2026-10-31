/**
 * The engine the language server asks for TypeScript diagnostics, behind a small asynchronous interface.
 *
 * The language server never waits on TypeScript to publish its own diagnostics, and TypeScript's first check of a
 * project (parsing the DOM library alone takes about half a second) must not hold up a completion or another
 * file's diagnostics. So the editor runs the engine in a worker thread (`createWorkerTypeScriptEngine`); tests and
 * hosts without a worker file run it on the main thread after the current turn (`createInProcessTypeScriptEngine`).
 * The interface is also the seam for swapping TypeScript's JavaScript LanguageService for TypeScript 7's native
 * API later.
 *
 * Cancellation: every edit makes the project's requests stale by bumping its epoch in shared memory. A queued
 * request that is stale is dropped before it starts, and one that is running stops at TypeScript's next
 * cancellation check, so typing never builds a queue.
 */
import { Worker } from "node:worker_threads";
import {
  TypeScriptProjects,
  type TypeScriptDiagnosticsResult,
} from "./typescript-service.js";

export type { TypeScriptDiagnosticsResult } from "./typescript-service.js";

export interface TypeScriptCheckRequest {
  projectRoot: string;
  /** `scripts.importRoot`, resolved. */
  importRoot: string;
  htmlPath: string;
  /** The page's current text, which may be unsaved. */
  text: string;
}

export interface TypeScriptEngine {
  diagnostics(
    request: TypeScriptCheckRequest,
  ): Promise<TypeScriptDiagnosticsResult>;
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
  dispose(): Promise<void>;
}

/** How the engine finds TypeScript; see `typescript-loader.ts`. */
export interface TypeScriptEngineSettings {
  /** A `typescript` package folder the client passes (VS Code passes its own). */
  clientPath?: string;
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

const failure = (error: unknown): TypeScriptDiagnosticsResult => ({
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
  const projects = new TypeScriptProjects({
    clientPath: settings.clientPath,
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
    cancel: (projectRoot) => epochs.bump(projectRoot),
    setOpenFile: (fsPath, text) => projects.setOpenFile(fsPath, text),
    fileChanged: (fsPath) => projects.fileChanged(fsPath),
    closePage: (projectRoot, htmlPath) =>
      projects.closePage(projectRoot, htmlPath),
    forgetProject: (projectRoot) => projects.forgetProject(projectRoot),
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
  | { type: "openFile"; fsPath: string; text: string | undefined }
  | { type: "fileChanged"; fsPath: string }
  | { type: "closePage"; projectRoot: string; htmlPath: string }
  | { type: "forgetProject"; projectRoot: string };

export interface TypeScriptWorkerResponse {
  id: number;
  result: TypeScriptDiagnosticsResult;
}

/** What the worker is started with. The flag tells a bundle that holds both entry points which one to run. */
export interface TypeScriptWorkerData {
  bascikTypeScriptWorker: true;
  settings: TypeScriptEngineSettings;
  epochs: SharedArrayBuffer;
}

/** After this many crashes the worker is not started again, and TypeScript checks stay off. */
const MAX_WORKER_STARTS = 3;

/**
 * Runs the engine in a worker thread started from `workerFile`: `typescript-worker.js`, or a bundle that runs it
 * when its `workerData` says so. The worker starts on the first request, so a project without TypeScript blocks
 * never loads TypeScript. A crashed worker is started again (with the open buffers sent again) on the next request.
 */
export function createWorkerTypeScriptEngine(
  workerFile: string | URL,
  settings: TypeScriptEngineSettings = {},
): TypeScriptEngine {
  const epochs = new Epochs();
  const openFiles = new Map<string, string>();
  const pending = new Map<
    number,
    (result: TypeScriptDiagnosticsResult) => void
  >();
  let worker: Worker | undefined;
  let starts = 0;
  let lastCrash = "";
  let nextId = 1;

  const settleAll = (result: TypeScriptDiagnosticsResult) => {
    for (const resolve of pending.values()) resolve(result);
    pending.clear();
  };

  const start = (): Worker | undefined => {
    if (worker) return worker;
    if (starts >= MAX_WORKER_STARTS) return undefined;
    starts++;
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
      if (worker !== started) return;
      worker = undefined;
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

  return {
    diagnostics(request) {
      const running = start();
      if (!running)
        return Promise.resolve({
          status: "unavailable",
          message: `TypeScript checks are off: the TypeScript worker stopped ${MAX_WORKER_STARTS} times (${lastCrash})`,
        });
      const id = nextId++;
      const slot = epochs.slot(request.projectRoot);
      return new Promise((resolve) => {
        pending.set(id, resolve);
        running.postMessage({
          type: "diagnostics",
          id,
          slot,
          epoch: epochs.current(slot),
          projectRoot: request.projectRoot,
          importRoot: request.importRoot,
          htmlPath: request.htmlPath,
          text: request.text,
        } satisfies TypeScriptWorkerRequest);
      });
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
    async dispose() {
      const running = worker;
      worker = undefined;
      settleAll({ status: "cancelled" });
      starts = MAX_WORKER_STARTS;
      await running?.terminate();
    },
  };
}
