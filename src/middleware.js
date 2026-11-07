const crypto = require('crypto');
const db = require('./db');
const fmt = require('./lib/format');
const pricing = require('./lib/pricing');
const settings = require('./lib/settings');
const { storeIcon } = require('./services/stores');
const icon = require('./lib/icons');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Версия стилей и скриптов для адресов (/css/style.css?v=…). Браузер хранит их 7 дней, а с новой версией
// после обновления сайта сразу берёт свежие — иначе новая разметка встречается со старыми стилями.
let assetVersion = '';
function assetV() {
  if (assetVersion && config.isProd) return assetVersion;
  const h = crypto.createHash('sha1');
  for (const dir of ['css', 'js']) {
    const full = path.join(config.root, 'public', dir);
    for (const f of fs.readdirSync(full).sort()) h.update(f).update(fs.readFileSync(path.join(full, f)));
  }
  assetVersion = h.digest('hex').slice(0, 10);
  return assetVersion;
}

function cartOwner(req) {
  if (req.session.userId) return `u:${req.session.userId}`;
  if (!req.session.guestId) req.session.guestId = crypto.randomBytes(12).toString('hex');
  return `g:${req.session.guestId}`;
}

function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    req.user = db.prepare('SELECT id, email, name, phone, city, address, role FROM users WHERE id = ?').get(req.session.userId) || null;
    if (!req.user) delete req.session.userId;
  }
  next();
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Для форм с файлами (multipart) токен передаётся в адресе формы: ?_csrf=...
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  if (token && token === req.session.csrf) return next();
  res.status(403);
  if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.json({ error: 'Сессия устарела. Обновите страницу.' });
  return res.render('error', { title: 'Сессия устарела', message: 'Обновите страницу и повторите действие.' });
}

function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
}

function locals(req, res, next) {
  const owner = cartOwner(req);
  req.cartOwner = owner;
  res.locals.user = req.user;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.fmt = fmt;
  res.locals.assetV = assetV();
  res.locals.storeIcon = storeIcon;
  res.locals.icon = icon;
  res.locals.pricing = pricing;
  res.locals.cartCount = db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM cart_items WHERE owner = ?').get(owner).n;
  res.locals.userBalance = req.user
    ? db.prepare("SELECT COALESCE(SUM(amount_rub), 0) AS b FROM balance_ops WHERE user_id = ? AND status = 'done'").get(req.user.id).b
    : 0;
  res.locals.favIds = req.user
    ? new Set(db.prepare('SELECT product_id FROM favorites WHERE user_id = ?').all(req.user.id).map((r) => r.product_id))
    : new Set();
  res.locals.shop = {
    email: settings.get('shop_email'),
    phone: settings.get('shop_phone'),
    telegram: settings.get('shop_telegram'),
    paymentInstructions: settings.get('payment_instructions'),
  };
  // Реквизиты продавца — в подвале и в оферте/политике/согласии (обязательны по правилам дистанционной продажи)
  res.locals.legal = {
    name: settings.get('legal_name'),
    ogrn: settings.get('legal_ogrn'),
    inn: settings.get('legal_inn'),
    address: settings.get('legal_address'),
    email: settings.get('shop_email'),
    phone: settings.get('shop_phone'),
    site: config.siteUrl,
  };
  res.locals.legal.filled = !!(res.locals.legal.name && res.locals.legal.ogrn && res.locals.legal.inn && res.locals.legal.email);
  res.locals.storesTotal = db.prepare('SELECT COUNT(*) AS n FROM stores WHERE is_active = 1').get().n;
  next();
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  req.flash('info', 'Войдите или зарегистрируйтесь, чтобы продолжить.');
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return res.status(403).render('error', { title: 'Нет доступа', message: 'Этот раздел доступен только администраторам.' });
}

module.exports = { loadUser, csrf, flash, locals, requireAuth, requireAdmin, cartOwner };
