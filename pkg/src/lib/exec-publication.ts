import type { ExecEntry } from './types.ts';
import type { EventEmitter } from 'node:events';
/** Report exec failures only. Successful completion never compiles or reloads. */
const listeners = new WeakMap<EventEmitter, (payload: { entry: ExecEntry; error: unknown }) => void>();

export const installExecPublication = (emitter: EventEmitter): void => {
  const previous = listeners.get(emitter);
  if (previous) emitter.removeListener('exec-failed', previous);
  const onExecFailed = (payload: { entry: ExecEntry; error: unknown }): void => {
    const message = payload.error instanceof Error ? payload.error.message : String(payload.error);
    emitter.emit('build-error', {
      message: `exec producer failed: ${message}`,
      file: payload.entry.script,
      line: undefined,
      column: undefined,
    });
  };
  listeners.set(emitter, onExecFailed);
  emitter.on('exec-failed', onExecFailed);
};