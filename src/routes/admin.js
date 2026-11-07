const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const pricing = require('../lib/pricing');
const mailer = require('../lib/mailer');
const yookassa = require('../lib/yookassa');
const { refreshRate } = require('../lib/rates');
const { ORDER_STATUSES, NEXT_STATUSES, BALANCE_OPS, CATEGORIES, BEAUTY_SUBCATS, DELIVERY_METHODS, PAYMENT_METHODS, PARSE_RESULTS, parseLabel,
  HOME_TAB_KEYS, NO_RANK, parseHomeTabs, formatHomeTabs, TILE_FONTS, cleanHex } = require('../lib/format');
const payments = require('../services/payments');
const { parseProduct, browserStatus } = require('../lib/parser');
const { safeUrl, slugify, regionPrefix, rootDomain } = require('../lib/urls');
const orders = require('../services/orders');
const balance = require('../services/balance');
const { categoryList } = require('../services/stores');

const router = express.Router();
const fmtRub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

const logoDir = path.join(config.uploadsDir, 'logos');
fs.mkdirSync(logoDir, { recursive: true });
const makeUpload = (dir) => multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(file.mimetype)),
});
const logoUpload = makeUpload(logoDir);

router.use((req, res, next) => {
  res.locals.adminNav = [
    ['/admin', 'Сводка'],
    ['/admin/orders', 'Заказы'],
    ['/admin/purchases', 'По магазинам'],
    ['/admin/balance', 'Балансы'],
    ['/admin/stores', 'Магазины'],
    ['/admin/users', 'Покупатели'],
    ['/admin/settings', 'Настройки'],
  ];
  res.locals.ORDER_STATUSES = ORDER_STATUSES;
  // Оплаченные, но ещё не отправленные заказы — работа менеджера; заявки на пополнение по реквизитам ждут зачисления
  res.locals.newOrdersCount = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n;
  res.locals.pendingTopups = db.prepare("SELECT COUNT(*) AS n FROM balance_ops WHERE type = 'topup' AND status = 'pending' AND provider = 'manual'").get().n;
  next();
});

// ---------- Сводка ----------
router.get('/', (req, res) => {
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  const recent = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();
  const paidSum = db.prepare("SELECT COALESCE(SUM(total_rub),0) AS s FROM orders WHERE status IN ('paid','purchased','shipped','delivered')").get().s;
  const monthSum = db.prepare("SELECT COALESCE(SUM(total_rub),0) AS s FROM orders WHERE status IN ('paid','purchased','shipped','delivered') AND paid_at >= datetime('now','-30 days')").get().s;
  const users = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n;
  const toBuy = db.prepare("SELECT COALESCE(SUM(oi.qty), 0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'paid' AND oi.item_status != 'unavailable'").get().n;
  const balances = db.prepare("SELECT COALESCE(SUM(amount_rub), 0) AS s FROM balance_ops WHERE status = 'done'").get().s;
  res.render('admin/dashboard', {
    title: 'Сводка', byStatus, recent, paidSum, monthSum, users, toBuy, balances,
    quote: pricing.quote(), rateUpdated: settings.get('rate_updated_at'), mail: mailer.mailStatus(), yookassaOn: yookassa.enabled(), payMode: payments.mode(),
  });
});

// ---------- Заказы ----------
router.get('/orders', (req, res) => {
  const status = ORDER_STATUSES[req.query.status] ? req.query.status : '';
  const q = String(req.query.q || '').trim();
  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (q) { where.push('(number LIKE @q OR customer_name LIKE @q OR email LIKE @q OR phone LIKE @q)'); params.q = `%${q}%`; }
  const list = db.prepare(`SELECT o.*, (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT 300`).all(params);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/orders', { title: 'Заказы', list, status, q, counts });
});

