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
const { ORDER_STATUSES, ITEM_STATUSES, CATEGORIES, BEAUTY_SUBCATS, GENDERS, DELIVERY_METHODS, PAYMENT_METHODS, PARSE_RESULTS, parseLabel,
  HOME_TAB_KEYS, NO_RANK, parseHomeTabs, formatHomeTabs } = require('../lib/format');
const payments = require('../services/payments');
const { parseProduct, browserStatus } = require('../lib/parser');
const { safeUrl, slugify, regionPrefix, rootDomain } = require('../lib/urls');
const orders = require('../services/orders');
const { categoryList } = require('../services/stores');

const router = express.Router();

const imgDir = path.join(config.uploadsDir, 'products');
const logoDir = path.join(config.uploadsDir, 'logos');
fs.mkdirSync(imgDir, { recursive: true });
fs.mkdirSync(logoDir, { recursive: true });
const makeUpload = (dir) => multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|svg\+xml)$/.test(file.mimetype)),
});
const productUpload = makeUpload(imgDir);
const logoUpload = makeUpload(logoDir);

router.use((req, res, next) => {
  res.locals.adminNav = [
    ['/admin', 'Сводка'],
    ['/admin/orders', 'Заказы'],
    ['/admin/purchases', 'Закупка'],
    ['/admin/products', 'Товары'],
    ['/admin/stores', 'Магазины'],
    ['/admin/users', 'Покупатели'],
    ['/admin/settings', 'Настройки'],
  ];
  res.locals.ORDER_STATUSES = ORDER_STATUSES;
  res.locals.newOrdersCount = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").get().n;
  next();
});

// ---------- Сводка ----------
router.get('/', (req, res) => {
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  const recent = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 8').all();
  const paidSum = db.prepare("SELECT COALESCE(SUM(total_rub),0) AS s FROM orders WHERE status IN ('paid','purchased','shipped','delivered')").get().s;
  const monthSum = db.prepare("SELECT COALESCE(SUM(total_rub),0) AS s FROM orders WHERE status IN ('paid','purchased','shipped','delivered') AND paid_at >= datetime('now','-30 days')").get().s;
  const users = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n;
  const toBuy = db.prepare("SELECT COUNT(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'paid' AND oi.item_status != 'purchased' AND oi.item_status != 'unavailable'").get().n;
  res.render('admin/dashboard', {
    title: 'Сводка', byStatus, recent, paidSum, monthSum, users, toBuy,
    quote: pricing.quote(), rateUpdated: settings.get('rate_updated_at'), mail: mailer.mailStatus(), yookassaOn: yookassa.enabled(),
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
    title: `Заказ ${order.number}`, order, ITEM_STATUSES, DELIVERY_METHODS,
    euLimit: parseFloat(settings.get('eu_limit_eur', '300')) || 0, yookassaOn: yookassa.enabled(),
    payMode: payments.mode(), methodLabel: payments.methodLabel(order.payment_method),
  });
});

router.post('/orders/:id/items', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return next();
  const items = db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(order.id);
  const upd = db.prepare('UPDATE order_items SET price_eur = ?, qty = ?, item_status = ?, size = ?, color = ? WHERE id = ? AND order_id = ?');
  const tx = db.transaction(() => {
    for (const { id } of items) {
      const price = parseFloat(String(req.body[`price_${id}`] || '').replace(',', '.'));
      const qty = Math.min(20, Math.max(1, parseInt(req.body[`qty_${id}`], 10) || 1));
      const st = ITEM_STATUSES[req.body[`status_${id}`]] ? req.body[`status_${id}`] : 'pending';
      const size = String(req.body[`size_${id}`] || '').slice(0, 60);
      const color = String(req.body[`color_${id}`] || '').slice(0, 60);
      if (Number.isFinite(price) && price >= 0) upd.run(price, qty, st, size, color, id, order.id);
    }
    const delivery = parseInt(req.body.delivery_rub, 10);
    if (Number.isFinite(delivery) && delivery >= 0) db.prepare('UPDATE orders SET delivery_rub = ? WHERE id = ?').run(delivery, order.id);
  });
  tx();
  orders.recalc(order.id);
  req.flash('ok', 'Позиции и сумма заказа обновлены.');
  res.redirect(`/admin/orders/${order.id}`);
});

