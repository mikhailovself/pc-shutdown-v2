'use strict';
/** Операции телефона: статус ПК и отправка команд. */
const L = require('./_lib');
const { HttpError } = L;

const ACTIONS = ['shutdown', 'sleep', 'cancel'];

module.exports = L.api({
  status: {
    method: 'GET',
    fn: async (req) => {
      const s = await L.requireSession(req);
      const d = String(req.query.d || '');
      if (!/^[\w-]{10,64}$/.test(d)) throw new HttpError(400, 'Не выбран ПК');
      const [uid, alive, state, ack, hotBefore] = await L.pipeline([
        ['HGET', `d:${d}`, 'uid'], ['EXISTS', `d:${d}:alive`], ['GET', `d:${d}:state`], ['GET', `d:${d}:ack`],
        ['EXISTS', `d:${d}:hot`],
        ['SET', `d:${d}:hot`, '1', 'EX', '60'],
      ]);
      if (uid !== s.uid) throw new HttpError(404, 'ПК не найден');
      // телефон только что открыл приложение: будим ПК, чтобы он сразу перешёл на частые heartbeat
      if (!Number(hotBefore)) await L.ablyWake(d);
      const online = !!Number(alive);
      return { online, state: online && state ? JSON.parse(state) : null, ack: ack ? JSON.parse(ack) : null, now: Date.now() };
    },
  },

  command: {
    method: 'POST',
    fn: async (req) => {
      L.requireCsrf(req);
      const s = await L.requireSession(req);
      await L.limit(`rl:cmd:${s.uid}`, 30, 60);
      const b = L.body(req);
      if (!ACTIONS.includes(b.action)) throw new HttpError(400, 'Неизвестное действие');
      const delay = b.action === 'cancel' ? 0 : Number(b.delay);
      if (!Number.isInteger(delay) || delay < 0 || delay > 1440) throw new HttpError(400, 'Задержка: от 0 до 1440 минут');
      const d = await L.getDevice(String(b.device || ''));
      if (!d || d.uid !== s.uid) throw new HttpError(404, 'ПК не найден');
      const did = String(b.device);
      if (!(await L.redis(['EXISTS', `d:${did}:alive`]))) throw new HttpError(409, 'ПК сейчас не в сети', 'offline');
      const id = L.randomToken(9);
      await L.pipeline([
        ['SET', `d:${did}:cmd`, JSON.stringify({ id, action: b.action, delay, t: Date.now() }), 'EX', '120'],
        ['SET', `d:${did}:ack`, JSON.stringify({ id, status: 'queued', t: Date.now() }), 'EX', '600'],
      ]);
      await L.logEvent(s.uid, 'cmd', { d: d.name, a: b.action, m: delay, s: s.label });
      await L.ablyWake(did);   // «звонок» ПК; без Ably или при сбое команду заберёт обычный опрос
      return { id };
    },
  },
});
