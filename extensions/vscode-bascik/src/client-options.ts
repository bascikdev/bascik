/**
 * Which documents the language server analyzes. Only files on disk have a project, so other schemes
 * (git diffs, output panels, untitled buffers) are never sent to it.
 */
export const DOCUMENT_SELECTOR = ['html', 'css', 'javascript', 'typescript'].map((language) => ({
  scheme: 'file',
  language,
}));

/** The language server bundle, next to the extension bundle, relative to the extension folder. */
export const SERVER_MODULE = 'dist/server.js';
