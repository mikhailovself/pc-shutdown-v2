'use strict';
/** Мини-Redis с REST-интерфейсом Upstash (для локальной разработки и тестов). */
const http = require('http');

function createStore() {
  const data = new Map(); // key -> {v, exp}
  const live = (k) => {
    const e = data.get(k);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) { data.delete(k); return null; }
    return e;
  };
  const val = (k) => (live(k) ? live(k).v : undefined);
  const put = (k, v, exp) => data.set(k, { v, exp: exp ?? live(k)?.exp ?? 0 });

  const cmds = {
    GET: (k) => val(k) ?? null,
    SET: (k, v, ...o) => {
      const nx = o.map(String).map((x) => x.toUpperCase()).includes('NX');
      const i = o.findIndex((x) => String(x).toUpperCase() === 'EX');
      if (nx && live(k)) return null;
      data.set(k, { v: String(v), exp: i >= 0 ? Date.now() + Number(o[i + 1]) * 1000 : 0 });
      return 'OK';
    },
    GETDEL: (k) => { const v = val(k) ?? null; data.delete(k); return v; },
    DEL: (...ks) => ks.filter((k) => live(k) && data.delete(k)).length,
    EXISTS: (k) => (live(k) ? 1 : 0),
    INCR: (k) => { const n = Number(val(k) ?? 0) + 1; put(k, String(n)); return n; },
    HSET: (k, ...kv) => { const h = val(k) ?? new Map(); for (let i = 0; i < kv.length; i += 2) h.set(String(kv[i]), String(kv[i + 1])); put(k, h); return kv.length / 2; },
    HGET: (k, f) => val(k)?.get(f) ?? null,
    HGETALL: (k) => [...(val(k) ?? new Map()).entries()].flat(),
    SADD: (k, ...m) => { const s = val(k) ?? new Set(); m.forEach((x) => s.add(String(x))); put(k, s); return m.length; },
    SREM: (k, ...m) => { const s = val(k); return s ? m.filter((x) => s.delete(String(x))).length : 0; },
    SMEMBERS: (k) => [...(val(k) ?? [])],
    SCARD: (k) => (val(k) ?? new Set()).size,
    LPUSH: (k, ...m) => { const l = val(k) ?? []; m.forEach((x) => l.unshift(String(x))); put(k, l); return l.length; },
    LTRIM: (k, a, b) => { const l = val(k); if (l) put(k, l.slice(Number(a), Number(b) + 1)); return 'OK'; },
    LRANGE: (k, a, b) => (val(k) ?? []).slice(Number(a), Number(b) + 1),
    // Эквивалент Lua-скрипта из api/agent.js
    EVAL: (script, n, ...rest) => {
      const keys = rest.slice(0, Number(n)), args = rest.slice(Number(n));
      if (cmds.HGET(keys[0], 'h') !== args[0]) return null;
      const hot = cmds.EXISTS(keys[3]);
      cmds.SET(keys[1], args[1], 'EX', hot ? args[3] : args[2]);
      if (args[4] !== '') cmds.SET(keys[4], args[4], 'EX', 604800);
      return [cmds.GETDEL(keys[2]), hot, cmds.EXISTS(keys[4])];
    },
  };
  const run = ([name, ...a]) => {
    const f = cmds[String(name).toUpperCase()];
    if (!f) throw new Error(`ERR unknown command ${name}`);
    return f(...a);
  };
  return { run, data };
}

function start(port = 0) {
  const store = createStore();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const one = (c) => { try { return { result: store.run(c) }; } catch (e) { return { error: e.message }; } };
      const body = JSON.parse(raw || 'null');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/pipeline' ? body.map(one) : one(body)));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, store, close: () => server.close() })));
}
module.exports = { start };
