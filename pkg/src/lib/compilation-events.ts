import { AsyncLocalStorage } from 'node:async_hooks';
import { eventEmitter } from './events.ts';
import type { PublishCompilation } from './source-cycle.ts';

export type CompilationPageErrorPolicy = 'throw' | 'publish';

type CompilationPublisherStore = {
  publish: PublishCompilation;
  writes: Promise<void>[];
  onPageErrors: CompilationPageErrorPolicy;
  active: boolean;
};

const publisher = new AsyncLocalStorage<CompilationPublisherStore>();

const readCompilationPublisher = (
  store: CompilationPublisherStore | undefined = publisher.getStore(),
): CompilationPublisherStore | undefined => store?.active ? store : undefined;

export const withCompilationPublisher = <T>(
  publish: PublishCompilation,
  work: () => Promise<T>,
  options: { onPageErrors?: CompilationPageErrorPolicy } = {},
): Promise<T> => {
  const store: CompilationPublisherStore = {
    publish,
    writes: [],
    onPageErrors: options.onPageErrors ?? 'throw',
    active: true,
  };
  return publisher.run(store, async () => {
    try {
      const result = await Promise.allSettled([work()]);
      const writes = await Promise.allSettled(store.writes);
      const errors = [...result, ...writes].filter(result => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), errors.map(result => String(result.reason)).join('\n'));
      const completed = result[0];
      if (completed.status === 'rejected') throw completed.reason;
      return completed.value;
    } finally {
      store.active = false;
    }
  });
};

/** Observe immediately; a lifecycle scope joins writes before starting post. */
export const trackCompilationWrite = (write: Promise<void>): void => {
  readCompilationPublisher()?.writes.push(write);
  void write.catch(() => undefined);
};
export const hasCompilationPublisher = (): boolean => !!readCompilationPublisher();
export const getCompilationPageErrorPolicy = (): CompilationPageErrorPolicy | undefined =>
  readCompilationPublisher()?.onPageErrors;

export const publishTranspiled = (payload: { relativePagePath: string }): void => {
  const store = readCompilationPublisher();
  if (store) store.publish('transpiled', payload);
  else eventEmitter.emit('transpiled', payload);
};