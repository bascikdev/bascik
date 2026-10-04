// Minimal static file server used to serve the output of static site generators that ship no
// production server of their own (here: Eleventy's `_site`). It maps `/x/` to `/x/index.html`,
// redirects a directory without a trailing slash, and answers unknown paths with the site's
// own 404.html and a 404 status. It never serves outside the root.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.xsl': 'text/xsl; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

async function locate(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) return { redirect: `${pathname}/` };
      return { file: join(candidate, 'index.html') };
    }
    return { file: candidate };
  } catch { return null; }
}

const server = createServer(async (request, response) => {
  const { pathname, search } = new URL(request.url ?? '/', 'http://localhost');
  const found = await locate(pathname);
  if (found?.redirect) {
    response.writeHead(301, { Location: found.redirect + search }).end();
    return;
  }
  try {
    if (!found) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const body = await readFile(found.file);
    const type = found.file.endsWith('feed.xml') ? 'application/atom+xml; charset=utf-8' : TYPES[extname(found.file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }).end(body);
  } catch {
    try {
      const page = await readFile(join(root, '404.html'));
      response.writeHead(404, { 'Content-Type': TYPES['.html'] }).end(page);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close());
