/**
 * Minimal static file server for the e2e fixture site.
 * Serves dist/ on the port given as the first CLI arg (default 4200).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 4200);
const distDir = join(fileURLToPath(import.meta.url), '..', 'dist');

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.txt': 'text/plain',
};

createServer((req, res) => {
  const rawUrl = (req.url ?? '/').split(/[?#]/)[0];
  let url = rawUrl;
  try {
    url = decodeURIComponent(rawUrl);
  } catch { }
  let p = join(distDir, url === '/' ? 'index.html' : url);
  if (!p.endsWith('.html') && existsSync(p + '.html')) p += '.html';
  if (!existsSync(p)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, { 'Content-Type': mime[extname(p)] ?? 'text/plain' });
  res.end(readFileSync(p));
}).listen(port, () => {
  console.log(`http://localhost:${port}`);
});
