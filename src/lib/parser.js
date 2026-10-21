// Автоматическое получение цены и данных товара по ссылке.
//
// Шаг 1 — быстрый запрос без браузера (доли секунды). Шаг 2 — если магазин не отдал страницу или цены в ней нет,
// страница открывается во встроенном Chrome без окна (src/lib/browser.js), как у обычного посетителя.
// На каждом шаге данные ищутся так:
//   0. отдельные обработчики для магазинов (сейчас — Adidas, его JSON товара);
//   1. Shopify — открытый JSON товара (/products/<handle>.js): цена, старая цена, размеры, цвета, наличие;
//   2. JSON-LD (schema.org Product / ProductGroup);
//   3. мета-теги product:price:amount / og:price:amount, og:title, og:image;
//   4. микроразметка itemprop="price";
//   5. теги из настроек магазина в админке (CSS-селекторы цены, старой цены, названия, фото, размеров).
// Открываются только сайты магазинов из нашего списка.
//
// Настройки (.env):
//   PARSER_PROXY=http://user:pass@host:port — ходить к магазинам через прокси (например, в Португалии/ЕС);
//   PARSER_TIMEOUT_MS=10000 — сколько ждать ответа на быстром шаге;
//   PARSER_BROWSER=off — не использовать встроенный Chrome.
const { fetch: undiciFetch, ProxyAgent } = require('undici');
const { parse: parseHtmlDom } = require('node-html-parser');
const { safeUrl, rootDomain, findStoreForLink } = require('./urls');
const browser = require('./browser');

const TIMEOUT = Number(process.env.PARSER_TIMEOUT_MS || 10000);
const MAX_BYTES = 4 * 1024 * 1024;
const CACHE_TTL = 20 * 60 * 1000;
const cache = new Map();
const dispatcher = process.env.PARSER_PROXY ? new ProxyAgent(process.env.PARSER_PROXY) : undefined;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

// ---------- Вспомогательные ----------
const NAMED = { szlig: 'ß', ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…', reg: '®', trade: '™', copy: '©', deg: '°', middot: '·', times: '×' };
const MARKS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327', ring: '\u030A' };

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring);/g, (_, ch, mark) => (ch + MARKS[mark]).normalize('NFC'))
    .replace(/&([a-z]+);/g, (m, name) => NAMED[name] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&euro;/g, '€').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// «89,95», «1.299,00 €», «1,299.00», «EUR 89.9», 89.95 → число
function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Десятичный разделитель — тот, что правее
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // «1,299» — тысячи, «89,95» — копейки
    s = /,\d{3}$/.test(s) && s.split(',').length > 1 && s.length > 4 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1 || /^\d{1,3}\.\d{3}$/.test(s)) {
    // «1.299.000» и «1.299» — точка как разделитель тысяч
    s = s.replace(/\.(?=\d{3}(\.|$))/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 && n < 1000000 ? Math.round(n * 100) / 100 : null;
}

function absUrl(src, base) {
  if (!src) return '';
  if (typeof src === 'object') src = src.url || src.contentUrl || (Array.isArray(src) ? src[0] : '');
  if (Array.isArray(src)) src = src[0];
  if (!src || typeof src !== 'string') return '';
  try { return new URL(src.startsWith('//') ? 'https:' + src : src, base).href; } catch { return ''; }
}

const SIZE_RE = /size|tamanho|taille|talla|taglia|gr(ö|o)(ß|ss)e|maat|rozmiar|tama[nñ]o|volume|capacidade|ml\b/i;
const COLOR_RE = /colou?r|\bcor\b|couleur|colore|farbe|kleur|kolor/i;

function uniq(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = (typeof x === 'string' ? x : x.name).toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Загрузка ----------
// Редиректы проходим вручную и только в пределах доменов магазинов из списка
async function download(url, { accept, allowed } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const res = await fetchOnce(current, accept);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = safeUrl(new URL(res.location, current).href);
      if (!next) return { ...res, status: 502 };
      if (allowed && !allowed.has(rootDomain(next.hostname))) return { ...res, status: 310, url: next.href };
      current = next.href;
      continue;
    }
    return { ...res, url: current };
  }
  return { status: 508, url: current, text: '', type: '' };
}

