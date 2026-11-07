const express = require('express');
const db = require('../db');
const pricing = require('../lib/pricing');
const { CATEGORIES, BEAUTY_SUBCATS, HOME_TABS, parseHomeTabs } = require('../lib/format');
const rateLimit = require('express-rate-limit');
const { findStoreForLink, safeUrl } = require('../lib/urls');
const { parseProduct } = require('../lib/parser');
const { categoryList } = require('../services/stores');

const router = express.Router();

// Главная: сетка брендов выбранной вкладки (Женщинам / Мужчинам / Детям / Для дома / Косметика) и вставка ссылки
const HOME_HEADINGS = { all: 'Бренды', women: 'Бренды для женщин', men: 'Бренды для мужчин', kids: 'Бренды для детей', home: 'Товары для дома', beauty: 'Косметика и парфюмерия' };
router.get('/', (req, res) => {
  const g = HOME_TABS[req.query.g] ? req.query.g : '';
  const key = g || 'all';
  const brands = db.prepare("SELECT * FROM stores WHERE is_active = 1 AND home_tabs != ''").all()
    .map((s) => ({ ...s, rank: parseHomeTabs(s.home_tabs)[key] }))
    .filter((s) => s.rank)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
  res.render('home', {
    title: 'QLIC — магазины Португалии с доставкой в Россию',
    brands, g, heading: HOME_HEADINGS[key], CATEGORIES,
    moreUrl: ['kids', 'home', 'beauty'].includes(g) ? `/stores?cat=${g}` : '/stores',
    quote: pricing.quote(),
  });
});

// Витрины товаров больше нет (07.11.2026): старые ссылки поиска и карточек ведут на бренды
router.get('/catalog', (req, res) => res.redirect(301, req.query.q ? `/stores?q=${encodeURIComponent(String(req.query.q).slice(0, 100))}` : '/stores'));
router.get('/product/:id', (req, res) => res.redirect(301, '/stores'));

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
  res.render('stores', { title: 'Бренды', stores, groups, letters, CATEGORIES, BEAUTY_SUBCATS, activeCat: req.query.cat || '', activeSub: req.query.sub || '', q: String(req.query.q || '').slice(0, 100) });
});

router.get('/stores/:slug', (req, res, next) => {
  const store = db.prepare('SELECT * FROM stores WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!store) return next();
  res.render('store', { title: store.name, store, cats: categoryList(store), subcats: (store.subcategories || '').split(',').filter(Boolean), CATEGORIES, BEAUTY_SUBCATS, quote: pricing.quote() });
});

router.get('/order-link', (req, res) => {
  const stores = db.prepare('SELECT id, name, slug, url, region FROM stores WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all();
  const preset = req.query.store ? stores.find((s) => s.slug === req.query.store) : null;
  res.render('order-link', { title: 'Заказ по ссылке', stores, preset, prefillUrl: req.query.url || '', quote: pricing.quote() });
});

router.get('/how-it-works', (req, res) => {
  res.render('how', { title: 'Как это работает', quote: pricing.quote() });
});

// Юридические документы (тексты — views/legal, реквизиты — из настроек)
router.get('/offer', (req, res) => res.render('legal/offer', { title: 'Публичная оферта', quote: pricing.quote() }));
router.get('/privacy', (req, res) => res.render('legal/privacy', { title: 'Политика обработки персональных данных' }));
router.get('/consent', (req, res) => res.render('legal/consent', { title: 'Согласие на обработку персональных данных' }));

// ---------- API для форм ----------
router.get('/api/detect', (req, res) => {
  const url = String(req.query.url || '');
  const u = safeUrl(url);
  if (!u) return res.json({ ok: false, error: 'Это не ссылка на товар' });
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
