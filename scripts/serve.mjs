/** Minimal static server for local preview: node scripts/serve.mjs [dir] [port] */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '_site');
const port = Number(process.argv[3] ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = resolve(join(root, decodeURIComponent(url.pathname)));
    // Never serve anything outside the build directory, whatever the request path claims.
    if (path !== root && !path.startsWith(root + sep)) throw new Error('outside root');

    const s = await stat(path).catch(() => null);
    if (!s || s.isDirectory()) path = join(path, 'index.html');

    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
