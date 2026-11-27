{
const APP_VERSION = '2.5.1';
/* ===== Хранилище: без config.js — в браузере (тест), с config.js — база Supabase на сервере ===== */
const KEY = 'desire_db_v1', CK = 'desire_cart_v1', FK = 'desire_fav_v1', MK = 'desire_my_v1';
const mem = {};
const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : (mem[k] ?? null); } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
const clone = o => JSON.parse(JSON.stringify(o));
let DB = ls.get(KEY);
if (!DB || DB.v !== SEED.v) DB = clone(SEED);
// Новые настройки подставляются из исходных, если в сохранённых их ещё нет
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
function withDefaults(cur, def) { const out = isObj(cur) ? { ...cur } : {}; for (const k in def) { if (isObj(def[k])) out[k] = withDefaults(out[k], def[k]); else if (out[k] === undefined) out[k] = def[k]; } return out; }
DB.settings = withDefaults(DB.settings, SEED.settings); if (!DB.reviews) DB.reviews = []; if (!DB.wishes) DB.wishes = [];
let reviewsOn = true, bonusOn = true, bonusBal = 0;
let cart = ls.get(CK) || [], favs = ls.get(FK) || [], myOrders = ls.get(MK) || [];
let staff = false;
/* ===== Общая база Supabase. Если config.js пустой — всё хранится локально в браузере ===== */
const CFG = window.DESIRE_CONFIG || {};
const SB = CFG.supabaseUrl && CFG.supabaseKey && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;
let loading = !!SB, loadErr = '', myRemote = [], synced = null, syncT;
let myTokens = ls.get('desire_tokens_v1') || [];
/* Постоянный анонимный номер устройства: по нему приходят уведомления и напоминания о корзине */
let DEV = ls.get('desire_dev'); if (!DEV) { DEV = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); ls.set('desire_dev', DEV); }
let NOTI = { vapid: '', bot: '' }, notifOn = ls.get('desire_notif') || false, cartSyncT;
const userTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
function syncCart() {
  if (!SB || !notifOn) return; clearTimeout(cartSyncT);
  cartSyncT = setTimeout(() => SB.rpc('save_cart', { p_dev: DEV, p_items: cart.map(i => ({ pid: i.pid, color: i.color, size: i.size, qty: i.qty })), p_tz: userTz() }).then(() => {}, () => {}), 2500);
}
if (SB) DB = { v: SEED.v, products: [], categories: SEED.categories, promos: [], campaigns: [], orders: [], reviews: [], events: [], wishes: [], settings: clone(SEED.settings) };
const pubSettings = () => { const s = clone(DB.settings); delete s.pin; return s; };
const mapJson = arr => Object.fromEntries(arr.map(x => [x.id, JSON.stringify(x)]));
const snapOf = () => ({ products: mapJson(DB.products), promos: mapJson(DB.promos), campaigns: mapJson(DB.campaigns), settings: JSON.stringify(pubSettings()), orders: Object.fromEntries(DB.orders.map(o => [o.id, o.status])) });
const rowToOrder = r => ({ ...r.data, id: r.id, status: r.status, paidClaimed: r.paid_claimed, date: r.data.date || Date.parse(r.created_at), bonusSpent: r.bonus_spent ?? r.data.bonusSpent ?? 0, bonusEarned: r.bonus_earned ?? 0 });
const seedIdx = id => SEED.products.findIndex(p => p.id === id);
async function loadRemote(withOrders) {
  const q = t => SB.from(t).select('id,data');
  const [p, pr, c, s] = await Promise.all([q('products'), q('promos'), q('campaigns'), SB.from('settings').select('data').eq('id', 1).maybeSingle()]);
  const err = p.error || pr.error || c.error || s.error; if (err) throw err;
  DB.products = p.data.map(r => r.data).sort((a, b) => seedIdx(a.id) - seedIdx(b.id));
  DB.promos = pr.data.map(r => r.data); DB.campaigns = c.data.map(r => r.data);
  if (s.data) DB.settings = withDefaults(s.data.data, SEED.settings);
  const rv = await SB.from('reviews').select('id,pid,data,status,created_at').order('created_at', { ascending: false });
  if (rv.error) { reviewsOn = false; DB.reviews = []; } else { reviewsOn = true; DB.reviews = rv.data.map(r => ({ ...r.data, id: r.id, pid: r.pid, status: r.status })); }
  if (withOrders) { const o = await SB.from('orders').select('*').order('created_at', { ascending: true }); if (o.error) throw o.error; DB.orders = o.data.map(rowToOrder); }
  synced = snapOf();
}
async function loadBonus() {
  if (!SB) { bonusBal = DB.orders.filter(o => myOrders.includes(o.id)).reduce((a, o) => a + (o.status === 'done' ? o.bonusEarned || 0 : 0) - (o.status !== 'cancelled' ? o.bonusSpent || 0 : 0), 0); return; }
  if (!myTokens.length) { bonusBal = 0; return; }
  const { data, error } = await SB.rpc('my_bonus', { p_tokens: myTokens.map(t => t.token) });
  if (error) { bonusOn = false; bonusBal = 0; } else { bonusOn = true; bonusBal = Math.max(0, +data || 0); }
}
async function loadMine() {
  if (!myTokens.length) return;
  const { data, error } = await SB.rpc('my_orders', { p_tokens: myTokens.map(t => t.token) });
  if (!error) myRemote = data.map(rowToOrder).map(o => ({ ...o, token: myTokens.find(t => t.id === o.id)?.token }));
}
async function sbSync() {
  if (!synced) return;
  const now = snapOf(), ops = [];
  for (const t of ['products', 'promos', 'campaigns']) {
    const changed = DB[t].filter(x => now[t][x.id] !== synced[t][x.id]);
    // Отправляем только изменённые поля поверх свежей версии из базы — чтобы не затереть то,
    // что за это время поменяли на сервере или с другого телефона (фото, параметры, остатки).
    const up = await Promise.all(changed.map(async x => {
      const old = synced[t][x.id] ? JSON.parse(synced[t][x.id]) : null;
      if (!old) return { id: x.id, data: x };
      const { data: row } = await SB.from(t).select('data').eq('id', x.id).maybeSingle();
      if (!row) return { id: x.id, data: x };
      const merged = { ...row.data };
      for (const k of new Set([...Object.keys(old), ...Object.keys(x)])) {
        if (JSON.stringify(old[k]) === JSON.stringify(x[k])) continue;
        if (k === 'stock' && x.stock && old.stock) { merged.stock = { ...(row.data.stock || {}) }; for (const sk of new Set([...Object.keys(old.stock), ...Object.keys(x.stock)])) if (old.stock[sk] !== x.stock[sk]) { if (sk in x.stock) merged.stock[sk] = x.stock[sk]; else delete merged.stock[sk]; } }
        else if (k in x) merged[k] = x[k]; else delete merged[k];
      }
      Object.assign(x, merged); for (const k of Object.keys(x)) if (!(k in merged)) delete x[k];
      return { id: x.id, data: merged };
    }));
    const del = Object.keys(synced[t]).filter(id => !(id in now[t]));
    if (up.length) ops.push(SB.from(t).upsert(up));
    if (del.length) ops.push(SB.from(t).delete().in('id', del));
  }
  if (now.settings !== synced.settings) ops.push(SB.from('settings').upsert({ id: 1, data: pubSettings() }));
  for (const o of DB.orders) if (o.id in synced.orders && synced.orders[o.id] !== o.status) ops.push(SB.from('orders').update({ status: o.status }).eq('id', o.id));
  const res = await Promise.all(ops), bad = res.find(r => r.error);
  if (bad) { toast('Не сохранилось в базе: ' + (bad.error.message || 'ошибка')); return false; }
  synced = snapOf(); return true;
}
async function uploadPhoto(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob(), path = Date.now() + '-' + uid() + '.jpg';
  const { error } = await SB.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return SB.storage.from('photos').getPublicUrl(path).data.publicUrl;
}
const save = () => {
  if (SB) { clearTimeout(syncT); syncT = setTimeout(sbSync, 250); return; }
  if (!ls.set(KEY, DB)) toast('Память браузера заполнена — уменьшите количество загруженных фото');
};
const saveCart = () => { ls.set(CK, cart); renderTabs(); syncCart(); };

/* ===== Аналитика: анонимные события воронки (без имён и телефонов) ===== */
const sstore = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
let SID = sstore.get('desire_sid'); const newSession = !SID; if (!SID) { SID = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); sstore.set('desire_sid', SID); }
function detectSource() {
  const q = new URLSearchParams(location.search), ref = document.referrer || '', ua = navigator.userAgent || '';
  const utm = q.get('utm_source');
  if (utm) return { src: utm.slice(0, 40), medium: (q.get('utm_medium') || '').slice(0, 40), campaign: (q.get('utm_campaign') || '').slice(0, 60) };
  if (/instagram/i.test(ref) || /Instagram/i.test(ua)) return { src: 'ig', medium: 'social', campaign: '' };
  if (/t\.me|telegram/i.test(ref) || /Telegram/i.test(ua)) return { src: 'tg', medium: 'social', campaign: '' };
  if (/yandex|google|bing|mail\.ru/i.test(ref)) return { src: 'search', medium: 'organic', campaign: '' };
  if (ref && !ref.includes(location.host)) { try { return { src: new URL(ref).hostname.slice(0, 40), medium: 'referral', campaign: '' }; } catch {} }
  return null;
}
const visitSrc = detectSource();
let firstSrc = ls.get('desire_src');
if (visitSrc && (!firstSrc || Date.now() - firstSrc.ts > 30 * 864e5)) { firstSrc = { ...visitSrc, ts: Date.now() }; ls.set('desire_src', firstSrc); }
const curSrc = () => (visitSrc || firstSrc || { src: 'direct' }).src;
let evQ = [], evT;
function track(type, d = {}) {
  const e = { ts: Date.now(), sid: SID, type, src: curSrc(), pid: d.pid || null, color: d.color || null, size: d.size || null, q: d.q || null, val: d.val ?? null, meta: d.meta || null };
  evQ.push(e); clearTimeout(evT); evT = setTimeout(flushEvents, 4000);
  try { if (window.ym && DB.settings.metrikaId) ym(+DB.settings.metrikaId, 'reachGoal', type); } catch {}
}
let onceSet = new Set(); const trackOnce = (type, d) => { if (onceSet.has(type)) return; onceSet.add(type); track(type, d); };
async function flushEvents() {
  if (!evQ.length || staff) { evQ = []; return; }   // действия сотрудников в статистику не попадают
  const batch = evQ.splice(0, 50);
  if (typeof SB !== 'undefined' && SB) { try { await SB.rpc('track', { p_events: batch }); } catch {} }
  else { const all = (ls.get('desire_ev_v1') || []).concat(batch).slice(-5000); ls.set('desire_ev_v1', all); }   // локальный режим: отдельно от базы, чтобы не перезаписать её
  if (evQ.length) flushEvents();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushEvents(); });

/* ===== Утилиты ===== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const uid = () => Math.random().toString(36).slice(2, 9);
const byId = id => DB.products.find(p => p.id === id);
const COLORS = { 'Бордо': '#6d1a2a', 'Бордовый': '#6d1a2a', 'Хаки': '#8a7d5a', 'Светлый хаки': '#b9ae8c', 'Шоколад': '#4a2e22', 'Шоколадный': '#4a2e22', 'Чёрный': '#111', 'Тёмно-синий': '#1d2b4f', 'Тёмно-синий сапфир': '#1b2752', 'Красный': '#d21f26', 'Меланж': '#bdbdbd', 'Белый': '#fff', 'Молочный': '#f3ede1', 'Оливковый': '#7a7a4e', 'Василёк': '#2d5fd3', 'Светлый меланж': '#dcdcdc', 'Серый меланж': '#a5a5a5', 'Голубой': '#a9cfee', 'Розовый': '#f2a7c3', 'Нежно-розовый': '#f3d3d6', 'Сливочный': '#f6efc4', 'Оливково-бежевый': '#b1a687', 'Кэмел': '#b0875a', 'Серый': '#8e8e93', 'Бежевый': '#d8c3a5', 'Графит': '#3f4045', 'Графитовый': '#3f4045', 'Серо-бежевый': '#a89c8c', 'Жёлтый': '#f4df7a', 'Кофейный': '#4b3326', 'Шоко-серый': '#5a514c', 'Слива': '#6b2f5a', 'Чёрно-молочный': 'linear-gradient(135deg,#111 50%,#f3ede1 50%)', 'Красно-молочный': 'linear-gradient(135deg,#d21f26 50%,#f3ede1 50%)', 'Голубо-молочный': 'linear-gradient(135deg,#8fb8e0 50%,#f3ede1 50%)', 'Белый с чёрным кантом': 'linear-gradient(135deg,#fff 70%,#111 70%)', 'Голубая полоска': 'repeating-linear-gradient(90deg,#9cc3ea 0 3px,#fff 3px 6px)', 'Жёлтая полоска': 'repeating-linear-gradient(90deg,#f0d76b 0 3px,#fff 3px 6px)', 'Розовая полоска': 'repeating-linear-gradient(90deg,#f0a9c6 0 3px,#fff 3px 6px)', 'Серо-шоколадный': '#5c534d', 'Синий': '#2643a8', 'Лаванда': '#b9b1df', 'Светло-серый': '#cfcfd4' };
const colorCss = c => COLORS[c] || '#c7c7cc';
const toastEl = $('#toast'); let tt;
const toast = m => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('show'), 2400); };
const IC = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  catalog: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  favorites: '<path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.6 4.5 6.8 4.5c2.1 0 3.6 1.2 5.2 3 1.6-1.8 3.1-3 5.2-3 3.2 0 5.3 3.1 4.1 6.3C19.5 15.4 12 20 12 20z"/>',
  cart: '<path d="M5 7h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.6 4.5 6.8 4.5c2.1 0 3.6 1.2 5.2 3 1.6-1.8 3.1-3 5.2-3 3.2 0 5.3 3.1 4.1 6.3C19.5 15.4 12 20 12 20z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  a_orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  a_goods: '<path d="M12 4a2 2 0 0 1 2 2c0 1-1 1.6-2 2.3L3.5 14a1.5 1.5 0 0 0 .9 2.7h15.2a1.5 1.5 0 0 0 .9-2.7L12 8.3"/>',
  a_stats: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  a_clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  a_more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'
};
const svg = (n, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}">${IC[n]}</svg>`;

/* ===== Цены, акции, остатки ===== */
const campaignFor = p => DB.campaigns.filter(c => c.active && (c.cat === p.cat || (c.productIds || []).includes(p.id))).sort((a, b) => b.percent - a.percent)[0];
const priceOf = p => { const c = campaignFor(p); return c ? Math.round(p.price * (1 - c.percent / 100) / 10) * 10 : p.price; };
const oldOf = p => { const n = priceOf(p); if (n < p.price) return p.price; return p.oldPrice > p.price ? p.oldPrice : 0; };
const stockOf = (p, c, s) => p.stock?.[c + '|' + s] ?? 0;
const totalStock = p => p.colors.reduce((a, c) => a + p.sizes.reduce((b, s) => b + stockOf(p, c, s), 0), 0);
const coverOf = (p, color) => (color && p.photos.find(f => f.color === color)?.src) || p.photos[0]?.src || '';
const visible = () => DB.products.filter(p => !p.hidden);
const priceHtml = p => { const n = priceOf(p), o = oldOf(p); return `<span class="price ${o ? 'sale' : ''}">${rub(n)}</span>${o ? `<span class="old">${rub(o)}</span>` : ''}`; };

/* ===== Доставка: расстояние от склада до города × тариф службы ===== */
const city = n => CITIES.find(c => c.n.toLowerCase() === String(n || '').trim().toLowerCase());
const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) * 1.25; };
function delivery(service, cityName, items) {
  const to = city(cityName), from = city(DB.settings.origin) || city('Иркутск');
  if (!to) return null;
  const t = DB.settings[service], d = km(from, to), qty = items.reduce((a, i) => a + i.qty, 0);
  let cost = t.base + t.perKm * d + t.perItem * Math.max(0, qty - 1) + (to.remote ? DB.settings.remoteExtra : 0);
  cost = Math.round(cost / 10) * 10;
  const allFree = items.length && items.every(i => byId(i.pid)?.freeShip);
  const fromN = +DB.settings.freeFromItems;
  let free = '';
  if (allFree) free = 'Бесплатная доставка для этих моделей';
  else if (fromN > 0 && qty >= fromN) free = `Бесплатно от ${fromN} шт.`;
  const days = service === 'ozon' ? [2 + Math.round(d / 900), 4 + Math.round(d / 800)] : [2 + Math.round(d / 1100), 3 + Math.round(d / 900)];
  return { cost: free ? 0 : cost, full: cost, free, dist: Math.round(d), days, remote: to.remote };
}

/* ===== Корзина и промокоды ===== */
let promoApplied = null;
const cartItems = () => cart.filter(i => byId(i.pid));
const subtotal = () => cartItems().reduce((a, i) => a + priceOf(byId(i.pid)) * i.qty, 0);
function promoDiscount(sum) {
  const p = promoApplied && DB.promos.find(x => x.code === promoApplied && x.active);
  if (!p || sum < (p.minSum || 0)) return 0;
  return p.type === 'percent' ? Math.round(sum * p.value / 100) : Math.min(p.value, sum);
}
function addToCart(pid, color, size, qty = 1) {
  const p = byId(pid), have = cart.find(i => i.pid === pid && i.color === color && i.size === size);
  const max = stockOf(p, color, size), cur = have ? have.qty : 0;
  if (cur + qty > max) { toast(max ? `В наличии только ${max} шт.` : 'Нет в наличии'); return false; }
  if (have) have.qty += qty; else cart.push({ pid, color, size, qty });
  saveCart(); return true;
}

/* ===== Навигация ===== */
const TABS = [['home', 'Главная'], ['catalog', 'Каталог'], ['favorites', 'Избранное'], ['cart', 'Корзина'], ['profile', 'Профиль']];
let route = 'home', catFilter = '', query = '', sortBy = 'pop';
/* Нижнее меню сотрудника: разделы панели сгруппированы по 5 кнопкам */
const ADM_GROUPS = { a_orders: ['orders'], a_goods: ['products', 'stock'], a_stats: ['stats'], a_clients: ['wishes', 'news', 'reviews'], a_more: ['promo', 'setup'] };
const ADM_NAMES = { a_orders: 'Заказы', a_goods: 'Товары', a_stats: 'Статистика', a_clients: 'Клиенты', a_more: 'Ещё' };
const ADM_SUB = { products: 'Товары', stock: 'Остатки', wishes: 'Ждут', news: 'Рассылки', reviews: 'Отзывы', promo: 'Акции', setup: 'Настройки' };
const admGroupOf = a => Object.keys(ADM_GROUPS).find(g => ADM_GROUPS[g].includes(a)) || 'a_orders';
const admLast = {};
function renderTabs() {
  if (route === 'admin' && staff) {
    const cur = admGroupOf(adm), awaiting = DB.orders.filter(o => o.status === 'awaiting').length;
    const cl = DB.wishes.filter(w => w.status === 'new').length + DB.reviews.filter(r => r.status === 'pending').length;
    const badge = { a_orders: awaiting, a_clients: cl };
    $('#tabs').innerHTML = Object.keys(ADM_GROUPS).map(g => `<button class="tab ${cur === g ? 'on' : ''}" data-admgo="${g}" aria-label="${ADM_NAMES[g]}">${svg(g)}${ADM_NAMES[g]}${badge[g] ? `<span class="cnt">${badge[g]}</span>` : ''}</button>`).join('');
    return;
  }
  const n = cartItems().reduce((a, i) => a + i.qty, 0);
  $('#tabs').innerHTML = TABS.map(([k, t]) => `<button class="tab ${route === k || (route === 'admin' && k === 'profile') ? 'on' : ''}" data-go="${k}" aria-label="${t}">${svg(k)}${t}${k === 'cart' && n ? `<span class="cnt">${n}</span>` : ''}${k === 'favorites' && favs.length ? `<span class="cnt">${favs.length}</span>` : ''}</button>`).join('');
}
function go(r) {
  if (r !== route) { if (r === 'catalog') track('catalog', { meta: { cat: catFilter || '' } }); if (r === 'cart') track('cart_view'); }
  if (r === 'profile') Promise.all([SB && myTokens.length ? loadMine() : null, loadBonus()]).then(() => route === 'profile' && render());
  if (SB && r === 'admin' && staff) loadRemote(true).then(() => route === 'admin' && render()).catch(() => toast('Не удалось обновить данные'));
  route = r; if (location.hash.slice(1) !== r) history.replaceState(null, '', '#' + r); render(); window.scrollTo({ top: 0 }); }
