import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve(process.env.SERVE_DIST === '1' ? 'dist' : '.');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'task-store.js', 'completion-sound.js', 'sw.js', 'manifest.webmanifest']);

http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicFiles.has(relative) && !/^icons\/[a-zA-Z0-9_-]+\.(png|svg)$/.test(relative)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(resolve(root, relative));
    res.writeHead(200, {
      'Content-Type': types[extname(relative)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`Gone running on port ${port}`));