router.get('/orders/:id', (req, res, next) => {
  const order = orders.getOrder(req.params.id);
  if (!order) return next();
  res.render('admin/order', {
    title: `Заказ ${order.number}`, order, DELIVERY_METHODS, NEXT_STATUSES,
    euLimit: parseFloat(settings.get('eu_limit_eur', '300')) || 0,
    methodLabel: payments.methodLabel(order.payment_method), userBalanceRub: balance.get(order.user_id),
  });
});

// Товар закончился до выкупа — вернуть его стоимость на баланс покупателя
router.post('/orders/:id/items/:itemId/refund', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return next();
  const r = orders.refundItem(order.id, Number(req.params.itemId), req.user.id);
  if (!r) req.flash('error', 'Вернуть деньги за позицию можно только в оплаченном и ещё не отправленном заказе.');
  else if (r.cancelled) req.flash('ok', `Товаров в заказе не осталось — заказ отменён, на баланс покупателя возвращено ${fmtRub(r.amount)}.`);
  else req.flash('ok', `На баланс покупателя возвращено ${fmtRub(r.amount)}. Покупатель получил письмо.`);
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/status', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return next();
  const allowed = NEXT_STATUSES[order.status] || [order.status];
  const status = allowed.includes(req.body.status) ? req.body.status : order.status;
  const tracking = String(req.body.tracking_number || '').trim().slice(0, 100);
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const notify = Boolean(req.body.notify);
  if (status === 'shipped' && !tracking) {
    req.flash('error', 'Укажите трек-номер — покупатель получит его в письме.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  db.prepare("UPDATE orders SET tracking_number = ?, manager_comment = ?, updated_at = datetime('now') WHERE id = ?")
    .run(tracking, String(req.body.manager_comment || '').trim().slice(0, 2000), order.id);
  if (status === order.status) {
    req.flash('ok', 'Данные заказа сохранены.');
  } else if (status === 'cancelled') {
    const r = orders.cancel(order.id, { note, notify, adminId: req.user.id });
    req.flash('ok', `Заказ отменён.${r && r.refunded ? ` На баланс покупателя возвращено ${fmtRub(r.refunded)}.` : ''}${notify ? ' Покупателю отправлено письмо.' : ''}`);
  } else {
    orders.setStatus(order.id, status, { note, notify });
    req.flash('ok', `Статус изменён: ${ORDER_STATUSES[status].label}.${notify ? ' Покупателю отправлено письмо.' : ''}`);
  }
  res.redirect(`/admin/orders/${order.id}`);
});

// ---------- По магазинам: позиции всех заказов, собранные по магазину, внутри — по покупателю ----------
// ZARA: 2 товара у одного покупателя и 3 у другого — в одной карточке, удобно выкупать одной корзиной.
// Оплаченные заказы — к выкупу; после отправки (трек-номер) заказ уходит во вкладку «Отправлены».
const BY_STORE = {
  paid: { label: 'Оплачены', statuses: ['paid'] },
  shipped: { label: 'Отправлены', statuses: ['shipped'] },
};
router.get('/purchases', (req, res) => {
  const filter = BY_STORE[req.query.s] ? req.query.s : 'paid';
  const statuses = BY_STORE[filter].statuses;
  const rows = db.prepare(`SELECT oi.*, o.number, o.id AS order_id, o.status AS order_status, o.customer_name, o.phone, o.email, o.user_id,
      o.city AS order_city, o.address AS order_address, o.delivery_method AS order_delivery,
      s.slug AS store_slug, s.name AS store_title, s.icon_domain, s.logo_path, s.url AS store_url, s.tile_bg, s.tile_fg, s.tile_font, s.tile_text
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN stores s ON s.id = oi.store_id
    WHERE o.status IN (${statuses.map(() => '?').join(',')}) AND oi.item_status != 'unavailable'
    ORDER BY o.id, oi.id`).all(...statuses);

  const stores = new Map();
  for (const r of rows) {
    const sk = r.store_id ? 's' + r.store_id : 'n' + (r.store_name || '');
    if (!stores.has(sk)) {
      stores.set(sk, { name: r.store_title || r.store_name || 'Другой магазин', store: r, customers: new Map(), qty: 0, sumEur: 0, orders: new Set() });
    }
    const st = stores.get(sk);
    // Один человек — по аккаунту, без аккаунта — по почте/телефону
    const ck = r.user_id ? 'u' + r.user_id : 'c' + (r.email || r.phone || r.order_id);
    if (!st.customers.has(ck)) st.customers.set(ck, { name: r.customer_name, phone: r.phone, orders: new Map(), items: [], qty: 0 });
    const c = st.customers.get(ck);
    c.orders.set(r.order_id, {
      id: r.order_id, number: r.number, status: r.order_status,
      address: [r.order_city, r.order_address].filter(Boolean).join(', '), delivery: DELIVERY_METHODS[r.order_delivery] || '',
    });
    c.items.push(r);
    c.qty += r.qty;
    st.qty += r.qty;
    st.sumEur += r.price_eur * r.qty;
    st.orders.add(r.order_id);
  }
  const groups = [...stores.values()]
    .map((st) => ({ ...st, orderCount: st.orders.size, customers: [...st.customers.values()].map((c) => ({ ...c, orders: [...c.orders.values()] })) }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'ru'));

  // Сколько позиций в каждом фильтре — для подписей на кнопках
  const counts = {};
  for (const [k, f] of Object.entries(BY_STORE)) {
    counts[k] = db.prepare(`SELECT COALESCE(SUM(oi.qty), 0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN (${f.statuses.map(() => '?').join(',')}) AND oi.item_status != 'unavailable'`).get(...f.statuses).n;
  }
  const customers = new Set(rows.map((r) => (r.user_id ? 'u' + r.user_id : 'c' + (r.email || r.phone || r.order_id)))).size;
  res.render('admin/purchases', { title: 'По магазинам', groups, filter, FILTERS: BY_STORE, counts, customers });
});

// ---------- Магазины ----------
router.get('/stores', (req, res) => {
  const q = String(req.query.q || '').trim();
  const sort = req.query.sort === 'parse' ? 's.parse_ok DESC, s.parse_fail DESC, s.name COLLATE NOCASE' : 's.name COLLATE NOCASE';
  const list = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.store_id = s.id) AS ordered
    FROM stores s ${q ? 'WHERE s.name LIKE ?' : ''} ORDER BY ${sort}`).all(...(q ? [`%${q}%`] : []));
  const parseStats = db.prepare("SELECT SUM(CASE WHEN parse_ok > 0 THEN 1 ELSE 0 END) AS works, SUM(CASE WHEN parse_ok = 0 AND parse_fail > 0 THEN 1 ELSE 0 END) AS fails FROM stores").get();
  res.render('admin/stores', { title: 'Магазины', list, q, sort: req.query.sort || '', parseStats, CATEGORIES, BEAUTY_SUBCATS, PARSE_RESULTS });
});

function storeForm(res, store, errors = {}) {
  res.render('admin/store-form', {
    title: store.id ? store.name : 'Новый магазин', store, errors, CATEGORIES, BEAUTY_SUBCATS, PARSE_RESULTS, cats: categoryList(store),
    subcats: (store.subcategories || '').split(',').filter(Boolean),
  });
}

router.get('/stores/new', (req, res) => storeForm(res, { region: 'PT', is_active: 1, categories: '' }));
router.get('/stores/:id/edit', (req, res, next) => {
  const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!s) return next();
  storeForm(res, s);
});

function readStore(req, existing = {}) {
  const b = req.body;
  const u = safeUrl(b.url);
  const cats = (Array.isArray(b.categories) ? b.categories : [b.categories]).filter((c) => CATEGORIES[c]);
  const data = {
    name: String(b.name || '').trim().slice(0, 100),
    url: u ? u.href : '',
    region: b.region === 'EU' ? 'EU' : 'PT',
    link_prefix: String(b.link_prefix || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\d?\./, '').replace(/\/+$/, '') || (u ? regionPrefix(u.href) : ''),
    categories: cats.join(','),
    subcategories: cats.includes('beauty') ? (Array.isArray(b.subcategories) ? b.subcategories : [b.subcategories]).filter((c) => BEAUTY_SUBCATS[c]).join(',') : '',
    icon_domain: String(b.icon_domain || '').trim().toLowerCase() || (u ? rootDomain(u.hostname) : ''),
    note: String(b.note || '').trim().slice(0, 1000),
    sel_price: String(b.sel_price || '').trim().slice(0, 500),
    sel_old_price: String(b.sel_old_price || '').trim().slice(0, 500),
    sel_title: String(b.sel_title || '').trim().slice(0, 500),
    sel_image: String(b.sel_image || '').trim().slice(0, 500),
    sel_sizes: String(b.sel_sizes || '').trim().slice(0, 500),
    home_tabs: formatHomeTabs(Object.fromEntries(HOME_TAB_KEYS.filter((k) => b[`tab_${k}`])
      .map((k) => { const n = parseInt(b[`rank_${k}`], 10); return [k, n > 0 && n < NO_RANK ? n : NO_RANK]; }))),
    tile_text: String(b.tile_text || '').trim().slice(0, 40),
    tile_bg: cleanHex(b.tile_bg),
    tile_fg: cleanHex(b.tile_fg),
    tile_font: TILE_FONTS[b.tile_font] !== undefined ? String(b.tile_font) : '',
    is_active: b.is_active ? 1 : 0,
    logo_path: b.remove_logo ? '' : (req.file ? `/uploads/logos/${req.file.filename}` : (existing.logo_path || '')),
  };
  const errors = {};
  if (!data.name) errors.name = 'Укажите название.';
  if (!u) errors.url = 'Укажите ссылку на португальскую версию сайта.';
  data.is_popular = parseHomeTabs(data.home_tabs).all ? 1 : 0; // «Популярный» = виден на главной без вкладки
  return { data, errors };
}

router.post('/stores', logoUpload.single('logo'), (req, res) => {
  const { data, errors } = readStore(req);
  if (Object.keys(errors).length) return storeForm(res, data, errors);
  let slug = slugify(data.name) || `store-${Date.now()}`;
  if (db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
  const info = db.prepare(`INSERT INTO stores (slug, name, url, region, link_prefix, categories, subcategories, icon_domain, note, is_popular, home_tabs, tile_text, tile_bg, tile_fg, tile_font, is_active, logo_path,
      sel_price, sel_old_price, sel_title, sel_image, sel_sizes)
    VALUES (@slug, @name, @url, @region, @link_prefix, @categories, @subcategories, @icon_domain, @note, @is_popular, @home_tabs, @tile_text, @tile_bg, @tile_fg, @tile_font, @is_active, @logo_path,
      @sel_price, @sel_old_price, @sel_title, @sel_image, @sel_sizes)`).run({ ...data, slug });
  req.flash('ok', 'Магазин добавлен.');
  res.redirect(`/admin/stores/${info.lastInsertRowid}/edit`);
});

router.post('/stores/:id', logoUpload.single('logo'), (req, res, next) => {
  const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!s) return next();
  const { data, errors } = readStore(req, s);
  if (Object.keys(errors).length) return storeForm(res, { ...data, id: s.id, slug: s.slug }, errors);
  db.prepare(`UPDATE stores SET name=@name, url=@url, region=@region, link_prefix=@link_prefix, categories=@categories, subcategories=@subcategories, icon_domain=@icon_domain,
    note=@note, is_popular=@is_popular, home_tabs=@home_tabs, tile_text=@tile_text, tile_bg=@tile_bg, tile_fg=@tile_fg, tile_font=@tile_font, is_active=@is_active, logo_path=@logo_path,
    sel_price=@sel_price, sel_old_price=@sel_old_price, sel_title=@sel_title, sel_image=@sel_image, sel_sizes=@sel_sizes WHERE id=@id`).run({ ...data, id: s.id });
  req.flash('ok', 'Магазин сохранён.');
  res.redirect(`/admin/stores/${s.id}/edit`);
});

// Проверка ссылки из карточки магазина: что получилось взять и по каким шагам
router.get('/parse-test', async (req, res) => {
  const url = String(req.query.url || '').slice(0, 2000);
  const stores = db.prepare('SELECT id, url, link_prefix, sel_price, sel_old_price, sel_title, sel_image, sel_sizes FROM stores WHERE is_active = 1').all();
  const r = await parseProduct(url, stores, { noCache: true });
  res.json({
    ok: Boolean(r.ok && r.priceEur),
    method: r.ok ? parseLabel(`${r.method}${r.via === 'browser' ? '@browser' : ''}`) : '',
    reason: r.ok ? (r.priceEur ? '' : `цена не в евро (${r.currency})`) : (PARSE_RESULTS[r.reason] || r.reason),
    title: r.title || '', priceEur: r.priceEur || null, oldPriceEur: r.oldPriceEur || null, image: r.image || '',
    sizes: r.sizes || [], colors: r.colors || [], trace: r.trace || [],
    browser: browserStatus(),
  });
});

// ---------- Покупатели ----------
router.get('/users', (req, res) => {
  const list = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders_count,
    (SELECT COALESCE(SUM(total_rub),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','purchased','shipped','delivered')) AS paid_sum,
    (SELECT COALESCE(SUM(amount_rub),0) FROM balance_ops b WHERE b.user_id = u.id AND b.status = 'done') AS balance_rub
    FROM users u ORDER BY u.id DESC LIMIT 500`).all();
  res.render('admin/users', { title: 'Покупатели', list });
});

