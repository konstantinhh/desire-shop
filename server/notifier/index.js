// DESIRE — сервис уведомлений: push в браузер, Telegram-бот, сообщения сотрудникам,
// статусы заказов, «снова в наличии», брошенные корзины, рассылки.
// Работает рядом с базой Supabase и слушает её сигналы (LISTEN desire).
import pg from 'pg';
import webpush from 'web-push';
import fs from 'node:fs';

const env = process.env;
const SITE = (env.SITE_URL || 'https://desire-store.ru').replace(/\/$/, '');
const TG_TOKEN = env.TG_TOKEN || '';
const TG_API = (env.TG_API || 'https://api.telegram.org') + '/bot' + TG_TOKEN;
const DATA_DIR = env.DATA_DIR || '/data';
const TICK_MS = +(env.TICK_MS || 5 * 60e3);
const DEFAULT_TZ = env.DEFAULT_TZ || 'Asia/Irkutsk';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
const q = (sql, params) => pool.query(sql, params);

/* ---------- VAPID-ключи для push: создаются один раз и хранятся на сервере ---------- */
const vapidFile = DATA_DIR + '/vapid.json';
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); log('VAPID keys created'); }
webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:' + (env.CONTACT_EMAIL || 'admin@desire-store.ru'), vapid.publicKey, vapid.privateKey);

/* ---------- Помощники ---------- */
const rub = n => (Math.round(n) || 0).toLocaleString('ru-RU') + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const vt = (c, z) => [c, z].filter(x => x && x !== 'Стандарт').join(', ');   // «Стандарт» — единственный вариант товаров BiWabi
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settings() { const r = await q('select data from settings where id = 1'); return r.rows[0]?.data || {}; }
function notifyCfg(s) { return { cartOn: true, cart1Hours: 3, cart2Days: 2, quietFrom: 22, quietTo: 9, stockOn: true, statusOn: true, ...(s.notify || {}) }; }
async function logN(kind, channel, ok, info) { try { await q('insert into notif_log (kind, channel, ok, info) values ($1,$2,$3,$4)', [kind, channel, ok, String(info || '').slice(0, 300)]); } catch (e) { log('log fail', e.message); } }

async function tg(method, body) {
  if (!TG_TOKEN) throw new Error('TG_TOKEN not set');
  const r = await fetch(TG_API + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!j.ok) { const e = new Error(j.description || 'telegram error'); e.code = j.error_code; throw e; }
  return j.result;
}
const tgText = (chat, html, url, button = 'Открыть магазин') =>
  tg('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(url ? { reply_markup: { inline_keyboard: [[{ text: button, url }]] } } : {}) });

/* Отправить одному подписчику. msg = { title, body, url, button, tag } */
async function sendTo(sub, msg, kind) {
  try {
    if (sub.kind === 'push') {
      await webpush.sendNotification(sub.push, JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || SITE, tag: msg.tag }), { TTL: 3 * 86400 });
    } else {
      await tgText(sub.tg_chat, `<b>${esc(msg.title)}</b>\n${esc(msg.body)}`, msg.url || SITE, msg.button);
    }
    if (sub.fails) await q('update subscribers set fails = 0 where id = $1', [sub.id]);
    await logN(kind, sub.kind, true);
    return true;
  } catch (e) {
    const gone = sub.kind === 'push' ? [404, 410].includes(e.statusCode) : e.code === 403;   // отписался / заблокировал бота
    if (gone) await q('delete from subscribers where id = $1', [sub.id]);
    else await q('update subscribers set fails = fails + 1 where id = $1', [sub.id]);
    await logN(kind, sub.kind, false, (gone ? 'gone: ' : '') + (e.statusCode || e.code || '') + ' ' + e.message);
    return false;
  }
}
async function sendMany(subs, msg, kind) {
  let ok = 0, fail = 0;
  for (const s of subs) { (await sendTo(s, msg, kind)) ? ok++ : fail++; if (s.kind === 'tg') await sleep(60); }   // Telegram: не больше ~20 сообщений в секунду
  return { ok, fail };
}
async function staffSay(html, url) {
  const r = await q('select chat_id from staff_chats');
  for (const { chat_id } of r.rows) {
    try { await tgText(chat_id, html, url, 'Открыть панель'); await logN('staff', 'tg', true); }
    catch (e) { if (e.code === 403) await q('delete from staff_chats where chat_id = $1', [chat_id]); await logN('staff', 'tg', false, e.message); }
  }
}
const subsForOrder = o => q(`select * from subscribers where $1::uuid = any(tokens) or ($2::text is not null and dev = $2)`, [o.token, o.data?.dev || null]).then(r => r.rows);
const getOrder = id => q('select * from orders where id = $1', [id]).then(r => r.rows[0]);
const productName = (p) => p?.data?.name || p?.id || '';

