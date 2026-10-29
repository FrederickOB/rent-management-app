// Serves a static single-page app: files as they are, and index.html for any route without a
// file. CI uses it for the Expo web export; it is a test helper, never a production server.
//
//   node scripts/serve-spa.mjs apps/tenant/web-build 8081
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const [directory, port = '8081'] = process.argv.slice(2);
if (!directory) {
  console.error('usage: node scripts/serve-spa.mjs <directory> [port]');
  process.exit(2);
}
const root = path.resolve(directory);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function isFile(file) {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

/** The file for a URL path; a route without one gets index.html, a missing asset gets nothing. */
async function resolve(urlPath) {
  const file = path.join(root, decodeURIComponent(urlPath));
  if (file !== root && !file.startsWith(root + path.sep)) return undefined;
  for (const candidate of [file, `${file}.html`, path.join(file, 'index.html')]) {
    if (await isFile(candidate)) return candidate;
  }
  return path.extname(file) ? undefined : path.join(root, 'index.html');
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  resolve(pathname)
    .then((file) => {
      if (!file) return void response.writeHead(404).end();
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      if (request.method === 'HEAD') return void response.end();
      createReadStream(file)
        .on('error', () => response.destroy())
        .pipe(response);
    })
    .catch(() => response.writeHead(400).end());
});

server.listen(Number(port), () => console.log(`Serving ${root} on http://localhost:${port}`));
