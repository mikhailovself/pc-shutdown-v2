'use strict';
/**
 * Heartbeat ПК (+ realtime: выдача токена Ably). Heartbeat = «я жив» + забрать команду.
 * Состояние (таймер, время включения ПК) ПК присылает только когда оно изменилось.
 */
const L = require('./_lib');
const { HttpError } = L;

/**
 * Один вызов Redis (Lua): проверка токена, отметка «ПК жив» (alive), необязательная запись состояния,
 * забор команды, признак «телефон смотрит». Возвращает { команда, hot, есть ли состояние }.
 * Пока телефон смотрит (hot), «жив» живёт коротко, чтобы пропавший ПК быстро показался «не в сети».
 */
const SCRIPT = `
local h = redis.call('HGET', KEYS[1], 'h')
if (not h) or h ~= ARGV[1] then return nil end
local hot = redis.call('EXISTS', KEYS[4])
local ttl = ARGV[3]
if hot == 1 then ttl = ARGV[4] end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
if ARGV[5] ~= '' then redis.call('SET', KEYS[5], ARGV[5], 'EX', 604800) end
local have = redis.call('EXISTS', KEYS[5])
local c = redis.call('GETDEL', KEYS[3])
return { c or false, hot, have }
`;
const ACKS = ['received', 'executing', 'cancelled', 'failed'];
const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : 0);

/** Состояние ПК из тела heartbeat. Новый клиент шлёт {state:{boot,uptime,timer}} только при изменениях;
 *  старый шлёт плоские uptime/timer в каждом heartbeat (так тоже работает). Нет состояния -> null. */
function parseState(b) {
  const s = b.state && typeof b.state === 'object' ? b.state : ('uptime' in b || 'timer' in b ? b : null);
  if (!s) return null;
  const tm = s.timer && ['shutdown', 'sleep'].includes(s.timer.action)
    ? { action: s.timer.action, remaining: num(s.timer.remaining, 90000), source: s.timer.source === 'phone' ? 'phone' : 'pc' }
    : null;
  const now = Date.now();
  const boot0 = Number(s.boot);
  const boot = Number.isFinite(boot0) && boot0 > 1e12 && boot0 <= now + 60000 ? Math.floor(boot0) : 0;   // когда включили ПК
  const up = boot ? Math.floor((now - boot) / 1000) : num(s.uptime, 3e9);
  return { t: now, boot, up, timer: tm, ver: String(b.ver || s.ver || '').slice(0, 16) };
}

module.exports = L.api({
  /** Токен для подписки ПК на свой канал Ably. Без ABLY_API_KEY -> { enabled: false }, ПК работает на опросе. */
  realtime: {
    method: 'POST',
    fn: async (req) => {
      const a = L.parseDeviceAuth(req);
      if (!a) throw new HttpError(401, 'Нет токена устройства', 'device_revoked');
      const h = await L.redis(['HGET', `d:${a.did}`, 'h']);
      if (!h || h !== a.h) throw new HttpError(401, 'Устройство отключено', 'device_revoked');
      const t = L.ablyToken(a.did);
      return t ? { enabled: true, url: t.url, expires: t.expires } : { enabled: false };
    },
  },
  beat: {
    method: 'POST',
    fn: async (req) => {
      const a = L.parseDeviceAuth(req);
      if (!a) throw new HttpError(401, 'Нет токена устройства', 'device_revoked');
      const b = L.body(req);
      const st = parseState(b);
      // с Ably команды приходят мгновенно, опрос нужен только как запасной путь и для «онлайн»
      const idle = Number(process.env.POLL_IDLE) || (L.ablyKey() ? 60 : 15), hot = Number(process.env.POLL_HOT) || 2;
      const aliveIdle = Math.max(60, Math.round(idle * 2.5));   // пропущенный-два опроса не делают ПК «не в сети»
      const aliveHot = Math.max(20, hot * 10);
      const did = a.did;
      const r = await L.redis(['EVAL', SCRIPT, '5',
        `d:${did}`, `d:${did}:alive`, `d:${did}:cmd`, `d:${did}:hot`, `d:${did}:state`,
        a.h, String(Date.now()), String(aliveIdle), String(aliveHot), st ? JSON.stringify(st) : '']);
      if (!r) throw new HttpError(401, 'Устройство отключено', 'device_revoked');

      const ack = b.ack;
      if (ack && /^[\w-]{6,40}$/.test(String(ack.id)) && ACKS.includes(ack.status)) {
        await L.setJson(`d:${did}:ack`, { id: ack.id, status: ack.status, t: Date.now() }, 3600);
        if (ack.status !== 'received') {
          const d = await L.getDevice(did);
          if (d) await L.logEvent(d.uid, 'ack', { d: d.name, a: ack.status });
        }
      }
      // need: на сервере нет состояния ПК (истекло или первый запуск) -> ПК пришлёт его следующим heartbeat
      return { command: r[0] ? JSON.parse(r[0]) : null, next: r[1] ? hot : idle, need: !r[2] };
    },
  },
});
