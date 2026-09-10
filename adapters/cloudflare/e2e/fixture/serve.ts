/**
 * Serve the emitted Cloudflare Pages bundle in local workerd for the E2E lane.
 *
 * Usage: node serve.ts <port>
 *
 * Reads dist/.bascik/cloudflare-pages/ (produced by
 * `bascik --build --target cloudflare-pages`), starts Miniflare with the asset
 * layer in front and the generated invocation routes, and listens on the given
 * port. Exits non-zero if the bundle is missing so a misconfigured lane fails
 * loudly instead of serving stale output.
 */
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 9876);
const targetDir = await realpath(join(here, 'dist', '.bascik', 'cloudflare-pages'));
const publicDir = join(targetDir, 'public');
const routes = JSON.parse(await readFile(join(publicDir, '_routes.json'), 'utf8')) as {
  include: string[];
};
const info = JSON.parse(await readFile(join(targetDir, 'build-info.json'), 'utf8')) as {
  notes?: string[];
};
const compatDateNote = info.notes?.find((n: string) => n.startsWith('compatibility date:'));
const compatFlagsNote = info.notes?.find((n: string) => n.startsWith('compatibility flags:'));
const compatibilityDate = compatDateNote ? compatDateNote.split(':')[1]?.trim() : '2024-09-23';
const compatibilityFlags = compatFlagsNote ? compatFlagsNote.split(':')[1]?.trim().split(', ') : ['nodejs_compat'];

const mf = new Miniflare({
  modules: true,
  modulesRoot: publicDir,
  scriptPath: join(publicDir, '_worker.js'),
  compatibilityDate,
  compatibilityFlags,
  host: '127.0.0.1',
  port,
  assets: {
    directory: publicDir,
    binding: 'ASSETS',
    assetConfig: { not_found_handling: '404-page', html_handling: 'auto-trailing-slash' },
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: false,
      static_routing: { user_worker: routes.include },
    },
  },
});

const url = await mf.ready;
console.log(`cloudflare fixture (workerd) running at ${url}`);

const shutdown = async (): Promise<void> => {
  await mf.dispose();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