/* ---------- Сигналы из базы ---------- */
const STATUS_MSG = {
  paid: ['Оплата получена', 'Заказ {id} оплачен — начинаем собирать.'],
  assembling: ['Заказ собирается', 'Заказ {id} собираем и скоро отправим.'],
  shipped: ['Заказ отправлен', 'Заказ {id} передан в доставку{track}. Придёт уведомление, когда он будет в пункте выдачи.'],
  done: ['Спасибо за покупку!', 'Заказ {id} получен. Будем рады вашему отзыву — его можно оставить в заказе.'],
  cancelled: ['Заказ отменён', 'Заказ {id} отменён. Если это ошибка — напишите нам.'],
};
async function onOrderNew(id) {
  const o = await getOrder(id); if (!o) return;
  const d = o.data || {}, c = d.customer || {}, dl = d.delivery || {};
  const items = (d.items || []).map(i => `• ${esc(i.name)} — ${esc(vt(i.color, i.size))} × ${i.qty}${i.gift ? ' (подарок)' : ''}`).join('\n');
  await staffSay(`🛍 <b>Новый заказ ${esc(id)}</b> · ${rub(d.total)}\n${esc(c.name)}, ${esc(dl.city)} (${dl.service === 'ozon' ? 'Ozon' : 'СДЭК'})\n${items}\n\nЖдёт оплату по QR.`, SITE + '/#admin');
}
async function onOrderPaid(id) {
  const o = await getOrder(id); if (!o) return;
  await staffSay(`💳 <b>«Я оплатил» — ${esc(id)}</b> · ${rub(o.data?.total)}\nПроверьте поступление и подтвердите оплату в панели.`, SITE + '/#admin');
}
async function onOrderStatus(id, status) {
  const cfg = notifyCfg(await settings()); if (!cfg.statusOn) return;
  const t = STATUS_MSG[status]; if (!t) return;
  const o = await getOrder(id); if (!o) return;
  const track = o.data?.track ? `, трек-номер ${o.data.track}` : '';
  const msg = { title: t[0], body: t[1].replace('{id}', id).replace('{track}', track), url: `${SITE}/#order=${encodeURIComponent(id)}`, button: 'Открыть заказ', tag: 'order-' + id };
  const subs = await subsForOrder(o);
  if (subs.length) await sendMany(subs, msg, 'status');
}
async function onProduct(id) {
  const cfg = notifyCfg(await settings()); if (!cfg.stockOn) return;
  const p = (await q('select * from products where id = $1', [id])).rows[0]; if (!p) return;
  const stock = p.data?.stock || {};
  const w = await q(`select * from wishes where pid = $1 and status = 'new' and dev is not null`, [id]);
  for (const wish of w.rows) {
    if (!((stock[wish.color + '|' + wish.size] || 0) > 0)) continue;
    const subs = (await q('select * from subscribers where dev = $1', [wish.dev])).rows;
    if (!subs.length) continue;
    const r = await sendMany(subs, { title: 'Снова в наличии', body: `${productName(p)} — ${vt(wish.color, wish.size)}. Успейте заказать!`, url: `${SITE}/#p=${encodeURIComponent(id)}`, button: 'Посмотреть', tag: 'stock-' + id }, 'stock');
    if (r.ok) await q(`update wishes set status = 'auto' where id = $1`, [wish.id]);
  }
}
async function onBroadcast(id) {
  const b = (await q(`update broadcasts set status = 'sending' where id = $1 and status = 'new' returning *`, [id])).rows[0]; if (!b) return;
  const subs = (await q('select * from subscribers where news')).rows;
  const r = await sendMany(subs, { title: b.title, body: b.body, url: b.url || SITE, button: 'Смотреть', tag: 'news-' + id }, 'news');
  await q(`update broadcasts set status = 'sent', sent = $2, failed = $3 where id = $1`, [id, r.ok, r.fail]);
  log('broadcast', id, r);
}