function render() {
  renderTabs();
  const v = $('#view');
  if (loading || loadErr) { v.innerHTML = `<div class="empty"><b>${loadErr ? 'Ошибка' : 'Загрузка…'}</b>${esc(loadErr)}</div>`; return; }
  if (SB && !DB.products.length && (route === 'home' || route === 'catalog')) { v.innerHTML = `<div class="empty"><b>Каталог ещё не загружен в базу</b>Сотрудник: Профиль → Вход для сотрудников → Настройки → «Загрузить каталог в базу»</div><div style="text-align:center"><button class="btn sec" data-go="profile">Перейти в профиль</button></div>`; v.onclick = v.oninput = v.onchange = null; return; }
  v.innerHTML = ({ home: viewHome, catalog: viewCatalog, favorites: viewFav, cart: viewCart, profile: viewProfile, admin: viewAdmin }[route] || viewHome)();
  if (route === 'admin') bindAdmin(); else v.onclick = v.oninput = v.onchange = null;
}

/* ===== Отзывы, рейтинг ===== */
const pubReviews = pid => DB.reviews.filter(r => r.pid === pid && r.status === 'published');
function ratingOf(pid) { const l = pubReviews(pid); return l.length ? { avg: l.reduce((a, r) => a + r.rating, 0) / l.length, n: l.length } : null; }
const stars = (v, size = 14) => `<span class="stars" style="--s:${size}px" aria-label="Оценка ${v} из 5">${[1, 2, 3, 4, 5].map(i => `<svg viewBox="0 0 24 24" class="${i <= Math.round(v) ? 'on' : ''}">${IC.star}</svg>`).join('')}</span>`;
/* ===== Уход за вещью: если сотрудник не заполнил — подсказка по составу ===== */
function defaultCare(p) {
  const c = ((p.comp || '') + ' ' + (p.desc || '')).toLowerCase();
  if (/шерст|мохер|ангор/.test(c)) return 'Ручная стирка или режим «шерсть» при 30 °C. Не отжимать в центрифуге, сушить в расправленном виде на горизонтальной поверхности. Не гладить — отпаривать.';
  if (/лён|лен,|лиоцелл|вискоз|тенсел/.test(c)) return 'Деликатная стирка при 30 °C, вывернув наизнанку. Отжим на низких оборотах. Гладить слегка влажной, средняя температура утюга.';
  if (/начёс|начес|плюш|утепл/.test(c)) return 'Стирка при 30 °C наизнанку, деликатный режим, жидким средством. Сушить в расправленном виде, не в сушильной машине. На начёсе со временем могут появляться небольшие катышки — это особенность ткани.';
  if (/полиэстер/.test(c) && !/хлоп/.test(c)) return 'Деликатная стирка при 30 °C, застегнув молнии. Не отбеливать. Гладить на низкой температуре через ткань.';
  return 'Стирка при 30 °C наизнанку, деликатный режим. Не отбеливать. Сушить в расправленном виде. Принт и вышивку гладить с изнанки.';
}
const careOf = p => (p.care || '').trim() || defaultCare(p);
/* ===== Связь с менеджером ===== */
const waLink = text => `https://wa.me/${(DB.settings.contacts.whatsapp || '').replace(/\D/g, '')}${text ? '?text=' + encodeURIComponent(text) : ''}`;
const tgLink = u => `https://t.me/${String(u || '').replace(/^@|^https?:\/\/t\.me\//g, '')}`;
function openContact(text) {
  const c = DB.settings.contacts;
  sheet('Написать нам', `<div class="sh-b"><p class="muted" style="margin-top:4px">Ответим на вопросы о размере, наличии и заказе.</p>
    ${c.managerTg ? `<a class="btn w" href="${esc(tgLink(c.managerTg))}" style="margin-top:6px;background:#229ED9;color:#fff">Написать в Telegram</a>` : ''}
    ${c.whatsapp ? `<a class="btn w" href="${esc(waLink(text))}" style="margin-top:10px;background:#25D366;color:#fff">Написать в WhatsApp</a>` : ''}
    ${text ? `<p class="small muted">В WhatsApp вопрос подставится сам. В Telegram напишите: «${esc(text)}»</p>` : ''}
    <div class="list" style="margin-top:14px">${c.group ? `<a class="row" href="${esc(tgLink(c.group))}"><span class="f">Telegram-группа</span><span class="muted r">общение и вопросы</span></a>` : ''}
    <a class="row" href="${esc(tgLink(c.telegram))}"><span class="f">Telegram-канал</span><span class="muted r">новинки и акции</span></a>
    <a class="row" href="https://instagram.com/${esc(c.instagram)}"><span class="f">Instagram</span><span class="muted r">@${esc(c.instagram)}</span></a></div>
    <p class="small muted">Telegram: @${esc(String(c.managerTg || '').replace(/^@/, ''))} · WhatsApp: +${esc((c.whatsapp || '').replace(/\D/g, ''))}</p></div>`);
}
/* ===== Возврат и обмен =====
   mode 'paid': акционные товары без возврата, возврат можно купить отдельно («Гарантия возврата»).
   mode 'law':  возврат 14 дней на всё, платная опция — расширенный возврат. Переключается в Настройках. */
const paidMode = () => DB.settings.returns.mode !== 'law';
const isSale = p => !!(p && oldOf(p));
const cartHasSale = () => cartItems().some(i => isSale(byId(i.pid)));  // (не используется в режиме 'paid' — гарантия на весь заказ)
const optName = () => paidMode() ? 'Гарантия возврата' : 'Возврат без забот';
const optText = () => paidMode() ? 'Любую вещь из заказа можно будет вернуть в течение 14 дней после получения.' : `${DB.settings.returns.extDays} дней на возврат вместо 7, обратную доставку оплачиваем мы. Для всех вещей в заказе, включая акционные.`;
function openReturns() {
  const r = DB.settings.returns, c = DB.settings.contacts;
  sheet('Условия возврата', `<div class="sh-b">
    ${paidMode() ? `<div class="note" style="margin-top:4px"><b>Возврат товаров не предусмотрен</b> — это позволяет нам держать такие цены.</div>
    <div class="note" style="margin-top:8px">Если вы не согласны с этим условием — добавьте при оформлении заказа <b>«Гарантию возврата» за ${rub(r.extPrice)}</b>. С ней любую вещь из заказа можно вернуть в течение 14 дней после получения.</div>` : `<div class="note" style="margin-top:4px"><b>14 дней на возврат</b> — с момента получения заказа. Касается всех вещей, в том числе купленных по акции.</div>`}
    <h3 style="margin-top:16px">${paidMode() ? 'Условия возврата по гарантии' : 'Условия'}</h3>
    <ul class="ul"><li>Вещь не носили, сохранены товарный вид, бирки и ярлыки.</li><li>Обратную доставку оплачивает покупатель.</li><li>Деньги за товар вернём в течение 10 дней после получения заявления — тем же способом, которым вы платили.</li></ul>
    <div class="note" style="margin-top:10px"><b>Вещь с браком</b> обменяем или вернём деньги в любом случае — с гарантией и без. Доставку оплачиваем мы.</div>
    <h3 style="margin-top:16px">Как вернуть</h3>
    <ol class="steps"><li><div>Напишите нам в Telegram или WhatsApp: номер заказа и какую вещь возвращаете. Пришлём адрес для отправки.</div></li><li><div>Упакуйте вещь и вложите заявление в свободной форме: ФИО, номер заказа, причина, куда вернуть деньги.</div></li><li><div>Отправьте через <b>СДЭК</b> или <b>Почту России</b> и пришлите нам трек-номер.</div></li></ol>
    ${r.extOn && !paidMode() ? `<div class="box" style="margin-top:14px"><h3>${optName()} · ${rub(r.extPrice)}</h3><p class="small muted" style="margin:0">Добавляется при оформлении заказа. ${optText()}</p></div>` : ''}
    <button class="btn w sec" style="margin-top:14px" data-contact="Здравствуйте! Хочу оформить возврат по заказу №">Написать про возврат</button></div>`);
}

/* ===== Параметры товара (замеры) ===== */
const paramsOf = p => (p.params || []).filter(r => r && (r.n || '').trim() && (r.v || '').trim());
// Пояснение про замеры: по галочке в панели; если галочку не трогали — показываем, только когда в замерах есть «×2»
const paramsNoteOn = p => typeof p.paramsNote === 'boolean' ? p.paramsNote : paramsOf(p).some(r => /[×x]\s*2/i.test(r.v));
function openParams(p) {
  const rows = paramsOf(p);
  sheet('Параметры · ' + p.name, `<div class="sh-b"><div class="list" style="margin-top:6px">
    <div class="row"><span class="f muted">Размер</span><span class="r">${esc(p.sizes.join(', '))}</span></div>
    ${rows.length ? rows.map(r => `<div class="row"><span class="f muted">${esc(r.n)}</span><span class="r">${esc(r.v)}</span></div>`).join('') : `<div class="row"><span class="f muted">Замеры</span><span class="r">${esc(p.specs || 'уточняйте у нас')}</span></div>`}
    ${p.comp ? `<div class="row"><span class="f muted">Состав</span><span class="r">${esc(p.comp)}</span></div>` : ''}</div>
    ${paramsNoteOn(p) ? '<p class="small muted">Замеры сняты с изделия в разложенном виде. «×2» — ширина изделия: умножьте на 2, чтобы получить обхват.</p>' : '<div style="height:12px"></div>'}
    <button class="btn sec w sm" data-contact="${esc(`Здравствуйте! Подскажите по размеру: ${p.name}.`)}">${svg('chat')} Подобрать размер с консультантом</button></div>`);
}

/* ===== «Сообщить о поступлении» ===== */
function openWish(p, color, size) {
  track('wish_open', { pid: p.id, color, size });
  const saved = ls.get('desire_contact') || '';
  sheet('Сообщить о поступлении', `<div class="sh-b"><p style="margin-top:4px"><b>${esc(p.name)}</b> · ${esc(color)} · ${esc(size)}</p>
    <p class="muted small">Как только появится — напишем вам. Укажите телефон для WhatsApp или ник в Telegram.</p>
    <div class="field"><label for="w_c">Телефон или @ник в Telegram</label><input class="inp" id="w_c" value="${esc(saved)}" placeholder="+7 900 123-45-67 или @ник" maxlength="60"></div>
    <button class="btn w" id="w_send">Сообщить мне</button>
    <p class="small muted">Нажимая, вы соглашаетесь с <button class="lnk" data-policy="1">политикой конфиденциальности</button>.</p></div>`, api => {
    api.el.querySelector('#w_send').onclick = async () => {
      const c = api.el.querySelector('#w_c').value.trim();
      if (c.replace(/[^\dA-Za-z]/g, '').length < 4) return toast('Укажите телефон или ник в Telegram');
      ls.set('desire_contact', c);
      const w = { pid: p.id, color, size, contact: c };
      if (SB) { const { error } = await SB.rpc('add_wish', { p_sid: SID, p_pid: p.id, p_color: color, p_size: size, p_contact: c, p_dev: DEV }); if (error) return toast('Не получилось — попробуйте позже'); }
      else { DB.wishes.push({ ...w, id: uid(), ts: Date.now(), status: 'new' }); save(); }
      track('wish', { pid: p.id, color, size }); api.close(); toast('Сообщим, как только появится'); if (SB && !notifOn) setTimeout(() => openNotify('wish'), 500);
    };
  });
}

/* ===== Уведомления: push в браузер и Telegram ===== */
async function loadNotiInfo() { if (!SB || NOTI.loaded) return; const { data } = await SB.from('notifier_info').select('vapid,bot').maybeSingle(); NOTI = { ...(data || {}), loaded: true }; }
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToU8 = b => { const s = atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); };
const tokenList = () => myTokens.map(t => t.token);
function setNotifOn(v) { notifOn = v; ls.set('desire_notif', v); if (v) { syncCart(); } }
async function openNotify(from) {
  if (!SB) return;
  await loadNotiInfo();
  const { data: st } = await SB.rpc('notif_status', { p_dev: DEV }); const S = st || { push: false, tg: false, news: true };
  if ((S.push || S.tg) !== notifOn) setNotifOn(S.push || S.tg);
  const intro = from === 'first' ? 'Расскажем первыми о новинках и скидках, а после заказа — когда он оплачен и отправлен.' : from === 'order' ? 'Сообщим, когда оплата подтвердится и заказ отправится.' : from === 'wish' ? 'Так мы напишем автоматически, как только вещь появится.' : 'Статусы заказов, «снова в наличии» и новинки — без спама.';
  const iosNeedsInstall = isIOS && !standalone;
  sheet('Уведомления', `<div class="sh-b"><p class="muted" style="margin-top:4px">${intro}</p>
    <div class="list">
      <div class="row"><span class="f"><b>Telegram</b><div class="small muted">${S.tg ? 'Подключено' : 'Сообщения от бота магазина'}</div></span>${S.tg ? '<button class="btn sm sec" data-noff="tg">Отключить</button>' : `<button class="btn sm" id="n_tg"${NOTI.bot ? '' : ' disabled'}>Подключить</button>`}</div>
      <div class="row"><span class="f"><b>Уведомления на телефоне</b><div class="small muted">${S.push ? 'Включены на этом устройстве' : iosNeedsInstall ? 'На iPhone — после установки магазина на экран «Домой»' : pushSupported() ? 'Как от обычного приложения' : 'Этот браузер не поддерживает'}</div></span>${S.push ? '<button class="btn sm sec" data-noff="push">Отключить</button>' : iosNeedsInstall ? '<button class="btn sm sec" id="n_inst">Как установить</button>' : `<button class="btn sm" id="n_push"${pushSupported() && NOTI.vapid ? '' : ' disabled'}>Включить</button>`}</div>
    </div>
    <label class="row" style="margin-top:10px;gap:10px"><input type="checkbox" id="n_news" ${S.news ? 'checked' : ''}><span class="f">Новинки и акции<div class="small muted">Не чаще пары раз в месяц</div></span></label>
    <p class="small muted">Мы не передаём ваши данные и не пишем ночью. Подробнее — в <button class="lnk" data-policy="1">политике конфиденциальности</button>.</p></div>`, api => {
    const news = () => api.el.querySelector('#n_news').checked;
    const again = () => { api.close(); setTimeout(() => openNotify(from), 320); };
    api.el.querySelector('#n_news').onchange = async () => { if (notifOn) { await SB.rpc('notif_update', { p_dev: DEV, p_news: news(), p_tokens: tokenList() }); toast('Сохранено'); } };
    const tgB = api.el.querySelector('#n_tg');
    if (tgB) tgB.onclick = async () => {
      const w = window.open('', '_blank');   // открываем окно сразу — иначе браузер заблокирует
      const { data: code, error } = await SB.rpc('tg_link', { p_dev: DEV, p_tokens: tokenList(), p_news: news() });
      if (error) { w?.close(); return toast('Не получилось — попробуйте позже'); }
      const url = `https://t.me/${NOTI.bot}?start=${code}`;
      if (w) w.location = url; else location.href = url;
      setNotifOn(true); track('notify', { meta: { ch: 'tg' } });
      toast('Нажмите «Запустить» в Telegram'); api.close();
    };
    const pB = api.el.querySelector('#n_push');
    if (pB) pB.onclick = async () => {
      try {
        const perm = await Notification.requestPermission(); if (perm !== 'granted') return toast('Уведомления запрещены в настройках браузера');
        const reg = await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(NOTI.vapid) });
        const { error } = await SB.rpc('subscribe_push', { p_dev: DEV, p_sub: sub.toJSON(), p_tokens: tokenList(), p_news: news() });
        if (error) throw error;
        setNotifOn(true); track('notify', { meta: { ch: 'push' } }); toast('Уведомления включены'); again();
      } catch (e) { toast('Не получилось включить уведомления'); }
    };
    const iB = api.el.querySelector('#n_inst'); if (iB) iB.onclick = () => { api.close(); setTimeout(openInstallGuide, 320); };
    api.el.querySelectorAll('[data-noff]').forEach(b => b.onclick = async () => {
      const kind = b.dataset.noff;
      if (kind === 'push') { try { const reg = await navigator.serviceWorker.ready; (await reg.pushManager.getSubscription())?.unsubscribe(); } catch {} }
      await SB.rpc('notif_off', { p_dev: DEV, p_kind: kind }); toast('Отключено'); again();
    });
  });
}

/* ===== Cookie, политика конфиденциальности, Яндекс Метрика ===== */
const CONSENT = 'desire_consent_v1';
function loadMetrika() {
  const id = String(DB.settings.metrikaId || '').replace(/\D/g, '');
  if (!id || window.ym || ls.get(CONSENT) !== 'all') return;
  (function (m, e, t, r, i, k, a) { m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); }; m[i].l = 1 * new Date(); k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a); })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  ym(+id, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
}
function consentBanner() {
  if (ls.get(CONSENT) || document.getElementById('cookie')) return;
  const d = document.createElement('div'); d.id = 'cookie'; d.className = 'cookie';
  d.innerHTML = `<p>Мы используем cookie и сервис Яндекс Метрика, чтобы понимать, как улучшить магазин. <button class="lnk" data-policy="1">Подробнее</button></p><div class="two"><button class="btn sm sec" data-consent="min">Только необходимые</button><button class="btn sm" data-consent="all">Принять</button></div>`;
  document.body.appendChild(d);
}
function openPolicy() {
  const L = DB.settings.legal, host = location.host;
  sheet('Политика конфиденциальности', `<div class="sh-b policy">
  <p class="muted small" style="margin-top:4px">Редакция от 27 ноября 2026 г.</p>
  <h3>1. Кто обрабатывает данные</h3><p>Оператор персональных данных — ${esc(L.name)}, ИНН ${esc(L.inn)} (далее — «мы»). Политика действует для сайта и приложения магазина DESIRE (${esc(host)}).</p>
  <h3>2. Какие данные мы получаем</h3><ul class="ul"><li>При оформлении заказа: имя и фамилия, телефон, email (если указали), город и адрес пункта выдачи, комментарий к заказу, состав и сумма заказа.</li>
  <li>При подписке «Сообщить о поступлении»: телефон или ник в Telegram.</li><li>Отзывы: имя, оценка, текст и фотографии, которые вы прислали.</li>
  <li>Обезличенные данные о посещении: какие страницы и товары открывали, шаги оформления, источник перехода, тип устройства. Они не содержат имени и телефона.</li>
  <li>Если вы приняли cookie — данные сервиса Яндекс Метрика (cookie, IP-адрес, сведения о браузере и действиях на сайте).</li></ul>
  <h3>3. Зачем</h3><ul class="ul"><li>Оформить, оплатить и доставить заказ, связаться с вами по заказу и возврату.</li><li>Начислять бонусы и показывать историю заказов.</li><li>Сообщить о поступлении товара, если вы попросили.</li><li>Улучшать магазин: понимать, какие товары интересны и где оформление неудобно.</li></ul>
  <h3>4. Основания</h3><p>Исполнение договора купли-продажи, который вы заключаете, оформляя заказ; ваше согласие — для подписки на уведомления, отзывов и аналитических cookie.</p>
  <h3>5. Кому передаём</h3><p>Только тем, без кого нельзя выполнить заказ: службам доставки (Ozon, СДЭК, Почта России) — имя, телефон и адрес пункта выдачи; банку — данные платежа. ООО «Яндекс» — данные Яндекс Метрики, если вы приняли cookie. Данные хранятся на серверах в России.</p>
  <h3>6. Сколько храним</h3><p>Данные заказов — пока это нужно для исполнения договора и по требованиям закона (бухгалтерский учёт), затем удаляем. Подписку «Сообщить о поступлении» — до уведомления или вашего отказа.</p>
  <h3>7. Ваши права</h3><p>Вы можете узнать, какие данные мы храним, попросить исправить или удалить их и отозвать согласие. Напишите на ${esc(L.email)} или в Telegram/WhatsApp магазина — ответим в течение 10 рабочих дней.</p>
  <h3>8. Cookie</h3><p>Необходимые данные (корзина, избранное, вход) хранятся в браузере вашего телефона. Аналитические cookie Яндекс Метрики включаются только с вашего согласия, его можно изменить: <button class="lnk" data-consent="reset">настроить cookie</button>.</p></div>`);
}

