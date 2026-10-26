'use strict';
/** Поддельный Ably для тестов: приём публикаций (REST) и SSE-поток подписчиков. */
const http = require('http');

async function start() {
  const published = [];
  const streams = new Set();
  const state = { failPublish: false };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname.startsWith('/channels/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (state.failPublish) { res.writeHead(500); return res.end('{}'); }
        const channel = decodeURIComponent(u.pathname.split('/')[2]);
        const msg = JSON.parse(raw);
        published.push({ channel, auth: req.headers.authorization, msg });
        for (const s of streams) {
          if (s.channel === channel) s.res.write(`event: message\ndata: ${JSON.stringify({ name: msg.name, data: msg.data, channel })}\n\n`);
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    if (u.pathname === '/sse') {
      const s = { res, channel: u.searchParams.get('channels'), token: u.searchParams.get('accessToken') };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(':keepalive\n\n');
      streams.add(s);
      req.on('close', () => streams.delete(s));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, published, streams, state,
    close: () => { for (const s of streams) s.res.end(); server.close(); },
  };
}
module.exports = { start };
