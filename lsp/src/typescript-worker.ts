/**
 * The worker thread that checks TypeScript blocks for the language server (see `typescript-engine.ts`).
 *
 * Loaded as a worker file, it runs when its `workerData` carries the `bascikTypeScriptWorker` flag; loaded any
 * other way (the language server importing it, or a bundle that holds both entry points) it does nothing.
 */
import {
  isMainThread,
  type MessagePort,
  parentPort,
  workerData,
} from "node:worker_threads";
import {
  readEpoch,
  type TypeScriptWorkerData,
  type TypeScriptWorkerRequest,
  type TypeScriptWorkerResponse,
} from "./typescript-engine.js";
import { TypeScriptProjects } from "./typescript-service.js";

/** Answers the main thread's requests, one at a time, in order. */
export function runTypeScriptWorker(
  port: MessagePort,
  data: TypeScriptWorkerData,
): void {
  let running: { slot: number; epoch: number } | undefined;
  const isStale = (request: { slot: number; epoch: number }) =>
    readEpoch(data.epochs, request.slot) !== request.epoch;
  const projects = new TypeScriptProjects({
    ...data.settings,
    isCancellationRequested: () => running !== undefined && isStale(running),
  });
  port.on("message", (message: TypeScriptWorkerRequest) => {
    switch (message.type) {
      case "diagnostics": {
        let response: TypeScriptWorkerResponse;
        if (isStale(message)) {
          response = { id: message.id, result: { status: "cancelled" } };
        } else {
          running = message;
          try {
            response = {
              id: message.id,
              result: projects.diagnostics(message),
            };
          } catch (error) {
            response = {
              id: message.id,
              result: {
                status: "failed",
                message:
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error),
              },
            };
          } finally {
            running = undefined;
          }
        }
        port.postMessage(response);
        break;
      }
      case "preparePages":
        projects.preparePages(message);
        break;
      case "stop":
        projects.dispose();
        // Nothing else holds the thread open, so it exits once the port is closed.
        port.close();
        // A safety net for a handle something left open; unref'd, so it never delays a clean exit.
        setTimeout(() => process.exit(0), 1000).unref();
        break;
      case "openFile":
        projects.setOpenFile(message.fsPath, message.text);
        break;
      case "fileChanged":
        projects.fileChanged(message.fsPath);
        break;
      case "closePage":
        projects.closePage(message.projectRoot, message.htmlPath);
        break;
      case "forgetProject":
        projects.forgetProject(message.projectRoot);
        break;
    }
  });
}

const data = workerData as Partial<TypeScriptWorkerData> | null;
if (!isMainThread && parentPort && data?.bascikTypeScriptWorker === true) {
  runTypeScriptWorker(parentPort, data as TypeScriptWorkerData);
}
