'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { start } = require('./dev-server');

let srv, ipN = 0;
test.before(async () => { srv = await start(0); });
test.after(() => srv.close());

class Client {   // «телефон»: свой cookie и свой IP
  constructor() { this.cookie = ''; this.ip = `10.0.0.${++ipN}`; }
  async call(method, file, op, { body, query = '', csrf = true, headers = {} } = {}) {
    const h = { 'content-type': 'application/json', 'x-vercel-forwarded-for': this.ip,
      'user-agent': 'Mozilla/5.0 (iPhone) Safari/605', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (csrf && method === 'POST') h['x-csrf'] = '1';
    const r = await fetch(`${srv.url}/api/${file}?op=${op}${query}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.startsWith('__Host-sess=;') ? '' : sc.split(';')[0];
    return { status: r.status, json: await r.json() };
  }
}
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const pcStart = async (c, name, secret) => (await c.call('POST', 'pair', 'start', { body: { name, secret } })).json.code;

async function pairNewPc(phone, name = 'Тест-ПК', pin = '482916') {
  const secret = newSecret();
  const pc = new Client();
  const code = await pcStart(pc, name, secret);
  const claim = await phone.call('POST', 'pair', 'claim', { body: { code, pin } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const poll = await pc.call('POST', 'pair', 'poll', { body: { code, secret } });
  assert.equal(poll.json.status, 'claimed');
  return { did: poll.json.deviceId, secret, auth: { authorization: `Device ${poll.json.deviceId}.${secret}` }, code };
}
const beat = (pc, dev, extra = {}) => pc.call('POST', 'agent', 'beat', { body: { uptime: 100, timer: null, ...extra }, headers: dev.auth, csrf: false });

test('полный сценарий: QR → PIN → статус → команда → ack', async () => {
  const phone = new Client(), pc = new Client();
  const secret = newSecret();
  const code = await pcStart(pc, 'Игровой ПК', secret);
  assert.match(code, /^[0-9A-Z]{10}$/);

  const info = await phone.call('POST', 'pair', 'info', { body: { code: code.toLowerCase().slice(0, 5) + '-' + code.slice(5) } });
  assert.deepEqual(info.json, { name: 'Игровой ПК', mode: 'new', needs: 'create-pin' });

  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '123456' } })).status, 400); // простой PIN
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '12ab' } })).status, 400);
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '482916' }, csrf: false })).status, 403);
  const claim = await phone.call('POST', 'pair', 'claim', { body: { code, pin: '482916' } });
  assert.equal(claim.status, 200);
  assert.ok(phone.cookie.startsWith('__Host-sess='));
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '482916' } })).status, 409); // повтор

  const poll = await pc.call('POST', 'pair', 'poll', { body: { code, secret } });
  assert.equal(poll.json.status, 'claimed');
  const dev = { did: poll.json.deviceId, auth: { authorization: `Device ${poll.json.deviceId}.${secret}` } };
  assert.equal((await pc.call('POST', 'pair', 'poll', { body: { code, secret } })).json.status, 'expired'); // одноразово

  const me = await phone.call('GET', 'account', 'me');
  assert.equal(me.json.devices.length, 1);
  assert.equal(me.json.devices[0].name, 'Игровой ПК');
  assert.equal(me.json.devices[0].online, false);

  // ПК ещё не выходил на связь
  assert.equal((await phone.call('POST', 'control', 'command', { body: { device: dev.did, action: 'sleep', delay: 5 } })).status, 409);

  const b1 = await beat(pc, dev);
  assert.equal(b1.status, 200);
  assert.equal(b1.json.command, null);
  assert.equal(b1.json.next, 15); // телефон ещё не смотрит -> редкий опрос
  const st = await phone.call('GET', 'control', 'status', { query: `&d=${dev.did}` });
  assert.equal(st.json.online, true);

  const cmd = await phone.call('POST', 'control', 'command', { body: { device: dev.did, action: 'shutdown', delay: 15 } });
  assert.equal(cmd.status, 200);
  const b2 = await beat(pc, dev);
  assert.equal(b2.json.command.action, 'shutdown');
  assert.equal(b2.json.command.delay, 15);
  assert.equal(b2.json.next, 2); // телефон смотрит -> быстрый опрос
  assert.equal((await beat(pc, dev)).json.command, null); // команда одноразовая

  await beat(pc, dev, { ack: { id: cmd.json.id, status: 'received' }, timer: { action: 'shutdown', remaining: 900, source: 'phone' } });
  const st2 = await phone.call('GET', 'control', 'status', { query: `&d=${dev.did}` });
  assert.equal(st2.json.ack.status, 'received');
  assert.equal(st2.json.state.timer.remaining, 900);

  const me2 = await phone.call('GET', 'account', 'me');
  assert.ok(me2.json.log.some((x) => x.e === 'cmd' && x.a === 'shutdown'));
});

test('валидация команд', async () => {
  const phone = new Client(); const pc = new Client();
  const dev = await pairNewPc(phone);
  await beat(pc, dev);
  const send = (body) => phone.call('POST', 'control', 'command', { body: { device: dev.did, ...body } });
  assert.equal((await send({ action: 'format' })).status, 400);
  assert.equal((await send({ action: 'shutdown', delay: -1 })).status, 400);
  assert.equal((await send({ action: 'shutdown', delay: 1441 })).status, 400);
  assert.equal((await send({ action: 'shutdown', delay: 1.5 })).status, 400);
  assert.equal((await send({ action: 'cancel' })).status, 200);
});

test('изоляция аккаунтов: чужой ПК недоступен', async () => {
  const a = new Client(), b = new Client(), pc = new Client();
  const devA = await pairNewPc(a, 'ПК Алисы');
  await pairNewPc(b, 'ПК Боба', '735190');
  await beat(pc, devA);
  assert.equal((await b.call('GET', 'control', 'status', { query: `&d=${devA.did}` })).status, 404);
  assert.equal((await b.call('POST', 'control', 'command', { body: { device: devA.did, action: 'shutdown', delay: 0 } })).status, 404);
  assert.equal((await b.call('POST', 'account', 'removeDevice', { body: { device: devA.did, pin: '735190' } })).status, 404);
  const meB = await b.call('GET', 'account', 'me');
  assert.deepEqual(meB.json.devices.map((d) => d.name), ['ПК Боба']);
});

test('нет сессии или токена ПК → 401', async () => {
  const anon = new Client();
  assert.equal((await anon.call('GET', 'account', 'me')).status, 401);
  assert.equal((await anon.call('GET', 'control', 'status', { query: '&d=abcdefghijkl' })).status, 401);
  const bad = await anon.call('POST', 'agent', 'beat', { body: {}, headers: { authorization: `Device abcdefghijkl.${newSecret()}` } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'device_revoked');
  assert.equal((await anon.call('POST', 'agent', 'beat', { body: {} })).status, 401);
});

test('подключение второго телефона через ПК + блокировка PIN', async () => {
  const phone1 = new Client(), phone2 = new Client(), pc = new Client();
  const dev = await pairNewPc(phone1, 'Домашний ПК', '905173');

  const code = (await pc.call('POST', 'pair', 'start', { body: {}, headers: dev.auth })).json.code;
  const info = await phone2.call('POST', 'pair', 'info', { body: { code } });
  assert.equal(info.json.mode, 'phone');
  assert.equal(info.json.needs, 'enter-pin');

  for (let i = 0; i < 5; i++) {
    const r = await phone2.call('POST', 'pair', 'claim', { body: { code, pin: '111222' } });
    assert.equal(r.status, 401);
  }
  const locked = await phone2.call('POST', 'pair', 'claim', { body: { code, pin: '905173' } });
  assert.equal(locked.status, 429); // даже верный PIN после блокировки не принимается
  assert.equal(phone2.cookie, '');

  // сброс блокировки (имитация прошедших 15 минут)
  for (const k of [...srv.redis.store.data.keys()]) if (k.startsWith('pf15:')) srv.redis.store.data.delete(k);
  const ok = await phone2.call('POST', 'pair', 'claim', { body: { code, pin: '905173' } });
  assert.equal(ok.status, 200);
  assert.ok(phone2.cookie);
  const poll = await pc.call('POST', 'pair', 'poll', { body: { code, secret: dev.secret } });
  assert.deepEqual([poll.json.status, poll.json.phone], ['claimed', true]);
  assert.equal((await phone2.call('GET', 'account', 'me')).json.devices[0].name, 'Домашний ПК');
});

test('второй ПК в тот же аккаунт требует PIN', async () => {
  const phone = new Client();
  await pairNewPc(phone, 'ПК-1', '618204');
  const code = await pcStart(new Client(), 'ПК-2', newSecret());
  assert.equal((await phone.call('POST', 'pair', 'info', { body: { code } })).json.needs, 'enter-pin');
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '999000' } })).status, 401);
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '618204' } })).status, 200);
  assert.equal((await phone.call('GET', 'account', 'me')).json.devices.length, 2);
});

test('отзыв ПК, смена PIN, выход и удаление аккаунта', async () => {
  const phone = new Client(), other = new Client(), pc = new Client();
  const dev = await pairNewPc(phone, 'Рабочий', '370518');
  await beat(pc, dev);

  // другой телефон
  const code = (await pc.call('POST', 'pair', 'start', { body: {}, headers: dev.auth })).json.code;
  await other.call('POST', 'pair', 'claim', { body: { code, pin: '370518' } });
  assert.equal((await phone.call('GET', 'account', 'me')).json.sessions.length, 2);

  // смена PIN сбрасывает остальные сессии
  assert.equal((await phone.call('POST', 'account', 'changePin', { body: { pin: '000000', newPin: '864209' } })).status, 401);
  assert.equal((await phone.call('POST', 'account', 'changePin', { body: { pin: '370518', newPin: '111111' } })).status, 400);
  assert.equal((await phone.call('POST', 'account', 'changePin', { body: { pin: '370518', newPin: '864209' } })).status, 200);
  assert.equal((await other.call('GET', 'account', 'me')).status, 401);
  assert.equal((await phone.call('GET', 'account', 'me')).status, 200);

  // удаление ПК -> агент получает device_revoked
  assert.equal((await phone.call('POST', 'account', 'removeDevice', { body: { device: dev.did, pin: '864209' } })).status, 200);
  const r = await beat(pc, dev);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'device_revoked');
  assert.equal((await phone.call('GET', 'account', 'me')).json.devices.length, 0);

  // выход
  assert.equal((await phone.call('POST', 'account', 'logout')).status, 200);
  assert.equal((await phone.call('GET', 'account', 'me')).status, 401);
});

test('удаление аккаунта стирает данные', async () => {
  const phone = new Client(), pc = new Client();
  const dev = await pairNewPc(phone, 'Удаляемый', '276041');
  await beat(pc, dev);
  assert.equal((await phone.call('POST', 'account', 'deleteAccount', { body: { pin: '276041' } })).status, 200);
  assert.equal((await beat(pc, dev)).status, 401);
  const left = [...srv.redis.store.data.keys()].filter((k) => k.includes(dev.did));
  assert.deepEqual(left, []);
});

test('ограничение числа ПК и просроченный код', async () => {
  const phone = new Client();
  await pairNewPc(phone, 'ПК-1', '529047');
  for (let i = 2; i <= 5; i++) {
    const code = await pcStart(new Client(), `ПК-${i}`, newSecret());
    assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code, pin: '529047' } })).status, 200);
  }
  const code6 = await pcStart(new Client(), 'ПК-6', newSecret());
  assert.equal((await phone.call('POST', 'pair', 'claim', { body: { code: code6, pin: '529047' } })).status, 409);
  assert.equal((await phone.call('POST', 'pair', 'info', { body: { code: 'ZZZZZZZZZZ' } })).status, 404);
  assert.equal((await phone.call('POST', 'pair', 'info', { body: { code: 'bad' } })).status, 400);
});

test('rate-limit на создание кодов', async () => {
  const pc = new Client();
  let last;
  for (let i = 0; i < 22; i++) last = await pc.call('POST', 'pair', 'start', { body: { name: 'x', secret: newSecret() } });
  assert.equal(last.status, 429);
});
