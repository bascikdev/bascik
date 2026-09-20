import { describe, it, expect } from 'vitest';
import { loadExtensionConfig } from './config';

describe('extension-config', () => {
  it('returns empty config when no file exists', () => {
    const cfg = loadExtensionConfig('/tmp');
    expect(cfg).toEqual({});
  });
});
