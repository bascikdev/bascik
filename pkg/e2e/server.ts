/**
 * Minimal static file server for the e2e fixture site.
 * Serves dist/ on the port given as the first CLI arg (default 4200).
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const port = Number(process.argv[2] ?? 4200);
const distDir = resolve(process.argv[3] ?? 'dist');
const distRoot = distDir + sep;
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
  let target = resolve(distDir, `.${url === '/' ? '/index.html' : url}`);
  if (url.endsWith('/') && url !== '/') target = join(target, 'index.html');
  // `/about` serves about.html when it exists, else the path itself.
  const candidates = target.endsWith('.html') ? [target] : [`${target}.html`, target];
  for (const candidate of candidates) {
    // The dotfile check above already rejects `..`; this keeps every read
    // inside dist/ even if that check changes.
    if (!candidate.startsWith(distRoot)) continue;
    if (!existsSync(candidate)) continue;
    res.writeHead(200, { 'Content-Type': mime[extname(candidate)] ?? 'text/plain' });
    return res.end(readFileSync(candidate));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}).listen(port, () => {
  console.log(`http://localhost:${port}`);
});