// ---------- Балансы покупателей ----------
// Все операции; ?user=ID — один покупатель: его баланс, история и ручная корректировка.
router.get('/balance', (req, res) => {
  // customer, а не user: user в шаблонах — вошедший администратор
  const customer = req.query.user ? db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(req.query.user) : null;
  const only = customer ? 'AND b.user_id = ?' : '';
  const args = customer ? [customer.id] : [];
  const pending = db.prepare(`SELECT b.*, u.name, u.email FROM balance_ops b JOIN users u ON u.id = b.user_id
    WHERE b.type = 'topup' AND b.status = 'pending' AND b.provider = 'manual' ${only} ORDER BY b.id`).all(...args);
  const ops = db.prepare(`SELECT b.*, u.name, u.email, o.number AS order_number FROM balance_ops b JOIN users u ON u.id = b.user_id LEFT JOIN orders o ON o.id = b.order_id
    WHERE (b.status = 'done' OR b.provider = 'manual' OR b.status = 'failed') ${only} ORDER BY b.id DESC LIMIT 300`).all(...args);
  const total = db.prepare("SELECT COALESCE(SUM(amount_rub), 0) AS s FROM balance_ops WHERE status = 'done'").get().s;
  res.render('admin/balance', {
    title: customer ? `Баланс: ${customer.name || customer.email}` : 'Балансы', customer, userBalanceRub: customer ? balance.get(customer.id) : 0,
    pending, ops, total, BALANCE_OPS, methodLabel: payments.methodLabel,
  });
});

