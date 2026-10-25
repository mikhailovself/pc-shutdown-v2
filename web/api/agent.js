'use strict';
/**
 * Heartbeat ПК. Один вызов = одна команда Redis (Lua):
 * проверка токена, запись состояния, получение команды, признак «телефон смотрит».
 */
const L = require('./_lib');
const { HttpError } = L;

const SCRIPT = `
local h = redis.call('HGET', KEYS[1], 'h')
if (not h) or h ~= ARGV[1] then return nil end
redis.call('SET', KEYS[2], ARGV[2], 'EX', 60)
local c = redis.call('GETDEL', KEYS[3])
local hot = redis.call('EXISTS', KEYS[4])
return { c or false, hot }
`;
const ACKS = ['received', 'executing', 'cancelled', 'failed'];
const num = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : 0);

module.exports = L.api({
  beat: {
    method: 'POST',
    fn: async (req) => {
      const a = L.parseDeviceAuth(req);
      if (!a) throw new HttpError(401, 'Нет токена устройства', 'device_revoked');
      const b = L.body(req);
      const t = b.timer && ['shutdown', 'sleep'].includes(b.timer.action)
        ? { action: b.timer.action, remaining: num(b.timer.remaining, 90000), source: b.timer.source === 'phone' ? 'phone' : 'pc' }
        : null;
      const state = JSON.stringify({ t: Date.now(), up: num(b.uptime, 3e9), timer: t, ver: String(b.ver || '').slice(0, 16) });
      const did = a.did;
      const r = await L.redis(['EVAL', SCRIPT, '4',
        `d:${did}`, `d:${did}:state`, `d:${did}:cmd`, `d:${did}:hot`, a.h, state]);
      if (!r) throw new HttpError(401, 'Устройство отключено', 'device_revoked');

      const ack = b.ack;
      if (ack && /^[\w-]{6,40}$/.test(String(ack.id)) && ACKS.includes(ack.status)) {
        await L.setJson(`d:${did}:ack`, { id: ack.id, status: ack.status, t: Date.now() }, 3600);
        if (ack.status !== 'received') {
          const d = await L.getDevice(did);
          if (d) await L.logEvent(d.uid, 'ack', { d: d.name, a: ack.status });
        }
      }
      const idle = Number(process.env.POLL_IDLE) || 15, hot = Number(process.env.POLL_HOT) || 2;
      return { command: r[0] ? JSON.parse(r[0]) : null, next: r[1] ? hot : idle };
    },
  },
});
