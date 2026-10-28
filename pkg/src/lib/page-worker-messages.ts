import type { ComponentList } from "./types.ts";

/**
 * Settings messages the main thread posts to page workers through
 * `WorkerPool.configure`, as opposed to page jobs. A worker applies them and
 * never replies, since a reply would be taken for a job's result.
 *
 * Kept in this leaf module, not in `page-worker.ts`, so `processing.ts` can
 * use the kinds without importing the worker entry (which imports it back).
 */

/**
 * The compile inputs every page job needs. Sent once they are loaded rather
 * than passed as `workerData`, so the pool can be started (and its workers
 * can load the compiler) while the component list is still being read.
 */
export const PAGE_WORKER_INIT_MESSAGE = "bascik:page-worker-init";

export interface PageWorkerInitMessage {
  kind: typeof PAGE_WORKER_INIT_MESSAGE;
  componentList: ComponentList;
  globalStylesHtml: string;
}

/**
 * The pool size after it was trimmed to the job count. The environment only
 * carries the size at spawn, and each worker's share of the build-script
 * child budget is divided by it (see `setChildWorkerCount`).
 */
export const CHILD_WORKER_COUNT_MESSAGE = "bascik:child-worker-count";

export interface ChildWorkerCountMessage {
  kind: typeof CHILD_WORKER_COUNT_MESSAGE;
  workerCount: number;
}

export type PageWorkerSettings =
  PageWorkerInitMessage | ChildWorkerCountMessage;