const backToBalance = (req, userId) => `/admin/balance${req.body.back === 'user' && userId ? '?user=' + userId : ''}`;

// Перевод по реквизитам пришёл — зачислить заявку
router.post('/balance/:id/confirm', (req, res, next) => {
  const op = balance.getOp(req.params.id);
  if (!op || op.type !== 'topup') return next();
  if (balance.confirmTopup(op.id, `Зачислил менеджер ${req.user.email}`)) {
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(op.user_id);
    if (u) mailer.sendTopupCredited(u.email, op.amount_rub, balance.get(op.user_id)).catch((e) => console.error('[mail]', e));
    req.flash('ok', `Зачислено ${fmtRub(op.amount_rub)}. Покупатель получил письмо.`);
  }
  res.redirect(backToBalance(req, op.user_id));
});

router.post('/balance/:id/reject', (req, res, next) => {
  const op = balance.getOp(req.params.id);
  if (!op || op.type !== 'topup') return next();
  if (balance.failTopup(op.id, `Отклонил менеджер ${req.user.email}`)) req.flash('ok', 'Заявка отклонена.');
  res.redirect(backToBalance(req, op.user_id));
});

// Ручная корректировка: + зачислить, − списать (например, вернули остаток на карту через кабинет ЮKassa)
router.post('/balance/adjust', (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.body.user_id);
  if (!user) return res.redirect('/admin/balance');
  const amount = balance.parseAmount(req.body.amount) * (req.body.sign === 'minus' ? -1 : 1);
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (!note) {
    req.flash('error', 'Напишите, за что корректировка — покупатель увидит это в истории баланса.');
    return res.redirect(`/admin/balance?user=${user.id}`);
  }
  const r = balance.adjust(user.id, amount, note, req.user.id);
  req.flash(r.ok ? 'ok' : 'error', r.ok ? `Готово. Баланс покупателя: ${fmtRub(r.balance)}.` : r.error);
  res.redirect(`/admin/balance?user=${user.id}`);
});

