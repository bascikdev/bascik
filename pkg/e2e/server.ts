/**
 * Minimal static file server for the e2e fixture site.
 * Serves dist/ on the port given as the first CLI arg (default 4200).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 4200);
const distDir = resolve(process.argv[3] ?? 'dist');
const base = process.argv[4] ?? '/';

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
};

createServer((req, res) => {
  const rawUrl = (req.url ?? '/').split(/[?#]/)[0];
  let url = rawUrl;
  try {
    url = decodeURIComponent(rawUrl);
  } catch { }

  // Deny dotfiles and dot-directories (e.g. /.env, /.bascik/manifest.json)
  if (url.split('/').some((segment) => segment.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  if (base !== '/') {
    const prefix = base.replace(/\/$/, '');
    if (url === prefix || url === base) url = '/';
    else if (url.startsWith(base)) url = url.slice(prefix.length);
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
  }
  let p = join(distDir, url === '/' ? 'index.html' : url);
  if (url.endsWith('/') && url !== '/') p = join(p, 'index.html');
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