/* ---------- Брошенные корзины: проверка каждые 5 минут ---------- */
function localHour(tz) { try { return +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz || DEFAULT_TZ }).format(new Date()) % 24; } catch { return localHour(DEFAULT_TZ); } }
const quiet = (h, from, to) => from > to ? (h >= from || h < to) : (h >= from && h < to);
async function cartTick() {
  const cfg = notifyCfg(await settings());
  await q(`delete from carts where updated_at < now() - interval '14 days'`);
  if (!cfg.cartOn) return;
  const r = await q(`select c.* from carts c where exists (select 1 from subscribers s where s.dev = c.dev)
    and ((c.r1 is null and c.updated_at < now() - make_interval(mins => $1)) or (c.r1 is not null and c.r2 is null and c.updated_at < now() - make_interval(days => $2) and c.r1 < now() - interval '12 hours'))`,
    [Math.round(cfg.cart1Hours * 60), cfg.cart2Days]);
  for (const c of r.rows) {
    // Уже купил после того, как положил в корзину — напоминать не нужно
    const bought = await q(`select 1 from orders where data->>'dev' = $1 and created_at > $2::timestamptz - interval '10 minutes' limit 1`, [c.dev, c.updated_at]);
    if (bought.rowCount) { await q('delete from carts where dev = $1', [c.dev]); continue; }
    if (quiet(localHour(c.tz), cfg.quietFrom, cfg.quietTo)) continue;   // ночью не беспокоим — дождёмся утра
    const first = !c.r1;
    const ids = [...new Set(c.items.map(i => i.pid))];
    const prods = Object.fromEntries((await q('select id, data from products where id = any($1)', [ids])).rows.map(p => [p.id, p]));
    const avail = c.items.filter(i => prods[i.pid] && !prods[i.pid].data?.hidden && ((prods[i.pid].data?.stock || {})[i.color + '|' + i.size] || 0) > 0);
    await q(`update carts set ${first ? 'r1' : 'r2'} = now() where dev = $1`, [c.dev]);
    if (!avail.length) continue;                                          // всё раскупили — не дразним
    const names = avail.slice(0, 3).map(i => `${productName(prods[i.pid])} (${vt(i.color, i.size)})`).join(', ') + (avail.length > 3 ? ` и ещё ${avail.length - 3}` : '');
    const msg = first
      ? { title: 'Вы оставили вещи в корзине', body: `${names}. Размеры заканчиваются — оформите, пока есть в наличии.` }
      : { title: 'Ещё думаете?', body: `${names} всё ещё ждут вас в корзине. Если есть вопрос по размеру — напишите нам, подскажем.` };
    const subs = (await q('select * from subscribers where dev = $1', [c.dev])).rows;
    await sendMany(subs, { ...msg, url: SITE + '/#cart', button: 'Открыть корзину', tag: 'cart' }, first ? 'cart1' : 'cart2');
  }
  await q(`delete from notif_log where ts < now() - interval '180 days'`);
}