/* ===== Карточка товара в сетке ===== */
const cardHtml = p => {
  const o = oldOf(p), st = totalStock(p);
  return `<div class="card"><button data-open="${esc(p.id)}" aria-label="${esc(p.name)}"><div class="im"><img loading="lazy" src="${esc(coverOf(p))}" alt=""></div>
  ${!st ? '<span class="badge">Нет в наличии</span>' : o ? `<span class="badge r">−${Math.round((1 - priceOf(p) / o) * 100)}%</span>` : p.isNew ? '<span class="badge">Новинка</span>' : ''}
  <div class="b"><span class="n">${esc(p.name)}</span><span class="c">${esc(p.cat)}${(r => r ? ` · <span class="rt">★ ${r.avg.toFixed(1)} <i>(${r.n})</i></span>` : '')(ratingOf(p.id))}</span><span>${priceHtml(p)}</span>
  <span class="dots">${p.colors.slice(0, 7).map(c => `<i class="dot" style="background:${colorCss(c)}"></i>`).join('')}</span></div></button>
  <button class="fav ${favs.includes(p.id) ? 'on' : ''}" data-fav="${esc(p.id)}" aria-label="В избранное">${svg('heart')}</button></div>`;
};

/* ===== Экраны покупателя ===== */
function viewHome() {
  const camp = DB.campaigns.filter(c => c.active);
  const news = visible().filter(p => p.isNew || p.cat === 'Костюмы').slice(0, 8);
  const sale = visible().filter(p => oldOf(p)).slice(0, 8);
  const h = ['yosh', 'star'].map(byId).filter(Boolean);
  return `${installBanner(false)}<section class="hero"><div class="tx"><span class="muted small">Каталог осень–зима 2026</span><b>DESIRE</b><p>Костюмы, свитшоты и базовые вещи, которые носят каждый день. Доставка в пункты Ozon и СДЭК по всей России.</p><div><button class="btn" data-go="catalog">Смотреть каталог</button></div></div>
  <div class="ph">${h.map(p => `<button data-open="${p.id}"><img src="${esc(coverOf(p))}" alt="${esc(p.name)}"></button>`).join('')}</div></section>
  ${camp.map(c => `<div class="promo"><b>${esc(c.title)}</b><span>${esc(c.text)}</span>${c.cat ? `<button class="btn sm sec" data-cat="${esc(c.cat)}">Смотреть</button>` : ''}</div>`).join('')}
  ${SB && !notifOn && !ls.get('desire_notif_hide') ? `<div class="notibox"><span class="ni">${svg('bell')}</span><div class="f"><b>Узнавайте первыми</b><span>Новинки, скидки и статус заказа — в Telegram или уведомлениями на телефоне</span></div><button class="btn sm" data-notify="1">Подключить</button><button class="x" data-notihide="1" aria-label="Скрыть">${svg('close')}</button></div>` : ''}
  <h2>Категории</h2><div class="chips">${DB.categories.map(c => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  ${sale.length ? `<h2>Скидки</h2><div class="grid">${sale.map(cardHtml).join('')}</div>` : ''}
  <h2>Костюмы и новинки</h2><div class="grid">${news.map(cardHtml).join('')}</div>
  <section class="about"><div class="ab-tx"><span class="muted small">О нас</span><h2 style="margin:6px 0 10px">DESIRE — 13 лет с вами</h2>
  <p>Мы начинали в Иркутске и уже 13 лет одеваем девушек по всей России, которые любят удобную и красивую одежду на каждый день. Всю нашу линейку шьём сами — на собственном производстве, небольшими партиями.</p>
</div>
  <div class="ab-st"><div><b>13</b><span>лет с любимыми покупательницами</span></div><div><b>Свой</b><span>пошив всей линейки</span></div></div></section>
  <h2>Как мы работаем</h2><div class="stack3">
  <div class="box"><h3>Доставка в ПВЗ</h3><p class="muted small" style="margin:0">Ozon или СДЭК. Стоимость считается автоматически по городу. От ${DB.settings.freeFromItems} шт. — бесплатно.</p></div>
  <div class="box"><h3>Оплата по QR</h3><p class="muted small" style="margin:0">Сканируйте код в приложении любого банка — сумма подставится сама.</p></div>
  <div class="box"><h3>Помощь с размером</h3><p class="muted small" style="margin:0">Напишите нам — подскажем по посадке.</p><button class="btn sm sec" style="margin-top:10px" data-contact="">Написать</button></div>
  <div class="box"><h3>Условия возврата</h3><button class="btn sm sec" style="margin-top:6px" data-returns="1">Подробнее</button></div></div>`;
}
function viewCatalog() {
  let list = visible();
  if (catFilter) list = list.filter(p => p.cat === catFilter);
  if (query) { const q = query.toLowerCase(); list = list.filter(p => (p.name + ' ' + p.cat + ' ' + p.colors.join(' ') + ' ' + p.desc).toLowerCase().includes(q)); }
  if (sortBy === 'asc') list = [...list].sort((a, b) => priceOf(a) - priceOf(b));
  if (sortBy === 'desc') list = [...list].sort((a, b) => priceOf(b) - priceOf(a));
  return `<h1>${esc(catFilter || 'Каталог')}</h1>
  <input class="inp" id="q" type="search" placeholder="Поиск: модель, цвет, категория" value="${esc(query)}" style="margin-bottom:10px">
  <div class="chips"><button class="chip ${!catFilter ? 'on' : ''}" data-cat="">Все</button>${DB.categories.map(c => `<button class="chip ${catFilter === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 12px"><span class="muted small">${list.length} ${plural(list.length, 'модель', 'модели', 'моделей')}</span>
  <select class="inp" id="sort" style="width:auto;height:38px;font-size:14px"><option value="pop">По умолчанию</option><option value="asc" ${sortBy === 'asc' ? 'selected' : ''}>Сначала дешевле</option><option value="desc" ${sortBy === 'desc' ? 'selected' : ''}>Сначала дороже</option></select></div>
  ${list.length ? `<div class="grid">${list.map(cardHtml).join('')}</div>` : `<div class="empty"><b>Ничего не нашлось</b>Попробуйте другой запрос</div>`}`;
}
const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const m = n % 10; return n > 10 && n < 20 ? c : m > 1 && m < 5 ? b : m === 1 ? a : c; };
function viewFav() {
  const l = favs.map(byId).filter(p => p && !p.hidden);
  return `<h1>Избранное</h1>${l.length ? `<div class="grid">${l.map(cardHtml).join('')}</div>` : `<div class="empty"><b>Пока пусто</b>Нажмите на сердечко у товара, чтобы сохранить его здесь</div><div style="text-align:center"><button class="btn" data-go="catalog">В каталог</button></div>`}`;
}
function viewCart() {
  const items = cartItems();
  if (!items.length) return `<h1>Корзина</h1><div class="empty"><b>Корзина пуста</b>Добавьте вещи из каталога</div><div style="text-align:center"><button class="btn" data-go="catalog">В каталог</button></div>`;
  const sub = subtotal(), disc = promoDiscount(sub);
  const pr = promoApplied && DB.promos.find(x => x.code === promoApplied);
  return `<h1>Корзина</h1><div class="list">${items.map((i, k) => { const p = byId(i.pid); return `<div class="row"><img class="thumb" src="${esc(coverOf(p, i.color))}" alt=""><div class="f"><b>${esc(p.name)}</b><div class="muted small">${esc(i.color)} · ${esc(i.size)}</div><div>${rub(priceOf(p) * i.qty)}</div></div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px"><div class="qty"><button data-q="${k}" data-d="-1" aria-label="Меньше">−</button><span>${i.qty}</span><button data-q="${k}" data-d="1" aria-label="Больше">+</button></div><button class="small muted" data-rm="${k}">Удалить</button></div></div>`; }).join('')}</div>
  <h2>Промокод</h2><div style="display:flex;gap:8px"><input class="inp" id="promo" placeholder="Например, DESIRE10" value="${esc(promoApplied || '')}" autocapitalize="characters"><button class="btn sec" id="applyPromo">Применить</button></div>
  ${pr && !disc ? `<p class="small sale">Промокод действует от ${rub(pr.minSum)}</p>` : ''}
  <div class="box" style="margin-top:18px"><div class="sum"><span>Товары</span><span>${rub(sub)}</span></div>${disc ? `<div class="sum sale"><span>Промокод ${esc(promoApplied)}</span><span>−${rub(disc)}</span></div>` : ''}
  <div class="sum muted"><span>Доставка</span><span>рассчитаем на следующем шаге</span></div><div class="sum t"><span>Итого</span><span>${rub(sub - disc)}</span></div>
  <button class="btn w" id="checkout" style="margin-top:12px">Оформить заказ</button></div>`;
}
const STATUS = { awaiting: 'Ждёт подтверждения оплаты', paid: 'Оплачен', assembling: 'Собирается', shipped: 'Отправлен', done: 'Получен', cancelled: 'Отменён' };
function viewProfile() {
  const mine = SB ? myRemote : DB.orders.filter(o => myOrders.includes(o.id)).reverse();
  const c = DB.settings.contacts;
  const b = DB.settings.bonus;
  return `<h1>Профиль</h1>${installBanner(true)}
  ${bonusOn && b.on ? `<div class="bonus"><div><span class="small">Бонусы DESIRE</span><b>${rub(bonusBal)}</b></div><p class="small">${b.earnPct}% от суммы заказа возвращаются бонусами после получения. Бонусами можно оплатить до ${b.maxSpendPct}% следующего заказа. Бонусы хранятся в приложении на этом телефоне.</p></div>` : ''}
  <h2>Мои заказы</h2>
  ${mine.length ? `<div class="list">${mine.map(o => `<button class="row" style="width:100%;text-align:left" data-order="${esc(o.id)}"><div class="f"><b>Заказ ${esc(o.id)}</b><div class="muted small">${new Date(o.date).toLocaleDateString('ru-RU')} · ${o.items.reduce((a, i) => a + i.qty, 0)} шт. · ${esc(o.delivery.service === 'ozon' ? 'Ozon' : 'СДЭК')}</div><span class="st ${o.status}" style="margin-top:6px">${STATUS[o.status]}</span></div><span class="price">${rub(o.total)}</span></button>`).join('')}</div>` : '<p class="muted">Здесь появятся ваши заказы.</p>'}
  <h2>Связаться с нами</h2><div class="two" style="margin-bottom:10px">${c.managerTg ? `<a class="btn" href="${esc(tgLink(c.managerTg))}" style="background:#229ED9;color:#fff">Telegram</a>` : ''}${c.whatsapp ? `<a class="btn" href="${esc(waLink(''))}" style="background:#25D366;color:#fff">WhatsApp</a>` : ''}</div>
  <div class="list">
  ${c.group ? `<a class="row" href="${esc(tgLink(c.group))}"><span class="f">Telegram-группа</span><span class="muted r">общение и вопросы</span></a>` : ''}
  <a class="row" href="${esc(tgLink(c.telegram))}"><span class="f">Telegram-канал</span><span class="muted r">новинки и акции</span></a>
  <a class="row" href="https://instagram.com/${esc(c.instagram)}"><span class="f">Instagram</span><span class="muted r">@${esc(c.instagram)}</span></a></div>
  <h2>Новинки и акции</h2><div class="list"><a class="row" href="${esc(tgLink(c.telegram))}"><span class="f">Подписаться в Telegram</span><span class="muted r">первыми узнавайте о новинках</span></a>${SB ? `<button class="row" style="width:100%;text-align:left" data-notify="1"><span class="f">Уведомления о заказах и новинках</span><span class="muted small r">${notifOn ? 'включены' : 'Telegram или телефон'} ›</span></button>` : ''}</div>
  <h2>Покупателям</h2><div class="list"><div class="row"><span class="f">Доставка</span><span class="muted small r">Ozon и СДЭК, ПВЗ по всей России</span></div><div class="row"><span class="f">Оплата</span><span class="muted small r">По QR-коду через банк</span></div><div class="row"><span class="f">Удалённые регионы</span><span class="muted small r">Камчатка, Сахалин, Калининград, Крым — с доплатой</span></div><button class="row" style="width:100%;text-align:left" data-returns="1"><span class="f">Условия возврата</span><span class="muted small r">подробнее ›</span></button><button class="row" style="width:100%;text-align:left" data-policy="1"><span class="f">Политика конфиденциальности</span><span class="muted small r">›</span></button></div>
  <div style="margin-top:28px;text-align:center"><button class="btn sec" id="staffBtn">${staff ? 'Открыть панель сотрудника' : 'Вход для сотрудников'}</button><p class="small muted" style="margin-top:14px">Версия ${APP_VERSION}</p></div>`;
}

/* ===== Листы (bottom sheets) ===== */
function sheet(title, body, onMount) {
  const bg = document.createElement('div'); bg.className = 'sheetbg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sh-h"><b>${esc(title)}</b><button class="icon" data-close aria-label="Закрыть">${svg('close')}</button></div><div class="sh-c">${body}</div></div>`;
  document.body.appendChild(bg); document.body.style.overflow = 'hidden';
  const close = () => { bg.classList.remove('show'); setTimeout(() => { bg.remove(); if (!document.querySelector('.sheetbg')) document.body.style.overflow = ''; }, 300); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  requestAnimationFrame(() => bg.classList.add('show'));
  const api = { el: bg.querySelector('.sh-c'), close, set: h => { api.el.innerHTML = h; } };
  onMount && onMount(api);
  return api;
}

/* ===== Страница товара ===== */
function openProduct(id) {
  const p = byId(id); if (!p) return;
  track('product', { pid: p.id });
  let color = p.colors.find(c => p.sizes.some(s => stockOf(p, c, s) > 0)) || p.colors[0], size = p.sizes[0], qty = 1;
  sheet(p.name, '', api => {
    const draw = () => {
      const photos = [...p.photos.filter(f => f.color === color), ...p.photos.filter(f => f.color !== color)];
      const st = stockOf(p, color, size);
      api.set(`<div class="gal" id="gal">${photos.map(f => `<img src="${esc(f.src)}" alt="${esc(p.name + ' ' + f.color)}">`).join('')}</div>
      <div class="sh-b"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:16px"><h1 style="margin:0;font-size:30px">${esc(p.name)}</h1><span style="font-size:22px">${priceHtml(p)}</span></div>
      <p class="muted small" style="margin:4px 0 0">${esc(p.cat)}${p.tag ? ' · ' + esc(p.tag) : ''}${campaignFor(p) ? ' · ' + esc(campaignFor(p).title) : ''}</p>
      ${(r => r ? `<button class="rlink" data-goreviews="1">${stars(r.avg)} <b>${r.avg.toFixed(1)}</b> <span class="muted">· ${r.n} ${plural(r.n, 'отзыв', 'отзыва', 'отзывов')}</span></button>` : '')(ratingOf(p.id))}
      <h3 style="margin-top:18px">Цвет: <span class="muted">${esc(color)}</span></h3>
      <div class="sw">${p.colors.map(c => { const has = p.sizes.some(s => stockOf(p, c, s) > 0); return `<button class="swb ${c === color ? 'on' : ''}" data-color="${esc(c)}" ${has ? '' : 'data-na="1"'}><i style="background:${colorCss(c)}"></i>${esc(c)}</button>`; }).join('')}</div>
      <h3 style="margin-top:16px">Размер</h3><div class="sw">${p.sizes.map(s => `<button class="swb ${s === size ? 'on' : ''}" data-size="${esc(s)}" style="padding-left:14px" ${stockOf(p, color, s) ? '' : 'data-na="1"'}>${esc(s)}</button>`).join('')}</div>
      <p class="small ${st && st <= 2 ? 'low' : 'muted'}">${st ? (st <= 2 ? `Осталось ${st} шт.` : 'В наличии') : `Нет в наличии: ${esc(color)}, ${esc(size)}`}</p>
      ${st ? '' : `<button class="btn w blue sm" data-wish="1" style="margin-bottom:6px">Сообщить о поступлении</button>`}
      <div style="display:flex;gap:10px;align-items:center;margin:14px 0"><div class="qty"><button data-pq="-1" aria-label="Меньше">−</button><span>${qty}</span><button data-pq="1" aria-label="Больше">+</button></div>
      <button class="btn" style="flex:1" id="add" ${st ? '' : 'disabled'}>В корзину</button>
      <button class="icon fav ${favs.includes(p.id) ? 'on' : ''}" style="position:static;background:var(--fill);width:50px;height:50px;border-radius:14px" data-fav="${esc(p.id)}" aria-label="В избранное">${svg('heart')}</button></div>
      ${cart.length ? (n => `<button class="btn w sec" data-tocart="1" style="margin:-4px 0 10px">Перейти в корзину · ${n} ${plural(n, 'вещь', 'вещи', 'вещей')}</button>`)(cart.reduce((a, i) => a + i.qty, 0)) : ''}
      ${p.freeShip ? '<div class="note">Доставка этой модели — бесплатно</div>' : ''}
      <div class="two2" style="margin-top:10px"><button class="btn sec sm" data-params="1">Смотреть параметры</button><button class="btn sec sm" data-contact="${esc(`Здравствуйте! Подскажите по размеру: ${p.name}, цвет ${color}.`)}">${svg('chat')} Спросить про размер</button></div>
      <h3 style="margin-top:18px">Описание</h3><p style="margin:0 0 10px">${esc(p.desc)}</p>
      <div class="list"><div class="row"><span class="f muted">Состав</span><span class="r">${esc(p.comp)}</span></div><div class="row"><span class="f muted">Размер</span><span class="r">${esc(p.sizes.join(', '))}</span></div>${paramsOf(p).length ? '' : `<div class="row"><span class="f muted">Замеры</span><span class="r">${esc(p.specs)}</span></div>`}</div>
      <h3 style="margin-top:18px">Уход</h3><p style="margin:0 0 10px">${esc(careOf(p))}</p>
      <p class="small muted" style="margin:0 0 10px"><button class="lnk" data-returns="1">Условия возврата</button></p>
      ${reviewsHtml(p)}
      ${similar(p)}</div>`);
    };
    draw();
    api.el.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.color) { color = t.dataset.color; if (!stockOf(p, color, size)) size = p.sizes.find(s => stockOf(p, color, s)) || size; qty = 1; draw(); track(stockOf(p, color, size) ? 'select' : 'oos', { pid: p.id, color, size }); }
      else if (t.dataset.size) { size = t.dataset.size; qty = 1; draw(); track(stockOf(p, color, size) ? 'select' : 'oos', { pid: p.id, color, size }); }
      else if (t.dataset.wish) openWish(p, color, size);
      else if (t.dataset.params) { openParams(p); track('params', { pid: p.id }); }
      else if (t.dataset.pq) { qty = Math.max(1, Math.min(stockOf(p, color, size) || 1, qty + +t.dataset.pq)); draw(); }
      else if (t.id === 'add') { if (addToCart(p.id, color, size, qty)) { toast(`${p.name} · ${color} — в корзине`); track('cart_add', { pid: p.id, color, size, val: priceOf(p) * qty }); draw(); } }
      else if (t.dataset.tocart) { api.close(); setTimeout(() => go('cart'), 250); }
      else if (t.dataset.fav) { toggleFav(p.id); draw(); }
      else if (t.dataset.open) { api.close(); setTimeout(() => openProduct(t.dataset.open), 320); }
      else if (t.dataset.goreviews) api.el.querySelector('#reviews')?.scrollIntoView({ behavior: 'smooth' });
      else if (t.dataset.photo) openPhoto(t.dataset.photo);
    });
  });
}
function reviewsHtml(p) {
  if (!reviewsOn) return '';
  const l = pubReviews(p.id), r = ratingOf(p.id);
  return `<h3 id="reviews" style="margin-top:20px">Отзывы${r ? ` <span class="muted">· ${r.avg.toFixed(1)} из 5</span>` : ''}</h3>
  ${l.length ? l.slice(0, 20).map(v => `<div class="rev"><div class="rh"><b>${esc(v.name || 'Покупатель')}</b>${stars(v.rating, 13)}<span class="muted small">${new Date(v.date).toLocaleDateString('ru-RU')}</span></div>
    ${v.color || v.size ? `<div class="small muted">${esc([v.color, v.size].filter(Boolean).join(' · '))}</div>` : ''}${v.text ? `<p>${esc(v.text)}</p>` : ''}
    ${(v.photos || []).length ? `<div class="rph">${v.photos.map(src => /^data:image\/jpeg;base64,/.test(src) ? `<button data-photo="${esc(src)}"><img src="${esc(src)}" alt="Фото покупателя"></button>` : '').join('')}</div>` : ''}</div>`).join('')
    : '<p class="muted small">Пока нет отзывов. Оставить отзыв можно после получения заказа — в Профиле → Мои заказы.</p>'}`;
}
function openPhoto(src) { sheet('Фото покупателя', `<div class="sh-b"><img src="${esc(src)}" alt="" style="width:100%;border-radius:16px"></div>`); }
const similar = p => { const l = visible().filter(x => x.cat === p.cat && x.id !== p.id).slice(0, 4); return l.length ? `<h2>Из этой категории</h2><div class="grid">${l.map(cardHtml).join('')}</div>` : ''; };
function toggleFav(id) { favs = favs.includes(id) ? favs.filter(x => x !== id) : [...favs, id]; if (favs.includes(id)) track('fav', { pid: id }); ls.set(FK, favs); toast(favs.includes(id) ? 'Добавлено в избранное' : 'Убрано из избранного'); renderTabs(); if (route === 'favorites' || route === 'home' || route === 'catalog') render(); }