// ---------- Настройки ----------
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Настройки', s: settings.getAll(), quote: pricing.quote(), mail: mailer.mailStatus(),
    yookassaOn: yookassa.enabled(), siteUrl: config.siteUrl,
    PAYMENT_METHODS, payMode: payments.mode(), enabledMethods: payments.enabledMethods().map((m) => m.key),
  });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const num = (v, min, max) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const markup = num(b.markup_pct, 0, 500);
  if (markup !== null) settings.set('markup_pct', markup);
  settings.set('rate_mode', b.rate_mode === 'manual' ? 'manual' : 'auto');
  const manual = num(b.rate_eur_manual, 1, 100000);
  if (manual !== null) settings.set('rate_eur_manual', manual);
  const delivery = num(b.delivery_fee_eur, 0, 10000);
  if (delivery !== null) settings.set('delivery_fee_eur', delivery);
  const euLimit = num(b.eu_limit_eur, 0, 1000000);
  if (euLimit !== null) settings.set('eu_limit_eur', euLimit);
  for (const k of ['notify_email', 'shop_email', 'shop_phone', 'shop_telegram', 'legal_name', 'legal_ogrn', 'legal_inn', 'legal_address']) settings.set(k, String(b[k] || '').trim().slice(0, 300));
  settings.set('payment_instructions', String(b.payment_instructions || '').trim().slice(0, 2000));
  if (['demo', 'manual', 'yookassa'].includes(b.payment_mode)) settings.set('payment_mode', b.payment_mode);
  const methods = (Array.isArray(b.payment_methods) ? b.payment_methods : [b.payment_methods]).filter((k) => PAYMENT_METHODS[k]);
  settings.set('payment_methods', (methods.length ? methods : ['card']).join(','));
  req.flash('ok', 'Настройки сохранены. Новые цены уже на сайте.');
  res.redirect('/admin/settings');
});

router.post('/settings/refresh-rate', async (req, res) => {
  const r = await refreshRate();
  req.flash(r ? 'ok' : 'error', r ? `Курс ЦБ обновлён: 1 € = ${r.toFixed(2)} ₽.` : 'Не удалось получить курс ЦБ. Сайт использует последний сохранённый или ручной курс.');
  res.redirect('/admin/settings');
});

router.post('/settings/test-email', async (req, res) => {
  const to = mailer.notifyAddress();
  const r = await mailer.sendTest(to);
  if (r.sent) req.flash('ok', `Тестовое письмо отправлено на ${to}.`);
  else if (r.outbox) req.flash('info', 'SMTP не настроен: письмо сохранено в папку data/outbox на сервере. Заполните SMTP в файле .env.');
  else req.flash('error', `Письмо не отправлено: ${r.error || 'адрес не указан'}.`);
  res.redirect('/admin/settings');
});

module.exports = router;