router.post('/orders/:id/status', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return next();
  const status = ORDER_STATUSES[req.body.status] ? req.body.status : order.status;
  const fields = {
    tracking: String(req.body.tracking_number || '').trim().slice(0, 100),
    payUrl: safeUrl(req.body.payment_url) ? safeUrl(req.body.payment_url).href : '',
    managerComment: String(req.body.manager_comment || '').trim().slice(0, 2000),
  };
  db.prepare("UPDATE orders SET tracking_number = ?, payment_url = ?, manager_comment = ?, updated_at = datetime('now') WHERE id = ?")
    .run(fields.tracking, fields.payUrl, fields.managerComment, order.id);
  if (status !== order.status) {
    orders.setStatus(order.id, status, { note: String(req.body.note || '').trim().slice(0, 1000), notify: Boolean(req.body.notify) });
    req.flash('ok', `Статус изменён: ${ORDER_STATUSES[status].label}.${req.body.notify ? ' Покупателю отправлено письмо.' : ''}`);
  } else {
    req.flash('ok', 'Данные заказа сохранены.');
  }
  res.redirect(`/admin/orders/${order.id}`);
});

// ---------- Закупка: что купить в магазинах по оплаченным заказам ----------
router.get('/purchases', (req, res) => {
  const rows = db.prepare(`SELECT oi.*, o.number, o.id AS order_id, s.slug AS store_slug, s.icon_domain, s.logo_path, s.url AS store_url
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN stores s ON s.id = oi.store_id
    WHERE o.status = 'paid' AND oi.item_status NOT IN ('purchased', 'unavailable')
    ORDER BY oi.store_name, o.id`).all();
  const groups = {};
  for (const r of rows) {
    const key = r.store_name || 'Другие магазины';
    (groups[key] = groups[key] || { store: r, items: [], sumEur: 0 }).items.push(r);
    groups[key].sumEur += r.price_eur * r.qty;
  }
  res.render('admin/purchases', { title: 'Закупка', groups });
});

router.post('/purchases/:itemId', (req, res) => {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.itemId);
  if (item) {
    db.prepare("UPDATE order_items SET item_status = 'purchased' WHERE id = ?").run(item.id);
    const left = db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND item_status NOT IN ('purchased','unavailable')").get(item.order_id).n;
    if (left === 0) {
      orders.setStatus(item.order_id, 'purchased', { note: 'Все товары выкуплены в магазинах', notify: true });
      req.flash('ok', 'Все товары заказа выкуплены — статус заказа обновлён, покупатель получил письмо.');
    } else {
      req.flash('ok', 'Отмечено как выкупленное.');
    }
  }
  res.redirect('/admin/purchases');
});

// ---------- Товары витрины ----------
router.get('/products', (req, res) => {
  const list = db.prepare(`SELECT p.*, s.name AS store_name FROM products p LEFT JOIN stores s ON s.id = p.store_id ORDER BY p.id DESC`).all()
    .map((p) => ({ ...p, image: (() => { try { return JSON.parse(p.images)[0] || ''; } catch { return ''; } })() }));
  res.render('admin/products', { title: 'Товары', list, CATEGORIES });
});

function productForm(res, product, errors = {}) {
  const stores = db.prepare('SELECT id, name FROM stores ORDER BY name COLLATE NOCASE').all();
  res.render('admin/product-form', { title: product.id ? 'Редактирование товара' : 'Новый товар', product, stores, errors, CATEGORIES, BEAUTY_SUBCATS, GENDERS });
}

router.get('/products/new', (req, res) => productForm(res, { images: '[]', gender: 'women', category: 'clothes', is_active: 1 }));

router.get('/products/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return next();
  productForm(res, p);
});

function readProduct(req, existingImages = []) {
  const b = req.body;
  let images = existingImages.filter((img) => !(Array.isArray(b.remove_image) ? b.remove_image : [b.remove_image]).includes(img));
  const urls = String(b.image_urls || '').split(/\s+/).map((s) => safeUrl(s)).filter(Boolean).map((u) => u.href);
  images = images.concat(urls, (req.files || []).map((f) => `/uploads/products/${f.filename}`));
  const price = parseFloat(String(b.price_eur || '').replace(',', '.'));
  const old = parseFloat(String(b.old_price_eur || '').replace(',', '.'));
  const data = {
    title: String(b.title || '').trim().slice(0, 200),
    store_id: b.store_id ? Number(b.store_id) : null,
    category: CATEGORIES[b.category] ? b.category : 'clothes',
    subcategory: b.category === 'beauty' && BEAUTY_SUBCATS[b.subcategory] ? b.subcategory : '',
    gender: GENDERS[b.gender] ? b.gender : 'women',
    description: String(b.description || '').trim().slice(0, 5000),
    price_eur: price,
    old_price_eur: Number.isFinite(old) && old > price ? old : null,
    sizes: String(b.sizes || '').split(',').map((s) => s.trim()).filter(Boolean).join(','),
    colors: String(b.colors || '').split(',').map((s) => s.trim()).filter(Boolean).join(','),
    images: JSON.stringify(images.slice(0, 10)),
    source_url: safeUrl(b.source_url) ? safeUrl(b.source_url).href : '',
    is_active: b.is_active ? 1 : 0,
    is_featured: b.is_featured ? 1 : 0,
  };
  const errors = {};
  if (!data.title) errors.title = 'Укажите название.';
  if (!Number.isFinite(price) || price <= 0) errors.price_eur = 'Укажите цену в евро.';
  return { data, errors };
}

