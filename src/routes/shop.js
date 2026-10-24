const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const pricing = require('../lib/pricing');
const yookassa = require('../lib/yookassa');
const { DELIVERY_METHODS } = require('../lib/format');
const { safeUrl, findStoreForLink, bareHost } = require('../lib/urls');
const { requireAuth } = require('../middleware');
const { getCart } = require('../services/cart');
const orders = require('../services/orders');
const payments = require('../services/payments');
const { decorate, PRODUCT_SELECT } = require('./public');

const router = express.Router();

const cartUploadDir = path.join(config.uploadsDir, 'cart');
fs.mkdirSync(cartUploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: cartUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

const wantsJson = (req) => req.xhr || (req.get('accept') || '').includes('application/json');
const clampQty = (v) => Math.min(20, Math.max(1, parseInt(v, 10) || 1));

// ---------- Корзина ----------
router.get('/cart', (req, res) => {
  const cart = getCart(req.cartOwner);
  res.render('cart', { title: 'Корзина', cart });
});

router.post('/cart/add-product', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(req.body.product_id);
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  const sizes = (product.sizes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const colors = (product.colors || '').split(',').map((s) => s.trim()).filter(Boolean);
  const size = String(req.body.size || '').trim();
  const color = String(req.body.color || '').trim();
  if (sizes.length && !sizes.includes(size)) return res.status(400).json({ error: 'Выберите размер' });
  if (colors.length && !colors.includes(color)) return res.status(400).json({ error: 'Выберите цвет' });
  const qty = clampQty(req.body.qty);

  const existing = db.prepare("SELECT id, qty FROM cart_items WHERE owner = ? AND type = 'product' AND product_id = ? AND size = ? AND color = ?")
    .get(req.cartOwner, product.id, size, color);
  if (existing) {
    db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(Math.min(20, existing.qty + qty), existing.id);
  } else {
    db.prepare(`INSERT INTO cart_items (owner, type, product_id, store_id, url, size, color, qty, price_eur, region_ok)
      VALUES (?, 'product', ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(req.cartOwner, product.id, product.store_id, product.source_url, size, color, qty, product.price_eur);
  }
  const count = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE owner = ?').get(req.cartOwner).n;
  if (wantsJson(req)) return res.json({ ok: true, count });
  req.flash('ok', 'Товар добавлен в корзину.');
  res.redirect('/cart');
});

router.post('/cart/add-link', upload.single('photo'), (req, res) => {
  const b = req.body;
  const errors = {};
  const u = safeUrl(b.url);
  if (!u) errors.url = 'Вставьте ссылку на товар';
  const price = parseFloat(String(b.price_eur || '').replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0 || price > 100000) errors.price_eur = 'Укажите цену';
  const size = String(b.size || '').trim().slice(0, 60);
  const color = String(b.color || '').trim().slice(0, 60);
  if (!size) errors.size = 'Выберите размер';
  if (!color) errors.color = 'Укажите цвет';

  // Заказываем только из магазинов нашего списка: магазин определяется по самой ссылке
  let store = null;
  let regionOk = 1;
  if (u) {
    const all = db.prepare('SELECT * FROM stores WHERE is_active = 1').all();
    const found = findStoreForLink(u.href, all);
    if (found) { store = found.store; regionOk = found.regionOk ? 1 : 0; }
    else errors.url = 'Этого магазина нет в нашем списке';
  }

  if (Object.keys(errors).length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (wantsJson(req)) return res.status(400).json({ errors });
    req.flash('error', errors.url || Object.values(errors)[0]);
    return res.redirect(u ? `/order-link?url=${encodeURIComponent(u.href)}` : '/order-link');
  }

  const image = req.file ? `/uploads/cart/${req.file.filename}` : (safeUrl(b.image_url) ? safeUrl(b.image_url).href : '');
  const parsed = parseFloat(String(b.parsed_price || ''));
  const priceAuto = Number.isFinite(parsed) && Math.abs(parsed - price) < 0.005 ? 1 : 0;
  db.prepare(`INSERT INTO cart_items (owner, type, store_id, url, title, image_url, size, color, qty, price_eur, comment, region_ok, price_auto)
    VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.cartOwner, store ? store.id : null, u.href,
      String(b.title || '').trim().slice(0, 200) || (store ? `Товар ${store.name}` : `Товар с ${bareHost(u.hostname)}`),
      image, size, color, clampQty(b.qty), Math.round(price * 100) / 100, String(b.comment || '').trim().slice(0, 500), regionOk, priceAuto);

  const count = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE owner = ?').get(req.cartOwner).n;
  if (wantsJson(req)) return res.json({ ok: true, count });
  req.flash('ok', 'Товар добавлен в корзину. Можно добавить ещё один или перейти к оформлению.');
  res.redirect(b.next === 'cart' ? '/cart' : '/order-link');
});

router.post('/cart/update/:id', (req, res) => {
  db.prepare('UPDATE cart_items SET qty = ? WHERE id = ? AND owner = ?').run(clampQty(req.body.qty), req.params.id, req.cartOwner);
  res.redirect('/cart');
});

router.post('/cart/remove/:id', (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE id = ? AND owner = ?').run(req.params.id, req.cartOwner);
  res.redirect('/cart');
});

// ---------- Оформление ----------
router.get('/checkout', requireAuth, (req, res) => {
  const cart = getCart(req.cartOwner);
  if (!cart.items.length) return res.redirect('/cart');
  const u = req.user;
  res.render('checkout', {
    title: 'Оформление заказа', cart, DELIVERY_METHODS, errors: {},
    methods: payments.enabledMethods(), payFlow: payments.payFlow(), payMode: payments.mode(),
    values: { name: u.name, phone: u.phone, email: u.email, city: u.city, address: u.address, delivery: 'pickup', comment: '', method: payments.enabledMethods()[0].key },
  });
});

router.post('/checkout', requireAuth, async (req, res) => {
  const cart = getCart(req.cartOwner);
  if (!cart.items.length) return res.redirect('/cart');
  const v = {
    name: String(req.body.name || '').trim().slice(0, 120),
    phone: String(req.body.phone || '').trim().slice(0, 40),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    city: String(req.body.city || '').trim().slice(0, 100),
    address: String(req.body.address || '').trim().slice(0, 300),
    delivery: DELIVERY_METHODS[req.body.delivery] ? req.body.delivery : 'pickup',
    comment: String(req.body.comment || '').trim().slice(0, 1000),
    method: String(req.body.method || ''),
  };
  const instant = payments.payFlow() === 'instant';
  const errors = {};
  if (!v.name) errors.name = 'Укажите имя и фамилию получателя.';
  if (v.phone.replace(/\D/g, '').length < 10) errors.phone = 'Укажите телефон для связи.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Проверьте адрес почты.';
  if (!v.city) errors.city = 'Укажите город.';
  if (!v.address) errors.address = v.delivery === 'pickup' ? 'Укажите адрес пункта выдачи.' : 'Укажите адрес доставки.';
  if (!req.body.agree) errors.agree = 'Подтвердите согласие с условиями.';
  if (instant && !payments.enabledMethods().some((m) => m.key === v.method)) errors.method = 'Выберите способ оплаты.';
  if (Object.keys(errors).length) {
    return res.status(400).render('checkout', {
      title: 'Оформление заказа', cart, DELIVERY_METHODS, errors, values: v,
      methods: payments.enabledMethods(), payFlow: payments.payFlow(), payMode: payments.mode(),
    });
  }
  // Сохраним контакты в профиль, чтобы не вводить заново
  db.prepare('UPDATE users SET name = ?, phone = ?, city = ?, address = ? WHERE id = ?').run(v.name, v.phone, v.city, v.address, req.user.id);
  const { method, ...form } = v;
  const order = orders.createFromCart({ owner: req.cartOwner, userId: req.user.id, form, status: instant ? 'awaiting_payment' : 'new' });
  if (instant) {
    const r = await payments.start(order, method);
    if (r.redirect) return res.redirect(r.redirect);
    req.flash('error', r.error);
    return res.redirect(`/pay/${order.id}`);
  }
  res.redirect(`/account/orders/${order.id}?new=1`);
});

// ---------- Избранное ----------
router.post('/favorites/:id/toggle', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Войдите, чтобы сохранять товары', login: '/login' });
  const pid = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND product_id = ?').get(req.user.id, pid);
  if (exists) db.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?').run(req.user.id, pid);
  else db.prepare('INSERT OR IGNORE INTO favorites (user_id, product_id) VALUES (?, ?)').run(req.user.id, pid);
  res.json({ ok: true, active: !exists });
});

router.get('/favorites', requireAuth, (req, res) => {
  const products = decorate(db.prepare(`${PRODUCT_SELECT} JOIN favorites f ON f.product_id = p.id WHERE f.user_id = ? AND p.is_active = 1 ORDER BY f.created_at DESC`).all(req.user.id));
  res.render('favorites', { title: 'Избранное', products });
});

// ---------- Личный кабинет ----------
router.get('/account', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  for (const o of list) {
    o.items = db.prepare('SELECT title, image_url, qty FROM order_items WHERE order_id = ? LIMIT 4').all(o.id);
    o.itemCount = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n;
  }
  res.render('account/orders', { title: 'Мои заказы', orders: list });
});

