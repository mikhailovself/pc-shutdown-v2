'use strict';
/**
 * Подключение по QR/коду.
 *  start  — ПК создаёт код (новый ПК или «добавить телефон» к уже подключённому)
 *  info   — телефон узнаёт, что за ПК и что нужно ввести (создать PIN / ввести PIN)
 *  claim  — телефон подтверждает подключение
 *  poll   — ПК ждёт подтверждения
 * Секрет ПК генерирует сам ПК; сервер хранит только его SHA-256.
 */
const L = require('./_lib');
const { HttpError } = L;

const PAIR_TTL = L.PAIR_TTL;
const pkey = (code) => `p:${code}`;

async function readPair(code) {
  const p = await L.getJson(pkey(code));
  if (!p) throw new HttpError(404, 'Код истёк или недействителен. Покажите новый QR на ПК.', 'bad_code');
  return p;
}
async function addDevice(uid, name, h) {
  const n = Number(await L.redis(['SCARD', `u:${uid}:devs`]));
  if (n >= L.MAX_DEVICES) throw new HttpError(409, `Можно подключить не более ${L.MAX_DEVICES} ПК`);
  const did = L.randomToken(12);
  await L.pipeline([
    ['HSET', `d:${did}`, 'uid', uid, 'name', name, 'h', h, 'created', String(Date.now())],
    ['SADD', `u:${uid}:devs`, did],
  ]);
  return did;
}

module.exports = L.api({
  start: {
    method: 'POST',
    fn: async (req) => {
      await L.limit(`rl:pstart:${L.clientIp(req)}`, 20, 3600);
      const b = L.body(req);
      const rec = { created: Date.now() };
      if (L.parseDeviceAuth(req)) {            // уже подключённый ПК добавляет ещё один телефон
        const d = await L.requireDevice(req);
        Object.assign(rec, { mode: 'phone', did: d.did, uid: d.uid, name: d.name, sh: d.h });
      } else {                                  // новый ПК
        const secret = String(b.secret || '');
        if (!/^[\w-]{32,128}$/.test(secret)) throw new HttpError(400, 'Некорректный секрет устройства');
        Object.assign(rec, { mode: 'new', name: L.cleanName(b.name, 'Мой ПК'), sh: L.sha256hex(secret) });
      }
      for (let i = 0; i < 5; i++) {
        const code = L.newCode();
        const ok = await L.redis(['SET', pkey(code), JSON.stringify(rec), 'EX', String(PAIR_TTL), 'NX']);
        if (ok === 'OK') return { code, expiresIn: PAIR_TTL };
      }
      throw new HttpError(503, 'Не удалось создать код, повторите');
    },
  },

  info: {
    method: 'POST',
    fn: async (req) => {
      await L.limit(`rl:pinfo:${L.clientIp(req)}`, 60, 600);
      const code = L.normalizeCode(L.body(req).code);
      if (!code) throw new HttpError(400, 'Код введён неверно', 'bad_code');
      const p = await readPair(code);
      const session = await L.getSession(req);
      return { name: p.name, mode: p.mode, needs: p.mode === 'new' && !session ? 'create-pin' : 'enter-pin' };
    },
  },

  claim: {
    method: 'POST',
    fn: async (req, res) => {
      L.requireCsrf(req);
      await L.limit(`rl:pclaim:${L.clientIp(req)}`, 30, 3600);
      const b = L.body(req);
      const code = L.normalizeCode(b.code);
      if (!code) throw new HttpError(400, 'Код введён неверно', 'bad_code');
      const p = await readPair(code);
      const label = L.deviceLabel(req.headers['user-agent']);
      const session = await L.getSession(req);
      const lock = () => L.redis(['SET', `${pkey(code)}:claimed`, '1', 'NX', 'EX', String(PAIR_TTL)])
        .then((r) => { if (r !== 'OK') throw new HttpError(409, 'Этот код уже использован'); });
      const done = (extra) => L.setJson(`${pkey(code)}:res`, { sh: p.sh, ...extra }, 120);

      if (p.mode === 'phone') {                 // новый телефон для уже подключённого ПК
        await L.checkPin(p.uid, b.pin);
        await lock();
        await L.createSession(res, p.uid, label);
        await done({ did: p.did, phone: true });
        await L.logEvent(p.uid, 'phone', { d: p.name, s: label });
        return { ok: true, device: { id: p.did, name: p.name } };
      }

      let uid, created = false;
      if (session) {                            // ещё один ПК в существующий аккаунт
        uid = session.uid;
        await L.checkPin(uid, b.pin);
        await lock();
      } else {                                  // первый ПК: создаём аккаунт и PIN
        L.validatePin(b.pin);
        const pin = await L.hashPin(b.pin);
        await lock();
        uid = L.randomToken(12);
        await L.setJson(`u:${uid}`, { pin, created: Date.now() });
        created = true;
      }
      const did = await addDevice(uid, p.name, p.sh);
      if (created) await L.createSession(res, uid, label);
      await done({ did });
      await L.logEvent(uid, 'pc', { d: p.name, s: label });
      return { ok: true, device: { id: did, name: p.name } };
    },
  },

  poll: {
    method: 'POST',
    fn: async (req) => {
      const b = L.body(req);
      const code = L.normalizeCode(b.code);
      if (!code) throw new HttpError(400, 'Код введён неверно', 'bad_code');
      await L.limit(`rl:ppoll:${code}`, 700, 600);
      const [praw, rraw] = await L.pipeline([['GET', pkey(code)], ['GET', `${pkey(code)}:res`]]);
      const sh = L.sha256hex(b.secret || '');
      if (rraw) {
        const r = JSON.parse(rraw);
        if (!L.safeEqualHex(sh, r.sh)) throw new HttpError(401, 'Неверный секрет');
        await L.pipeline([['DEL', pkey(code)], ['DEL', `${pkey(code)}:claimed`], ['DEL', `${pkey(code)}:res`]]);
        return { status: 'claimed', deviceId: r.did, phone: !!r.phone };
      }
      if (!praw) return { status: 'expired' };
      if (!L.safeEqualHex(sh, JSON.parse(praw).sh)) throw new HttpError(401, 'Неверный секрет');
      return { status: 'pending' };
    },
  },
});
