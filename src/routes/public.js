const express = require('express');
const db = require('../db');
const pricing = require('../lib/pricing');
const { CATEGORIES, BEAUTY_SUBCATS, GENDERS, HOME_TABS, parseHomeTabs } = require('../lib/format');
const rateLimit = require('express-rate-limit');
const { findStoreForLink, safeUrl } = require('../lib/urls');
const { parseProduct } = require('../lib/parser');
const { categoryList } = require('../services/stores');

const router = express.Router();

function decorate(products) {
  const q = pricing.quote();
  return products.map((p) => {
    let images = [];
    try { images = JSON.parse(p.images || '[]'); } catch { images = []; }
    const priceRub = pricing.eurToRub(p.price_eur, q.rate, q.markup);
    const oldRub = p.old_price_eur ? pricing.eurToRub(p.old_price_eur, q.rate, q.markup) : null;
    const discount = oldRub && oldRub > priceRub ? Math.round((1 - priceRub / oldRub) * 100) : 0;
    return {
      ...p, images, image: images[0] || '', price_rub: priceRub, old_rub: discount ? oldRub : null, discount,
      sizesList: (p.sizes || '').split(',').map((s) => s.trim()).filter(Boolean),
      colorsList: (p.colors || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
  });
}

const PRODUCT_SELECT = `SELECT p.*, s.name AS store_name, s.slug AS store_slug, s.region AS store_region
  FROM products p LEFT JOIN stores s ON s.id = p.store_id`;

// Главная: сетка брендов выбранной вкладки (Женщинам / Мужчинам / Детям / Для дома) и вставка ссылки
const HOME_HEADINGS = { all: 'Бренды', women: 'Бренды для женщин', men: 'Бренды для мужчин', kids: 'Бренды для детей', home: 'Товары для дома' };
const HOME_LIMIT = 16;
router.get('/', (req, res) => {
  const g = HOME_TABS[req.query.g] ? req.query.g : '';
  const key = g || 'all';
  const brands = db.prepare("SELECT * FROM stores WHERE is_active = 1 AND home_tabs != ''").all()
    .map((s) => ({ ...s, rank: parseHomeTabs(s.home_tabs)[key] }))
    .filter((s) => s.rank)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }))
    .slice(0, HOME_LIMIT);
  res.render('home', {
    title: 'Brand Store — магазины Португалии с доставкой в Россию',
    brands, g, heading: HOME_HEADINGS[key], CATEGORIES,
    moreUrl: g === 'kids' || g === 'home' ? `/stores?cat=${g}` : '/stores',
    quote: pricing.quote(),
  });
});

router.get('/catalog', (req, res) => {
  const where = ['p.is_active = 1'];
  const params = {};
  const { gender, cat, store, q, sort, sub } = req.query;
  if (gender && GENDERS[gender]) {
    if (gender === 'kids') where.push("p.gender = 'kids'");
    else { where.push("(p.gender = @gender OR p.gender = 'unisex')"); params.gender = gender; }
  }
  if (cat && CATEGORIES[cat]) { where.push('p.category = @cat'); params.cat = cat; }
  if (cat === 'beauty' && BEAUTY_SUBCATS[sub]) { where.push('p.subcategory = @sub'); params.sub = sub; }
  if (req.query.popular === '1') where.push('p.is_featured = 1');
  if (store) { where.push('s.slug = @store'); params.store = store; }
  if (q) { where.push('(p.title LIKE @q OR s.name LIKE @q OR p.description LIKE @q)'); params.q = `%${q}%`; }
  if (req.query.sale === '1') where.push('p.old_price_eur > p.price_eur');
  const order = {
    new: 'p.id DESC',
    price_asc: 'p.price_eur ASC',
    price_desc: 'p.price_eur DESC',
    discount: '(COALESCE(p.old_price_eur, p.price_eur) - p.price_eur) / COALESCE(p.old_price_eur, p.price_eur) DESC',
  }[sort] || 'p.is_featured DESC, p.id DESC';

  const products = decorate(db.prepare(`${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`).all(params));
  const storesWithProducts = db.prepare(`SELECT DISTINCT s.slug, s.name FROM products p JOIN stores s ON s.id = p.store_id WHERE p.is_active = 1 ORDER BY s.name`).all();
  const matchedStores = q
    ? db.prepare('SELECT * FROM stores WHERE is_active = 1 AND name LIKE ? ORDER BY name LIMIT 12').all(`%${q}%`)
    : [];

  let heading = 'Каталог';
  if (q) heading = `Поиск: «${q}»`;
  else if (req.query.popular === '1') heading = 'Популярное';
  else if (req.query.sale === '1') heading = 'Скидки';
  else if (cat === 'beauty' && BEAUTY_SUBCATS[sub]) heading = BEAUTY_SUBCATS[sub];
  else if (cat && CATEGORIES[cat]) heading = CATEGORIES[cat];
  else if (gender && GENDERS[gender]) heading = GENDERS[gender];
  else if (sort === 'new') heading = 'Новинки';
  res.render('catalog', { title: heading, heading, products, storesWithProducts, matchedStores, CATEGORIES, BEAUTY_SUBCATS, GENDERS });
});