async function fetchOnce(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await undiciFetch(devRemap(url), {
      headers: { ...HEADERS, ...(accept ? { Accept: accept } : {}) },
      redirect: 'manual',
      signal: ctrl.signal,
      dispatcher,
    });
    const location = res.headers.get('location');
    const chunks = [];
    let size = 0;
    if (res.body && !(res.status >= 300 && res.status < 400)) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { ctrl.abort(); break; }
        chunks.push(Buffer.from(value));
      }
    } else if (res.body) {
      await res.body.cancel().catch(() => {});
    }
    return { status: res.status, location, text: Buffer.concat(chunks).toString('utf8'), type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

// Только для тестов: PARSER_DEV_MAP="zara.com=http://127.0.0.1:4500" подменяет сайт магазина локальным
function devRemap(url) {
  const map = process.env.PARSER_DEV_MAP;
  if (!map) return url;
  const u = new URL(url);
  for (const pair of map.split(',')) {
    const [domain, target] = pair.split('=');
    if (domain && target && rootDomain(u.hostname) === domain.trim()) {
      return target.trim().replace(/\/$/, '') + u.pathname + u.search;
    }
  }
  return url;
}

function looksBlocked(status, text) {
  if ([401, 403, 429, 503].includes(status)) return true;
  // Страницы-заглушки маленькие; на большой обычной странице слово «captcha» — это скрипт защиты форм, а не блок
  if (status === 200 && text.length > 40000) return false;
  const head = text.slice(0, 20000).toLowerCase();
  return /captcha|access denied|are you a robot|datadome|px-captcha|cf-chl|attention required|request unsuccessful|incapsula|akamai bot|não podemos dar-te acesso|erro de referência|reference #\d/.test(head)
    && !/application\/ld\+json/.test(head);
}

// ---------- Shopify ----------
function shopifyHandleUrl(u) {
  const m = u.pathname.match(/^(.*?\/products\/[^/?#]+)/);
  if (!m) return null;
  return { productJs: `${u.origin}${m[1].replace(/\.(js|json)$/, '')}.js`, prefix: m[1].replace(/\/products\/.*$/, '') };
}

async function tryShopify(u, get) {
  const h = shopifyHandleUrl(u);
  if (!h) return null;
  const r = await get(h.productJs, 'application/json');
  if (r.status !== 200 || !/^\s*\{/.test(r.text)) return null;
  let p;
  try { p = JSON.parse(r.text); } catch { return null; }
  if (!p || !Array.isArray(p.variants)) return null;

  let currency = '';
  try {
    const c = await get(`${u.origin}${h.prefix}/cart.js`, 'application/json');
    if (c.status === 200) currency = (JSON.parse(c.text).currency || '').toUpperCase();
  } catch { /* валюту возьмём по умолчанию */ }

  // Если в ссылке указан вариант (?variant=…), берём его цену
  const variantId = u.searchParams.get('variant');
  const variant = (variantId && p.variants.find((v) => String(v.id) === variantId)) || p.variants.find((v) => v.available) || p.variants[0];
  const options = (p.options || []).map((o, i) => (typeof o === 'string' ? { name: o, position: i + 1 } : o));
  const sizeOpt = options.find((o) => SIZE_RE.test(o.name || ''));
  const colorOpt = options.find((o) => COLOR_RE.test(o.name || ''));
  const valuesOf = (opt) => {
    if (!opt) return [];
    const key = `option${opt.position || options.indexOf(opt) + 1}`;
    const names = uniq(p.variants.map((v) => v[key]).filter(Boolean));
    return names.map((name) => ({ name, available: p.variants.some((v) => v[key] === name && v.available) }));
  };
  const cents = (n) => (Number.isFinite(Number(n)) ? Number(n) / 100 : null);
  const price = cents(variant ? variant.price : p.price);
  const compare = cents(variant ? variant.compare_at_price : p.compare_at_price);

  return {
    method: 'shopify',
    title: decodeEntities(p.title),
    price,
    oldPrice: compare && compare > price ? compare : null,
    currency: currency || 'EUR',
    image: absUrl(p.featured_image || (p.images || [])[0], u.href),
    sizes: valuesOf(sizeOpt),
    colors: valuesOf(colorOpt),
    available: p.variants.some((v) => v.available),
    selectedColor: colorOpt && variant ? variant[`option${colorOpt.position || options.indexOf(colorOpt) + 1}`] : '',
  };
}

// ---------- Отдельные магазины ----------
// Adidas: страница товара /<название>/<АРТИКУЛ>.html, данные — в /api/products/<АРТИКУЛ>
// (название, цена, старая цена, фото, цвет, размеры) и /api/products/<АРТИКУЛ>/availability (наличие размеров).
async function tryAdidas(u, get) {
  const m = u.pathname.match(/\/([A-Z0-9]{5,8})\.html$/i);
  if (!m) return null;
  const id = m[1].toUpperCase();
  const r = await get(`${u.origin}/api/products/${id}`, 'application/json');
  if (r.status !== 200 || !/^\s*\{/.test(r.text)) return null;
  let p;
  try { p = JSON.parse(r.text); } catch { return null; }
  const pi = p.pricing_information || {};
  const price = parsePrice(pi.currentPrice ?? pi.sale_price ?? pi.standard_price);
  if (!price) return null;
  const standard = parsePrice(pi.standard_price);

  // Наличие размеров — отдельным запросом; если не получилось, показываем все размеры
  const stock = new Map();
  try {
    const a = await get(`${u.origin}/api/products/${id}/availability`, 'application/json');
    if (a.status === 200 && /^\s*\{/.test(a.text)) {
      for (const v of JSON.parse(a.text).variation_list || []) {
        const status = String(v.availability_status || '');
        const inStock = status ? !/NOT|OUT|UNAVAILABLE|SOLD/i.test(status) : Number(v.availability) > 0;
        stock.set(String(v.size), inStock);
      }
    }
  } catch { /* наличие неизвестно */ }

  const attrs = p.attribute_list || {};
  const color = attrs.search_color || attrs.color || '';
  const views = p.view_list || [];
  const image = (views.find((v) => v.type === 'standard') || views[0] || {}).image_url
    || ((p.product_description || {}).description_assets || {}).image_url || '';
  const sizes = uniq((p.variation_list || []).filter((v) => v.size).map((v) => ({
    name: String(v.size),
    available: stock.size ? stock.get(String(v.size)) === true : true,
  })));

  return {
    method: 'adidas',
    title: decodeEntities(p.name || (p.product_description || {}).title || ''),
    price,
    oldPrice: standard && standard > price ? standard : null,
    currency: 'EUR',
    image: absUrl(image, u.href),
    sizes,
    colors: color ? [{ name: decodeEntities(color), available: true }] : [],
    available: stock.size ? [...stock.values()].some(Boolean) : null,
    selectedColor: decodeEntities(color),
  };
}

// Inditex (Massimo Dutti, Pull&Bear, Stradivarius…): товар — pelement=<id> в ссылке, данные —
// /itxrest/2/catalog/store/<магазин>/<каталог>/category/0/product/<id>/detail (цвета, размеры, цены в центах)
// и …/product/<id>/stock (наличие по sku). Номера магазина и каталога берём из запросов самой страницы,
// запасные — для Португалии (21.10.2026). Работает только в браузере: API закрыт от простых запросов.
const INDITEX_PT = {
  'massimodutti.com': ['34009460', '30359498'],
  'pullandbear.com': ['24009410', '20309459'],
  'stradivarius.com': ['54009560', '50331100'],
};
async function tryInditex(u, get, hints = {}) {
  const pid = u.searchParams.get('pelement') || (u.pathname.match(/[-/]c0p(\d{6,})\.html$/) || [])[1];
  if (!pid || !/^\d+$/.test(pid)) return null;
  const seen = (hints.resources || []).map((r) => (r.match(/\/itxrest\/\d\/catalog\/store\/(\d+)\/(\d+)\//) || []).slice(1)).find((x) => x.length === 2);
  const ids = seen || INDITEX_PT[rootDomain(u.hostname)];
  if (!ids) return null;
  const base = `${u.origin}/itxrest/2/catalog/store/${ids[0]}/${ids[1]}`;
  const r = await get(`${base}/category/0/product/${pid}/detail?languageId=-6&appId=1`, 'application/json');
  if (r.status !== 200 || !/^\s*\{/.test(r.text)) return null;
  let p;
  try { p = JSON.parse(r.text); } catch { return null; }
  const detail = (p.detail && (p.detail.colors || []).length ? p.detail : ((p.bundleProductSummaries || [])[0] || {}).detail) || {};
  const colors = detail.colors || [];
  if (!colors.length) return null;
  const wanted = u.searchParams.get('colorId') || u.searchParams.get('cS') || String(p.mainColorid || '');
  const color = colors.find((c) => String(c.id) === wanted) || colors[0];
  const sizesRaw = color.sizes || [];
  const cents = (n) => (n && Number.isFinite(Number(n)) ? Number(n) / 100 : null);
  const price = cents(sizesRaw.map((s) => s.price).find(Boolean));
  if (!price) return null;
  const old = cents(sizesRaw.map((s) => s.oldPrice).find(Boolean));

  // Наличие по sku; если не получилось — по признаку «можно купить»
  const stock = new Map();
  try {
    const s = await get(`${base}/product/${pid}/stock?languageId=-6&appId=1`, 'application/json');
    if (s.status === 200 && /^\s*\{/.test(s.text)) {
      for (const group of JSON.parse(s.text).stocks || []) {
        for (const x of group.stocks || []) stock.set(String(x.id), !/out|sold|no_stock|unavailable/i.test(String(x.availability || '')));
      }
    }
  } catch { /* наличие неизвестно */ }
  const sizes = uniq(sizesRaw.filter((s) => s.name).map((s) => ({
    name: String(s.name),
    available: stock.has(String(s.sku)) ? stock.get(String(s.sku)) : s.isBuyable !== false,
  })));

  return {
    method: 'inditex',
    title: decodeEntities(p.name || ''),
    price,
    oldPrice: old && old > price ? old : null,
    currency: 'EUR',
    image: '', // фото — со страницы (разметка товара)
    sizes,
    colors: colors.map((c) => ({ name: decodeEntities(c.name || ''), available: (c.sizes || []).some((s) => s.isBuyable !== false) })).filter((c) => c.name),
    available: sizes.length ? sizes.some((s) => s.available) : null,
    selectedColor: decodeEntities(color.name || ''),
  };
}
tryInditex.browserOnly = true;

// Обработчики по домену магазина. Если обработчик ничего не нашёл, дальше пробуем общие способы.
const ADAPTERS = {
  'adidas.pt': tryAdidas,
  'massimodutti.com': tryInditex,
  'pullandbear.com': tryInditex,
  'stradivarius.com': tryInditex,
  'oysho.com': tryInditex,
  'zarahome.com': tryInditex,
  'lefties.com': tryInditex,
};

// ---------- JSON-LD ----------
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { out.push(JSON.parse(raw)); } catch {
      try { out.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch { /* пропускаем битый блок */ }
    }
  }
  return out;
}

function flattenLd(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, acc)); return acc; }
  if (typeof node !== 'object') return acc;
  acc.push(node);
  if (node['@graph']) flattenLd(node['@graph'], acc);
  if (node.mainEntity) flattenLd(node.mainEntity, acc);
  return acc;
}

const isType = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).toLowerCase() === t);

function offersOf(node) {
  const list = [].concat(node.offers || []).flatMap((o) => (o && o.offers ? [].concat(o.offers) : [o])).filter(Boolean);
  return list.map((o) => {
    const price = parsePrice(o.price ?? o.lowPrice ?? (o.priceSpecification && [].concat(o.priceSpecification)[0]?.price));
    const spec = [].concat(o.priceSpecification || []);
    const strike = spec.find((s) => /strikethrough|listprice|msrp/i.test(String(s.priceType || '')));
    return {
      price,
      oldPrice: strike ? parsePrice(strike.price) : null,
      currency: String(o.priceCurrency || (spec[0] && spec[0].priceCurrency) || '').toUpperCase(),
      available: o.availability ? /instock|limitedavailability|preorder|onlineonly/i.test(String(o.availability)) : null,
    };
  }).filter((o) => o.price);
}

function fromJsonLd(html, baseUrl) {
  const nodes = flattenLd(jsonLdBlocks(html));
  const group = nodes.find((n) => isType(n, 'productgroup'));
  const products = nodes.filter((n) => isType(n, 'product'));
  const variants = group ? [].concat(group.hasVariant || []) : [];
  const main = group || products[0];
  if (!main) return null;

  const allOffers = [main, ...variants, ...products].flatMap(offersOf);
  if (!allOffers.length) return null;
  const eur = allOffers.filter((o) => o.currency === 'EUR');
  const pick = (eur.length ? eur : allOffers).sort((a, b) => a.price - b.price)[0];

  const variantList = variants.length ? variants : products.length > 1 ? products : [];
  const sizes = uniq(variantList.filter((v) => v.size).map((v) => ({
    name: decodeEntities(typeof v.size === 'object' ? v.size.name : v.size),
    available: offersOf(v).some((o) => o.available !== false),
  })));
  const colors = uniq(variantList.filter((v) => v.color).map((v) => ({ name: decodeEntities(v.color), available: true })));
  if (!colors.length && main.color) colors.push({ name: decodeEntities(main.color), available: true });

  return {
    method: 'json-ld',
    title: decodeEntities(main.name || (products[0] && products[0].name)),
    price: pick.price,
    oldPrice: pick.oldPrice && pick.oldPrice > pick.price ? pick.oldPrice : null,
    currency: pick.currency || '',
    image: absUrl(main.image || (variantList[0] && variantList[0].image) || (products[0] && products[0].image), baseUrl),
    sizes,
    colors,
    available: allOffers.some((o) => o.available !== false),
  };
}

// ---------- Мета-теги и микроразметка ----------
function metaTags(html) {
  const map = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    m[1].replace(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, v1, v2) => { attrs[k.toLowerCase()] = v1 ?? v2; });
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in map)) map[key] = decodeEntities(attrs.content);
  }
  return map;
}

function fromMeta(html, baseUrl) {
  const meta = metaTags(html);
  let price = parsePrice(meta['product:price:amount'] || meta['og:price:amount'] || meta['product:sale_price:amount'] || meta.price);
  let currency = (meta['product:price:currency'] || meta['og:price:currency'] || meta.pricecurrency || '').toUpperCase();
  let method = 'meta';
  if (!price) {
    const mm = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i)
      || html.match(/itemprop=["']price["'][^>]*>([^<]{1,30})</i);
    if (mm) { price = parsePrice(decodeEntities(mm[1])); method = 'microdata'; }
    const cm = html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/i);
    if (cm) currency = cm[1].toUpperCase();
  }
  if (!price) return null;
  const old = parsePrice(meta['product:original_price:amount'] || meta['og:original_price:amount']);
  const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  return {
    method,
    title: decodeEntities(meta['og:title'] || meta['twitter:title'] || titleTag || ''),
    price,
    oldPrice: old && old > price ? old : null,
    currency,
    image: absUrl(meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'], baseUrl),
    sizes: [],
    colors: [],
    available: meta['product:availability'] ? !/out ?of ?stock|oos/i.test(meta['product:availability']) : null,
  };
}

function fromHtml(html, baseUrl) {
  const ld = fromJsonLd(html, baseUrl);
  const meta = fromMeta(html, baseUrl);
  if (ld && meta) {
    // Дополняем JSON-LD тем, чего в нём нет
    return {
      ...ld,
      title: ld.title || meta.title,
      image: ld.image || meta.image,
      currency: ld.currency || meta.currency,
      oldPrice: ld.oldPrice || (meta.oldPrice && meta.oldPrice > ld.price ? meta.oldPrice : null),
    };
  }
  return ld || meta;
}

// ---------- Теги из настроек магазина ----------
function storeSelectors(store) {
  if (!store) return {};
  return {
    price: store.sel_price || '',
    oldPrice: store.sel_old_price || '',
    title: store.sel_title || '',
    image: store.sel_image || '',
    sizes: store.sel_sizes || '',
  };
}
const hasSelectors = (sel) => Boolean(sel.price || sel.oldPrice || sel.title || sel.image || sel.sizes);

// То же, что readSelectors в браузере, но по уже скачанному HTML
function readSelectorsStatic(html, sel) {
  let root;
  try { root = parseHtmlDom(html); } catch { return {}; }
  const parts = (spec) => (spec || '').split('||').map((p) => p.trim()).filter(Boolean);
  const one = (spec) => {
    for (const part of parts(spec)) {
      const at = part.lastIndexOf('@');
      const css = at > 0 ? part.slice(0, at).trim() : part;
      const attr = at > 0 ? part.slice(at + 1).trim() : '';
      let el = null;
      try { el = root.querySelector(css); } catch { continue; }
      if (!el) continue;
      const v = attr ? el.getAttribute(attr) : el.text;
      if (v && v.trim()) return decodeEntities(v);
    }
    return '';
  };
  const many = (spec) => {
    for (const part of parts(spec)) {
      let els = [];
      try { els = root.querySelectorAll(part); } catch { continue; }
      if (!els.length) continue;
      return els.map((el) => {
        const cls = `${el.getAttribute('class') || ''} ${(el.parentNode && el.parentNode.getAttribute && el.parentNode.getAttribute('class')) || ''}`;
        return {
          name: decodeEntities(el.text),
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
            || /disabled|unavailable|out-of-stock|outofstock|sold-out|soldout|esgotad|not-available/i.test(cls),
        };
      }).filter((x) => x.name && x.name.length < 40);
    }
    return [];
  };
  return { price: one(sel.price), oldPrice: one(sel.oldPrice), title: one(sel.title), image: one(sel.image), sizes: many(sel.sizes) };
}

// Объединяет найденное по разметке (data) с найденным по тегам магазина (raw). Теги магазина важнее.
function mergeSelectors(data, raw, baseUrl) {
  if (!raw) return data;
  const price = parsePrice(raw.price);
  const old = parsePrice(raw.oldPrice);
  const sizes = (raw.sizes || []).map((x) => ({ name: decodeEntities(x.name), available: !x.disabled }));
  if (!data && !price) return null;
  const base = data || { method: 'selectors', title: '', price: null, oldPrice: null, currency: 'EUR', image: '', sizes: [], colors: [], available: null };
  const out = { ...base };
  if (price) { out.price = price; out.method = data ? `${data.method}+selectors` : 'selectors'; if (!data) out.currency = 'EUR'; }
  if (old && out.price && old > out.price) out.oldPrice = old;
  if (raw.title) out.title = decodeEntities(raw.title);
  if (raw.image) out.image = absUrl(raw.image, baseUrl) || out.image;
  if (sizes.length) out.sizes = uniq(sizes);
  return out;
}

// Название из заголовка страницы: «Macacão … - Mulher | MANGO Portugal» → «Macacão …»
function cleanTitle(title) {
  let t = String(title || '').trim();
  for (let i = 0; i < 3; i += 1) {
    const cut = t.replace(/\s+[|≡]\s+[^|≡]*$/, '').trim();
    if (!cut || cut === t) break;
    t = cut;
  }
  return t.replace(/\s+-\s+(mulher|homem|senhora|criança|crianças|kids|bebé|menina|menino)$/i, '').trim();
}

const pageTitle = (html) => decodeEntities((String(html).match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').slice(0, 80);

// ---------- Шаг 1: быстрый запрос ----------
async function directStep(u, allowed, sel, trace) {
  const started = Date.now();
  const get = async (url, accept) => {
    const r = await download(url, { accept, allowed });
    return r;
  };
  const adapter = ADAPTERS[rootDomain(u.hostname)];
  if (adapter && !adapter.browserOnly) {
    try {
      const data = await adapter(u, get);
      trace.push({ step: 'Быстрый запрос: данные магазина', ok: Boolean(data), ms: Date.now() - started });
      if (data) return { data };
    } catch (e) {
      trace.push({ step: 'Быстрый запрос: данные магазина', ok: false, note: e.message });
    }
  }
  try {
    const data = await tryShopify(u, get);
    if (data) { trace.push({ step: 'Быстрый запрос: Shopify', ok: true, ms: Date.now() - started }); return { data }; }
  } catch { /* не Shopify */ }

  const page = await download(u.href, { allowed });
  const note = `ответ ${page.status}${pageTitle(page.text) ? `, «${pageTitle(page.text)}»` : ''}`;
  if (page.status === 310) { trace.push({ step: 'Быстрый запрос', ok: false, note: 'ссылка ведёт на другой сайт' }); return { reason: 'redirected' }; }
  if (page.status === 404) { trace.push({ step: 'Быстрый запрос', ok: false, note }); return { reason: 'not_found' }; }
  let data = fromHtml(page.text, page.url || u.href);
  if (hasSelectors(sel) && page.status === 200) data = mergeSelectors(data, readSelectorsStatic(page.text, sel), page.url || u.href);
  const blocked = !data && looksBlocked(page.status, page.text);
  trace.push({ step: 'Быстрый запрос', ok: Boolean(data), ms: Date.now() - started, note: data ? `${note}, цена найдена` : `${note}${blocked ? ' — защита от ботов' : ', цены в странице нет'}` });
  return data ? { data } : { reason: blocked ? 'blocked' : 'no_price' };
}

// ---------- Шаг 2: встроенный Chrome ----------
async function browserStep(u, allowed, sel, trace) {
  const started = Date.now();
  const devMode = Boolean(process.env.PARSER_DEV_MAP);
  try {
    return await browser.withPage(devRemap(u.href), allowed, async (page, response) => {
      const status = response ? response.status() : 0;
      const ready = await waitForPriceSafe(page, sel.price);
      const html = await page.content();
      const finalUrl = page.url();
      const title = pageTitle(html);
      if (!devMode) {
        const fu = safeUrl(finalUrl);
        if (fu && !allowed.has(rootDomain(fu.hostname))) {
          trace.push({ step: 'Браузер', ok: false, note: 'страница ушла на другой сайт' });
          return { reason: 'redirected' };
        }
      }
      if (status === 404) { trace.push({ step: 'Браузер', ok: false, note: `ответ 404, «${title}»` }); return { reason: 'not_found' }; }

      let data = null;
      const adapter = ADAPTERS[rootDomain(u.hostname)];
      if (adapter) {
        try {
          // Адреса, которые запрашивала страница, — из них обработчик берёт служебные номера (Inditex)
          const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name)).catch(() => []);
          data = await adapter(u, browser.pageGetter(page), { resources });
        } catch { data = null; }
        // Чего нет в данных магазина (обычно фото) — из разметки страницы
        const fromPage = data && (!data.image || !data.title) ? fromHtml(html, finalUrl) : null;
        if (fromPage) { data.image = data.image || fromPage.image || ''; data.title = data.title || fromPage.title || ''; }
        if (data && !data.image) data.image = absUrl(metaTags(html)['og:image'], finalUrl) || '';
      }
      if (!data) data = fromHtml(html, finalUrl);
      if (hasSelectors(sel)) data = mergeSelectors(data, await browser.readSelectors(page, sel).catch(() => null), finalUrl);

      const blocked = !data && looksBlocked(status, html);
      trace.push({
        step: 'Браузер', ok: Boolean(data), ms: Date.now() - started,
        note: `ответ ${status || '—'}${title ? `, «${title}»` : ''}${data ? ', цена найдена' : blocked ? ' — защита от ботов' : ready ? ', цены нет' : ', цена не появилась'}`,
      });
      if (data) data.via = 'browser';
      return data ? { data } : { reason: blocked ? 'blocked' : 'no_price' };
    }, { devMode });
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    trace.push({ step: 'Браузер', ok: false, ms: Date.now() - started, note: msg });
    return { reason: /timeout/i.test(msg) ? 'timeout' : 'network' };
  }
}

async function waitForPriceSafe(page, priceSel) {
  try { return await browser.waitForPrice(page, priceSel); } catch { return false; }
}

// ---------- Главная функция ----------
// stores — активные магазины (url, link_prefix и теги sel_*). Возвращает объект результата, никогда не бросает.
// В результате есть trace — шаги проверки (для npm run check и админки).
async function parseProduct(rawUrl, stores, { noCache = false } = {}) {
  const u = safeUrl(rawUrl);
  if (!u) return { ok: false, reason: 'bad_url', trace: [] };
  const allowed = new Set(stores.map((s) => { const su = safeUrl(s.url); return su ? rootDomain(su.hostname) : ''; }).filter(Boolean));
  if (!allowed.has(rootDomain(u.hostname))) return { ok: false, reason: 'unknown_store', trace: [] };

  const key = u.href;
  const hit = cache.get(key);
  if (!noCache && hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.result, cached: true };

  const found = findStoreForLink(u.href, stores);
  const sel = storeSelectors(found && found.store);
  const trace = [];
  let step;
  try {
    step = await directStep(u, allowed, sel, trace);
  } catch (e) {
    trace.push({ step: 'Быстрый запрос', ok: false, note: e.name === 'AbortError' ? 'нет ответа' : e.message });
    step = { reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  }

  const canRetry = !step.data && !['not_found', 'redirected'].includes(step.reason);
  if (canRetry) {
    const st = browser.status();
    if (st.available) {
      step = await browserStep(u, allowed, sel, trace);
    } else {
      trace.push({ step: 'Браузер', ok: false, note: st.reason });
    }
  }

  let result;
  if (step.data) {
    const data = step.data;
    result = {
      ok: true,
      method: data.method,
      via: data.via || 'direct',
      title: cleanTitle(data.title).slice(0, 200),
      priceEur: data.currency && data.currency !== 'EUR' ? null : data.price,
      oldPriceEur: data.currency && data.currency !== 'EUR' ? null : data.oldPrice,
      price: data.price,
      currency: data.currency || 'EUR',
      image: data.image || '',
      sizes: (data.sizes || []).slice(0, 40),
      colors: (data.colors || []).slice(0, 30),
      available: data.available,
      selectedColor: data.selectedColor || '',
      trace,
    };
  } else {
    result = { ok: false, reason: step.reason || 'no_price', trace };
  }

  if (cache.size > 500) cache.delete(cache.keys().next().value);
  // Неудачи кэшируем ненадолго, чтобы после настройки тегов можно было сразу проверить снова
  cache.set(key, { at: result.ok ? Date.now() : Date.now() - CACHE_TTL + 60 * 1000, result });
  return result;
}

function clearCache() { cache.clear(); }

module.exports = { parseProduct, parsePrice, cleanTitle, fromHtml, fromJsonLd, fromMeta, decodeEntities, readSelectorsStatic, clearCache, browserStatus: browser.status };
