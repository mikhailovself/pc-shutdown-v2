'use strict';
/**
 * Общая библиотека: Redis (REST), сессии, PIN, rate-limit, обработчик запросов.
 * Нулевые зависимости: только встроенные модули Node.
 *
 * Модель данных (Redis):
 *   u:{uid}            JSON  {pin, created}                  аккаунт
 *   u:{uid}:devs       SET   id ПК
 *   u:{uid}:sess       SET   id сессий
 *   u:{uid}:log        LIST  журнал действий (последние 50)
 *   d:{did}            HASH  uid, name, h(sha256 секрета ПК), created
 *   d:{did}:state      JSON  состояние от ПК (живёт 60 с, это и есть «онлайн»)
 *   d:{did}:cmd        JSON  команда для ПК (живёт 120 с)
 *   d:{did}:ack        JSON  статус последней команды
 *   d:{did}:hot        1     «телефон смотрит» -> ПК опрашивает чаще
 *   s:{sid}            JSON  {uid, h, label, created}        сессия телефона (30 дней)
 *   p:{code}           JSON  ожидающее подключение (10 минут)
 */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 30;
const SESSION_COOKIE = '__Host-sess';
const PAIR_TTL = 600;
const MAX_DEVICES = 5;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ---------- Redis ----------
async function redisFetch(path, body) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('Redis не настроен: нет UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
    throw new HttpError(503, 'Сервис временно недоступен');
  }
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function redis(cmd) {
  const j = await redisFetch('', cmd);
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}
async function pipeline(cmds) {
  const arr = await redisFetch('/pipeline', cmds);
  if (!Array.isArray(arr)) throw new Error('redis: bad pipeline response');
  return arr.map((x) => { if (x.error) throw new Error('redis: ' + x.error); return x.result; });
}
async function getJson(key) {
  const v = await redis(['GET', key]);
  return v ? JSON.parse(v) : null;
}
const setJson = (key, obj, ex) =>
  redis(ex ? ['SET', key, JSON.stringify(obj), 'EX', String(ex)] : ['SET', key, JSON.stringify(obj)]);
function hashToObj(flat) {
  const o = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
}
const getDevice = async (did) => {
  const o = hashToObj(await redis(['HGETALL', `d:${did}`]));
  return o.uid ? o : null;
};

// ---------- криптография ----------
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[crypto.randomInt(32)];
  return s;
}
function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(s) ? s : null;
}

