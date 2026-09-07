import { AsyncLocalStorage } from 'node:async_hooks';
import { eventEmitter } from './events.ts';
import type { PublishCompilation } from './source-cycle.ts';

const publisher = new AsyncLocalStorage<{ publish: PublishCompilation; writes: Promise<void>[] }>();
export const withCompilationPublisher = <T>(publish: PublishCompilation, work: () => Promise<T>): Promise<T> =>
  publisher.run({ publish, writes: [] }, async () => {
    const result = await Promise.allSettled([work()]);
    const writes = await Promise.allSettled(publisher.getStore()!.writes);
    const errors = [...result, ...writes].filter(result => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), errors.map(result => String(result.reason)).join('\n'));
    const completed = result[0];
    if (completed.status === 'rejected') throw completed.reason;
    return completed.value;
  });

/** Observe immediately; a lifecycle scope joins writes before starting post. */
export const trackCompilationWrite = (write: Promise<void>): void => {
  publisher.getStore()?.writes.push(write);
  void write.catch(() => undefined);
};
export const hasCompilationPublisher = (): boolean => !!publisher.getStore();

export const publishTranspiled = (payload: { relativePagePath: string }): void => {
  const publish = publisher.getStore();
  if (publish) publish.publish('transpiled', payload);
  else eventEmitter.emit('transpiled', payload);
};