/* ===== Оформление заказа ===== */
// Телефон: +7 всегда на месте, номер форматируется как +7 900 123-45-67; 8 в начале отбрасывается только у вставленного 11-значного номера
function fmtPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('7')) d = d.slice(1); else if (d.length === 11 && d.startsWith('8')) d = d.slice(1);
  d = d.slice(0, 10);
  let out = '+7';
  if (d.length) out += ' ' + d.slice(0, 3);
  if (d.length > 3) out += ' ' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  if (d.length > 8) out += '-' + d.slice(8, 10);
  return d.length ? out : '+7 ';
}
const phoneOk = p => String(p || '').replace(/\D/g, '').length === 11;
function openCheckout() {
  track('checkout', { val: subtotal() });
  const f = ls.get('desire_form') || { name: '', phone: '', email: '', service: 'ozon', city: '', address: '', comment: '' };
  f.useBonus = false; f.returnCare = false;
  sheet('Оформление', '', api => {
    const calc = () => delivery(f.service, f.city, cartItems());
    const R = DB.settings.returns, B = DB.settings.bonus;
    const bonusMax = () => bonusOn && B.on ? Math.max(0, Math.min(bonusBal, Math.floor((subtotal() - promoDiscount(subtotal())) * B.maxSpendPct / 100))) : 0;
    const bonusUse = () => f.useBonus ? bonusMax() : 0;
    const optShown = () => R.extOn;
    const careFee = () => optShown() && f.returnCare ? +R.extPrice || 0 : 0;
    const xtraHtml = () => `${paidMode() ? `<p class="small muted" style="margin:0 0 6px">Возврат товаров не предусмотрен. Хотите возможность вернуть — добавьте гарантию.</p>` : ''}${optShown() ? `<label class="opt"><input type="checkbox" id="xc" ${f.returnCare ? 'checked' : ''}><span><b>${optName()} · ${rub(R.extPrice)}</b><br><span class="small muted">${optText()}</span></span></label>` : ''}
      ${bonusMax() ? `<label class="opt"><input type="checkbox" id="xb" ${f.useBonus ? 'checked' : ''}><span><b>Списать ${rub(bonusMax())} бонусами</b><br><span class="small muted">На счёте ${rub(bonusBal)}, можно оплатить до ${B.maxSpendPct}% заказа</span></span></label>` : ''}`;
    const draw = () => {
      const sub = subtotal(), disc = promoDiscount(sub), d = calc();
      api.set(`<div class="sh-b"><h2 style="margin-top:6px">Получатель</h2>
      <div class="field"><label for="fn">Имя и фамилия</label><input class="inp" id="fn" autocomplete="name" value="${esc(f.name)}"></div>
      <div class="two"><div class="field"><label for="fp">Телефон</label><input class="inp" id="fp" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 123-45-67" value="${esc(fmtPhone(f.phone))}"></div>
      <div class="field"><label for="fe">Email (необязательно)</label><input class="inp" id="fe" type="email" autocomplete="email" value="${esc(f.email)}"></div></div>
      <h2>Доставка в пункт выдачи</h2>
      <div class="seg" style="margin-bottom:12px"><button class="${f.service === 'ozon' ? 'on' : ''}" data-svc="ozon">Ozon</button><button class="${f.service === 'cdek' ? 'on' : ''}" data-svc="cdek">СДЭК</button></div>
      <div class="field"><label for="fc">Город</label><input class="inp" id="fc" autocomplete="off" placeholder="Начните вводить: Иркутск, Казань…" value="${esc(f.city)}"><div id="sug"></div></div>
      <div class="field"><label for="fa">Адрес пункта выдачи ${f.service === 'ozon' ? 'Ozon' : 'СДЭК'}</label><input class="inp" id="fa" placeholder="Улица, дом — как в приложении ${f.service === 'ozon' ? 'Ozon' : 'СДЭК'}" value="${esc(f.address)}"></div>
      <div id="dl">${dlHtml(d)}</div>
      <div class="field"><label for="fm">Комментарий</label><textarea class="inp" id="fm" placeholder="Например, нужна помощь с размером">${esc(f.comment)}</textarea></div>
      <div id="xtra">${xtraHtml()}</div>
      <div class="box" id="tot">${totHtml(sub, disc, d)}</div>
      <button class="btn w blue" id="pay" style="margin-top:14px" ${d && f.address.trim().length > 4 && f.name.trim() && phoneOk(f.phone) ? '' : 'disabled'}>Оплатить по QR-коду</button>
      <p class="muted small" style="text-align:center">Заполните имя, телефон, город и адрес ПВЗ. Оформляя заказ, вы соглашаетесь с <button class="lnk" data-returns="1">условиями возврата</button> и <button class="lnk" data-policy="1">политикой конфиденциальности</button>.</p></div>`);
    };
    const dlHtml = d => !f.city ? '' : d ? `<div class="note" style="margin-bottom:12px"><b>${d.cost ? rub(d.cost) : 'Бесплатно'}</b>${d.free ? ` <span class="muted">(${esc(d.free)}, обычно ${rub(d.full)})</span>` : ''} · ${d.days[0]}–${d.days[1]} дн. · ~${d.dist.toLocaleString('ru-RU')} км от склада${d.remote ? '<br>Удалённый регион — включена доплата' : ''}</div>` : `<div class="note" style="margin-bottom:12px">Выберите город из подсказок — так мы рассчитаем доставку</div>`;
    const totHtml = (sub, disc, d) => { const bu = bonusUse(), cf = careFee(), goods = sub - disc - bu; const earn = bonusOn && B.on ? Math.floor(goods * B.earnPct / 100) : 0;
      return `<div class="sum"><span>Товары</span><span>${rub(sub)}</span></div>${disc ? `<div class="sum sale"><span>Промокод</span><span>−${rub(disc)}</span></div>` : ''}${bu ? `<div class="sum sale"><span>Бонусы</span><span>−${rub(bu)}</span></div>` : ''}${cf ? `<div class="sum"><span>${optName()}</span><span>${rub(cf)}</span></div>` : ''}<div class="sum"><span>Доставка</span><span>${d ? (d.cost ? rub(d.cost) : 'Бесплатно') : '—'}</span></div><div class="sum t"><span>К оплате</span><span>${rub(goods + cf + (d ? d.cost : 0))}</span></div>${earn ? `<p class="small" style="margin:8px 0 0;color:var(--green)">+${rub(earn)} бонусами после получения заказа</p>` : ''}`; };
    const refresh = () => { if (!$('#tot')) return; const d = calc();
      if (f.name.trim() && phoneOk(f.phone)) trackOnce('contacts', {});
      if (d && f.address.trim().length > 4) trackOnce('delivery', { meta: { service: f.service, city: f.city } }); $('#dl').innerHTML = dlHtml(d); $('#tot').innerHTML = totHtml(subtotal(), promoDiscount(subtotal()), d); $('#pay').disabled = !(d && f.address.trim().length > 4 && f.name.trim() && phoneOk(f.phone)); ls.set('desire_form', f); };
    draw();
    loadBonus().then(() => { if (api.el.querySelector('#xtra')) { api.el.querySelector('#xtra').innerHTML = xtraHtml(); refresh(); } });
    api.el.addEventListener('focusin', e => { if (e.target.id === 'fp') setTimeout(() => { const L = e.target.value.length; try { e.target.setSelectionRange(L, L); } catch {} }); });
    api.el.addEventListener('input', e => {
      const id = e.target.id, v = e.target.value;
      if (id === 'xc') f.returnCare = e.target.checked; if (id === 'xb') f.useBonus = e.target.checked;
      if (id === 'fn') f.name = v; if (id === 'fp') { let pv = v; const k = pv.indexOf('+7'); if (k > 0) pv = '+7 ' + pv.slice(0, k) + pv.slice(k + 2); f.phone = fmtPhone(pv); e.target.value = f.phone; const L = f.phone.length; try { e.target.setSelectionRange(L, L); } catch {} } if (id === 'fe') f.email = v; if (id === 'fa') f.address = v; if (id === 'fm') f.comment = v;
      if (id === 'fc') {
        f.city = v; const q = v.trim().toLowerCase();
        const s = q ? CITIES.filter(c => c.n.toLowerCase().startsWith(q)).slice(0, 7) : [];
        $('#sug').innerHTML = s.length && !(s.length === 1 && s[0].n.toLowerCase() === q) ? `<div class="sug">${s.map(c => `<button data-city="${esc(c.n)}">${esc(c.n)}</button>`).join('')}</div>` : '';
      }
      refresh();
    });
    api.el.addEventListener('click', async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.svc) { f.service = t.dataset.svc; draw(); refresh(); }
      if (t.dataset.city) { f.city = t.dataset.city; $('#fc').value = f.city; $('#sug').innerHTML = ''; refresh(); $('#fa').focus(); }
      if (t.id === 'pay') { track('pay', { val: subtotal() }); t.disabled = true; t.textContent = 'Оформляем…'; const o = await createOrder(f, calc(), bonusUse(), careFee()); if (o) { api.close(); setTimeout(() => openPay(o), 320); } else { t.disabled = false; t.textContent = 'Оплатить по QR-коду'; } }
    });
  });
}
async function createOrder(f, d, bonusSpent = 0, careFee = 0) {
  const items = cartItems();
  for (const i of items) { const p = byId(i.pid); if (stockOf(p, i.color, i.size) < i.qty) { toast(`${p.name} ${i.color}: осталось ${stockOf(p, i.color, i.size)} шт.`); return null; } }
  const sub = subtotal(), disc = promoDiscount(sub);
  const n = 1001 + DB.orders.length;
  const o = { id: 'D-' + n, date: Date.now(), status: 'awaiting', items: items.map(i => { const p = byId(i.pid); return { pid: p.id, name: p.name, color: i.color, size: i.size, qty: i.qty, price: priceOf(p), basePrice: p.price, img: coverOf(p, i.color) }; }),
    subtotal: sub, discount: disc, promo: disc ? promoApplied : '', delivery: { service: f.service, city: f.city, address: f.address, cost: d.cost, dist: d.dist },
    customer: { name: f.name, phone: f.phone, email: f.email }, comment: f.comment, total: sub - disc - bonusSpent + careFee + d.cost, paidClaimed: false,
    sid: SID, dev: DEV, src: curSrc(), srcFirst: firstSrc?.src || '', bonusSpent, returnCare: careFee > 0, returnCarePrice: careFee, returnCareName: careFee > 0 ? optName() : '', bonusEarned: 0 };
  if (SB) {
    const { id: _drop, ...payload } = o;
    const { data, error } = await SB.rpc('place_order', bonusOn ? { p_order: payload, p_tokens: myTokens.map(t => t.token) } : { p_order: payload });
    if (error) {
      const m = /OUT_OF_STOCK:(.*)/.exec(error.message || '');
      toast(m ? `${m[1]}: столько уже нет в наличии` : /BONUS/.test(error.message || '') ? 'Бонусов недостаточно — обновите страницу' : 'Не удалось оформить заказ. Попробуйте ещё раз');
      if (m) { try { await loadRemote(false); } catch {} render(); }
      return null;
    }
    o.id = data.id; o.token = data.token;
    myTokens.push({ id: data.id, token: data.token }); ls.set('desire_tokens_v1', myTokens);
    items.forEach(i => { const p = byId(i.pid); p.stock[i.color + '|' + i.size] -= i.qty; });
    myRemote.unshift(o);
  } else {
    items.forEach(i => { const p = byId(i.pid); p.stock[i.color + '|' + i.size] -= i.qty; });
    DB.orders.push(o); save(); myOrders.push(o.id); ls.set(MK, myOrders);
  }
  cart = []; promoApplied = null; saveCart(); if (route === 'cart') render();
  return o;
}

