'use strict';
(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  // ---------- утилиты ----------
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  async function api(method, file, op, { body, query = '' } = {}) {
    const headers = {};
    if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-CSRF'] = '1'; }
    let r;
    try {
      r = await fetch(`/api/${file}?op=${op}${query}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store',
      });
    } catch { throw new ApiError(0, 'network', 'Нет связи с сервером'); }
    let j = {};
    try { j = await r.json(); } catch { /* пустой ответ */ }
    if (!r.ok) throw new ApiError(r.status, j.code, j.error || `Ошибка ${r.status}`);
    return j;
  }
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 3800);
  }
  function render(node) { app.replaceChildren(node); app.removeAttribute('aria-busy'); }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };
  const pad = (n) => String(n).padStart(2, '0');
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  }
  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60);
    return d ? `${d} д ${hh} ч` : hh ? `${hh} ч ${mm} мин` : `${mm} мин`;
  }
  const fmtTime = (t) => new Date(t).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const delayWord = (m) => (m === 0 ? 'сразу' : m % 60 === 0 && m >= 60 ? `через ${m / 60} ч` : `через ${m} мин`);

  // ---------- диалоги ----------
  function modal(build) {
    return new Promise((resolve) => {
      const d = h('dialog');
      let result = null;
      const close = (v) => { result = v === undefined ? null : v; d.close(); };
      d.append(build(close));
      d.addEventListener('close', () => { d.remove(); resolve(result); });
      d.addEventListener('click', (e) => { if (e.target === d) close(null); });
      document.body.append(d);
      d.showModal();
    });
  }
  const confirmDlg = ({ title, text, ok, danger }) => modal((close) => h('div', { class: 'dlg' },
    h('h2', { text: title }), text && h('p', { class: 'muted', text }),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => close(null) }),
      h('button', { class: `btn ${danger ? 'solid-danger' : 'primary'}`, type: 'button', text: ok, onclick: () => close(true) }))));

  function askPin(title, text, err) {
    return modal((close) => {
      const input = h('input', { class: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12', autocomplete: 'current-password', 'aria-label': 'PIN' });
      const go = () => { if (/^\d{6,12}$/.test(input.value)) close(input.value); else input.focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      setTimeout(() => input.focus(), 50);
      return h('div', { class: 'dlg' },
        h('h2', { text: title }), text && h('p', { class: 'muted', text }), input,
        h('p', { class: 'error', role: 'alert', text: err || '' }),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => close(null) }),
          h('button', { class: 'btn primary', type: 'button', text: 'Подтвердить', onclick: go })));
    });
  }
  /** Запрашивает PIN, пока он не подойдёт или пользователь не откажется. */
  async function withPin(title, text, fn) {
    let err = '';
    for (;;) {
      const pin = await askPin(title, text, err);
      if (pin == null) return null;
      try { return (await fn(pin)) ?? true; } catch (e) {
        if (e.code === 'bad_pin') { err = e.message; continue; }
        toast(e.message); return null;
      }
    }
  }

  // ---------- подключение ----------
  const steps = () => h('ol', { class: 'steps' },
    h('li', { text: 'Запустите программу «SNOOZ» на компьютере. Она покажет QR-код.' }),
    h('li', { text: 'Наведите на QR-код камеру телефона и откройте ссылку.' }),
    h('li', { text: 'Придумайте PIN. После этого ПК появится здесь.' }));

  function codeForm() {
    const input = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXXX-XXXXX', maxlength: '14', 'aria-label': 'Код с экрана ПК' });
    const go = (e) => {
      e.preventDefault();
      const c = input.value.replace(/[\s-]/g, '');
      if (c.length >= 8) location.hash = `#pair=${encodeURIComponent(c)}`; else input.focus();
    };
    return h('form', { class: 'stack', onsubmit: go },
      h('label', { class: 'field' }, 'Нет QR под рукой? Введите код с экрана ПК', input),
      h('button', { class: 'btn wide', type: 'submit', text: 'Подключить' }),
      h('p', { class: 'muted small', text: 'Если вы открыли приложение с экрана «Домой», камера браузера недоступна. Введите код вручную.' }));
  }
  function welcomeView(message) {
    stopPolling();
    render(h('section', { class: 'wrap' },
      h('h1', { text: 'Подключите ПК' }),
      message && h('p', { class: 'notice', role: 'alert', text: message }),
      steps(), codeForm()));
  }

  async function pairView(raw) {
    stopPolling();
    render(h('p', { class: 'boot', text: 'Проверяем код…' }));
    let info;
    try { info = await api('POST', 'pair', 'info', { body: { code: decodeURIComponent(raw) } }); } catch (e) {
      history.replaceState(null, '', location.pathname);
      return welcomeView(e.message);
    }
    const create = info.needs === 'create-pin';
    const title = info.mode === 'phone' ? `Подключить телефон к «${info.name}»`
      : create ? `Подключить «${info.name}»` : `Добавить «${info.name}» в ваш аккаунт`;
    const text = create
      ? 'Придумайте PIN из 6–12 цифр. Он нужен, чтобы подключать новые телефоны и ПК и удалять устройства. Восстановить забытый PIN нельзя.'
      : 'Введите ваш PIN, чтобы подтвердить подключение.';
    const pin = h('input', { class: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12', autocomplete: create ? 'new-password' : 'current-password', 'aria-label': 'PIN' });
    const pin2 = create ? h('input', { class: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12', autocomplete: 'new-password', 'aria-label': 'Повторите PIN' }) : null;
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = h('button', { class: 'btn primary wide', type: 'submit', text: create ? 'Создать PIN и подключить' : 'Подключить' });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!/^\d{6,12}$/.test(pin.value)) { err.textContent = 'PIN: от 6 до 12 цифр'; return pin.focus(); }
      if (pin2 && pin2.value !== pin.value) { err.textContent = 'PIN не совпадает'; return pin2.focus(); }
      btn.disabled = true;
      try {
        await api('POST', 'pair', 'claim', { body: { code: decodeURIComponent(raw), pin: pin.value } });
        history.replaceState(null, '', location.pathname);
        toast(info.mode === 'phone' ? 'Телефон подключён' : 'ПК подключён');
        await start();
      } catch (ex) {
        err.textContent = ex.message; btn.disabled = false;
        if (ex.code === 'bad_code') { history.replaceState(null, '', location.pathname); welcomeView(ex.message); }
      }
    } },
    h('label', { class: 'field' }, create ? 'Придумайте PIN' : 'PIN', pin),
    pin2 && h('label', { class: 'field' }, 'Повторите PIN', pin2),
    err, btn);
    render(h('section', { class: 'wrap' }, h('h1', { text: title }), h('p', { class: 'muted', text }), form,
      h('button', { class: 'btn wide', type: 'button', text: 'Отмена', onclick: () => { history.replaceState(null, '', location.pathname); start(); } })));
    pin.focus();
  }

  // ---------- панель ----------
  const S = { me: null, dev: null, st: null, offset: 0, delay: 15, running: false, checking: false, polls: 0, busy: false, lastCmd: null, err: null, ui: null,
    es: null, live: false, fb: null, lastCheck: 0, backoff: 2000 };
  const PRESETS = [[0, 'Сразу'], [5, '5 мин'], [15, '15 мин'], [30, '30 мин'], [60, '1 час'], [120, '2 часа']];
  const ACKS = {
    queued: 'Команда отправлена, ждём ответ ПК…', received: 'ПК принял команду.',
    executing: 'ПК выполняет команду.', cancelled: 'Таймер отменён на ПК.', failed: 'ПК не смог выполнить команду.',
  };
  const curDev = () => S.me.devices.find((d) => d.id === S.dev);
  function currentDelay() {
    if (S.delay !== 'custom') return S.delay;
    const n = Number(S.ui.custom.value);
    return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : null;
  }

  async function start() {
    stopPolling();
    const m = /^#pair=(.+)$/.exec(location.hash);
    if (m) return pairView(m[1]);
    try { S.me = await api('GET', 'account', 'me'); } catch (e) {
      if (e.status === 401) return welcomeView();
      return render(h('section', { class: 'wrap' }, h('p', { class: 'notice', text: e.message }),
        h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: start })));
    }
    panelView();
  }

  function panelView() {
    const devs = S.me.devices;
    if (!devs.length) return emptyView();
    const saved = store.get('dev');
    if (!devs.some((d) => d.id === S.dev)) S.dev = devs.some((d) => d.id === saved) ? saved : devs[0].id;
    S.st = null; S.lastCmd = null;

    const ui = S.ui = {};
    ui.title = devs.length > 1
      ? h('select', { 'aria-label': 'Выбор ПК', onchange: (e) => { S.dev = e.target.value; store.set('dev', S.dev); S.st = null; S.lastCmd = null; paint(); recheck(); openStream(); } },
        devs.map((d) => h('option', { value: d.id, text: d.name })))
      : h('h1', { text: devs[0].name });
    if (ui.title.tagName === 'SELECT') ui.title.value = S.dev;
    ui.led = h('div', { class: 'led', 'aria-hidden': 'true' });
    ui.readout = h('div', { class: 'readout' });
    ui.caption = h('p', { class: 'caption' });
    ui.hero = h('section', { class: 'hero', 'aria-live': 'polite' }, ui.led, ui.readout, ui.caption);
    ui.cmdline = h('p', { class: 'cmdline', role: 'status' });

    ui.chips = PRESETS.map(([m, label]) => h('button', { class: 'chip', type: 'button', role: 'radio', 'data-d': String(m), text: label, onclick: () => { S.delay = m; paintDelay(); } }));
    ui.chips.push(h('button', { class: 'chip', type: 'button', role: 'radio', 'data-d': 'custom', text: 'Своё', onclick: () => { S.delay = 'custom'; paintDelay(); ui.custom.focus(); } }));
    ui.custom = h('input', { type: 'number', min: '1', max: '1440', inputmode: 'numeric', 'aria-label': 'Минут до выполнения' });
    ui.customRow = h('label', { class: 'custom', hidden: true }, ui.custom, 'минут (1–1440)');
    ui.off = h('button', { class: 'btn primary', type: 'button', text: 'Выключить', onclick: () => send('shutdown') });
    ui.sleep = h('button', { class: 'btn', type: 'button', text: 'Сон', onclick: () => send('sleep') });
    ui.cancel = h('button', { class: 'btn danger wide', type: 'button', text: 'Отменить таймер', onclick: () => send('cancel') });
    ui.log = h('ul', { class: 'log' });
    ui.logWrap = h('section', { class: 'group' }, h('h2', { text: 'Недавние действия' }), ui.log);

    render(h('div', { class: 'wrap' },
      h('header', { class: 'top' }, ui.title,
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Настройки', onclick: openSettings },
          iconGear())),
      ui.hero, ui.cmdline,
      h('section', { class: 'group' },
        h('h2', { id: 'when', text: 'Когда выполнить' }),
        h('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': 'when' }, ui.chips), ui.customRow,
        h('div', { class: 'btnrow' }, ui.off, ui.sleep, ui.cancel)),
      ui.logWrap));
    paintDelay(); paintLog(); paint();
    startPolling();
  }
  function iconGear() {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '3');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
    s.append(c, p); return s;
  }

  function paintDelay() {
    const u = S.ui; if (!u) return;
    u.chips.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.d === String(S.delay))));
    u.customRow.hidden = S.delay !== 'custom';
  }
  /** Сколько ПК работает: считаем от момента включения (его ПК шлёт один раз), а не ждём свежего числа. */
  function upNow(state) {
    const now = Date.now() + S.offset;
    return state.boot ? Math.max(0, (now - state.boot) / 1000) : state.up + Math.max(0, (now - state.t) / 1000);
  }
  function paint() {
    const u = S.ui; if (!u || !S.me) return;
    const st = S.st;
    let kind = 'off', word = false, big = '—', cap = S.err || 'Загрузка…', timer = null;
    if (st && !S.err) {
      if (!st.online) { word = true; big = 'Не в сети'; cap = 'ПК выключен, спит или без интернета. Команды недоступны.'; }
      else {
        timer = st.state ? st.state.timer : null;   // state бывает пустым, пока ПК не прислал его после перерыва
        if (timer) {
          const left = timer.remaining - (Date.now() + S.offset - st.state.t) / 1000;
          kind = 'warn';
          if (left <= 0) {
            word = true; big = 'Выполняется'; cap = timer.action === 'shutdown' ? 'ПК выключается.' : 'ПК уходит в сон.';
            // выключившийся ПК сам ничего не сообщит: через полминуты спросим у него ещё раз
            if (!S.chkT) S.chkT = setTimeout(() => { S.chkT = null; recheck(); }, 25000);
          }
          else { big = fmtClock(left); cap = (timer.action === 'shutdown' ? 'До выключения' : 'До сна') + (timer.source === 'phone' ? '. Задано с телефона.' : '. Задано на ПК.'); }
        } else { kind = 'ok'; word = true; big = 'Включён'; cap = st.state && (st.state.boot || st.state.up > 0) ? `Работает ${fmtUptime(upNow(st.state))}` : 'ПК на связи'; }
      }
    } else if (S.err) { word = true; big = 'Нет связи'; }
    u.hero.dataset.s = kind;
    u.readout.textContent = big; u.readout.classList.toggle('word', word); u.caption.textContent = cap;
    const online = !!(st && st.online);
    u.off.disabled = u.sleep.disabled = !online || S.busy;
    u.cancel.hidden = !timer; u.cancel.disabled = S.busy;
    const ack = st && st.ack;
    u.cmdline.textContent = ack && S.lastCmd && ack.id === S.lastCmd.id ? (ACKS[ack.status] || '') : '';
  }
  const LOG = {
    pc: (x) => `Подключён ПК «${x.d}»`, phone: (x) => `Подключён телефон (${x.s}) к «${x.d}»`,
    rm: (x) => `ПК «${x.d}» удалён`, pin: () => 'PIN изменён',
    cmd: (x) => `«${x.d}»: ${x.a === 'cancel' ? 'отмена таймера' : (x.a === 'shutdown' ? 'выключение ' : 'сон ') + delayWord(x.m)}`,
    ack: (x) => `«${x.d}»: ${{ executing: 'команда выполняется', cancelled: 'таймер отменён', failed: 'ошибка выполнения' }[x.a] || x.a}`,
  };
  function paintLog() {
    const u = S.ui; if (!u) return;
    const items = (S.me.log || []).filter((x) => LOG[x.e]).slice(0, 8);
    u.logWrap.hidden = !items.length;
    u.log.replaceChildren(...items.map((x) => h('li', {}, h('span', { text: LOG[x.e](x) }), h('time', { text: fmtTime(x.t) }))));
  }
  async function refreshMe() {
    try { S.me = await api('GET', 'account', 'me'); paintLog(); } catch (e) { if (e.status === 401) start(); }
  }

  async function send(action) {
    if (S.busy) return;
    const delay = action === 'cancel' ? 0 : currentDelay();
    if (delay == null) return toast('Укажите время: от 1 до 1440 минут');
    if (action !== 'cancel' && delay === 0) {
      const ok = await confirmDlg({
        title: action === 'shutdown' ? 'Выключить ПК сейчас?' : 'Отправить ПК в сон сейчас?',
        text: 'На экране ПК будет несколько секунд, чтобы отменить действие.',
        ok: action === 'shutdown' ? 'Выключить' : 'Сон', danger: action === 'shutdown',
      });
      if (!ok) return;
    }
    S.busy = true; paint();
    try {
      const r = await api('POST', 'control', 'command', { body: { device: S.dev, action, delay } });
      S.lastCmd = { id: r.id };
      S.st = S.st && { ...S.st, ack: { id: r.id, status: 'queued', t: Date.now() + S.offset } };
      toast(action === 'cancel' ? 'Отмена отправлена' : 'Команда отправлена');
      // ПК должен ответить «принял» за секунды (через Ably); молчит -> проверяем, в сети ли он вообще
      clearTimeout(S.ackT);
      S.ackT = setTimeout(() => { const a = S.st && S.st.ack; if (a && a.id === r.id && a.status === 'queued') recheck(); }, 12000);
      setTimeout(refreshMe, 2500);
    } catch (e) { toast(e.message); } finally { S.busy = false; paint(); }
  }

  // ---------- статус ПК ----------
  // Телефон ничего не опрашивает. При открытии (и когда вы возвращаетесь на вкладку) — один запрос: сервер будит ПК
  // и ждёт его ответа, так узнаём «в сети». Дальше состояние приходит само: сервер при каждом изменении
  // (команда принята, таймер сменился, подтверждение) публикует его в канал Ably, а мы слушаем канал через EventSource.
  // Если Ably не настроен или поток не работает, включается запасной опрос.
  function startPolling() { stopPolling(); S.running = true; S.polls = 0; S.tick = setInterval(paint, 1000); recheck(); openStream(); }
  function stopPolling() {
    S.running = false; clearInterval(S.tick); clearTimeout(S.chkT); clearTimeout(S.ackT);
    S.chkT = S.ackT = null; closeStream(); stopFallback();
  }
  /** Ответ на 401/404. true — экран уже сменился. */
  function statusFailed(e) {
    if (e.status === 401) { stopPolling(); welcomeView('Сессия закончилась. Отсканируйте QR на ПК ещё раз.'); return true; }
    if (e.status === 404) { stopPolling(); refreshMe().then(panelView); return true; }
    S.err = e.message; return false;
  }
  const newer = (a, b) => (a && (!b || (a.t || 0) >= (b.t || 0)) ? a : b || null);
  async function fetchStatus(check) {
    const dev = S.dev;
    const r = await api('GET', 'control', 'status', { query: `&d=${encodeURIComponent(dev)}${check ? '&check=1' : ''}` });
    if (dev !== S.dev) return;
    const cur = S.st || {};
    S.offset = r.now - Date.now(); S.err = null;
    S.st = { online: r.online, state: r.online ? newer(r.state, cur.state) : null, ack: newer(r.ack, cur.ack), now: r.now };
  }
  /** «ПК в сети?» спрашиваем у самого ПК (check=1). Один запрос, сервер ждёт ответа ПК до ~6 с. */
  async function recheck() {
    if (!S.running || S.checking || document.hidden) return;
    S.checking = true;
    try { await fetchStatus(true); S.lastCheck = Date.now(); } catch (e) { if (statusFailed(e)) { S.checking = false; return; } }
    S.checking = false; paint();
  }
  /** Сообщение из канала: { t, online?, state?, ack? }. Склеиваем с тем, что уже знаем. */
  function applyMsg(d) {
    if (!S.st) S.st = { online: false, state: null, ack: null };
    const cur = S.st;
    if (d.t) S.offset = d.t - Date.now();
    S.st = { ...cur, online: cur.online || !!d.online,           // сообщения шлёт сервер только по данным живого ПК
      state: d.state ? newer(d.state, cur.state) : cur.state, ack: d.ack ? newer(d.ack, cur.ack) : cur.ack };
    S.err = null; paint();
  }
  function onStreamMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || m.name !== 'state') return;
    let d = m.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (d && typeof d === 'object') applyMsg(d);
  }
  function closeStream() { clearTimeout(S.rtT); if (S.es) { S.es.close(); S.es = null; } S.live = false; }
  async function openStream() {
    closeStream();
    if (!S.running) return;
    const dev = S.dev;
    let info;
    try { info = await api('GET', 'control', 'realtime', { query: `&d=${encodeURIComponent(dev)}` }); } catch (e) {
      if (e.status === 401 || e.status === 404) return;            // recheck уже разберётся
      startFallback(10000, false);
      S.rtT = setTimeout(openStream, S.backoff = Math.min(60000, S.backoff * 2));
      return;
    }
    if (!S.running || dev !== S.dev) return;
    if (!info.enabled) return startFallback(3000, false);          // без Ably: опрос раз в 3 с, ПК в это время отвечает чаще
    const es = new EventSource(info.url);
    S.es = es;
    es.onopen = () => {
      S.live = true; S.backoff = 2000; stopFallback();
      if (Date.now() - S.lastCheck > 8000) recheck();              // пока потока не было, могли пропустить события
    };
    es.addEventListener('message', (e) => onStreamMessage(e.data));
    es.addEventListener('error', () => {
      S.live = false;
      startFallback(30000, true);                                  // потока нет: раз в 30 с спрашиваем ПК напрямую
      if (es.readyState === 2) {                                   // браузер сдался (токен истёк и т. п.): берём новый токен
        clearTimeout(S.rtT); S.rtT = setTimeout(openStream, S.backoff = Math.min(60000, S.backoff * 2));
      }
    });
    // токен живёт час: за две минуты до конца переподключаемся с новым
    S.rtT = setTimeout(openStream, Math.max(30000, info.expires - Date.now() - 120000));
  }
  function startFallback(ms, check) {
    if (S.fb && S.fb.ms === ms && S.fb.check === check) return;
    stopFallback(); S.fb = { ms, check }; S.pollT = setTimeout(pollTick, ms);
  }
  function stopFallback() { clearTimeout(S.pollT); S.fb = null; }
  async function pollTick() {
    if (!S.running || S.live || !S.fb) return;
    if (!document.hidden) {
      try { await fetchStatus(S.fb.check); if (++S.polls % 20 === 0) refreshMe(); } catch (e) { if (statusFailed(e)) return; }
      paint();
    }
    if (S.running && !S.live && S.fb) S.pollT = setTimeout(pollTick, S.fb.ms);
  }
  document.addEventListener('visibilitychange', () => {
    if (!S.running) return;
    if (document.hidden) { closeStream(); stopFallback(); return; }   // свёрнутый телефон не держит соединений
    recheck(); openStream();
  });

  function emptyView() {
    stopPolling();
    render(h('section', { class: 'wrap' },
      h('header', { class: 'top' }, h('h1', { text: 'Нет подключённых ПК' }),
        h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Настройки', onclick: openSettings }, iconGear())),
      steps(), codeForm()));
  }

  // ---------- настройки ----------
  async function openSettings() {
    for (;;) {
      const r = await modal((close) => settingsNode(close));
      if (r === 'again') continue;
      if (r === 'out') return start();
      break;
    }
    await refreshMe(); panelView();
  }
  function settingsNode(close) {
    const me = S.me;
    const again = async () => { await refreshMe(); close('again'); };
    const devRows = me.devices.map((d) => h('div', { class: 'row' },
      h('span', {}, h('strong', { text: d.name }), h('span', { class: 'muted small', text: d.online ? '  в сети' : '  не в сети' })),
      h('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: async () => {
        const ok = await withPin(`Удалить «${d.name}»?`, 'Программа на ПК отключится от аккаунта. Введите PIN.', (pin) => api('POST', 'account', 'removeDevice', { body: { device: d.id, pin } }));
        if (ok) { toast('ПК удалён'); await again(); }
      } })));
    const sessRows = me.sessions.map((s) => h('div', { class: 'row' },
      h('span', {}, h('strong', { text: s.label }), h('span', { class: 'muted small', text: s.current ? '  этот телефон' : `  с ${fmtTime(s.created)}` })),
      !s.current && h('button', { class: 'btn small', type: 'button', text: 'Отключить', onclick: async () => {
        const ok = await withPin('Отключить телефон?', 'Введите PIN.', (pin) => api('POST', 'account', 'revoke', { body: { sid: s.id, pin } }));
        if (ok) { toast('Телефон отключён'); await again(); }
      } })));
    const others = me.sessions.filter((s) => !s.current).length;

    return h('div', { class: 'dlg' },
      h('h2', { text: 'Настройки' }),
      h('div', { class: 'sec' }, h('h2', { text: 'Мои ПК' }), devRows.length ? devRows : h('p', { class: 'muted', text: 'Пока пусто.' }),
        h('p', { class: 'muted small', text: 'Новый ПК: запустите на нём программу и отсканируйте QR. Ещё один телефон: в программе на ПК нажмите «Подключить телефон».' })),
      h('div', { class: 'sec' }, h('h2', { text: 'Телефоны' }), sessRows,
        others > 1 && h('button', { class: 'btn small', type: 'button', text: 'Отключить все остальные', onclick: async () => {
          const ok = await withPin('Отключить все остальные телефоны?', 'Введите PIN.', (pin) => api('POST', 'account', 'revoke', { body: { sid: 'others', pin } }));
          if (ok) { toast('Остальные телефоны отключены'); await again(); }
        } })),
      h('div', { class: 'sec' }, h('h2', { text: 'Безопасность' }),
        h('button', { class: 'btn small', type: 'button', text: 'Сменить PIN', onclick: async () => { if (await changePinDlg()) await again(); } })),
      h('div', { class: 'sec' }, h('h2', { text: 'Аккаунт' }),
        h('button', { class: 'btn small', type: 'button', text: 'Выйти на этом телефоне', onclick: async () => {
          try { await api('POST', 'account', 'logout'); close('out'); } catch (e) { toast(e.message); }
        } }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Удалить аккаунт и все данные', onclick: async () => {
          if (!(await confirmDlg({ title: 'Удалить аккаунт?', text: 'Все ПК и телефоны будут отключены, данные удалены без возможности восстановления.', ok: 'Продолжить', danger: true }))) return;
          const ok = await withPin('Подтвердите удаление', 'Введите PIN.', (pin) => api('POST', 'account', 'deleteAccount', { body: { pin } }));
          if (ok) { toast('Аккаунт удалён'); close('out'); }
        } })),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', text: 'Готово', onclick: () => close(null) })));
  }
  function changePinDlg() {
    return modal((close) => {
      const mk = (label, ac) => h('input', { class: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '12', autocomplete: ac, 'aria-label': label });
      const cur = mk('Текущий PIN', 'current-password'), n1 = mk('Новый PIN', 'new-password'), n2 = mk('Повторите новый PIN', 'new-password');
      const err = h('p', { class: 'error', role: 'alert' });
      const btn = h('button', { class: 'btn primary', type: 'button', text: 'Сменить PIN', onclick: async () => {
        err.textContent = '';
        if (!/^\d{6,12}$/.test(cur.value) || !/^\d{6,12}$/.test(n1.value)) { err.textContent = 'PIN: от 6 до 12 цифр'; return; }
        if (n1.value !== n2.value) { err.textContent = 'Новый PIN не совпадает'; return; }
        btn.disabled = true;
        try {
          await api('POST', 'account', 'changePin', { body: { pin: cur.value, newPin: n1.value } });
          toast('PIN изменён. Остальные телефоны отключены.'); close(true);
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      } });
      return h('div', { class: 'dlg' }, h('h2', { text: 'Смена PIN' }),
        h('label', { class: 'field' }, 'Текущий PIN', cur), h('label', { class: 'field' }, 'Новый PIN', n1), h('label', { class: 'field' }, 'Повторите новый PIN', n2), err,
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => close(null) }), btn));
    });
  }

  // ---------- запуск ----------
  window.addEventListener('hashchange', start);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  start();
})();