router.get('/account/orders/:id', requireAuth, async (req, res, next) => {
  const order = orders.getOrder(req.params.id);
  if (!order || (order.user_id !== req.user.id && req.user.role !== 'admin')) return next();
  // Возврат со страницы оплаты ЮKassa — сверяем статус платежа
  if (req.query.paid && order.payment_id && yookassa.enabled() && order.status === 'awaiting_payment') {
    try {
      const p = await yookassa.getPayment(order.payment_id);
      if (p.status === 'succeeded') payments.markPaid(order.id, `Оплата получена: ${payments.methodLabel(order.payment_method) || 'ЮKassa'}`);
      return res.redirect(`/account/orders/${order.id}?paid=1`);
    } catch (e) { console.error('[yookassa]', e.message); }
  }
  res.render('account/order', {
    title: `Заказ ${order.number}`, order, isNew: Boolean(req.query.new), justPaid: Boolean(req.query.paid) && order.status === 'paid',
    DELIVERY_METHODS, payMode: payments.mode(), methodLabel: payments.methodLabel(order.payment_method),
  });
});

// ---------- Оплата ----------
function ownOrder(req) {
  const order = orders.getOrder(req.params.id);
  if (!order || order.user_id !== req.user.id) return null;
  return order;
}

router.get('/pay/:id', requireAuth, (req, res, next) => {
  const order = ownOrder(req);
  if (!order) return next();
  if (order.status !== 'awaiting_payment') return res.redirect(`/account/orders/${order.id}`);
  res.render('pay', {
    title: `Оплата заказа ${order.number}`, order, methods: payments.enabledMethods(), payMode: payments.mode(),
    failed: Boolean(req.query.failed), selected: order.payment_method || payments.enabledMethods()[0].key,
  });
});

