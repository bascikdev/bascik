import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const server = createServer(async (request, response) => {
  const paths = { '/': 'dist/index.html', '/about/': 'dist/about/index.html' };
  const path = paths[request.url];
  if (!path) { response.writeHead(404).end('Not found'); return; }
  try { response.setHeader('Content-Type', 'text/html'); response.end(await readFile(path)); }
  catch { response.writeHead(500).end('Build output missing'); }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close());