/* ===== Оплата по QR ===== */
function qrPayload(o) {
  const p = DB.settings.pay;
  if (p.mode === 'sbp' && /^https:\/\//.test(p.sbpLink)) { const u = p.sbpLink.trim().split('?')[0] + `?type=01&sum=${Math.round(o.total * 100)}&cur=RUB`; return { text: u, link: u, demo: false }; }   // сумма в копейках — банк подставляет её сам
  const ok = p.account && p.bic && p.bank;
  const s = ['ST00012', 'Name=' + p.name, 'PersonalAcc=' + (p.account || '00000000000000000000'), 'BankName=' + (p.bank || 'ТЕСТОВЫЙ БАНК'), 'BIC=' + (p.bic || '000000000'), 'CorrespAcc=' + (p.corr || '0'), p.inn ? 'PayeeINN=' + p.inn : '', 'Sum=' + Math.round(o.total * 100), 'Purpose=Оплата заказа ' + o.id].filter(Boolean).join('|');
  return { text: s, link: '', demo: !ok };
}
/* Банки СБП: на iPhone ссылка https://qr.nspk.ru не открывает приложение банка (сертификат Минцифры не доверен в Safari),
   поэтому открываем приложение выбранного банка напрямую по его схеме bankXXXXXXXXXX:// — так делает виджет СБП. */
const SBP_BANKS = [['100000000111', 'Сбербанк', '#21a038'], ['100000000004', 'Т-Банк', '#ffdd2d'], ['110000000005', 'ВТБ', '#0a2896'], ['100000000008', 'Альфа-Банк', '#ef3124'],
  ['100000000273', 'Озон Банк', '#005bff'], ['100000000001', 'Газпромбанк', '#02356e'], ['100000000007', 'Райффайзен', '#fee600'], ['100000000013', 'Совкомбанк', '#0b1f35'],
  ['100000000150', 'Яндекс Банк', '#fc3f1d'], ['100000000259', 'ВБ Банк', '#9b26b6'], ['100000000010', 'ПСБ', '#f26126'], ['100000000017', 'МТС Банк', '#e30611'],
  ['100000000082', 'Банк ДОМ.РФ', '#1f2b66'], ['100000000025', 'МКБ', '#d2233c'], ['100000000006', 'Ак Барс', '#00843d'], ['100000000032', 'Ренессанс', '#4b2d82']];
const bankLink = (id, link) => `bank${id}://` + link.replace(/^https:\/\//, '');
function qrSvg(text) {
  try { qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']; const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
  catch { return '<p>Не удалось построить QR-код</p>'; }
}
function openPay(o) {
  const pl = qrPayload(o), mob = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !!pl.link;
  sheet('Оплата заказа ' + o.id, `<div class="sh-b" style="text-align:center"><p class="muted" style="margin:4px 0">${mob ? 'Нажмите «Оплатить» — откроется приложение вашего банка' : 'Отсканируйте код камерой или в приложении банка'}</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:-.02em">${rub(o.total)}</div>
  ${mob ? `<button class="btn w" id="payGo" style="margin:12px 0 6px">Оплатить ${rub(o.total)}</button>
  <div id="banks" hidden style="text-align:left;margin-top:6px"><p class="small muted" style="margin:4px 0 8px;text-align:center">Выберите свой банк</p><div class="list banks">${(() => { const last = ls.get('desire_bank'); const l = [...SBP_BANKS].sort((a, b) => (b[0] === last) - (a[0] === last)); return l.map(([id, n, c]) => `<a class="row" data-bank="${id}" href="${esc(bankLink(id, pl.link))}"><i class="bk" style="background:${c}">${esc(n[0])}<img src="img/banks/bank${id}.png" alt="" loading="lazy" onerror="this.remove()"></i><span class="f">${esc(n)}</span><span class="muted">›</span></a>`).join(''); })()}
  ${isAndroid ? `<a class="row" href="${esc(pl.link)}"><i class="bk" style="background:var(--muted)">…</i><span class="f">Другой банк</span><span class="muted">›</span></a>` : ''}</div></div>
  <p class="small muted" style="margin:14px 0 4px">или отсканируйте QR с другого телефона</p>` : ''}
  <div class="qrbox"${mob ? ' style="max-width:180px;margin:0 auto"' : ''}>${qrSvg(pl.text)}</div>
  ${pl.demo ? '<div class="note" style="text-align:left">Тестовый QR: реквизиты магазина ещё не заполнены в панели сотрудника. Платить по нему не нужно.</div>' : ''}
  ${pl.link && !mob ? `<a class="btn w sec" href="${esc(pl.link)}" style="margin-top:10px">Открыть в приложении банка</a>` : ''}
  ${DB.settings.pay.mode === 'sbp' ? '' : '<p class="small muted">Сумма и назначение платежа подставятся автоматически.</p>'}
  <button class="btn w${mob ? ' sec' : ''}" id="paid" style="margin-top:12px">Я оплатил(а)</button>
  <p class="small muted">Заказ сохранён. Мы проверим поступление и отправим его в течение 1–2 дней.</p></div>`, api => {
    const pg = api.el.querySelector('#payGo');
    if (pg) pg.onclick = () => { const b = api.el.querySelector('#banks'); b.hidden = !b.hidden; if (!b.hidden) b.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
    api.el.querySelectorAll('[data-bank]').forEach(a => a.addEventListener('click', () => { ls.set('desire_bank', a.dataset.bank); track('pay_bank', { meta: { bank: a.dataset.bank } }); }));
    api.el.querySelector('#paid').onclick = async () => { track('paid', { val: o.total, meta: { order: o.id } }); if (SB) { await SB.rpc('claim_paid', { p_token: o.token }); o.paidClaimed = true; } else { const x = DB.orders.find(y => y.id === o.id); x.paidClaimed = true; save(); } api.close(); toast('Спасибо! Заказ ' + o.id + ' принят'); go('profile'); if (SB && !notifOn) setTimeout(() => openNotify('order'), 700); };
  });
}
function openOrder(id) {
  const o = (SB ? myRemote : DB.orders).find(x => x.id === id); if (!o) return;
  sheet('Заказ ' + o.id, `<div class="sh-b"><p><span class="st ${o.status}">${STATUS[o.status]}</span></p>
  <div class="list">${o.items.map(i => `<div class="row"><img class="thumb" src="${esc(i.img)}" alt=""><div class="f"><b>${esc(i.name)}</b><div class="muted small">${esc(i.color)} · ${esc(i.size)} · ${i.qty} шт.</div></div><span class="price">${rub(i.price * i.qty)}</span></div>`).join('')}</div>
  <div class="box" style="margin-top:12px"><div class="sum"><span>Доставка ${o.delivery.service === 'ozon' ? 'Ozon' : 'СДЭК'}</span><span>${o.delivery.cost ? rub(o.delivery.cost) : 'Бесплатно'}</span></div><div class="small muted">${esc(o.delivery.city)}, ${esc(o.delivery.address)}</div>
  ${o.discount ? `<div class="sum sale"><span>Промокод ${esc(o.promo)}</span><span>−${rub(o.discount)}</span></div>` : ''}<div class="sum t"><span>Итого</span><span>${rub(o.total)}</span></div></div>
  ${o.bonusSpent ? `<p class="small muted">Оплачено бонусами: ${rub(o.bonusSpent)}</p>` : ''}${o.bonusEarned && o.status === 'done' ? `<p class="small" style="color:var(--green)">Начислено бонусов: ${rub(o.bonusEarned)}</p>` : ''}
  ${o.returnCare ? `<p class="small muted">Подключено: «${esc(o.returnCareName || optName())}».</p>` : ''}
  ${o.status === 'done' && reviewsOn ? `<h3 style="margin-top:14px">Оцените покупку</h3><div class="list">${[...new Map(o.items.map(i => [i.pid, i])).values()].map(i => `<div class="row"><span class="f">${esc(i.name)}</span>${reviewedKey(o.id, i.pid) ? '<span class="muted small">Отзыв отправлен</span>' : `<button class="btn sm" data-rev="${esc(i.pid)}">Оставить отзыв</button>`}</div>`).join('')}</div>` : ''}
  ${o.status === 'awaiting' ? '<button class="btn w blue" id="repay" style="margin-top:12px">Показать QR для оплаты</button>' : ''}
  <button class="btn w sec" style="margin-top:10px" data-contact="${esc(`Здравствуйте! Вопрос по заказу ${o.id}.`)}">Вопрос по заказу</button></div>`, api => {
    const b = api.el.querySelector('#repay'); if (b) b.onclick = () => { api.close(); setTimeout(() => openPay(o), 320); };
    api.el.addEventListener('click', e => { const t = e.target.closest('[data-rev]'); if (t) { api.close(); setTimeout(() => openReviewForm(o, o.items.find(i => i.pid === t.dataset.rev)), 320); } });
  });
}
const RK = 'desire_reviewed_v1';
const reviewedKey = (oid, pid) => (ls.get(RK) || []).includes(oid + '|' + pid);
function openReviewForm(o, item) {
  let rating = 5, photos = [];
  sheet('Отзыв: ' + item.name, '', api => {
    const draw = () => api.set(`<div class="sh-b"><p class="muted small" style="margin-top:4px">${esc(item.color)} · ${esc(item.size)}</p>
      <div class="rate">${[1, 2, 3, 4, 5].map(i => `<button data-rt="${i}" class="${i <= rating ? 'on' : ''}" aria-label="${i} из 5">${svg('star')}</button>`).join('')}</div>
      <div class="field"><label for="r_n">Ваше имя</label><input class="inp" id="r_n" maxlength="40" value="${esc((o.customer?.name || '').split(' ')[0] || '')}"></div>
      <div class="field"><label for="r_t">Отзыв</label><textarea class="inp" id="r_t" maxlength="2000" placeholder="Как сидит, подошёл ли размер, качество ткани"></textarea></div>
      <div class="phs">${photos.map((src, i) => `<div><img src="${esc(src)}" alt=""><button class="x" data-rx="${i}" aria-label="Удалить фото">×</button></div>`).join('')}</div>
      ${photos.length < 3 ? '<label class="btn sec sm" style="margin-top:10px">Добавить фото (до 3)<input type="file" accept="image/*" multiple id="r_up" hidden></label>' : ''}
      <button class="btn w" id="r_send" style="margin-top:16px">Отправить отзыв</button>
      <p class="small muted">Отзыв появится на сайте после проверки.</p></div>`);
    let nm = '', tx = '';
    const keep = () => { const n = api.el.querySelector('#r_n'), t = api.el.querySelector('#r_t'); if (n) nm = n.value; if (t) tx = t.value; };
    const redraw = () => { keep(); draw(); api.el.querySelector('#r_n').value = nm || api.el.querySelector('#r_n').value; api.el.querySelector('#r_t').value = tx; };
    draw();
    api.el.addEventListener('change', async e => { if (e.target.id !== 'r_up') return; keep(); for (const f of [...e.target.files].slice(0, 3 - photos.length)) { try { photos.push(await resizeImg(f, 800, .72)); } catch { toast('Не удалось прочитать фото'); } } draw(); api.el.querySelector('#r_n').value = nm; api.el.querySelector('#r_t').value = tx; });
    api.el.addEventListener('click', async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.rt) { rating = +t.dataset.rt; redraw(); }
      if (t.dataset.rx) { photos.splice(+t.dataset.rx, 1); redraw(); }
      if (t.id === 'r_send') {
        keep(); const data = { name: nm.trim() || 'Покупатель', rating, text: tx.trim(), photos, color: item.color, size: item.size, date: Date.now() };
        t.disabled = true;
        if (SB) {
          const { error } = await SB.rpc('add_review', { p_token: o.token, p_pid: item.pid, p_data: data });
          if (error) { t.disabled = false; return toast(/DUPLICATE/.test(error.message) ? 'Вы уже оставили отзыв на эту вещь' : /TOO_BIG/.test(error.message) ? 'Фото слишком большие — уберите одно' : 'Не удалось отправить отзыв'); }
        } else DB.reviews.unshift({ ...data, id: uid(), pid: item.pid, orderId: o.id, status: 'pending' }), save();
        ls.set(RK, [...(ls.get(RK) || []), o.id + '|' + item.pid]);
        api.close(); toast('Спасибо! Отзыв появится после проверки');
      }
    });
  });
}

/* ===== Вход сотрудника ===== */
function openStaffLogin() {
  if (staff) return go('admin');
  if (SB) return sheet('Вход для сотрудников', `<div class="sh-b"><div class="field"><label for="em">Email</label><input class="inp" id="em" type="email" autocomplete="username"></div><div class="field"><label for="pw">Пароль</label><input class="inp" id="pw" type="password" autocomplete="current-password"></div><button class="btn w" id="enter">Войти</button><p class="small muted">Аккаунты сотрудников создаёт владелец в Supabase → Authentication → Users.</p></div>`, api => {
    const tryIn = async () => {
      const b = api.el.querySelector('#enter'); b.disabled = true;
      const { error } = await SB.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
      b.disabled = false;
      if (error) return toast('Неверный email или пароль');
      staff = true; adm = 'orders'; api.close(); go('admin');
    };
    api.el.querySelector('#enter').onclick = tryIn; api.el.querySelector('#pw').onkeydown = e => { if (e.key === 'Enter') tryIn(); };
  });
  sheet('Вход для сотрудников', `<div class="sh-b"><div class="field"><label for="pin">PIN-код</label><input class="inp" id="pin" type="password" inputmode="numeric" autocomplete="off"></div><button class="btn w" id="enter">Войти</button><p class="small muted">Для теста PIN: 1234 — смените его в настройках панели.</p></div>`, api => {
    const tryIn = () => { if ($('#pin').value === String(DB.settings.pin)) { staff = true; adm = 'orders'; api.close(); go('admin'); } else toast('Неверный PIN'); };
    api.el.querySelector('#enter').onclick = tryIn; api.el.querySelector('#pin').onkeydown = e => { if (e.key === 'Enter') tryIn(); };
    setTimeout(() => $('#pin')?.focus(), 350);
  });
}

/* ===== Панель сотрудника ===== */
let adm = 'orders', admQ = '', ordF = 'all';
function viewAdmin() {
  if (!staff) { setTimeout(() => go('profile')); return ''; }
  const today = new Date().toDateString();
  const td = DB.orders.filter(o => new Date(o.date).toDateString() === today && o.status !== 'cancelled');
  const low = DB.products.reduce((a, p) => a + p.colors.reduce((b, c) => b + p.sizes.filter(s => stockOf(p, c, s) <= 1).length, 0), 0);
  const pend = DB.reviews.filter(r => r.status === 'pending').length;
  const nw = DB.wishes.filter(w => w.status !== 'done').length;
  const grp = admGroupOf(adm), subs = ADM_GROUPS[grp].filter(k => SB || k !== 'news');
  const lbl = k => ADM_SUB[k] + (k === 'wishes' && nw ? ` (${nw})` : k === 'reviews' && pend ? ` (${pend})` : '');
  const awaiting = DB.orders.filter(o => o.status === 'awaiting').length;
  return `<div class="admhead"><b>Панель</b>${SB ? '<button class="btn sm sec" id="reload">Обновить</button>' : ''}</div>
  <div class="kpis mini"><div class="kpi"><span>Сегодня</span><b>${td.length}</b></div><div class="kpi"><span>Выручка</span><b>${rub(td.reduce((a, o) => a + o.total, 0))}</b></div>
  <button class="kpi" data-admto="orders" data-of="awaiting"><span>К проверке</span><b class="${awaiting ? 'low' : ''}">${awaiting}</b></button><button class="kpi" data-admto="stock"><span>Остаток ≤ 1</span><b class="${low ? 'low' : ''}">${low}</b></button></div>
  ${subs.length > 1 ? `<div class="seg" style="margin:12px 0 16px">${subs.map(k => `<button class="${adm === k ? 'on' : ''}" data-adm="${k}">${lbl(k)}</button>`).join('')}</div>` : '<div style="height:12px"></div>'}
  <div id="admBody">${({ orders: admOrders, products: admProducts, stock: admStock, promo: admPromo, reviews: admReviews, setup: admSetup, stats: admStats, wishes: admWishes, news: admNews })[adm]()}</div>
  ${grp === 'a_more' ? `<div class="list" style="margin-top:16px"><button class="row" style="width:100%;text-align:left" data-go="home"><span class="f">Открыть магазин как покупатель</span><span class="muted r">›</span></button><button class="row" style="width:100%;text-align:left" id="logout"><span class="f" style="color:var(--red)">Выйти из панели</span></button></div>` : ''}`;
}
function admOrders() {
  let l = [...DB.orders].reverse(); if (ordF !== 'all') l = l.filter(o => o.status === ordF);
  return `<div class="chips"><button class="chip ${ordF === 'all' ? 'on' : ''}" data-of="all">Все</button>${Object.entries(STATUS).map(([k, v]) => `<button class="chip ${ordF === k ? 'on' : ''}" data-of="${k}">${v}</button>`).join('')}</div>
  ${l.length ? `<div class="list">${l.map(o => `<div class="row" style="flex-wrap:wrap"><div class="f" style="flex:1 1 220px"><b>${esc(o.id)}</b> · ${esc(o.customer.name)} · <a href="tel:${esc(o.customer.phone)}">${esc(o.customer.phone)}</a>
  <div class="small muted">${new Date(o.date).toLocaleString('ru-RU')} · ${o.delivery.service === 'ozon' ? 'Ozon' : 'СДЭК'}: ${esc(o.delivery.city)}, ${esc(o.delivery.address)}</div>
  <div class="small">${o.items.map(i => `${esc(i.name)} ${esc(i.color)} ${esc(i.size)} ×${i.qty}`).join('; ')}</div>${o.comment ? `<div class="small muted">«${esc(o.comment)}»</div>` : ''}
  ${o.returnCare ? `<div class="small"><span class="st paid">${esc(o.returnCareName || 'Возврат')}</span></div>` : ''}${o.bonusSpent ? `<div class="small muted">Бонусами: −${rub(o.bonusSpent)}</div>` : ''}${o.bonusEarned ? `<div class="small" style="color:var(--green)">Начислено бонусов: ${rub(o.bonusEarned)}</div>` : ''}
  ${o.paidClaimed && o.status === 'awaiting' ? '<div class="small" style="color:var(--accent)">Покупатель нажал «Я оплатил» — проверьте поступление</div>' : ''}</div>
  <span class="price">${rub(o.total)}</span><select class="inp" data-ost="${esc(o.id)}" style="width:auto;height:38px;font-size:14px">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`).join('')}</div>` : '<div class="empty"><b>Заказов пока нет</b>Оформите тестовый заказ как покупатель — он появится здесь</div>'}`;
}
/* ===== Статистика ===== */
let statPer = 30, statData = null, statLoading = false;
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
const CONFIRMED = ['paid', 'assembling', 'shipped', 'done'];
async function loadStats() {
  if (statLoading) return; statLoading = true;
  const from = Date.now() - statPer * 864e5; let ev = [];
  if (SB) {
    for (let off = 0; off < 100000; off += 1000) {
      const { data, error } = await SB.from('events').select('ts,sid,type,src,pid,color,size,q,val,meta').gte('ts', new Date(from).toISOString()).order('ts').range(off, off + 999);
      if (error) { statLoading = false; statData = { error: error.message }; return render(); }
      ev.push(...data.map(e => ({ ...e, ts: Date.parse(e.ts) }))); if (data.length < 1000) break;
    }
    const w = await SB.from('wishes').select('*').order('created_at', { ascending: false });
    if (!w.error) DB.wishes = w.data.map(x => ({ ...x, ts: Date.parse(x.created_at) }));
  } else ev = (ls.get('desire_ev_v1') || []).filter(e => e.ts >= from);
  statData = calcStats(ev, from); statLoading = false; if (route === 'admin' && adm === 'stats') render();
}
function calcStats(ev, from) {
  const sids = t => new Set(ev.filter(e => e.type === t).map(e => e.sid));
  const visits = new Set(ev.map(e => e.sid));
  const orders = DB.orders.filter(o => o.date >= from);
  const ok = orders.filter(o => CONFIRMED.includes(o.status));
  // Каждый шаг = сессии, дошедшие до него или дальше (добавила в корзину ⇒ выбрала размер, даже если оставила размер по умолчанию)
  const okS = new Set(ok.map(o => o.sid).filter(x => visits.has(x)));
  const steps = [['Зашли на сайт', null], ['Каталог', 'catalog'], ['Карточка товара', 'product'], ['Выбрали цвет и размер', 'select'], ['Добавили в корзину', 'cart_add'], ['Начали оформление', 'checkout'],
    ['Заполнили контакты', 'contacts'], ['Выбрали доставку', 'delivery'], ['Нажали «Оплатить по QR»', 'pay'], ['Нажали «Я оплатил»', 'paid'], ['Оплата подтверждена', 'ok']];
  const sets = steps.map(([, t]) => t === null ? visits : t === 'ok' ? okS : sids(t));
  const funnel = steps.map(([l], i) => { const u = new Set(); for (let j = i; j < sets.length; j++) sets[j].forEach(x => u.add(x)); return [l, u.size]; });
  // источники
  const src = {}; ev.filter(e => e.type === 'visit').forEach(e => { (src[e.src] ||= { v: 0, o: 0, r: 0 }).v++; });
  ok.forEach(o => { const k = o.src || 'direct'; (src[k] ||= { v: 0, o: 0, r: 0 }).o++; src[k].r += o.total; });
  // товары
  const prod = {}; const P = id => prod[id] ||= { views: 0, cart: 0, sold: 0, rev: 0, fav: 0 };
  ev.forEach(e => { if (!e.pid) return; if (e.type === 'product') P(e.pid).views++; if (e.type === 'cart_add') P(e.pid).cart++; if (e.type === 'fav') P(e.pid).fav++; });
  const colors = {}; ev.filter(e => e.type === 'cart_add' && e.color).forEach(e => { colors[e.color] = (colors[e.color] || 0) + 1; });
  ok.forEach(o => o.items.forEach(i => { P(i.pid).sold += i.qty; P(i.pid).rev += i.price * i.qty; }));
  const oos = {}; ev.filter(e => e.type === 'oos').forEach(e => { const k = `${e.pid}|${e.color}|${e.size}`; oos[k] = (oos[k] || 0) + 1; });
  const searches = {}; ev.filter(e => e.type === 'search' && e.q).forEach(e => { const s = searches[e.q] ||= { n: 0, zero: e.val === 0 }; s.n++; });
  // покупатели
  const byPhone = {}; DB.orders.filter(o => o.status !== 'cancelled').forEach(o => { const ph = (o.customer?.phone || '').replace(/\D/g, '').slice(-10); if (ph) (byPhone[ph] ||= []).push(o.date); });
  let newC = 0, repC = 0; Object.values(byPhone).forEach(d => { const inP = d.filter(x => x >= from).length; if (!inP) return; if (d.some(x => x < from) || d.length > 1) repC++; else newC++; });
  const custs = Object.keys(byPhone).length, allOrders = Object.values(byPhone).reduce((a, d) => a + d.length, 0);
  const cities = {}, serv = {}; ok.forEach(o => { cities[o.delivery.city] = (cities[o.delivery.city] || 0) + 1; serv[o.delivery.service] = (serv[o.delivery.service] || 0) + 1; });
  const rev = ok.reduce((a, o) => a + o.total, 0), items = ok.reduce((a, o) => a + o.items.reduce((b, i) => b + i.qty, 0), 0);
  const gross = ok.reduce((a, o) => a + o.items.reduce((b, i) => b + (i.basePrice || i.price) * i.qty, 0), 0);
  const disc = ok.reduce((a, o) => a + o.items.reduce((b, i) => b + ((i.basePrice || i.price) - i.price) * i.qty, 0) + (o.discount || 0) + (o.bonusSpent || 0), 0);
  const promos = {}; ok.filter(o => o.promo).forEach(o => { (promos[o.promo] ||= { n: 0, sum: 0 }).n++; promos[o.promo].sum += o.discount || 0; });
  const days = {}; for (let t = from; t <= Date.now(); t += 864e5) days[new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })] = 0;
  ok.forEach(o => { const k = new Date(o.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); if (k in days) days[k] += o.total; });
  const weeks = {}; ok.forEach(o => { const d = new Date(o.date); const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const k = 'с ' + m.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); weeks[k] = (weeks[k] || 0) + o.total; });
  const statuses = {}; orders.forEach(o => { statuses[o.status] = (statuses[o.status] || 0) + 1; });
  const installs = new Set(ev.filter(e => e.type === 'install' || (e.type === 'visit' && e.meta?.standalone)).map(e => e.sid)).size;
  return { funnel, src, prod, colors, oos, searches, newC, repC, custs, perCust: custs ? allOrders / custs : 0, cities, serv, rev, items, cnt: ok.length, gross, disc, promos, days, weeks, statuses, installs,
    guar: ok.filter(o => o.returnCare).length, bonus: ok.reduce((a, o) => a + (o.bonusSpent || 0), 0), visits: visits.size, evCount: ev.length };
}
const bars = (rows, fmt = v => v, max) => { const m = max || Math.max(1, ...rows.map(r => r[1])); return `<div class="bars">${rows.map(([l, v, extra]) => `<div class="bar"><span class="bl">${esc(l)}</span><span class="bt"><i style="width:${Math.max(v ? 2 : 0, v / m * 100)}%"></i></span><span class="bv">${fmt(v)}${extra ? ` <em>${extra}</em>` : ''}</span></div>`).join('')}</div>`; };
const top = (o, n = 8) => Object.entries(o).sort((a, b) => (b[1].n ?? b[1]) - (a[1].n ?? a[1])).slice(0, n);
const srcName = k => ({ ig: 'Instagram', tg: 'Telegram', search: 'Поиск', direct: 'Прямой заход' }[k] || k);
function admStats() {
  if (!statData) { setTimeout(loadStats); return '<div class="empty"><b>Считаем…</b></div>'; }
  if (statData.error) return `<div class="note">Статистика ещё не подключена в базе. Запустите обновлённый supabase-setup.sql в Supabase → SQL Editor.<br><span class="small muted">${esc(statData.error)}</span></div>`;
  const S = statData, f = S.funnel;
  let worst = 0, wi = -1; for (let i = 1; i < f.length - 1; i++) { const drop = f[i - 1][1] ? 1 - f[i][1] / f[i - 1][1] : 0; if (f[i - 1][1] >= 5 && drop > worst) { worst = drop; wi = i; } }
  const prodRows = Object.entries(S.prod).map(([id, v]) => ({ id, name: byId(id)?.name || id, ...v })).sort((a, b) => b.views - a.views);
  const lookers = prodRows.filter(r => r.views >= 15 && r.sold / r.views < .02).slice(0, 5);
  return `<div class="chips">${[7, 30, 90].map(d => `<button class="chip ${statPer === d ? 'on' : ''}" data-per="${d}">${d} дней</button>`).join('')}</div>
  <div class="kpis"><div class="kpi"><span class="muted small">Посетители</span><b>${S.visits}</b></div><div class="kpi"><span class="muted small">Оплаченные заказы</span><b>${S.cnt}</b></div><div class="kpi"><span class="muted small">Конверсия</span><b>${pct(S.cnt, S.visits)}%</b></div><div class="kpi"><span class="muted small">Выручка</span><b>${rub(S.rev)}</b></div><div class="kpi"><span class="muted small">Средний чек</span><b>${rub(S.cnt ? S.rev / S.cnt : 0)}</b></div></div>
  <h2>Воронка</h2><div class="box">${f.map(([l, v], i) => `<div class="fn ${i === wi ? 'warn' : ''}"><span class="bl">${i + 1}. ${esc(l)}</span><span class="bt"><i style="width:${pct(v, f[0][1] || 1)}%"></i></span><span class="bv">${v}${i ? ` <em>${pct(v, f[i - 1][1])}%</em>` : ''}</span></div>`).join('')}
  ${wi > 0 ? `<p class="small" style="color:var(--red);margin:10px 0 0">Больше всего уходят на шаге «${esc(f[wi][0])}»: дальше проходят только ${pct(f[wi][1], f[wi - 1][1])}%.</p>` : '<p class="small muted" style="margin:10px 0 0">Процент справа — сколько перешли с предыдущего шага.</p>'}</div>
  <h2>Источники</h2><div class="box scroll"><table><thead><tr><th>Источник</th><th class="n">Визиты</th><th class="n">Заказы</th><th class="n">Конверсия</th><th class="n">Выручка</th></tr></thead><tbody>${Object.entries(S.src).sort((a, b) => b[1].v - a[1].v).map(([k, v]) => `<tr><td>${esc(srcName(k))}</td><td class="n">${v.v}</td><td class="n">${v.o}</td><td class="n">${pct(v.o, v.v)}%</td><td class="n">${rub(v.r)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Нет данных</td></tr>'}</tbody></table>
  <p class="small muted">Чтобы различать сторис, шапку профиля и рассылки — используйте ссылки с метками ниже.</p></div>
  <h2>Товары</h2><div class="box scroll"><table><thead><tr><th>Модель</th><th class="n">Просмотры</th><th class="n">В корзину</th><th class="n">Продано</th><th class="n">Просм.→корз.</th><th class="n">Выручка</th></tr></thead><tbody>${prodRows.slice(0, 15).map(r => `<tr><td>${esc(r.name)}</td><td class="n">${r.views}</td><td class="n">${r.cart}</td><td class="n">${r.sold}</td><td class="n">${pct(r.cart, r.views)}%</td><td class="n">${rub(r.rev)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Нет данных</td></tr>'}</tbody></table>
  ${lookers.length ? `<p class="small" style="margin:10px 0 0"><b>Смотрят, но не покупают:</b> ${lookers.map(r => esc(r.name)).join(', ')} — проверьте цену, фото и наличие размеров.</p>` : ''}</div>
  <div class="stack3" style="margin-top:14px"><div class="box"><h3>Популярные цвета (в корзину)</h3>${bars(top(S.colors).map(([k, v]) => [k, v]))}</div>
  <div class="box"><h3>Нет в наличии — спрашивали</h3>${Object.keys(S.oos).length ? bars(top(S.oos).map(([k, v]) => { const [pid, c, z] = k.split('|'); return [`${byId(pid)?.name || pid} · ${c} · ${z}`, v]; })) : '<p class="small muted">Пока никто не выбирал отсутствующие варианты</p>'}<p class="small muted">Сигнал, что дошивать. Подписки — во вкладке «Ждут».</p></div>
  <div class="box"><h3>В избранном</h3>${bars(prodRows.filter(r => r.fav).sort((a, b) => b.fav - a.fav).slice(0, 8).map(r => [r.name, r.fav]))}</div></div>
  <h2>Поиск</h2><div class="stack3"><div class="box"><h3>Частые запросы</h3>${bars(top(S.searches).map(([k, v]) => [k, v.n]))}</div><div class="box"><h3>Ничего не нашлось</h3>${bars(top(Object.fromEntries(Object.entries(S.searches).filter(([, v]) => v.zero))).map(([k, v]) => [k, v.n]))}<p class="small muted">Чего не хватает в ассортименте или в названиях</p></div></div>
  <h2>Покупатели</h2><div class="kpis"><div class="kpi"><span class="muted small">Новые</span><b>${S.newC}</b></div><div class="kpi"><span class="muted small">Повторные</span><b>${S.repC}</b></div><div class="kpi"><span class="muted small">Заказов на покупателя</span><b>${S.perCust.toFixed(1)}</b></div><div class="kpi"><span class="muted small">Вещей в заказе</span><b>${S.cnt ? (S.items / S.cnt).toFixed(1) : 0}</b></div><div class="kpi"><span class="muted small">Установили приложение</span><b>${S.installs}</b></div></div>
  <div class="stack3"><div class="box"><h3>Города</h3>${bars(top(S.cities).map(([k, v]) => [k, v]))}</div><div class="box"><h3>Доставка</h3>${bars(Object.entries(S.serv).map(([k, v]) => [k === 'ozon' ? 'Ozon' : 'СДЭК', v]))}</div>
  <div class="box"><h3>Опции и скидки</h3><div class="sum"><span>Гарантия возврата</span><span>${S.guar} из ${S.cnt} (${pct(S.guar, S.cnt)}%)</span></div><div class="sum"><span>Оплачено бонусами</span><span>${rub(S.bonus)}</span></div><div class="sum"><span>Доля скидок</span><span>${pct(S.disc, S.gross)}%</span></div>
  ${Object.keys(S.promos).length ? top(S.promos).map(([k, v]) => `<div class="sum"><span>Промокод ${esc(k)}</span><span>${v.n} · −${rub(v.sum)}</span></div>`).join('') : '<p class="small muted">Промокоды не применяли</p>'}</div></div>
  <h2>Выручка</h2><div class="box"><h3>По дням</h3>${bars(Object.entries(S.days).slice(-31), v => v ? rub(v) : '—')}</div>
  <div class="stack3" style="margin-top:14px"><div class="box"><h3>По неделям</h3>${bars(Object.entries(S.weeks), rub)}</div><div class="box"><h3>Лучшие товары по выручке</h3>${bars(prodRows.filter(r => r.rev).sort((a, b) => b.rev - a.rev).slice(0, 8).map(r => [r.name, r.rev]), rub)}</div>
  <div class="box"><h3>Статусы заказов</h3>${Object.entries(STATUS).map(([k, v]) => `<div class="sum"><span>${v}</span><span>${S.statuses[k] || 0}</span></div>`).join('')}</div></div>
  <h2>Ссылки с метками</h2><div class="box"><p class="small muted" style="margin-top:0">Ставьте такие ссылки в шапку профиля, сторис и Telegram — статистика покажет, что приносит заказы.</p>
  <div class="two"><div class="field"><label for="u_s">Где ссылка</label><select class="inp" id="u_s"><option value="ig">Instagram</option><option value="tg">Telegram</option><option value="wa">WhatsApp</option><option value="ads">Реклама</option><option value="qr">QR на бирке/в посылке</option></select></div>
  <div class="field"><label for="u_m">Место</label><select class="inp" id="u_m"><option value="bio">Шапка профиля</option><option value="stories">Сторис</option><option value="post">Пост</option><option value="direct">Директ / личка</option><option value="channel">Канал</option><option value="package">Посылка</option></select></div></div>
  <div class="field"><label for="u_c">Кампания (необязательно, латиницей)</label><input class="inp" id="u_c" placeholder="blackfriday"></div>
  <button class="btn" id="mkLink">Создать и скопировать ссылку</button><p class="small" id="utmOut" style="word-break:break-all;margin-bottom:0"></p></div>
  <p class="small muted">Событий за период: ${S.evCount}. Действия сотрудников в статистику не попадают.</p>`;
}
function buildUtm() { const c = ($('#u_c').value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''); return `${location.origin}/?utm_source=${$('#u_s').value}&utm_medium=${$('#u_m').value}${c ? '&utm_campaign=' + c : ''}`; }
function admWishes() {
  const l = [...DB.wishes].sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.ts - a.ts);
  if (!l.length) { if (SB && !statData) setTimeout(loadStats); return '<div class="empty"><b>Пока никто не ждёт</b>Здесь появятся покупатели, которые нажали «Сообщить о поступлении»</div>'; }
  const groups = {}; l.filter(w => w.status !== 'done').forEach(w => { const k = `${w.pid}|${w.color}|${w.size}`; groups[k] = (groups[k] || 0) + 1; });
  return `${Object.keys(groups).length ? `<div class="box"><h3>Что дошить или довезти</h3>${bars(Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => { const [pid, c, z] = k.split('|'); return [`${byId(pid)?.name || pid} · ${c} · ${z}`, v]; }), v => v + ' чел.')}</div>` : ''}
  <div class="list" style="margin-top:12px">${l.map(w => { const p = byId(w.pid), inStock = p && stockOf(p, w.color, w.size) > 0, c = String(w.contact || ''), isTg = /^@|[a-z]/i.test(c) && !/^\+?\d[\d\s()-]+$/.test(c);
    const link = isTg ? tgLink(c) : `https://wa.me/${c.replace(/\D/g, '').replace(/^8/, '7')}?text=${encodeURIComponent(`Здравствуйте! ${p?.name || ''} ${w.color} ${w.size} снова в наличии в DESIRE.`)}`;
    return `<div class="row" style="flex-wrap:wrap"><div class="f" style="flex:1 1 200px"><b>${esc(p?.name || w.pid)}</b> · ${esc(w.color)} · ${esc(w.size)} ${w.status === 'done' ? '<span class="st done">сообщили</span>' : inStock ? '<span class="st shipped">уже в наличии</span>' : ''}<div class="small muted">${new Date(w.ts).toLocaleDateString('ru-RU')} · ${esc(c)}</div></div>
    ${w.status !== 'done' ? `<a class="btn sm sec" href="${esc(link)}">Написать</a><button class="btn sm" data-wdone="${esc(w.id)}">Сообщили</button>` : ''}</div>`; }).join('')}</div>`;
}
async function markWish(id) {
  const w = DB.wishes.find(x => String(x.id) === id); if (!w) return;
  if (SB) { const { error } = await SB.from('wishes').update({ status: 'done' }).eq('id', id); if (error) return toast('Не удалось: ' + error.message); }
  w.status = 'done'; if (!SB) save(); render();
}
/* ===== Рассылки и подписчики ===== */
let newsData = null;
async function loadNews() {
  await loadNotiInfo();
  const [b, s, l] = await Promise.all([SB.from('broadcasts').select('*').order('id', { ascending: false }).limit(30), SB.from('subscribers').select('kind,news'), SB.from('notif_log').select('kind,channel,ok,ts').gte('ts', new Date(Date.now() - 30 * 864e5).toISOString()).limit(5000)]);
  const { data: info } = await SB.from('notifier_info').select('seen_at,bot').maybeSingle();
  newsData = { b: b.data || [], subs: s.data || [], log: l.data || [], info: info || {}, err: b.error?.message || s.error?.message };
  if (route === 'admin' && adm === 'news') render();
}
function admNews() {
  if (!newsData) { setTimeout(loadNews); return '<div class="empty"><b>Загружаем…</b></div>'; }
  if (newsData.err) return `<div class="note">Рассылки ещё не подключены в базе: запустите обновлённый supabase-setup.sql.<br><span class="small muted">${esc(newsData.err)}</span></div>`;
  const S = newsData.subs, push = S.filter(x => x.kind === 'push').length, tgc = S.filter(x => x.kind === 'tg').length, news = S.filter(x => x.news).length;
  const alive = newsData.info.seen_at && Date.now() - Date.parse(newsData.info.seen_at) < 864e5 * 3;
  const by = {}; newsData.log.forEach(x => { const k = x.kind; (by[k] ||= { ok: 0, fail: 0 })[x.ok ? 'ok' : 'fail']++; });
  const KN = { status: 'Статусы заказов', stock: 'Снова в наличии', cart1: 'Корзина: 1-е напоминание', cart2: 'Корзина: 2-е напоминание', news: 'Рассылки', staff: 'Сотрудникам' };
  return `<div class="kpis"><div class="kpi"><span class="muted small">Telegram</span><b>${tgc}</b></div><div class="kpi"><span class="muted small">Push</span><b>${push}</b></div><div class="kpi"><span class="muted small">Согласны на новинки</span><b>${news}</b></div></div>
  ${alive ? '' : '<div class="note">Сервис уведомлений на сервере не отвечает — сообщения не уходят. Проверьте, что он запущен.</div>'}
  <div class="box"><h3>Новая рассылка</h3><p class="small muted" style="margin-top:0">Получат ${news} подписчиков, которые согласились на новинки и акции.</p>
  <div class="field"><label for="n_t">Заголовок</label><input class="inp" id="n_t" maxlength="60" placeholder="Новая коллекция уже в магазине"></div>
  <div class="field"><label for="n_b">Текст</label><textarea class="inp" id="n_b" rows="3" maxlength="300" placeholder="Тёплые костюмы и пальто — успейте выбрать свой размер"></textarea></div>
  <div class="field"><label for="n_p">Куда ведёт кнопка</label><select class="inp" id="n_p"><option value="">Главная магазина</option><option value="#catalog">Каталог</option>${DB.products.filter(p => !p.hidden).map(p => `<option value="#p=${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
  <button class="btn" id="nSend"${news ? '' : ' disabled'}>Отправить</button></div>
  <h2>Отправлено за 30 дней</h2><div class="box">${Object.keys(by).length ? Object.entries(by).map(([k, v]) => `<div class="sum"><span>${KN[k] || k}</span><span>${v.ok}${v.fail ? ` <em class="muted">· не дошло ${v.fail}</em>` : ''}</span></div>`).join('') : '<p class="small muted">Пока ничего не отправляли</p>'}</div>
  <h2>История рассылок</h2><div class="list">${newsData.b.map(b => `<div class="row" style="flex-wrap:wrap"><div class="f" style="flex:1 1 200px"><b>${esc(b.title)}</b><div class="small muted">${new Date(b.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${b.status === 'sent' ? `доставлено ${b.sent}${b.failed ? `, не дошло ${b.failed}` : ''}` : 'отправляется…'}</div><div class="small">${esc(b.body)}</div></div></div>`).join('') || '<div class="empty">Рассылок ещё не было</div>'}</div>`;
}
async function sendNews() {
  const t = $('#n_t').value.trim(), b = $('#n_b').value.trim(), link = $('#n_p').value;
  if (t.length < 3 || b.length < 5) return toast('Заполните заголовок и текст');
  const cnt = newsData.subs.filter(x => x.news).length;
  if (!confirm(`Отправить рассылку «${t}» ${cnt} подписчикам? Отменить после отправки нельзя.`)) return;
  const { error } = await SB.from('broadcasts').insert({ title: t, body: b, url: location.origin + '/' + link });
  if (error) return toast('Не удалось: ' + error.message);
  toast('Рассылка отправляется'); newsData = null; setTimeout(loadNews, 3000); render();
}
async function staffTg() {
  await loadNotiInfo(); if (!NOTI.bot) return toast('Бот ещё не подключён на сервере');
  const w = window.open('', '_blank');
  const { data, error } = await SB.rpc('staff_tg_code'); if (error) { w?.close(); return toast('Не удалось: ' + error.message); }
  const url = `https://t.me/${NOTI.bot}?start=${data}`; if (w) w.location = url; else location.href = url;
  toast('Нажмите «Запустить» в Telegram');
}
function admReviews() {
  if (!reviewsOn) return '<div class="note">Отзывы ещё не подключены в базе. Запустите обновлённый файл supabase-setup.sql в Supabase → SQL Editor.</div>';
  const l = [...DB.reviews].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0));
  return l.length ? `<div class="list">${l.map(r => `<div class="row" style="flex-wrap:wrap;align-items:flex-start"><div class="f" style="flex:1 1 240px"><b>${esc(byId(r.pid)?.name || r.pid)}</b> · ${esc(r.name)} ${stars(r.rating, 12)} <span class="st ${r.status === 'published' ? 'shipped' : r.status === 'hidden' ? 'cancelled' : 'awaiting'}">${r.status === 'published' ? 'опубликован' : r.status === 'hidden' ? 'скрыт' : 'ждёт проверки'}</span>
    <div class="small muted">${new Date(r.date).toLocaleDateString('ru-RU')}${r.color ? ' · ' + esc(r.color) : ''}${r.size ? ' · ' + esc(r.size) : ''}</div>${r.text ? `<p style="margin:6px 0">${esc(r.text)}</p>` : ''}
    ${(r.photos || []).length ? `<div class="rph">${r.photos.map(src => /^data:image\/jpeg;base64,/.test(src) ? `<img src="${esc(src)}" alt="">` : '').join('')}</div>` : ''}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${r.status !== 'published' ? `<button class="btn sm" data-rvs="published" data-rid="${esc(r.id)}">Опубликовать</button>` : ''}${r.status !== 'hidden' ? `<button class="btn sm sec" data-rvs="hidden" data-rid="${esc(r.id)}">Скрыть</button>` : ''}<button class="btn sm red" data-rvd="${esc(r.id)}">Удалить</button></div></div>`).join('')}</div>`
    : '<div class="empty"><b>Отзывов пока нет</b>Покупатели оставляют отзыв в профиле после статуса «Получен»</div>';
}
async function setReview(id, status) {
  const r = DB.reviews.find(x => x.id === id); if (!r) return;
  if (SB) { const q = status ? SB.from('reviews').update({ status }).eq('id', id) : SB.from('reviews').delete().eq('id', id); const { error } = await q; if (error) return toast('Не удалось: ' + error.message); }
  if (status) r.status = status; else DB.reviews = DB.reviews.filter(x => x.id !== id);
  if (!SB) save(); render(); toast(status === 'published' ? 'Отзыв опубликован' : status ? 'Отзыв скрыт' : 'Отзыв удалён');
}
function admProducts() {
  const q = admQ.toLowerCase(), l = DB.products.filter(p => !q || (p.name + p.cat).toLowerCase().includes(q));
  return `<div style="display:flex;gap:8px;margin-bottom:12px"><input class="inp" id="admQ" placeholder="Поиск товара" value="${esc(admQ)}"><button class="btn" id="newP">+ Товар</button></div>
  <div class="list">${l.map(p => `<div class="row"><img class="thumb" style="width:48px;height:64px" src="${esc(coverOf(p))}" alt=""><div class="f"><b>${esc(p.name)}</b>${p.hidden ? ' <span class="st cancelled">скрыт</span>' : ''}<div class="small muted">${esc(p.cat)} · ${rub(priceOf(p))} · остаток ${totalStock(p)} шт.</div></div><button class="btn sm sec" data-edit="${esc(p.id)}">Изменить</button></div>`).join('')}</div>`;
}
function admStock() {
  const q = admQ.toLowerCase(), l = DB.products.filter(p => !q || (p.name + p.cat).toLowerCase().includes(q));
  return `<input class="inp" id="admQ" placeholder="Поиск товара" value="${esc(admQ)}" style="margin-bottom:12px"><p class="small muted">Изменения сохраняются сразу. Красным — остаток 1 шт. и меньше.</p>
  ${l.map(p => `<div class="box" style="margin-bottom:10px"><h3>${esc(p.name)} <span class="muted small">${esc(p.cat)}</span></h3><div class="scroll"><table><thead><tr><th>Цвет</th>${p.sizes.map(s => `<th>${esc(s)}</th>`).join('')}</tr></thead><tbody>
  ${p.colors.map(c => `<tr><td><i class="dot" style="display:inline-block;vertical-align:-2px;background:${colorCss(c)}"></i> ${esc(c)}</td>${p.sizes.map(s => `<td><input class="stk ${stockOf(p, c, s) <= 1 ? 'low' : ''}" type="number" min="0" inputmode="numeric" data-stk="${esc(p.id)}" data-k="${esc(c + '|' + s)}" value="${stockOf(p, c, s)}" aria-label="${esc(p.name + ' ' + c + ' ' + s)}"></td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('')}`;
}
function admPromo() {
  return `<h2 style="margin-top:0">Промокоды</h2><div class="list">${DB.promos.map(p => `<div class="row"><div class="f"><b>${esc(p.code)}</b> ${p.active ? '' : '<span class="st cancelled">выкл</span>'}<div class="small muted">${p.type === 'percent' ? p.value + '%' : rub(p.value)} · от ${rub(p.minSum || 0)}${p.note ? ' · ' + esc(p.note) : ''}</div></div><button class="btn sm sec" data-ptog="${p.id}">${p.active ? 'Выключить' : 'Включить'}</button><button class="btn sm red" data-pdel="${p.id}">Удалить</button></div>`).join('') || '<div class="row muted">Нет промокодов</div>'}</div>
  <div class="box" style="margin-top:10px"><h3>Новый промокод</h3><div class="two"><div class="field"><label for="pc">Код</label><input class="inp" id="pc" placeholder="SALE20"></div><div class="field"><label for="pt">Тип</label><select class="inp" id="pt"><option value="percent">Процент</option><option value="fixed">Сумма, ₽</option></select></div>
  <div class="field"><label for="pv">Размер скидки</label><input class="inp" id="pv" type="number" min="1"></div><div class="field"><label for="pm">Минимальная сумма, ₽</label><input class="inp" id="pm" type="number" min="0" value="0"></div></div><button class="btn" id="addPromo">Создать промокод</button></div>
  <h2>Акции на витрине</h2><p class="small muted" style="margin-top:-6px">Скидка применяется к категории или выбранным товарам и показывается баннером на главной.</p>
  <div class="list">${DB.campaigns.map(c => `<div class="row"><div class="f"><b>${esc(c.title)}</b> ${c.active ? '<span class="st shipped">идёт</span>' : '<span class="st cancelled">выкл</span>'}<div class="small muted">−${c.percent}% · ${esc(c.cat || (c.productIds || []).map(id => byId(id)?.name).filter(Boolean).join(', ') || '—')}</div></div><button class="btn sm sec" data-ctog="${c.id}">${c.active ? 'Остановить' : 'Запустить'}</button><button class="btn sm red" data-cdel="${c.id}">Удалить</button></div>`).join('') || '<div class="row muted">Нет акций</div>'}</div>
  <div class="box" style="margin-top:10px"><h3>Новая акция</h3><div class="field"><label for="ct">Название</label><input class="inp" id="ct" placeholder="Чёрная пятница"></div><div class="field"><label for="cx">Текст баннера</label><input class="inp" id="cx" placeholder="−20% на все костюмы до воскресенья"></div>
  <div class="two"><div class="field"><label for="cp">Скидка, %</label><input class="inp" id="cp" type="number" min="1" max="90"></div><div class="field"><label for="cc">Категория</label><select class="inp" id="cc"><option value="">— выбрать товары ниже —</option>${DB.categories.map(c => `<option>${esc(c)}</option>`).join('')}</select></div></div>
  <div class="field"><label>Или отдельные товары</label><div class="chips" style="flex-wrap:wrap">${DB.products.map(p => `<label class="chip" style="display:flex;align-items:center;gap:6px"><input type="checkbox" value="${esc(p.id)}" class="cpi">${esc(p.name)}</label>`).join('')}</div></div>
  <button class="btn" id="addCamp">Запустить акцию</button></div>`;
}
function admSetup() {
  const s = DB.settings, p = s.pay;
  return `<div class="box"><h3>Оплата по QR</h3><div class="seg" style="margin:8px 0 12px"><button class="${p.mode === 'requisites' ? 'on' : ''}" data-pm="requisites">По реквизитам</button><button class="${p.mode === 'sbp' ? 'on' : ''}" data-pm="sbp">Ссылка СБП</button></div>
  ${p.mode === 'sbp' ? `<div class="field"><label for="s_sbp">Ссылка СБП из банка (https://qr.nspk.ru/…)</label><input class="inp" id="s_sbp" data-set="pay.sbpLink" value="${esc(p.sbpLink)}"></div><p class="small muted">Статичная ссылка СБП из кабинета банка. Покупатель вводит сумму сам — она показана рядом с кодом.</p>` :
    `<p class="small muted">QR по стандарту ГОСТ Р 56042: сумма и номер заказа подставятся в приложении банка автоматически.</p>
  <div class="field"><label for="s1">Получатель</label><input class="inp" id="s1" data-set="pay.name" value="${esc(p.name)}"></div><div class="two"><div class="field"><label for="s2">Расчётный счёт</label><input class="inp" id="s2" data-set="pay.account" inputmode="numeric" value="${esc(p.account)}"></div><div class="field"><label for="s3">Банк</label><input class="inp" id="s3" data-set="pay.bank" value="${esc(p.bank)}"></div>
  <div class="field"><label for="s4">БИК</label><input class="inp" id="s4" data-set="pay.bic" inputmode="numeric" value="${esc(p.bic)}"></div><div class="field"><label for="s5">Корр. счёт</label><input class="inp" id="s5" data-set="pay.corr" inputmode="numeric" value="${esc(p.corr)}"></div><div class="field"><label for="s6">ИНН</label><input class="inp" id="s6" data-set="pay.inn" inputmode="numeric" value="${esc(p.inn)}"></div></div>`}</div>
  <div class="box" style="margin-top:12px"><h3>Доставка</h3><div class="two"><div class="field"><label for="d0">Город склада (откуда считаем)</label><select class="inp" id="d0" data-set="origin">${CITIES.map(c => `<option ${c.n === s.origin ? 'selected' : ''}>${esc(c.n)}</option>`).join('')}</select></div>
  <div class="field"><label for="d1">Бесплатно от, шт. (0 — выкл.)</label><input class="inp" id="d1" type="number" min="0" data-set="freeFromItems" value="${s.freeFromItems}"></div></div>
  ${['ozon', 'cdek'].map(k => `<p style="margin:6px 0"><b>${k === 'ozon' ? 'Ozon' : 'СДЭК'}</b></p><div class="two" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="field"><label>База, ₽</label><input class="inp" type="number" data-set="${k}.base" value="${s[k].base}"></div><div class="field"><label>За км, ₽</label><input class="inp" type="number" step="0.005" data-set="${k}.perKm" value="${s[k].perKm}"></div><div class="field"><label>Доп. вещь, ₽</label><input class="inp" type="number" data-set="${k}.perItem" value="${s[k].perItem}"></div></div>`).join('')}
  <div class="field"><label for="d2">Доплата за удалённые регионы, ₽</label><input class="inp" id="d2" type="number" data-set="remoteExtra" value="${s.remoteExtra}"></div>
  <p class="small muted">Пример: ${esc(s.origin)} → ${s.origin === 'Москва' ? 'Иркутск' : 'Москва'}, Ozon, 1 вещь: ${rub(delivery('ozon', s.origin === 'Москва' ? 'Иркутск' : 'Москва', [{ pid: 'yosh', qty: 1 }])?.full || 0)}.</p></div>
  <div class="box" style="margin-top:12px"><h3>Возврат</h3><div class="seg" style="margin:8px 0 6px"><button class="${s.returns.mode !== 'law' ? 'on' : ''}" data-rmode="paid">Без возврата + гарантия</button><button class="${s.returns.mode === 'law' ? 'on' : ''}" data-rmode="law">14 дней на всё</button></div>
  <p class="small muted">${s.returns.mode !== 'law' ? 'Возврат не предусмотрен; покупатель может добавить «Гарантию возврата» на весь заказ. Перед запуском проверьте этот вариант у юриста.' : 'Возврат 14 дней на все товары, платная опция — расширенный возврат с доставкой за ваш счёт.'}</p>
  <div class="switch"><span>Предлагать платную опцию при оформлении</span><input type="checkbox" data-set="returns.extOn" ${s.returns.extOn ? 'checked' : ''}></div>
  <div class="two"><div class="field"><label>Цена, ₽</label><input class="inp" type="number" min="0" data-set="returns.extPrice" value="${s.returns.extPrice}"></div><div class="field"><label>Дней на возврат</label><input class="inp" type="number" min="7" data-set="returns.extDays" value="${s.returns.extDays}"></div></div></div>
  <div class="box" style="margin-top:12px"><h3>Бонусы</h3><div class="switch"><span>Бонусная программа включена</span><input type="checkbox" data-set="bonus.on" ${s.bonus.on ? 'checked' : ''}></div>
  <div class="two"><div class="field"><label>Начислять, % от заказа</label><input class="inp" type="number" min="0" max="50" data-set="bonus.earnPct" value="${s.bonus.earnPct}"></div><div class="field"><label>Оплатить бонусами до, %</label><input class="inp" type="number" min="0" max="100" data-set="bonus.maxSpendPct" value="${s.bonus.maxSpendPct}"></div></div>
  <p class="small muted">Бонусы начисляются, когда заказу ставится статус «Получен». При отмене заказа списанные бонусы возвращаются.</p></div>
  ${SB ? `<div class="box" style="margin-top:12px"><h3>Уведомления покупателям</h3>
  <label class="row" style="gap:10px"><input type="checkbox" data-set="notify.statusOn" ${s.notify.statusOn ? 'checked' : ''}><span class="f">Статус заказа (оплачен, отправлен, получен)</span></label>
  <label class="row" style="gap:10px"><input type="checkbox" data-set="notify.stockOn" ${s.notify.stockOn ? 'checked' : ''}><span class="f">«Снова в наличии» — автоматически, когда пополняете остаток</span></label>
  <label class="row" style="gap:10px"><input type="checkbox" data-set="notify.cartOn" ${s.notify.cartOn ? 'checked' : ''}><span class="f">Напоминать о брошенной корзине</span></label>
  <div class="two"><div class="field"><label>Первое напоминание через, часов</label><input class="inp" type="number" min="1" max="48" data-set="notify.cart1Hours" value="${esc(s.notify.cart1Hours)}"></div><div class="field"><label>Второе через, дней</label><input class="inp" type="number" min="1" max="14" data-set="notify.cart2Days" value="${esc(s.notify.cart2Days)}"></div>
  <div class="field"><label>Не писать с, ч</label><input class="inp" type="number" min="0" max="23" data-set="notify.quietFrom" value="${esc(s.notify.quietFrom)}"></div><div class="field"><label>до, ч (по времени покупателя)</label><input class="inp" type="number" min="0" max="23" data-set="notify.quietTo" value="${esc(s.notify.quietTo)}"></div></div>
  <p class="small muted">Напоминания получают только те, кто включил уведомления. Если вещи из корзины раскупили или покупатель уже оформил заказ — не пишем.</p></div>
  <div class="box" style="margin-top:12px"><h3>Новые заказы — в мой Telegram</h3><p class="small muted" style="margin-top:0">Бот пришлёт сообщение о каждом новом заказе и о нажатии «Я оплатил». Подключите каждый телефон сотрудника отдельно.</p><button class="btn sm" id="staffTg">Подключить Telegram</button></div>` : ''}
  <div class="box" style="margin-top:12px"><h3>Яндекс Метрика и реквизиты</h3><div class="two"><div class="field"><label>Номер счётчика Метрики</label><input class="inp" data-set="metrikaId" inputmode="numeric" placeholder="например, 98765432" value="${esc(s.metrikaId)}"></div>
  <div class="field"><label>Оператор данных (для политики)</label><input class="inp" data-set="legal.name" value="${esc(s.legal.name)}"></div><div class="field"><label>ИНН</label><input class="inp" data-set="legal.inn" value="${esc(s.legal.inn)}"></div><div class="field"><label>Email для запросов по данным</label><input class="inp" data-set="legal.email" value="${esc(s.legal.email)}"></div></div>
  <p class="small muted">Метрика включается только у покупателей, которые приняли cookie.</p></div>
  <div class="box" style="margin-top:12px"><h3>Контакты и доступ</h3><div class="two"><div class="field"><label>Instagram</label><input class="inp" data-set="contacts.instagram" value="${esc(s.contacts.instagram)}"></div><div class="field"><label>Telegram-канал</label><input class="inp" data-set="contacts.telegram" value="${esc(s.contacts.telegram)}"></div>
  <div class="field"><label>Telegram-группа</label><input class="inp" data-set="contacts.group" value="${esc(s.contacts.group)}"></div><div class="field"><label>Telegram менеджера</label><input class="inp" data-set="contacts.managerTg" value="${esc(s.contacts.managerTg)}"></div>
  <div class="field"><label>WhatsApp (номер)</label><input class="inp" data-set="contacts.whatsapp" inputmode="tel" value="${esc(s.contacts.whatsapp)}"></div>
  ${SB ? '' : `<div class="field"><label>PIN сотрудников</label><input class="inp" data-set="pin" inputmode="numeric" value="${esc(s.pin)}"></div>`}</div></div>
  ${SB ? `<div class="box" style="margin-top:12px"><h3>База Supabase</h3><p class="small muted">Подключена. Товаров в базе: ${DB.products.length}, заказов: ${DB.orders.length}.</p><button class="btn sec" id="seed">Загрузить каталог в базу</button></div>` : `<div class="box" style="margin-top:12px"><h3>Тестовые данные</h3><p class="small muted">Вернуть каталог, остатки и акции к исходным и удалить тестовые заказы.</p><button class="btn red sec" id="reset">Сбросить к исходным</button></div>`}`;
}
function bindAdmin() {
  const v = $('#view');
  v.oninput = e => {
    const t = e.target;
    if (t.id === 'admQ') { admQ = t.value; const pos = t.selectionStart; $('#admBody').innerHTML = adm === 'stock' ? admStock() : admProducts(); const n = $('#admQ'); n.focus(); n.setSelectionRange(pos, pos); }
  };
  v.onchange = e => {
    const t = e.target;
    if (t.dataset.stk) { const p = byId(t.dataset.stk); p.stock[t.dataset.k] = Math.max(0, parseInt(t.value) || 0); t.classList.toggle('low', p.stock[t.dataset.k] <= 1); save(); toast('Остаток сохранён'); }
    if (t.dataset.ost) { setStatus(t.dataset.ost, t.value); }
    if (t.dataset.set) { const path = t.dataset.set.split('.'); let o = DB.settings; while (path.length > 1) o = o[path.shift()]; o[path[0]] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value; save(); toast('Сохранено'); }
  };
  v.onclick = e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.adm) { adm = t.dataset.adm; admQ = ''; render(); }
    if (t.id === 'logout') { if (SB) SB.auth.signOut(); staff = false; go('profile'); }
    if (t.id === 'reload') { t.disabled = true; loadRemote(true).then(() => { render(); toast('Обновлено'); }).catch(() => { t.disabled = false; toast('Не удалось обновить'); }); }
    if (t.id === 'seed') confirmBox('Загрузить 40 моделей из каталога в базу? Товары с такими же названиями будут перезаписаны.', async () => { DB.products = clone(SEED.products); if (!DB.promos.length) DB.promos = clone(SEED.promos); if (!DB.campaigns.length) DB.campaigns = clone(SEED.campaigns); clearTimeout(syncT); if (await sbSync()) { toast('Каталог загружен в базу'); render(); } });
    if (t.dataset.of) { ordF = t.dataset.of; render(); }
    if (t.dataset.per) { statPer = +t.dataset.per; statData = null; render(); }
    if (t.dataset.wdone) markWish(t.dataset.wdone);
    if (t.id === 'staffTg') staffTg();
    if (t.id === 'nSend') sendNews();
    if (t.id === 'mkLink') { const u = buildUtm(); $('#utmOut').textContent = u; (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => toast('Ссылка скопирована'), () => toast('Скопируйте ссылку ниже')); }
    if (t.dataset.rvs) setReview(t.dataset.rid, t.dataset.rvs);
    if (t.dataset.rvd) confirmBox('Удалить отзыв?', () => setReview(t.dataset.rvd, ''));
    if (t.dataset.edit) editProduct(t.dataset.edit);
    if (t.id === 'newP') editProduct(null);
    if (t.dataset.ptog) { const p = DB.promos.find(x => x.id === t.dataset.ptog); p.active = !p.active; save(); render(); }
    if (t.dataset.pdel) confirmBox('Удалить промокод?', () => { DB.promos = DB.promos.filter(x => x.id !== t.dataset.pdel); save(); render(); });
    if (t.dataset.ctog) { const c = DB.campaigns.find(x => x.id === t.dataset.ctog); c.active = !c.active; save(); render(); toast(c.active ? 'Акция запущена' : 'Акция остановлена'); }
    if (t.dataset.cdel) confirmBox('Удалить акцию?', () => { DB.campaigns = DB.campaigns.filter(x => x.id !== t.dataset.cdel); save(); render(); });
    if (t.id === 'addPromo') {
      const code = $('#pc').value.trim().toUpperCase(), val = +$('#pv').value;
      if (!code || !val) return toast('Укажите код и размер скидки');
      if (DB.promos.some(p => p.code === code)) return toast('Такой код уже есть');
      DB.promos.push({ id: uid(), code, type: $('#pt').value, value: val, minSum: +$('#pm').value || 0, active: true, note: '' }); save(); render(); toast('Промокод создан');
    }
    if (t.id === 'addCamp') {
      const title = $('#ct').value.trim(), percent = +$('#cp').value, cat = $('#cc').value, ids = [...document.querySelectorAll('.cpi:checked')].map(x => x.value);
      if (!title || !percent) return toast('Укажите название и скидку');
      if (!cat && !ids.length) return toast('Выберите категорию или товары');
      DB.campaigns.push({ id: uid(), title, text: $('#cx').value.trim(), cat, productIds: ids, percent: Math.min(90, percent), active: true }); save(); render(); toast('Акция запущена');
    }
    if (t.dataset.pm) { DB.settings.pay.mode = t.dataset.pm; save(); render(); }
    if (t.dataset.rmode) { DB.settings.returns.mode = t.dataset.rmode; save(); render(); toast('Режим возврата изменён'); }
    if (t.id === 'reset') confirmBox('Сбросить все данные магазина к исходным? Тестовые заказы будут удалены.', () => { DB = clone(SEED); save(); myOrders = []; ls.set(MK, []); cart = []; saveCart(); render(); toast('Данные сброшены'); });
  };
}
function setStatus(id, st) {
  const o = DB.orders.find(x => x.id === id), prev = o.status;
  if (st === 'cancelled' && prev !== 'cancelled') o.items.forEach(i => { const p = byId(i.pid); if (p) p.stock[i.color + '|' + i.size] = (p.stock[i.color + '|' + i.size] || 0) + i.qty; });
  if (prev === 'cancelled' && st !== 'cancelled') o.items.forEach(i => { const p = byId(i.pid); if (p) p.stock[i.color + '|' + i.size] -= i.qty; });
  o.status = st; const B = DB.settings.bonus;
  o.bonusEarned = st === 'done' && B.on ? Math.floor(Math.max(0, (o.subtotal || 0) - (o.discount || 0) - (o.bonusSpent || 0)) * B.earnPct / 100) : 0;
  save(); render(); toast(st === 'cancelled' ? 'Заказ отменён, товар вернулся в остатки' : 'Статус: ' + STATUS[st]);
}
function confirmBox(msg, yes) {
  sheet('Подтверждение', `<div class="sh-b"><p>${esc(msg)}</p><div class="two"><button class="btn sec" data-close>Отмена</button><button class="btn" id="yes" style="background:var(--red);color:#fff">Да</button></div></div>`, api => { api.el.querySelector('#yes').onclick = () => { api.close(); yes(); }; });
}
function resizeImg(file, max = 700, q = .78) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const im = new Image(); im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement('canvas'); c.width = im.width * k; c.height = im.height * k; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', q)); }; im.onerror = rej; im.src = r.result; }; r.onerror = rej; r.readAsDataURL(file); });
}
function editProduct(id) {
  const src = id ? byId(id) : { id: '', name: '', cat: DB.categories[0], price: 0, oldPrice: 0, desc: '', comp: '', specs: '', params: [], sizes: ['42–48'], colors: ['Чёрный'], photos: [], stock: {}, hidden: false, freeShip: false, isNew: true, tag: '' };
  const p = clone(src);
  sheet(id ? 'Редактировать товар' : 'Новый товар', '', api => {
    const draw = () => api.set(`<div class="sh-b">
    <div class="field"><label for="e_n">Название</label><input class="inp" id="e_n" value="${esc(p.name)}"></div>
    <div class="two"><div class="field"><label for="e_c">Категория</label><select class="inp" id="e_c">${DB.categories.map(c => `<option ${c === p.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div><div class="field"><label for="e_t">Метка (необязательно)</label><input class="inp" id="e_t" value="${esc(p.tag || '')}" placeholder="Новый материал"></div>
    <div class="field"><label for="e_p">Цена, ₽</label><input class="inp" id="e_p" type="number" min="0" value="${p.price}"></div><div class="field"><label for="e_o">Старая цена, ₽ (для скидки)</label><input class="inp" id="e_o" type="number" min="0" value="${p.oldPrice || ''}"></div></div>
    <div class="field"><label for="e_d">Описание</label><textarea class="inp" id="e_d">${esc(p.desc)}</textarea></div>
    <div class="field"><label for="e_m">Состав</label><input class="inp" id="e_m" value="${esc(p.comp)}"></div>
    <h3 style="margin-top:12px">Параметры</h3><p class="small muted" style="margin-top:0">Покупатель видит их по кнопке «Смотреть параметры». Например: Длина — 65 см, Ширина — 60×2 см.</p>
    <div class="prm">${(p.params || []).map((r, i) => `<div class="prow"><input class="inp" data-pn="${i}" placeholder="Название" value="${esc(r.n)}"><input class="inp" data-pv="${i}" placeholder="Значение" value="${esc(r.v)}"><button class="x" data-pdel="${i}" aria-label="Удалить параметр">×</button></div>`).join('')}</div>
    <button class="btn sec sm" id="e_padd" style="margin:6px 0 4px">+ Добавить параметр</button>
    <label class="row" style="gap:10px;margin:4px 0 8px"><input type="checkbox" id="e_pnote" ${paramsNoteOn(p) ? 'checked' : ''}><span class="f small">Показывать пояснение «Замеры сняты с изделия в разложенном виде, ×2 — ширина…»</span></label>
    <div class="field"><label for="e_care">Уход (если очистить поле — подставится подсказка по составу)</label><textarea class="inp" id="e_care" rows="3">${esc(careOf(p))}</textarea></div>
    <div class="field"><label for="e_col">Цвета через запятую</label><input class="inp" id="e_col" value="${esc(p.colors.join(', '))}"></div>
    <div class="field"><label for="e_sz">Размеры через запятую</label><input class="inp" id="e_sz" value="${esc(p.sizes.join(', '))}"></div>
    <div class="switch"><span>Показывать в магазине</span><input type="checkbox" id="e_h" ${p.hidden ? '' : 'checked'}></div>
    <div class="switch"><span>Бесплатная доставка</span><input type="checkbox" id="e_f" ${p.freeShip ? 'checked' : ''}></div>
    <div class="switch"><span>Метка «Новинка»</span><input type="checkbox" id="e_new" ${p.isNew ? 'checked' : ''}></div>
    <h3 style="margin-top:12px">Фото</h3><div class="phs">${p.photos.map((f, i) => `<div><img src="${esc(f.src)}" alt=""><button class="x" data-xph="${i}" aria-label="Удалить фото">×</button><span class="mv"><button data-phl="${i}" ${i ? '' : 'disabled'} aria-label="Левее">‹</button>${i ? `<button data-ph1="${i}" aria-label="Сделать главным">★</button>` : '<em>главное</em>'}<button data-phr="${i}" ${i < p.photos.length - 1 ? '' : 'disabled'} aria-label="Правее">›</button></span><select data-phc="${i}"><option value="">Общее</option>${p.colors.map(c => `<option ${c === f.color ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('')}</div>
    <label class="btn sec sm" style="margin-top:10px">Добавить фото<input type="file" accept="image/*" multiple id="e_up" hidden></label>
    <h3 style="margin-top:18px">Остатки</h3><div class="scroll"><table><thead><tr><th>Цвет</th>${p.sizes.map(s => `<th>${esc(s)}</th>`).join('')}</tr></thead><tbody>${p.colors.map(c => `<tr><td>${esc(c)}</td>${p.sizes.map(s => `<td><input class="stk" type="number" min="0" data-ek="${esc(c + '|' + s)}" value="${p.stock[c + '|' + s] ?? 0}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <button class="btn w" id="e_save" style="margin-top:16px">Сохранить</button>${id ? '<button class="btn w red" id="e_del" style="margin-top:6px">Удалить товар</button>' : ''}</div>`);
    const read = () => {
      p.name = $('#e_n').value.trim(); p.cat = $('#e_c').value; p.tag = $('#e_t').value.trim(); p.price = +$('#e_p').value || 0; p.oldPrice = +$('#e_o').value || 0;
      p.desc = $('#e_d').value; { const c = $('#e_care').value.trim(); p.care = c === defaultCare(p) ? '' : c; } p.comp = $('#e_m').value; p.paramsNote = $('#e_pnote').checked;
      p.params = [...api.el.querySelectorAll('[data-pn]')].map(x => ({ n: x.value.trim(), v: (api.el.querySelector(`[data-pv="${x.dataset.pn}"]`).value || '').trim() })); p.hidden = !$('#e_h').checked; p.freeShip = $('#e_f').checked; p.isNew = $('#e_new').checked;
      api.el.querySelectorAll('[data-ek]').forEach(x => p.stock[x.dataset.ek] = Math.max(0, parseInt(x.value) || 0));
    };
    draw();
    api.el.addEventListener('change', async e => {
      const t = e.target;
      if (t.id === 'e_col' || t.id === 'e_sz') { read(); const arr = t.value.split(',').map(x => x.trim()).filter(Boolean); if (t.id === 'e_col') p.colors = arr; else p.sizes = arr; draw(); }
      if (t.dataset.phc) p.photos[+t.dataset.phc].color = t.value;
      if (t.id === 'e_up') { read(); for (const f of t.files) { try { let src = await resizeImg(f); if (SB) { toast('Загружаем фото…'); src = await uploadPhoto(src); } p.photos.push({ src, color: '' }); } catch { toast('Не удалось прочитать файл'); } } draw(); }
    });
    api.el.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.xph) { read(); p.photos.splice(+t.dataset.xph, 1); draw(); }
      if (t.dataset.phl || t.dataset.phr || t.dataset.ph1) {   // порядок фото: первое — обложка в каталоге
        read(); const i = +(t.dataset.phl || t.dataset.phr || t.dataset.ph1), j = t.dataset.ph1 ? 0 : t.dataset.phl ? i - 1 : i + 1;
        if (j >= 0 && j < p.photos.length) { const [f] = p.photos.splice(i, 1); p.photos.splice(j, 0, f); draw(); }
      }
      if (t.id === 'e_padd') { read(); (p.params ||= []).push({ n: '', v: '' }); draw(); api.el.querySelector(`[data-pn="${p.params.length - 1}"]`)?.focus(); }
      if (t.dataset.pdel) { read(); p.params.splice(+t.dataset.pdel, 1); draw(); }
      if (t.id === 'e_save') {
        read();
        p.params = (p.params || []).filter(r => r.n || r.v);
        if (!p.name || !p.price) return toast('Укажите название и цену');
        if (!p.colors.length || !p.sizes.length) return toast('Нужен хотя бы один цвет и размер');
        Object.keys(p.stock).forEach(k => { const [c, s] = k.split('|'); if (!p.colors.includes(c) || !p.sizes.includes(s)) delete p.stock[k]; });
        if (id) DB.products[DB.products.findIndex(x => x.id === id)] = p;
        else { p.id = p.name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-') + '-' + uid().slice(0, 4); DB.products.unshift(p); }
        save(); api.close(); render(); toast('Товар сохранён');
      }
      if (t.id === 'e_del') confirmBox(`Удалить «${p.name}» из магазина?`, () => { DB.products = DB.products.filter(x => x.id !== id); cart = cart.filter(i => i.pid !== id); saveCart(); save(); api.close(); render(); toast('Товар удалён'); });
    });
  });
}

/* ===== Общие события ===== */
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-go]'); if (!t) return;
  if (t.dataset.inst) return installAction(t.dataset.inst);
  if (t.dataset.contact !== undefined) return openContact(t.dataset.contact);
  if (t.dataset.returns) return openReturns();
  if (t.dataset.admgo) { admLast[admGroupOf(adm)] = adm; const g = t.dataset.admgo; adm = admLast[g] || ADM_GROUPS[g][0]; admQ = ''; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.admto) { adm = t.dataset.admto; admQ = ''; if (t.dataset.of) ordF = t.dataset.of; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.policy) return openPolicy();
  if (t.dataset.notify) return openNotify();
  if (t.dataset.notihide) { ls.set('desire_notif_hide', 1); return render(); }
  if (t.dataset.consent) { if (t.dataset.consent === 'reset') { try { localStorage.removeItem(CONSENT); } catch {} toast('Выберите настройки cookie внизу экрана'); document.querySelectorAll('.sheetbg [data-close]').forEach(b => b.click()); return consentBanner(); } ls.set(CONSENT, t.dataset.consent); document.getElementById('cookie')?.remove(); if (t.dataset.consent === 'all') loadMetrika(); return; }
  if (t.id === 'chatBtn') return openContact('');
  if (t.dataset.go) return go(t.dataset.go);
  if (t.dataset.fav && !t.closest('.sheet')) return toggleFav(t.dataset.fav);
  if (t.dataset.open && !t.closest('.sheet')) return openProduct(t.dataset.open);
  if (t.dataset.cat !== undefined && route !== 'admin') { catFilter = t.dataset.cat; if (route === 'catalog') track('catalog', { meta: { cat: catFilter } }); if (route !== 'catalog') go('catalog'); else render(); return; }
  if (t.dataset.q) { const i = cart[+t.dataset.q], p = byId(i.pid), n = i.qty + +t.dataset.d; if (n > stockOf(p, i.color, i.size)) return toast('Больше нет в наличии'); if (n < 1) cart.splice(+t.dataset.q, 1); else i.qty = n; saveCart(); render(); return; }
  if (t.dataset.rm) { cart.splice(+t.dataset.rm, 1); saveCart(); render(); return; }
  if (t.id === 'applyPromo') { const c = $('#promo').value.trim().toUpperCase(), p = DB.promos.find(x => x.code === c && x.active); if (!p) { promoApplied = null; toast('Промокод не найден'); } else { promoApplied = c; toast(promoDiscount(subtotal()) ? 'Промокод применён' : `Промокод действует от ${rub(p.minSum)}`); } render(); return; }
  if (t.id === 'checkout') return openCheckout();
  if (t.dataset.order) return openOrder(t.dataset.order);
  if (t.id === 'staffBtn') return openStaffLogin();
  if (t.id === 'logo') return go('home');
  if (t.id === 'searchBtn') { go('catalog'); setTimeout(() => $('#q')?.focus(), 50); }
});
let qt, sqt;
const searchCount = q => visible().filter(p => (p.name + ' ' + p.cat + ' ' + p.colors.join(' ') + ' ' + p.desc).toLowerCase().includes(q)).length;
document.addEventListener('input', e => {
  if (e.target.id === 'q') { query = e.target.value; clearTimeout(sqt); sqt = setTimeout(() => { const q = query.trim().toLowerCase(); if (q.length >= 2) track('search', { q: q.slice(0, 60), val: searchCount(q) }); }, 1500); clearTimeout(qt); qt = setTimeout(() => { const pos = e.target.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); }, 200); }
});
document.addEventListener('change', e => { if (e.target.id === 'sort') { sortBy = e.target.value; render(); } });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== route && TABS.some(x => x[0] === h)) { route = h; render(); } });