/* ---------- Telegram: привязка по /start КОД ---------- */
let tgOffset = 0, botName = '';
async function tgLoop() {
  if (!TG_TOKEN) { log('TG_TOKEN не задан — Telegram выключен'); return; }
  try { const me = await tg('getMe', {}); botName = me.username; log('bot @' + botName); } catch (e) { log('getMe failed:', e.message); }
  await q(`insert into notifier_info (id, vapid, bot, seen_at) values (1, $1, $2, now()) on conflict (id) do update set vapid = $1, bot = $2, seen_at = now()`, [vapid.publicKey, botName || null]);
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset: tgOffset, timeout: 50, allowed_updates: ['message'] });
      for (const u of ups) { tgOffset = u.update_id + 1; await onTgMessage(u.message).catch(e => log('tg msg', e.message)); }
    } catch (e) { log('getUpdates', e.message); await sleep(e.code === 409 ? 30e3 : 5e3); }
  }
}
async function onTgMessage(m) {
  if (!m?.text || m.chat?.type !== 'private') return;
  const chat = m.chat.id, text = m.text.trim();
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ');
  if (text === '/stop') {
    await q('delete from subscribers where tg_chat = $1', [chat]); await q('delete from staff_chats where chat_id = $1', [chat]);
    return tgText(chat, 'Уведомления отключены. Включить снова можно в магазине: Профиль → Уведомления.');
  }
  const code = (text.match(/^\/start\s+([A-Za-z0-9_-]{8,80})$/) || [])[1];
  if (!code) return tgText(chat, 'Здравствуйте! Это бот магазина DESIRE. Чтобы получать уведомления о заказах и новинках, нажмите «Получать в Telegram» в магазине (Профиль → Уведомления).', SITE);
  const l = (await q('delete from tg_links where code = $1 and created_at > now() - interval \'1 day\' returning *', [code])).rows[0];
  if (!l) return tgText(chat, 'Ссылка устарела. Откройте магазин и нажмите «Получать в Telegram» ещё раз.', SITE);
  if (l.staff) {
    await q('insert into staff_chats (chat_id, name) values ($1, $2) on conflict (chat_id) do update set name = $2', [chat, name]);
    return tgText(chat, '✅ Готово! Сюда будут приходить новые заказы и отметки «Я оплатил». Отключить: /stop');
  }
  await q(`insert into subscribers (dev, kind, tg_chat, news, tokens) values ($1, 'tg', $2, $3, $4)
    on conflict (dev, kind) do update set tg_chat = $2, news = $3, fails = 0, tokens = (select coalesce(array_agg(distinct t), '{}') from unnest(subscribers.tokens || $4::uuid[]) t)`,
    [l.dev, chat, l.news, l.tokens]);
  return tgText(chat, `✅ Готово, ${esc(m.from?.first_name || 'спасибо')}! Здесь будут статусы ваших заказов${l.news ? ', новинки и акции DESIRE' : ''}. Отключить: /stop`, SITE, 'В магазин');
}

/* ---------- Запуск ---------- */
async function listen() {
  for (;;) {
    const c = new pg.Client({ connectionString: env.DATABASE_URL });
    try {
      await c.connect(); await c.query('LISTEN desire'); log('listening');
      const queue = []; let busy = false;
      const run = async () => {
        if (busy) return; busy = true;
        while (queue.length) {
          const m = queue.shift();
          try {
            if (m.t === 'order_new') await onOrderNew(m.id);
            else if (m.t === 'order_paid') await onOrderPaid(m.id);
            else if (m.t === 'order_status') await onOrderStatus(m.id, m.status);
            else if (m.t === 'product') await onProduct(m.id);
            else if (m.t === 'broadcast') await onBroadcast(m.id);
          } catch (e) { log('event', m.t, e.message); }
        }
        busy = false;
      };
      c.on('notification', n => { try { queue.push(JSON.parse(n.payload)); run(); } catch {} });
      await new Promise((_, rej) => { c.on('error', rej); c.on('end', () => rej(new Error('connection ended'))); });
    } catch (e) { log('listen error:', e.message); try { await c.end(); } catch {} await sleep(5e3); }
  }
}
async function main() {
  for (let i = 0; ; i++) { try { await q('select 1 from notifier_info limit 1'); break; } catch (e) { log('waiting for db:', e.message); await sleep(5e3); } }
  await q(`insert into notifier_info (id, vapid, seen_at) values (1, $1, now()) on conflict (id) do update set vapid = $1, seen_at = now()`, [vapid.publicKey]);
  // Рассылки, которые не успели уйти (например, сервис перезапускался)
  for (const b of (await q(`update broadcasts set status = 'new' where status = 'sending' returning id`)).rows) onBroadcast(b.id).catch(e => log(e.message));
  for (const b of (await q(`select id from broadcasts where status = 'new'`)).rows) onBroadcast(b.id).catch(e => log(e.message));
  listen(); tgLoop();
  const tick = () => cartTick().catch(e => log('cartTick', e.message));
  setTimeout(tick, 15e3); setInterval(tick, TICK_MS);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
export { cartTick, onOrderNew, onOrderPaid, onOrderStatus, onProduct, onBroadcast, onTgMessage, quiet, localHour, pool, vapid };
