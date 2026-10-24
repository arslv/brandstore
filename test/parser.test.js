// Тесты парсера цен: node --test test/
// Сайты магазинов подменяются локальным сервером через PARSER_DEV_MAP — интернет не нужен.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Здесь проверяется быстрый шаг, без встроенного браузера (его проверяет test/browser.test.js)
process.env.PARSER_BROWSER = 'off';

const PAGES = {
  // JSON-LD, обычный товар
  '/pt/casaco-p1.html': {
    type: 'text/html',
    body: `<html><head><title>Casaco | Loja</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Casaco de l&atilde; com cinto",
      "image":["https://cdn.example/casaco.jpg"],"color":"Camel",
      "offers":{"@type":"Offer","price":"89.95","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script></head><body></body></html>`,
  },
  // JSON-LD: @graph + ProductGroup с вариантами
  '/pt/vestido-p2.html': {
    type: 'text/html',
    body: `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
      {"@type":"ProductGroup","name":"Vestido midi","image":{"@type":"ImageObject","url":"/img/vestido.jpg"},
       "hasVariant":[
        {"@type":"Product","size":"S","color":"Preto","offers":{"@type":"Offer","price":59.99,"priceCurrency":"EUR","availability":"InStock",
          "priceSpecification":[{"@type":"UnitPriceSpecification","priceType":"https://schema.org/StrikethroughPrice","price":79.99}]}},
        {"@type":"Product","size":"M","color":"Preto","offers":{"@type":"Offer","price":59.99,"priceCurrency":"EUR","availability":"OutOfStock"}},
        {"@type":"Product","size":"L","color":"Bege","offers":{"@type":"Offer","price":59.99,"priceCurrency":"EUR","availability":"InStock"}}
       ]}]}</script>`,
  },
  // Мета-теги
  '/pt/mala-p3': {
    type: 'text/html',
    body: `<meta property="og:title" content="Mala tote em pele &amp; camurça"><meta content="1.299,00" property="product:price:amount">
      <meta property="product:price:currency" content="EUR"><meta property="og:image" content="//cdn.example/mala.jpg">`,
  },
  // Микроразметка
  '/pt/oculos-p4': {
    type: 'text/html',
    body: `<title>Óculos</title><div itemscope itemtype="https://schema.org/Product"><span itemprop="price">95,00 €</span>
      <meta itemprop="priceCurrency" content="EUR"></div>`,
  },
  // Цена в долларах
  '/us/tenis-p5': {
    type: 'text/html',
    body: `<script type="application/ld+json">{"@type":"Product","name":"Sneaker","offers":{"price":"150.00","priceCurrency":"USD"}}</script>`,
  },
  // Защита от ботов
  '/pt/blocked-p6': { status: 403, type: 'text/html', body: '<html><title>Access Denied</title><div id="px-captcha"></div></html>' },
  // Нет цены
  '/pt/sem-preco': { type: 'text/html', body: '<html><title>Página</title><p>Olá</p></html>' },
  // Редирект на чужой домен
  '/pt/redir': { status: 302, location: 'https://evil.example/steal' },
  // Редирект внутри магазина
  '/pt/old-link': { status: 301, location: '/pt/casaco-p1.html' },
  // Shopify
  '/en-pt/products/numero-un.js': {
    type: 'application/json',
    body: JSON.stringify({
      title: 'Numéro Un', price: 39000, compare_at_price: 45000, featured_image: '//cdn.shopify.com/s/files/numero-un.jpg',
      options: [{ name: 'Color', position: 1 }, { name: 'Size', position: 2 }],
      variants: [
        { id: 11, option1: 'Black', option2: 'Mini', price: 39000, compare_at_price: 45000, available: true },
        { id: 12, option1: 'Black', option2: 'Large', price: 42000, compare_at_price: null, available: false },
        { id: 13, option1: 'Camel', option2: 'Mini', price: 39000, compare_at_price: 45000, available: true },
      ],
    }),
  },
  // Цена только в тегах страницы, без разметки — берётся по тегам из настроек магазина
  '/pt/pt/casaco-tags-p7.html': {
    type: 'text/html',
    body: `<html><head><title>Casaco | ZARA</title><meta property="og:image" content="https://static.zara.net/casaco.jpg"></head><body>
      <h1 class="product-detail-info__header-name">Casaco de lã</h1>
      <div class="price-old__amount"><span class="money-amount__main">69,95 EUR</span></div>
      <div class="price-current__amount"><span class="money-amount__main">49,95 EUR</span></div>
      <ul><li><button class="size">S</button></li><li><button class="size" disabled>M</button></li><li><button class="size">L</button></li></ul></body></html>`,
  },
  '/en-pt/cart.js': { type: 'application/json', body: '{"currency":"EUR","items":[]}' },
  // Adidas: JSON товара и наличие размеров
  '/api/products/JI2734': {
    type: 'application/json',
    body: JSON.stringify({
      id: 'JI2734', name: 'Sapatilhas Samba OG',
      pricing_information: { currentPrice: 130, standard_price: 130, standard_price_no_vat: 108.33 },
      attribute_list: { color: 'Brown / Preloved Red / Cream White', search_color: 'Castanho' },
      view_list: [{ type: 'standard', image_url: 'https://assets.adidas.com/images/samba_01_standard.jpg' }],
      variation_list: [{ sku: 'JI2734_520', size: '35 1/2' }, { sku: 'JI2734_530', size: '36' }, { sku: 'JI2734_540', size: '36 2/3' }],
    }),
  },
  '/api/products/JI2734/availability': {
    type: 'application/json',
    body: JSON.stringify({ id: 'JI2734', availability_status: 'IN_STOCK', variation_list: [
      { sku: 'JI2734_520', size: '35 1/2', availability: 3, availability_status: 'IN_STOCK' },
      { sku: 'JI2734_530', size: '36', availability: 0, availability_status: 'NOT_AVAILABLE' },
      { sku: 'JI2734_540', size: '36 2/3', availability: 1, availability_status: 'IN_STOCK' }] }),
  },
  '/api/products/HQ1234': {
    type: 'application/json',
    body: JSON.stringify({ id: 'HQ1234', name: 'Casaco Adicolor', pricing_information: { currentPrice: 70, standard_price: 100, sale_price: 70 },
      attribute_list: { search_color: 'Preto' }, view_list: [], variation_list: [{ size: 'M' }] }),
  },
};

