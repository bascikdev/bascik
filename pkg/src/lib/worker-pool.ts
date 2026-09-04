import { Worker } from "node:worker_threads";

interface QueuedTask<Task, Result> {
  task: Task;
  resolve: (value: Result) => void;
  reject: (error: unknown) => void;
}

/**
 * Fixed-size pool of worker threads. Each worker is initialized once with
 * `initData` (via `workerData`) and then reused for many `run()` calls,
 * avoiding the cost of re-spawning a worker (and re-running its module
 * top-level code) per task.
 */
export class WorkerPool<Task, Result> {
  #workerScript: string;
  #initData: unknown;
  #workers: Worker[] = [];
  #idleWorkers: Worker[] = [];
  #queue: QueuedTask<Task, Result>[] = [];
  #pending = new Map<Worker, QueuedTask<Task, Result>>();
  #terminated = false;

  constructor(workerScript: string, size: number, initData: unknown) {
    this.#workerScript = workerScript;
    this.#initData = initData;
    for (let i = 0; i < size; i++) {
      this.#spawn();
    }
  }

  #spawn(): void {
    const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--input-type"));
    const worker = new Worker(this.#workerScript, {
      workerData: this.#initData,
      execArgv,
    });
    worker.on("message", (message: any) => {
      const job = this.#pending.get(worker);
      this.#pending.delete(worker);
      if (job) {
        if (message.ok) job.resolve(message.result);
        else job.reject(new Error(message.error));
      }
      this.#dispatch(worker);
    });
    worker.on("error", (error) => {
      // Reject the in-flight job, then retire the dead worker and spawn a
      // replacement.  Without this, a worker that crashes sits in
      // #idleWorkers forever; postMessage() to a dead worker silently drops
      // the task and the returned promise never settles — hanging the build.
      const job = this.#pending.get(worker);
      this.#pending.delete(worker);
      job?.reject(error);
      this.#retire(worker);
      if (!this.#terminated) this.#spawn();
    });
    worker.on("exit", (code) => {
      if (code !== 0 && this.#workers.includes(worker)) {
        const job = this.#pending.get(worker);
        this.#pending.delete(worker);
        job?.reject(new Error(`Worker exited with code ${code}`));
        this.#retire(worker);
        if (!this.#terminated) this.#spawn();
      }
    });
    this.#workers.push(worker);
    this.#dispatch(worker);
  }

  /** Remove a worker from every tracking structure (best-effort terminate). */
  #retire(worker: Worker): void {
    this.#workers = this.#workers.filter((w) => w !== worker);
    this.#idleWorkers = this.#idleWorkers.filter((w) => w !== worker);
    worker.terminate().catch(() => { });
  }

  run(task: Task): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      if (this.#terminated) {
        reject(new Error("WorkerPool has been terminated"));
        return;
      }
      this.#queue.push({ task, resolve, reject });
      const worker = this.#idleWorkers.pop();
      if (worker) this.#dispatch(worker);
    });
  }

  #dispatch(worker: Worker): void {
    const job = this.#queue.shift();
    if (!job) {
      this.#idleWorkers.push(worker);
      return;
    }
    this.#pending.set(worker, job);
    worker.postMessage(job.task);
  }

  async terminate(): Promise<void> {
    this.#terminated = true;
    // Reject everything still queued so no caller is left hanging.
    for (const job of this.#queue.splice(0)) {
      job.reject(new Error("WorkerPool terminated before task ran"));
    }
    for (const [, job] of this.#pending) {
      job.reject(new Error("WorkerPool terminated while task was in flight"));
    }
    this.#pending.clear();
    await Promise.all(this.#workers.map((w) => w.terminate()));
  }
}
