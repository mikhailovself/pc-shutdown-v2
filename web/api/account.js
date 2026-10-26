'use strict';
/** Аккаунт: список ПК и сессий, журнал, выход, смена PIN, удаление. */
const L = require('./_lib');
const { HttpError } = L;

const devKeys = (did) => ['', ':state', ':cmd', ':ack', ':hot'].map((x) => `d:${did}${x}`);

async function dropSessions(uid, keep) {
  const sids = (await L.redis(['SMEMBERS', `u:${uid}:sess`])).filter((x) => x !== keep);
  if (sids.length) await L.pipeline([...sids.map((x) => ['DEL', `s:${x}`]), ['SREM', `u:${uid}:sess`, ...sids]]);
}
async function dropDevice(uid, did) {
  await L.pipeline([...devKeys(did).map((k) => ['DEL', k]), ['SREM', `u:${uid}:devs`, did]]);
}
async function authed(req) {
  L.requireCsrf(req);
  return L.requireSession(req);
}

module.exports = L.api({
  me: {
    method: 'GET',
    fn: async (req) => {
      const s = await L.requireSession(req);
      const [devs, sess, log] = await L.pipeline([
        ['SMEMBERS', `u:${s.uid}:devs`], ['SMEMBERS', `u:${s.uid}:sess`], ['LRANGE', `u:${s.uid}:log`, '0', '29'],
      ]);
      const devices = [];
      if (devs.length) {
        const r = await L.pipeline(devs.flatMap((d) => [['HGET', `d:${d}`, 'name'], ['EXISTS', `d:${d}:state`]]));
        devs.forEach((id, i) => { if (r[i * 2]) devices.push({ id, name: r[i * 2], online: !!r[i * 2 + 1] }); });
      }
      const sessions = [];
      if (sess.length) {
        const r = await L.pipeline(sess.map((x) => ['GET', `s:${x}`]));
        const dead = [];
        sess.forEach((id, i) => {
          if (!r[i]) return dead.push(id);
          const o = JSON.parse(r[i]);
          sessions.push({ id, label: o.label, created: o.created, current: id === s.sid });
        });
        if (dead.length) await L.redis(['SREM', `u:${s.uid}:sess`, ...dead]);
      }
      sessions.sort((a, b) => b.created - a.created);
      return { devices, sessions, log: log.map((x) => JSON.parse(x)) };
    },
  },

  logout: {
    method: 'POST',
    fn: async (req, res) => {
      const s = await authed(req);
      await L.pipeline([['DEL', `s:${s.sid}`], ['SREM', `u:${s.uid}:sess`, s.sid]]);
      L.clearCookie(res);
      return { ok: true };
    },
  },

  revoke: {
    method: 'POST',
    fn: async (req) => {
      const s = await authed(req);
      const b = L.body(req);
      await L.checkPin(s.uid, b.pin);
      if (b.sid === 'others') { await dropSessions(s.uid, s.sid); return { ok: true }; }
      if (!/^[\w-]{10,64}$/.test(String(b.sid))) throw new HttpError(400, 'Сессия не найдена');
      if (Number(await L.redis(['SREM', `u:${s.uid}:sess`, b.sid]))) await L.redis(['DEL', `s:${b.sid}`]);
      return { ok: true };
    },
  },

  removeDevice: {
    method: 'POST',
    fn: async (req) => {
      const s = await authed(req);
      const b = L.body(req);
      await L.checkPin(s.uid, b.pin);
      const d = await L.getDevice(String(b.device || ''));
      if (!d || d.uid !== s.uid) throw new HttpError(404, 'ПК не найден');
      await dropDevice(s.uid, b.device);
      await L.logEvent(s.uid, 'rm', { d: d.name, s: s.label });
      return { ok: true };
    },
  },

  changePin: {
    method: 'POST',
    fn: async (req) => {
      const s = await authed(req);
      const b = L.body(req);
      const u = await L.checkPin(s.uid, b.pin);
      L.validatePin(b.newPin);
      await L.setJson(`u:${s.uid}`, { ...u, pin: await L.hashPin(b.newPin) });
      await dropSessions(s.uid, s.sid);
      await L.logEvent(s.uid, 'pin', { s: s.label });
      return { ok: true };
    },
  },

  deleteAccount: {
    method: 'POST',
    fn: async (req, res) => {
      const s = await authed(req);
      await L.checkPin(s.uid, L.body(req).pin);
      const devs = await L.redis(['SMEMBERS', `u:${s.uid}:devs`]);
      for (const d of devs) await dropDevice(s.uid, d);
      await dropSessions(s.uid, null);
      await L.pipeline([['DEL', `u:${s.uid}`], ['DEL', `u:${s.uid}:devs`], ['DEL', `u:${s.uid}:sess`],
        ['DEL', `u:${s.uid}:log`], ['DEL', `pf15:${s.uid}`], ['DEL', `pf24:${s.uid}`]]);
      L.clearCookie(res);
      return { ok: true };
    },
  },
});