let server;
let stores;
let parser;

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const page = PAGES[path];
    if (!page) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
    res.writeHead(page.status || 200, { 'content-type': page.type || 'text/html', ...(page.location ? { location: page.location } : {}) });
    res.end(page.body || '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PARSER_DEV_MAP = `shop-a.com=${base},shop-b.com=${base},adidas.pt=${base}`;
  parser = require('../src/lib/parser');
  stores = [{ url: 'https://www.shop-a.com/pt/' }, { url: 'https://euro.shop-b.com/' }, { url: 'https://www.adidas.pt' }];
});

after(() => server.close());

test('цены в разных форматах', () => {
  const { parsePrice } = parser;
  assert.equal(parsePrice('89.95'), 89.95);
  assert.equal(parsePrice('89,95 €'), 89.95);
  assert.equal(parsePrice('1.299,00'), 1299);
  assert.equal(parsePrice('1,299.00'), 1299);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice('EUR 25'), 25);
  assert.equal(parsePrice(59.99), 59.99);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('Grátis'), null);
});

test('JSON-LD: обычный товар', async () => {
  const r = await parser.parseProduct('https://www.shop-a.com/pt/casaco-p1.html', stores);
  assert.equal(r.ok, true);
  assert.equal(r.method, 'json-ld');
  assert.equal(r.priceEur, 89.95);
  assert.equal(r.title, 'Casaco de lã com cinto');
  assert.equal(r.image, 'https://cdn.example/casaco.jpg');
  assert.deepEqual(r.colors.map((c) => c.name), ['Camel']);
});

test('JSON-LD: варианты, размеры, наличие, старая цена', async () => {
  const r = await parser.parseProduct('https://www.shop-a.com/pt/vestido-p2.html', stores);
  assert.equal(r.ok, true);
  assert.equal(r.priceEur, 59.99);
  assert.equal(r.oldPriceEur, 79.99);
  assert.deepEqual(r.sizes, [{ name: 'S', available: true }, { name: 'M', available: false }, { name: 'L', available: true }]);
  assert.deepEqual(r.colors.map((c) => c.name), ['Preto', 'Bege']);
  assert.ok(r.image.endsWith('/img/vestido.jpg'));
});

test('мета-теги', async () => {
  const r = await parser.parseProduct('https://www.shop-a.com/pt/mala-p3', stores);
  assert.equal(r.method, 'meta');
  assert.equal(r.priceEur, 1299);
  assert.equal(r.title, 'Mala tote em pele & camurça');
  assert.equal(r.image, 'https://cdn.example/mala.jpg');
});

test('микроразметка', async () => {
  const r = await parser.parseProduct('https://www.shop-a.com/pt/oculos-p4', stores);
  assert.equal(r.method, 'microdata');
  assert.equal(r.priceEur, 95);
});

test('цена не в евро — не подставляется', async () => {
  const r = await parser.parseProduct('https://www.shop-a.com/us/tenis-p5', stores);
  assert.equal(r.ok, true);
  assert.equal(r.currency, 'USD');
  assert.equal(r.priceEur, null);
});