router.post('/products', productUpload.array('photos', 10), (req, res) => {
  const { data, errors } = readProduct(req);
  if (Object.keys(errors).length) return productForm(res, { ...data }, errors);
  const info = db.prepare(`INSERT INTO products (title, store_id, category, subcategory, gender, description, price_eur, old_price_eur, sizes, colors, images, source_url, is_active, is_featured)
    VALUES (@title, @store_id, @category, @subcategory, @gender, @description, @price_eur, @old_price_eur, @sizes, @colors, @images, @source_url, @is_active, @is_featured)`).run(data);
  req.flash('ok', 'Товар добавлен.');
  res.redirect(`/admin/products/${info.lastInsertRowid}/edit`);
});

router.post('/products/:id', productUpload.array('photos', 10), (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return next();
  let existing = [];
  try { existing = JSON.parse(p.images || '[]'); } catch { existing = []; }
  const { data, errors } = readProduct(req, existing);
  if (Object.keys(errors).length) return productForm(res, { ...data, id: p.id }, errors);
  db.prepare(`UPDATE products SET title=@title, store_id=@store_id, category=@category, subcategory=@subcategory, gender=@gender, description=@description, price_eur=@price_eur,
    old_price_eur=@old_price_eur, sizes=@sizes, colors=@colors, images=@images, source_url=@source_url, is_active=@is_active, is_featured=@is_featured, is_demo=0 WHERE id=@id`)
    .run({ ...data, id: p.id });
  req.flash('ok', 'Товар сохранён.');
  res.redirect(`/admin/products/${p.id}/edit`);
});

router.post('/products/:id/delete', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  req.flash('ok', 'Товар удалён.');
  res.redirect('/admin/products');
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
  const info = db.prepare(`INSERT INTO stores (slug, name, url, region, link_prefix, categories, subcategories, icon_domain, note, is_popular, home_tabs, is_active, logo_path,
      sel_price, sel_old_price, sel_title, sel_image, sel_sizes)
    VALUES (@slug, @name, @url, @region, @link_prefix, @categories, @subcategories, @icon_domain, @note, @is_popular, @home_tabs, @is_active, @logo_path,
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
    note=@note, is_popular=@is_popular, home_tabs=@home_tabs, is_active=@is_active, logo_path=@logo_path,
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
    (SELECT COALESCE(SUM(total_rub),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','purchased','shipped','delivered')) AS paid_sum
    FROM users u ORDER BY u.id DESC LIMIT 500`).all();
  res.render('admin/users', { title: 'Покупатели', list });
});

// ---------- Настройки ----------
router.get('/settings', (req, res) => {
  const demoCount = db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_demo = 1').get().n;
  res.render('admin/settings', {
    title: 'Настройки', s: settings.getAll(), quote: pricing.quote(), mail: mailer.mailStatus(),
    yookassaOn: yookassa.enabled(), demoCount, siteUrl: config.siteUrl,
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
  const delivery = num(b.delivery_fee_rub, 0, 1000000);
  if (delivery !== null) settings.set('delivery_fee_rub', Math.round(delivery));
  const euLimit = num(b.eu_limit_eur, 0, 1000000);
  if (euLimit !== null) settings.set('eu_limit_eur', euLimit);
  for (const k of ['notify_email', 'shop_email', 'shop_phone', 'shop_telegram']) settings.set(k, String(b[k] || '').trim().slice(0, 200));
  settings.set('payment_instructions', String(b.payment_instructions || '').trim().slice(0, 2000));
  if (['demo', 'link', 'yookassa'].includes(b.payment_mode)) settings.set('payment_mode', b.payment_mode);
  settings.set('pay_flow', b.pay_flow === 'instant' ? 'instant' : 'after_check');
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

router.post('/settings/delete-demo', (req, res) => {
  const n = db.prepare('DELETE FROM products WHERE is_demo = 1').run().changes;
  req.flash('ok', `Удалено демо-товаров: ${n}.`);
  res.redirect('/admin/settings');
});

module.exports = router;
