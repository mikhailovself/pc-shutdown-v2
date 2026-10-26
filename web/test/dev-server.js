'use strict';
/** Локальный запуск: node test/dev-server.js  ->  http://localhost:3000 (с поддельным Redis). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const fakeRedis = require('./fake-redis');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function start(port = 3000) {
  const redis = await fakeRedis.start();
  process.env.UPSTASH_REDIS_REST_URL = redis.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'dev';
  const handlers = {};
  const load = (n) => (handlers[n] ??= require(`../api/${n}.js`));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const m = /^\/api\/(agent|pair|control|account)$/.exec(u.pathname);
      if (m) {
        req.query = Object.fromEntries(u.searchParams);
        try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = undefined; }
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
        return load(m[1])(req, res);
      }
      const file = path.join(PUBLIC, u.pathname === '/' ? 'index.html' : u.pathname);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, redis, close: () => { server.close(); redis.close(); } };
}
module.exports = { start };
if (require.main === module) start(Number(process.env.PORT) || 3000).then((s) => console.log('dev server:', s.url));
