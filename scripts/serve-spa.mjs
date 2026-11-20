// Serves a static single-page app: files as they are, and index.html for any route without a
// file. CI uses it for the Expo web export; it is a test helper, never a production server.
//
//   node scripts/serve-spa.mjs apps/tenant/web-build 8081
//
// M11 (decision 8): it sends files as the production host (a CDN) will, so Lighthouse measures
// what a tenant downloads: compressed with Brotli or gzip when the browser accepts them, and the
// build's hashed files (`/_expo/static/`, `/assets/`) cached for a year; everything else, the
// page itself included, is checked again on every visit.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

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
/** Types worth compressing; images and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.map', '.svg', '.ttf']);
/** Files whose names carry a hash of their content, so they never change under the same name. */
const HASHED = /^\/(?:_expo\/static|assets)\//;

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

/** Each file compressed once, per encoding and version, as a CDN keeps it. */
const compressed = new Map();
async function encoded(file, encoding) {
  const { mtimeMs, size } = await stat(file);
  const key = `${encoding}:${file}:${mtimeMs}:${size}`;
  if (!compressed.has(key)) {
    const body = await readFile(file);
    compressed.set(
      key,
      encoding === 'br'
        ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
        : gzipSync(body, { level: 9 }),
    );
  }
  return compressed.get(key);
}

function encodingFor(request, file) {
  if (!COMPRESSIBLE.has(path.extname(file))) return null;
  const accepted = String(request.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  resolve(pathname)
    .then(async (file) => {
      if (!file) return void response.writeHead(404).end();
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Cache-Control':
          HASHED.test(pathname) && !file.endsWith('index.html')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        Vary: 'Accept-Encoding',
      };
      const encoding = encodingFor(request, file);
      if (encoding) {
        const body = await encoded(file, encoding);
        response.writeHead(200, {
          ...headers,
          'Content-Encoding': encoding,
          'Content-Length': body.length,
        });
        return void response.end(request.method === 'HEAD' ? undefined : body);
      }
      response.writeHead(200, headers);
      if (request.method === 'HEAD') return void response.end();
      createReadStream(file)
        .on('error', () => response.destroy())
        .pipe(response);
    })
    .catch(() => response.writeHead(400).end());
});

server.listen(Number(port), () => console.log(`Serving ${root} on http://localhost:${port}`));