// ---------- PIN ----------
function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) {
    throw new HttpError(400, 'PIN должен состоять из 6–12 цифр');
  }
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  const sequential = steps.every((x) => x === 1) || steps.every((x) => x === -1);
  if (new Set(d).size < 3 || sequential) {
    throw new HttpError(400, 'Слишком простой PIN. Не используйте повторы и последовательности (111111, 123456).');
  }
}
async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pin, salt, 32);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
}
async function verifyPin(pin, stored) {
  const [s, h] = String(stored).split(':');
  const x = await scrypt(String(pin), Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
}

// ---------- rate-limit ----------
async function hit(key, windowSec) {
  const r = await pipeline([['SET', key, '0', 'EX', String(windowSec), 'NX'], ['INCR', key]]);
  return Number(r[1]);
}
async function limit(key, max, windowSec, msg) {
  if ((await hit(key, windowSec)) > max) throw new HttpError(429, msg || 'Слишком много запросов. Попробуйте позже.');
}
/** Проверка PIN с блокировкой: 5 ошибок за 15 минут или 15 за сутки. */
async function checkPin(uid, pin) {
  const k15 = `pf15:${uid}`, k24 = `pf24:${uid}`;
  const [a, b] = await pipeline([['GET', k15], ['GET', k24]]);
  if (Number(a) >= 5 || Number(b) >= 15) {
    throw new HttpError(429, 'Слишком много неверных попыток PIN. Подождите 15 минут.');
  }
  const u = await getJson(`u:${uid}`);
  if (!u) throw new HttpError(404, 'Аккаунт не найден');
  const ok = typeof pin === 'string' && /^\d{6,12}$/.test(pin) && (await verifyPin(pin, u.pin));
  if (!ok) {
    await pipeline([
      ['SET', k15, '0', 'EX', '900', 'NX'], ['INCR', k15],
      ['SET', k24, '0', 'EX', '86400', 'NX'], ['INCR', k24],
    ]);
    throw new HttpError(401, 'Неверный PIN', 'bad_pin');
  }
  await redis(['DEL', k15]);
  return u;
}

// ---------- запрос ----------
function clientIp(req) {
  const h = req.headers;
  let ip = String(h['x-vercel-forwarded-for'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  if (ip.includes(':') && ip.includes('.')) ip = ip.slice(ip.lastIndexOf(':') + 1); // ::ffff:1.2.3.4
  if (ip.includes(':')) { // IPv6 -> подсеть /64
    const [head, tail] = ip.split('::');
    const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
    const full = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
    ip = full.slice(0, 4).join(':');
  }
  return ip;
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
/** Защита от CSRF для запросов с cookie: SameSite=Strict + свой заголовок + Sec-Fetch-Site. */
function requireCsrf(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (req.headers['x-csrf'] !== '1' || (sfs && sfs !== 'same-origin' && sfs !== 'none')) {
    throw new HttpError(403, 'Запрос отклонён');
  }
}
function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Телефон';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
const cleanName = (s, fallback) =>
  String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) || fallback;

// ---------- сессии ----------
async function createSession(res, uid, label) {
  const sid = randomToken(12), secret = randomToken(32);
  await pipeline([
    ['SET', `s:${sid}`, JSON.stringify({ uid, h: sha256hex(secret), label, created: Date.now() }), 'EX', String(SESSION_DAYS * 86400)],
    ['SADD', `u:${uid}:sess`, sid],
  ]);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${sid}.${secret}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`);
  return sid;
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}
async function getSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE] || '';
  const [sid, secret] = raw.split('.');
  if (!/^[\w-]{10,64}$/.test(sid || '') || !secret) return null;
  const s = await getJson(`s:${sid}`);
  if (!s || !safeEqualHex(sha256hex(secret), s.h)) return null;
  return { sid, uid: s.uid, label: s.label };
}
async function requireSession(req) {
  const s = await getSession(req);
  if (!s) throw new HttpError(401, 'Нужно подключить телефон к ПК', 'unauthorized');
  return s;
}
/** Токен ПК: «Authorization: Device <id>.<секрет>». Возвращает {did, h} (хэш секрета). */
function parseDeviceAuth(req) {
  const m = /^Device ([\w-]{10,64})\.([\w-]{20,128})$/.exec(String(req.headers.authorization || ''));
  return m ? { did: m[1], h: sha256hex(m[2]) } : null;
}
async function requireDevice(req) {
  const a = parseDeviceAuth(req);
  if (!a) throw new HttpError(401, 'Нет токена устройства', 'device_revoked');
  const d = await getDevice(a.did);
  if (!d || !safeEqualHex(a.h, d.h)) throw new HttpError(401, 'Устройство отключено', 'device_revoked');
  return { did: a.did, ...d };
}

// ---------- журнал ----------
const logEvent = (uid, e, extra = {}) => pipeline([
  ['LPUSH', `u:${uid}:log`, JSON.stringify({ t: Date.now(), e, ...extra })],
  ['LTRIM', `u:${uid}:log`, '0', '49'],
]);

// ---------- Ably: мгновенная доставка (необязательно; без ключа всё работает на опросе) ----------
/** ABLY_API_KEY = «appId.keyId:секрет». Ably нужен только как «звонок»: сообщение будит ПК, а сама
 *  команда по-прежнему лежит в Redis и забирается через heartbeat. Упал Ably — просто будет чуть дольше. */
const ablyHost = () => (process.env.ABLY_HOST || 'https://main.realtime.ably.net').replace(/\/+$/, '');
function ablyKey() {
  const raw = process.env.ABLY_API_KEY || '';
  const i = raw.indexOf(':');
  return i > 0 && i < raw.length - 1 ? { raw, name: raw.slice(0, i), secret: raw.slice(i + 1) } : null;
}
const ablyChannel = (did) => `snooz-${did}`;
/** Токен ПК: JWT (HS256), подписанный ключом Ably, право только «subscribe» на канал ЭТОГО ПК. */
function ablyToken(did, ttlSec = 3600) {
  const key = ablyKey();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ typ: 'JWT', alg: 'HS256', kid: key.name });
  const claims = b64({ iat: now, exp: now + ttlSec, 'x-ably-capability': JSON.stringify({ [ablyChannel(did)]: ['subscribe'] }) });
  const sig = crypto.createHmac('sha256', key.secret).update(`${head}.${claims}`).digest('base64url');
  const token = `${head}.${claims}.${sig}`;
  return {
    token, expires: (now + ttlSec) * 1000,
    url: `${ablyHost()}/sse?v=1.2&channels=${encodeURIComponent(ablyChannel(did))}&accessToken=${encodeURIComponent(token)}`,
  };
}
/** Разбудить ПК. Никогда не бросает исключений: команда уже в Redis, опрос её всё равно заберёт. */
async function ablyWake(did) {
  const key = ablyKey();
  if (!key) return false;
  try {
    const r = await fetch(`${ablyHost()}/channels/${encodeURIComponent(ablyChannel(did))}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(key.raw).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wake', data: '1' }),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) console.error('ably publish: HTTP', r.status);
    return r.ok;
  } catch (e) {
    console.error('ably publish:', e.message);
    return false;
  }
}

// ---------- обработчик ----------
function send(res, code, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(obj);
}
/** ops: { имя: { method: 'GET'|'POST', fn(req,res) } }; операция берётся из ?op= */
function api(ops) {
  return async (req, res) => {
    try {
      const op = ops[String((req.query && req.query.op) || '')];
      if (!op) return send(res, 404, { error: 'Неизвестная операция' });
      if (req.method !== op.method) return send(res, 405, { error: 'Метод не поддерживается' });
      const out = await op.fn(req, res);
      if (out !== undefined) send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      send(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  };
}
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

module.exports = {
  HttpError, redis, pipeline, getJson, setJson, hashToObj, getDevice,
  sha256hex, randomToken, safeEqualHex, newCode, normalizeCode,
  validatePin, hashPin, verifyPin, hit, limit, checkPin,
  clientIp, requireCsrf, deviceLabel, cleanName,
  createSession, clearCookie, getSession, requireSession, parseDeviceAuth, requireDevice,
  logEvent, api, body, send, PAIR_TTL, MAX_DEVICES,
  ablyKey, ablyToken, ablyWake,
};
