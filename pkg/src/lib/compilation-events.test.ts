import { AsyncResource } from 'node:async_hooks';
import { expect, it, vi } from 'vitest';
import { eventEmitter } from './events.ts';
import {
  getCompilationPageErrorPolicy,
  hasCompilationPublisher,
  publishTranspiled,
  trackCompilationWrite,
  withCompilationPublisher,
} from './compilation-events.ts';

it('buffers only the associated async compilation, not unrelated events', async () => {
  const publish = vi.fn();
  const listener = vi.fn();
  eventEmitter.on('transpiled', listener);
  try {
    await withCompilationPublisher(publish, async () => {
      await Promise.resolve();
      publishTranspiled({ relativePagePath: 'buffered.html' });
    });
    expect(listener).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('transpiled', { relativePagePath: 'buffered.html' });
    publishTranspiled({ relativePagePath: 'normal.html' });
    expect(listener).toHaveBeenCalledOnce();
  } finally { eventEmitter.removeListener('transpiled', listener); }
});

it('does not leak a completed publisher scope into later async resources', async () => {
  const publish = vi.fn();
  const listener = vi.fn();
  let leakedResource: AsyncResource | undefined;
  eventEmitter.on('transpiled', listener);
  try {
    await withCompilationPublisher(publish, async () => {
      leakedResource = new AsyncResource('compilation-events-test');
    });

    expect(hasCompilationPublisher()).toBe(false);
    expect(() => trackCompilationWrite(Promise.resolve())).not.toThrow();

    leakedResource!.runInAsyncScope(() => {
      expect(hasCompilationPublisher()).toBe(false);
      publishTranspiled({ relativePagePath: 'normal-after-scope.html' });
    });

    expect(publish).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ relativePagePath: 'normal-after-scope.html' });
  } finally {
    eventEmitter.removeListener('transpiled', listener);
    leakedResource?.emitDestroy();
  }
});

it('restores the outer publisher policy, buffering, and write tracking after a nested scope completes', async () => {
  const outerPublish = vi.fn();
  const innerPublish = vi.fn();
  const listener = vi.fn();
  const innerWrite = Promise.withResolvers<void>();
  const innerFinished = Promise.withResolvers<void>();
  const outerContinue = Promise.withResolvers<void>();
  const outerWrite = Promise.withResolvers<void>();
  let outerCallback: (() => void) | undefined;
  let outerPolicyBeforeInner: ReturnType<typeof getCompilationPageErrorPolicy>;
  let innerPolicy: ReturnType<typeof getCompilationPageErrorPolicy>;
  let outerPolicyAfterInner: ReturnType<typeof getCompilationPageErrorPolicy>;
  let outerCompleted = false;
  eventEmitter.on('transpiled', listener);
  try {
    const outer = withCompilationPublisher(outerPublish, async () => {
      outerPolicyBeforeInner = getCompilationPageErrorPolicy();
      outerCallback = AsyncResource.bind(() => {
        outerPolicyAfterInner = getCompilationPageErrorPolicy();
        publishTranspiled({ relativePagePath: 'outer-after-inner.html' });
        trackCompilationWrite(outerWrite.promise);
        outerContinue.resolve();
      });

      const inner = withCompilationPublisher(innerPublish, async () => {
        innerPolicy = getCompilationPageErrorPolicy();
        publishTranspiled({ relativePagePath: 'inner.html' });
        trackCompilationWrite(innerWrite.promise);
      }, { onPageErrors: 'publish' });

      await vi.waitFor(() => expect(innerPublish).toHaveBeenCalledWith('transpiled', { relativePagePath: 'inner.html' }));
      innerWrite.resolve();
      await inner;
      innerFinished.resolve();

      await outerContinue.promise;
    }).then(() => {
      outerCompleted = true;
    });

    await innerFinished.promise;
    outerCallback!();
    await vi.waitFor(() => expect(outerPolicyAfterInner).not.toBeUndefined());

    expect(outerPolicyBeforeInner).toBe('throw');
    expect(innerPolicy).toBe('publish');
    expect(outerPolicyAfterInner).toBe('throw');
    expect(listener).not.toHaveBeenCalled();
    expect(outerPublish).toHaveBeenCalledWith('transpiled', { relativePagePath: 'outer-after-inner.html' });
    expect(outerCompleted).toBe(false);

    outerWrite.resolve();
    await outer;
  } finally {
    eventEmitter.removeListener('transpiled', listener);
  }
});

it('keeps an overlapping publisher active after another scope completes', async () => {
  const firstPublish = vi.fn();
  const secondPublish = vi.fn();
  const listener = vi.fn();
  const firstGate = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const secondContinue = Promise.withResolvers<void>();
  const secondWrite = Promise.withResolvers<void>();
  let secondCallback: (() => void) | undefined;
  let secondPolicyAfterFirst: ReturnType<typeof getCompilationPageErrorPolicy>;
  let secondCompleted = false;
  eventEmitter.on('transpiled', listener);
  try {
    const first = withCompilationPublisher(firstPublish, async () => {
      await firstGate.promise;
    });

    const second = withCompilationPublisher(secondPublish, async () => {
      secondCallback = AsyncResource.bind(() => {
        secondPolicyAfterFirst = getCompilationPageErrorPolicy();
        publishTranspiled({ relativePagePath: 'second-after-first.html' });
        trackCompilationWrite(secondWrite.promise);
        secondContinue.resolve();
      });
      secondStarted.resolve();
      await first;
      await secondContinue.promise;
    }, { onPageErrors: 'publish' }).then(() => {
      secondCompleted = true;
    });

    await secondStarted.promise;
    firstGate.resolve();
    await first;
    secondCallback!();
    await vi.waitFor(() => expect(secondPolicyAfterFirst).not.toBeUndefined());

    expect(secondPolicyAfterFirst).toBe('publish');
    expect(listener).not.toHaveBeenCalled();
    expect(secondPublish).toHaveBeenCalledWith('transpiled', { relativePagePath: 'second-after-first.html' });
    expect(secondCompleted).toBe(false);

    secondWrite.resolve();
    await second;
  } finally {
    eventEmitter.removeListener('transpiled', listener);
  }
});