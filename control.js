'use strict';
/** Операции телефона: статус ПК и отправка команд. */
const L = require('./_lib');
const { HttpError } = L;

const ACTIONS = ['shutdown', 'sleep', 'cancel'];

// Проверка «в сети» по запросу: сервер будит ПК через Ably и ждёт, пока тот отметится (heartbeat пишет время в alive).
const pingWaitMs = () => Number(process.env.PING_WAIT_MS) || 6000;   // дольше ждать нельзя: лимит времени функции на Vercel
const pingStepMs = () => Number(process.env.PING_STEP_MS) || 400;
const PING_FRESH_MS = 3000;                                      // ПК отметился только что: пинг не нужен
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pcAnswered(did, since) {
  const end = Date.now() + pingWaitMs();
  while (Date.now() < end) {
    await sleep(pingStepMs());
    if (Number(await L.redis(['GET', `d:${did}:alive`])) >= since) return true;
  }
  return false;
}

module.exports = L.api({
  status: {
    method: 'GET',
    fn: async (req) => {
      const s = await L.requireSession(req);
      const d = String(req.query.d || '');
      if (!/^[\w-]{10,64}$/.test(d)) throw new HttpError(400, 'Не выбран ПК');
      const ably = !!L.ablyKey();
      // Без Ably: телефон опрашивает статус, пока открыт, а ПК в это время чаще шлёт heartbeat (флаг hot).
      const [uid, aliveTs] = await L.pipeline([
        ['HGET', `d:${d}`, 'uid'], ['GET', `d:${d}:alive`],
        ...(ably ? [] : [['SET', `d:${d}:hot`, '1', 'EX', '60']]),
      ]);
      if (uid !== s.uid) throw new HttpError(404, 'ПК не найден');
      let online = !!aliveTs;
      if (ably && req.query.check === '1') {
        // Телефон открыли (или вернулись на вкладку): спрашиваем у самого ПК, а не верим старой отметке.
        const t0 = Date.now();
        if (aliveTs && t0 - Number(aliveTs) < PING_FRESH_MS) online = true;
        else if ((await L.hit(`rl:ping:${d}`, 60)) > 12) online = !!aliveTs;     // слишком часто: пингуем не чаще 12 раз в минуту
        else if (await L.ablyWake(d)) online = await pcAnswered(d, t0 - 500);   // 500 мс запаса на разницу часов серверов
        // Ably не принял сигнал: честно ответить нельзя, остаётся отметка последнего heartbeat
      }
      const [state, ack] = await L.pipeline([['GET', `d:${d}:state`], ['GET', `d:${d}:ack`]]);
      return { online, state: online && state ? JSON.parse(state) : null, ack: ack ? JSON.parse(ack) : null, now: Date.now() };
    },
  },

  /** Токен телефона для подписки на состояние ОДНОГО из его ПК (?d=…, по умолчанию первый). Только чтение.
   *  Без ABLY_API_KEY -> { enabled: false }: телефон опрашивает сервер сам. */
  realtime: {
    method: 'GET',
    fn: async (req) => {
      const s = await L.requireSession(req);
      if (!L.ablyKey()) return { enabled: false };
      const dids = await L.redis(['SMEMBERS', `u:${s.uid}:devs`]);
      const want = String(req.query.d || '');
      const did = want ? dids.find((x) => x === want) : dids[0];
      if (!did) throw new HttpError(404, 'ПК не найден');
      const t = L.ablyUiToken([did]);
      return t ? { enabled: true, url: t.url, expires: t.expires } : { enabled: false };
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
      const ack = { id, status: 'queued', t: Date.now() };
      await L.pipeline([
        ['SET', `d:${did}:cmd`, JSON.stringify({ id, action: b.action, delay, t: Date.now() }), 'EX', '120'],
        ['SET', `d:${did}:ack`, JSON.stringify(ack), 'EX', '600'],
      ]);
      await L.logEvent(s.uid, 'cmd', { d: d.name, a: b.action, m: delay, s: s.label });
      // «звонок» ПК и сразу сообщаем всем телефонам аккаунта, что команда принята (без Ably обе функции ничего не делают)
      await Promise.all([L.ablyWake(did), L.ablyPushState(did, { ack })]);
      return { id };
    },
  },
});