test('защита от ботов, нет цены, 404', async () => {
  assert.equal((await parser.parseProduct('https://www.shop-a.com/pt/blocked-p6', stores)).reason, 'blocked');
  assert.equal((await parser.parseProduct('https://www.shop-a.com/pt/sem-preco', stores)).reason, 'no_price');
  assert.equal((await parser.parseProduct('https://www.shop-a.com/pt/nao-existe', stores)).reason, 'not_found');
});

test('редиректы: внутри магазина — да, на чужой сайт — нет', async () => {
  const ok = await parser.parseProduct('https://www.shop-a.com/pt/old-link', stores);
  assert.equal(ok.priceEur, 89.95);
  const bad = await parser.parseProduct('https://www.shop-a.com/pt/redir', stores);
  assert.equal(bad.reason, 'redirected');
});

test('только магазины из списка', async () => {
  assert.equal((await parser.parseProduct('https://example.org/x', stores)).reason, 'unknown_store');
  assert.equal((await parser.parseProduct('not a url', stores)).reason, 'bad_url');
});

test('Shopify: цена варианта, старая цена, размеры и цвета', async () => {
  const r = await parser.parseProduct('https://euro.shop-b.com/en-pt/products/numero-un?variant=13', stores);
  assert.equal(r.method, 'shopify');
  assert.equal(r.priceEur, 390);
  assert.equal(r.oldPriceEur, 450);
  assert.equal(r.title, 'Numéro Un');
  assert.equal(r.image, 'https://cdn.shopify.com/s/files/numero-un.jpg');
  assert.deepEqual(r.sizes, [{ name: 'Mini', available: true }, { name: 'Large', available: false }]);
  assert.deepEqual(r.colors.map((c) => c.name), ['Black', 'Camel']);
  assert.equal(r.selectedColor, 'Camel');
});

test('Adidas: цена, фото, цвет, размеры с наличием', async () => {
  const r = await parser.parseProduct('https://www.adidas.pt/sapatilhas-samba-og/JI2734.html', stores);
  assert.equal(r.method, 'adidas');
  assert.equal(r.priceEur, 130);
  assert.equal(r.oldPriceEur, null);
  assert.equal(r.title, 'Sapatilhas Samba OG');
  assert.equal(r.image, 'https://assets.adidas.com/images/samba_01_standard.jpg');
  assert.equal(r.selectedColor, 'Castanho');
  assert.deepEqual(r.sizes, [{ name: '35 1/2', available: true }, { name: '36', available: false }, { name: '36 2/3', available: true }]);
});

test('Adidas: скидка и товар без данных о наличии', async () => {
  const r = await parser.parseProduct('https://www.adidas.pt/casaco-adicolor/HQ1234.html?pr=x', stores);
  assert.equal(r.priceEur, 70);
  assert.equal(r.oldPriceEur, 100);
  assert.deepEqual(r.sizes, [{ name: 'M', available: true }]);
});

test('теги из настроек магазина, когда разметки нет', async () => {
  const withTags = [...stores, {
    url: 'https://www.shop-c.com/pt/',
    sel_price: '.price-current__amount .money-amount__main || .money-amount__main',
    sel_old_price: '.price-old__amount .money-amount__main',
    sel_title: 'h1.product-detail-info__header-name || h1',
    sel_image: 'meta[property="og:image"]@content',
    sel_sizes: 'button.size',
  }];
  process.env.PARSER_DEV_MAP += `,shop-c.com=${process.env.PARSER_DEV_MAP.split('=')[1].split(',')[0]}`;
  const r = await parser.parseProduct('https://www.shop-c.com/pt/pt/casaco-tags-p7.html', withTags);
  assert.equal(r.ok, true);
  assert.equal(r.method, 'selectors');
  assert.equal(r.priceEur, 49.95);
  assert.equal(r.oldPriceEur, 69.95);
  assert.equal(r.title, 'Casaco de lã');
  assert.equal(r.image, 'https://static.zara.net/casaco.jpg');
  assert.deepEqual(r.sizes, [{ name: 'S', available: true }, { name: 'M', available: false }, { name: 'L', available: true }]);
  // Без тегов эта страница цены не даёт
  const plain = await parser.parseProduct('https://www.shop-a.com/pt/pt/casaco-tags-p7.html', stores);
  assert.equal(plain.reason, 'no_price');
});

test('название без хвоста с именем магазина', () => {
  assert.equal(parser.cleanTitle('Macacão halter acetinado em jacquard - Mulher | MANGO Portugal'), 'Macacão halter acetinado em jacquard');
  assert.equal(parser.cleanTitle('Peptide Lip Tint - Glaze nutritivo | RHODE ≡ SEPHORA'), 'Peptide Lip Tint - Glaze nutritivo');
  assert.equal(parser.cleanTitle('Sapatilhas Adizero EVO SL'), 'Sapatilhas Adizero EVO SL');
});