router.post('/pay/:id', requireAuth, async (req, res, next) => {
  const order = ownOrder(req);
  if (!order) return next();
  const r = await payments.start(order, String(req.body.method || ''));
  if (r.redirect) return res.redirect(r.redirect);
  req.flash('error', r.error);
  res.redirect(order.status === 'awaiting_payment' ? `/pay/${order.id}` : `/account/orders/${order.id}`);
});

// Тестовая страница банка (режим «Тестовая оплата»)
router.get('/pay/:id/demo', requireAuth, (req, res, next) => {
  const order = ownOrder(req);
  if (!order || payments.mode() !== 'demo' || !order.payment_id.startsWith('demo_')) return next();
  if (order.status !== 'awaiting_payment') return res.redirect(`/account/orders/${order.id}`);
  res.render('pay-demo', { title: 'Тестовая оплата', order, methodLabel: payments.methodLabel(order.payment_method) });
});

router.post('/pay/:id/demo', requireAuth, (req, res, next) => {
  const order = ownOrder(req);
  if (!order || payments.mode() !== 'demo' || !order.payment_id.startsWith('demo_')) return next();
  if (req.body.result !== 'success') return res.redirect(`/pay/${order.id}?failed=1`);
  payments.markPaid(order.id, `Оплачено: ${payments.methodLabel(order.payment_method)} (тестовый режим)`);
  res.redirect(`/account/orders/${order.id}?paid=1`);
});

router.get('/account/profile', requireAuth, (req, res) => {
  res.render('account/profile', { title: 'Профиль', values: req.user, errors: {} });
});

router.post('/account/profile', requireAuth, (req, res) => {
  const v = {
    name: String(req.body.name || '').trim().slice(0, 100),
    phone: String(req.body.phone || '').trim().slice(0, 40),
    city: String(req.body.city || '').trim().slice(0, 100),
    address: String(req.body.address || '').trim().slice(0, 300),
  };
  db.prepare('UPDATE users SET name = ?, phone = ?, city = ?, address = ? WHERE id = ?').run(v.name, v.phone, v.city, v.address, req.user.id);
  req.flash('ok', 'Профиль сохранён.');
  res.redirect('/account/profile');
});

// ---------- Уведомления ЮKassa ----------
router.post('/webhooks/yookassa', async (req, res) => {
  res.sendStatus(200);
  try {
    const id = req.body && req.body.object && req.body.object.id;
    if (!id || !yookassa.enabled()) return;
    // Не доверяем телу уведомления — запрашиваем платёж у ЮKassa
    const p = await yookassa.getPayment(id);
    const orderId = p.metadata && p.metadata.order_id;
    if (!orderId) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order || order.payment_id !== p.id) return;
    if (p.status === 'succeeded') payments.markPaid(order.id, `Оплата получена: ${payments.methodLabel(order.payment_method) || 'ЮKassa'}`);
  } catch (e) {
    console.error('[yookassa webhook]', e.message);
  }
});

module.exports = router;
