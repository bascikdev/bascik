import { expect, it, vi } from 'vitest';
import { eventEmitter } from './events.ts';
import { withCompilationPublisher, publishTranspiled } from './compilation-events.ts';

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