/* ===== Установка на телефон (иконка на экране «Домой») ===== */
const UA = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(UA);
const inApp = /Instagram|FBAN|FBAV|FB_IAB/i.test(UA);
const isYandex = /YaBrowser|YaSearchBrowser/i.test(UA);
const isSamsung = /SamsungBrowser/i.test(UA);
const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (route === 'home' || route === 'profile') render(); });
window.addEventListener('appinstalled', () => { track('install'); installEvt = null; toast('DESIRE установлен на телефон'); render(); });
const installMode = () => standalone ? '' : inApp ? 'inapp' : installEvt ? 'prompt' : isIOS ? 'ios' : isAndroid ? 'android' : '';
const DISMISS_KEY = 'desire_inst_hide';
function installBanner(always) {
  const m = installMode();
  if (!m) return always && standalone ? '<div class="inst"><img src="icon-192.png" alt=""><div class="f"><b>Приложение установлено</b><span>Вы открыли DESIRE с экрана телефона</span></div></div>' : '';
  if (!always && Date.now() < (+ls.get(DISMISS_KEY) || 0)) return '';
  const txt = {
    inapp: ['Установите DESIRE на телефон', 'Сейчас магазин в окне Instagram. Нажмите «Как?» — покажем, где кнопка'],
    prompt: ['Установите приложение DESIRE', 'Иконка на экране, магазин открывается в одно касание'],
    ios: ['Добавьте DESIRE на экран «Домой»', 'Магазин будет открываться как приложение'],
    android: ['Добавьте DESIRE на главный экран', 'Магазин будет открываться как приложение']
  }[m];
  const btn = m === 'prompt' ? '<button class="btn sm" data-inst="go">Установить</button>' : '<button class="btn sm" data-inst="guide">Как?</button>';
  return `<div class="inst"><img src="icon-192.png" alt=""><div class="f"><b>${txt[0]}</b><span>${txt[1]}</span></div>${btn}${always ? '' : `<button class="icon" data-inst="hide" aria-label="Скрыть" style="width:36px;height:36px">${svg('close')}</button>`}</div>`;
}
const KBD = {
  dots: '<span class="kbd">•••</span>',
  vdots: '<span class="kbd">⋮</span>',
  share: '<span class="kbd"><svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span>',
  safari: '<span class="kbd" style="color:#1a7cf5"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor"/></svg></span>',
  burger: '<span class="kbd">☰</span>',
  plus: '<span class="kbd"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg></span>'
};
// Схема встроенного окна Instagram: значок Safari внизу справа
const IG_WINDOW = `<svg viewBox="0 0 300 230" role="img" aria-label="Встроенное окно Instagram: значок Safari внизу справа" style="width:100%;max-width:340px;display:block;margin:6px auto 2px">
  <rect x="40" y="6" width="220" height="218" rx="22" fill="var(--card)" stroke="var(--line)" stroke-width="2"/>
  <rect x="52" y="20" width="196" height="26" rx="8" fill="var(--fill)"/>
  <path d="M62 29l8 8M70 29l-8 8" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/>
  <text x="150" y="37" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="-apple-system,Inter,sans-serif">desire-shop</text>
  <g fill="var(--muted)"><circle cx="226" cy="33" r="2"/><circle cx="233" cy="33" r="2"/><circle cx="240" cy="33" r="2"/></g>
  <rect x="60" y="58" width="180" height="60" rx="10" fill="var(--beige)"/>
  <rect x="60" y="126" width="120" height="8" rx="4" fill="var(--fill)"/><rect x="60" y="140" width="150" height="8" rx="4" fill="var(--fill)"/>
  <line x1="40" y1="172" x2="260" y2="172" stroke="var(--line)" stroke-width="2"/>
  <path d="M70 191l-7 7 7 7M100 191l7 7-7 7" stroke="var(--muted)" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M150 203v-14M145 193l5-5 5 5M142 196h-2v12h20v-12h-2" stroke="var(--muted)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="222" cy="198" r="17" fill="none" stroke="#e30000" stroke-width="3"/>
  <circle cx="222" cy="198" r="10" fill="none" stroke="#1a7cf5" stroke-width="2.2"/><path d="M226 194l-2.5 6-6 2.5 2.5-6z" fill="#1a7cf5"/>
  <path d="M268 160c18 10 18 30 -22 36" stroke="#e30000" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M252 189l-8 7 10 3" stroke="#e30000" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="278" y="150" text-anchor="middle" font-size="12" font-weight="700" fill="#e30000" font-family="-apple-system,Inter,sans-serif">Safari</text>
</svg>`;
function openInstallGuide() {
  const link = location.origin + '/';
  let steps = '', extra = '', intro = '';
  if (inApp && isIOS) { intro = `<div class="note" style="margin:10px 0 4px">Сейчас магазин открыт <b>во всплывающем окне Instagram</b> — это не браузер, из него иконку на экран не добавить. Сначала откройте магазин в Safari.</div>${IG_WINDOW}`;
    steps = `<li><div>Нажмите значок Safari ${KBD.safari} <b>внизу справа</b> — магазин откроется в браузере Safari.<br><span class="small muted">Нет такого значка? Нажмите ${KBD.dots} <b>вверху справа</b> → «Открыть во внешнем браузере».</span></div></li>
    <li><div>В Safari нажмите ${KBD.share} <b>«Поделиться»</b>. На новых iPhone она спрятана в кнопке ${KBD.dots} внизу справа.</div></li>
    <li><div>Выберите ${KBD.plus} <b>«На экран „Домой“»</b> и нажмите <b>«Добавить»</b>. На экране появится иконка DESIRE.</div></li>`; }
  else if (inApp) { intro = `<div class="note" style="margin:10px 0 4px">Сейчас магазин открыт <b>во всплывающем окне Instagram</b> — это не браузер, из него иконку на экран не добавить. Сначала откройте магазин в браузере.</div>`;
    steps = `<li><div>Нажмите кнопку <b>«Открыть в браузере»</b> ниже — магазин откроется в вашем обычном браузере (Chrome, Яндекс, Samsung — какой стоит на телефоне). Если телефон спросит, чем открыть, выберите любой браузер.<br><span class="small muted">Или нажмите ${KBD.vdots} <b>вверху справа</b> → «Открыть в браузере» / «Открыть в Chrome».</span></div></li>
    <li><div>В браузере появится предложение <b>«Установить приложение»</b>. Если его нет — откройте меню браузера (${KBD.vdots} или ${KBD.burger}) и выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>.</div></li>`;
    extra = `<a class="btn w" style="margin-top:14px" href="intent://${location.host}/#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end">Открыть в браузере</a>`; }
  else if (isIOS) steps = `<li><div>Нажмите ${KBD.share} <b>«Поделиться»</b> внизу экрана. На новых iPhone она спрятана в кнопке ${KBD.dots} внизу справа.</div></li>
    <li><div>Пролистайте вниз и выберите ${KBD.plus} <b>«На экран „Домой“»</b>.</div></li>
    <li><div>Нажмите <b>«Добавить»</b> — на экране появится иконка DESIRE.</div></li>`;
  else if (isYandex) steps = `<li><div>Нажмите ${KBD.vdots} <b>в нижней панели Яндекс Браузера</b> (справа от адресной строки).</div></li>
    <li><div>Выберите <b>«Добавить ярлык»</b> или <b>«Установить приложение»</b>. Если такого пункта нет в первом экране меню — пролистайте его вправо или вниз.</div></li>`;
  else if (isSamsung) steps = `<li><div>Если в адресной строке есть значок установки (стрелка вниз), нажмите его. Иначе нажмите ${KBD.burger} <b>внизу справа</b>.</div></li>
    <li><div>Выберите <b>«Добавить страницу на»</b> → <b>«Главный экран»</b>.</div></li>`;
  else steps = `<li><div>Нажмите ${KBD.vdots} в правом верхнем углу Chrome.</div></li>
    <li><div>Выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>.</div></li>
    <li><div>Подтвердите — на экране появится иконка DESIRE.</div></li>`;
  sheet('Установка на телефон', `<div class="sh-b"><div class="inst" style="margin-top:4px"><img src="icon-192.png" alt=""><div class="f"><b>DESIRE</b><span>${esc(location.host)}</span></div></div>
    ${intro}<ol class="steps">${steps}</ol>${extra}
    <button class="btn w sec" style="margin-top:12px" data-inst="copy">Скопировать ссылку на магазин</button>
    <p class="small muted">Если кнопки не находятся — скопируйте ссылку и вставьте её в адресную строку браузера.</p></div>`);
}
async function installAction(a) {
  if (a === 'guide') return openInstallGuide();
  if (a === 'hide') { ls.set(DISMISS_KEY, Date.now() + 14 * 864e5); return render(); }
  if (a === 'copy') { try { await navigator.clipboard.writeText(location.origin + '/'); toast('Ссылка скопирована'); } catch { toast(location.origin + '/'); } return; }
  if (a === 'go' && installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch {} installEvt = null; render(); }
}
if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window.self) { try { navigator.serviceWorker.register('/sw.js').catch(() => {}); } catch {} }
const h0 = location.hash.slice(1); if (TABS.some(x => x[0] === h0)) route = h0;
async function deepLink(h) {
  const m = /^(p|order)=(.+)$/.exec(h || ''); if (!m) return false;
  const id = decodeURIComponent(m[2]);
  document.querySelectorAll('.sheetbg').forEach(x => x.remove()); document.body.style.overflow = '';
  for (let i = 0; i < 40 && loading; i++) await new Promise(r => setTimeout(r, 250));
  if (m[1] === 'p') { const p = byId(id); history.replaceState(null, '', '#catalog'); route = 'catalog'; render(); if (p) openProduct(p.id); }
  else { history.replaceState(null, '', '#profile'); route = 'profile'; if (SB && myTokens.length) await loadMine(); render(); openOrder(id); }
  return true;
}
deepLink(h0);
window.addEventListener('hashchange', () => deepLink(location.hash.slice(1)));
setTimeout(() => { consentBanner(); loadMetrika(); }, 800);
// Один раз предлагаем уведомления — не сразу, а когда покупатель уже осмотрелся
setTimeout(function askNotify() {
  if (!SB || notifOn || ls.get('desire_notif_asked') || staff) return;
  if (document.querySelector('.sheetbg') || document.getElementById('cookie') || route === 'admin') return setTimeout(askNotify, 15000);
  ls.set('desire_notif_asked', 1); openNotify('first');
}, 25000);
if (newSession) track('visit', { meta: { standalone: standalone, ref: (document.referrer || '').slice(0, 80), medium: visitSrc?.medium || '', campaign: visitSrc?.campaign || '' } });
render();
if (SB) {
  const tm = setTimeout(() => { if (loading) { loading = false; loadErr = 'База не отвечает. Проверьте интернет и обновите страницу.'; render(); } }, 12000);
  (async () => {
    try {
      const { data } = await SB.auth.getSession(); staff = !!data.session;
      await loadRemote(staff); await loadMine(); await loadBonus();
    } catch (e) { loadErr = 'Не удалось загрузить магазин: ' + (e.message || e); }
    clearTimeout(tm); if (loading) { loading = false; render(); }
  })();
  setInterval(() => { if (route === 'admin' && staff && adm === 'orders' && !document.querySelector('.sheetbg')) loadRemote(true).then(render).catch(() => {}); }, 30000);
}
}