router.get('/product/:id', (req, res, next) => {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.is_active = 1`).get(req.params.id);
  if (!row) return next();
  const [product] = decorate([row]);
  const store = row.store_id ? db.prepare('SELECT * FROM stores WHERE id = ?').get(row.store_id) : null;
  const related = decorate(db.prepare(`${PRODUCT_SELECT} WHERE p.is_active = 1 AND p.id != ? AND (p.category = ? OR p.store_id = ?) ORDER BY RANDOM() LIMIT 5`)
    .all(row.id, row.category, row.store_id));
  res.render('product', { title: product.title, product, store, related, CATEGORIES });
});

router.get('/stores', (req, res) => {
  const stores = db.prepare('SELECT * FROM stores WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all()
    .map((s) => ({ ...s, cats: categoryList(s) }));
  const groups = {};
  for (const s of stores) {
    const ch = s.name.replace(/^[&\s]+/, '').charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(ch) ? ch : '#';
    (groups[letter] = groups[letter] || []).push(s);
  }
  const letters = Object.keys(groups).sort();
  res.render('stores', { title: 'Бренды', stores, groups, letters, CATEGORIES, BEAUTY_SUBCATS, activeCat: req.query.cat || '', activeSub: req.query.sub || '' });
});

router.get('/stores/:slug', (req, res, next) => {
  const store = db.prepare('SELECT * FROM stores WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!store) return next();
  const products = decorate(db.prepare(`${PRODUCT_SELECT} WHERE p.is_active = 1 AND p.store_id = ? ORDER BY p.id DESC`).all(store.id));
  const similar = db.prepare(`SELECT * FROM stores WHERE is_active = 1 AND id != ? AND (',' || categories || ',') LIKE ? ORDER BY RANDOM() LIMIT 8`)
    .all(store.id, `%,${categoryList(store)[0] || ''},%`);
  res.render('store', { title: store.name, store, cats: categoryList(store), subcats: (store.subcategories || '').split(',').filter(Boolean), products, similar, CATEGORIES, BEAUTY_SUBCATS });
});

router.get('/order-link', (req, res) => {
  const stores = db.prepare('SELECT id, name, slug, url, region FROM stores WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all();
  const preset = req.query.store ? stores.find((s) => s.slug === req.query.store) : null;
  res.render('order-link', { title: 'Заказ по ссылке', stores, preset, prefillUrl: req.query.url || '', quote: pricing.quote() });
});

router.get('/how-it-works', (req, res) => {
  res.render('how', { title: 'Как это работает', quote: pricing.quote() });
});

// ---------- API для форм ----------
router.get('/api/detect', (req, res) => {
  const url = String(req.query.url || '');
  const u = safeUrl(url);
  if (!u) return res.json({ ok: false, error: 'Это не похоже на ссылку. Скопируйте адрес страницы товара из браузера.' });
  const stores = db.prepare('SELECT * FROM stores WHERE is_active = 1').all();
  const found = findStoreForLink(url, stores);
  if (!found) return res.json({ ok: true, store: null });
  const s = found.store;
  res.json({ ok: true, regionOk: found.regionOk, store: { id: s.id, name: s.name, slug: s.slug, url: s.url, region: s.region } });
});

const parseLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ ok: false, reason: 'rate_limit' }) });

router.get('/api/parse', parseLimiter, async (req, res) => {
  const url = String(req.query.url || '').slice(0, 2000);
  const stores = db.prepare('SELECT id, url, link_prefix, sel_price, sel_old_price, sel_title, sel_image, sel_sizes FROM stores WHERE is_active = 1').all();
  const found = findStoreForLink(url, stores);
  const result = await parseProduct(url, stores);
  // Ошибки самой ссылки (404, редирект на другой сайт) не говорят о магазине — их не считаем
  const linkProblem = ['bad_url', 'not_found', 'redirected', 'unknown_store'].includes(result.reason);
  if (found && !result.cached && !linkProblem) {
    const ok = result.ok && result.priceEur ? 1 : 0;
    db.prepare(`UPDATE stores SET parse_ok = parse_ok + ?, parse_fail = parse_fail + ?, parse_last = ?, parse_last_at = datetime('now') WHERE id = ?`)
      .run(ok, ok ? 0 : 1, ok ? `${result.method}${result.via === 'browser' ? '@browser' : ''}` : (result.reason || (result.ok ? 'currency' : 'error')), found.store.id);
  }
  const q = pricing.quote();
  res.json({
    ...result,
    detail: undefined,
    trace: undefined,
    priceRub: result.priceEur ? pricing.eurToRub(result.priceEur, q.rate, q.markup) : null,
    oldPriceRub: result.oldPriceEur ? pricing.eurToRub(result.oldPriceEur, q.rate, q.markup) : null,
  });
});

router.get('/api/quote', (req, res) => {
  const eur = parseFloat(String(req.query.eur || '0').replace(',', '.'));
  const q = pricing.quote();
  res.json({ eur, rub: pricing.eurToRub(eur, q.rate, q.markup), rate: q.rate, markup: q.markup });
});

module.exports = router;
module.exports.decorate = decorate;
module.exports.PRODUCT_SELECT = PRODUCT_SELECT;
