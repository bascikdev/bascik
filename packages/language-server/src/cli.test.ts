import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCliCheck } from './cli.js';

describe('runCliCheck', () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bascik-cli-test-'));
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 0 when checking clean files', async () => {
    const pageHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';
    const filePath = path.join(tempDir, 'clean.html');
    fs.writeFileSync(filePath, pageHtml);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No Bascik diagnostics found'));
  });

  it('reports errors and returns 1 when checking a file with errors', async () => {
    // A misplaced script directive on a non-script element produces an error
    const pageHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><div data-bascik-build></div></body></html>';
    const filePath = path.join(tempDir, 'error.html');
    fs.writeFileSync(filePath, pageHtml);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('only valid on <script> tags'));
  });

  it('returns 0 when a file has warnings but no errors', async () => {
    // Unanchored attribute selector in CSS is a warning, not an error
    const css = '[data-state] { color: red; }';
    const filePath = path.join(tempDir, 'warning.css');
    fs.writeFileSync(filePath, css);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found 0 errors, 1 warning.'));
  });

  it('returns 1 when target path does not exist', async () => {
    const nonExistent = path.join(tempDir, 'does-not-exist.html');
    const exitCode = await runCliCheck([nonExistent]);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Path does not exist'));
  });
});
