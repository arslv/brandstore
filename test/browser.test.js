// Тесты встроенного браузера: магазин не отдаёт страницу простому запросу, а цена появляется только после скриптов.
// Если Chrome не скачан (npm run browser), тесты пропускаются.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const browser = require('../src/lib/browser');

const skip = !browser.status().available && `встроенный Chrome не установлен: ${browser.status().reason}`;

// Пускаем только «настоящий браузер»: переход по странице или запрос со страницы того же сайта
const isBrowserNav = (req) => req.headers['sec-fetch-mode'] === 'navigate';
const isSameOrigin = (req) => req.headers['sec-fetch-site'] === 'same-origin';

const ROUTES = {
  // Похоже на Zara: цена рисуется скриптом, разметки товара нет
  '/pt/pt/casaco-p1.html': (req) => (isBrowserNav(req) ? { body: `<!doctype html><html><head><title>Casaco | ZARA Portugal</title>
      <meta property="og:image" content="https://static.zara.net/casaco.jpg"></head><body><div id="app">A carregar…</div>
      <script>setTimeout(() => { document.getElementById('app').innerHTML =
        '<h1 class="product-detail-info__header-name">Casaco de lã com cinto</h1>' +
        '<div class="price-old__amount"><span class="money-amount__main">69,95 EUR</span></div>' +
        '<div class="price-current__amount"><span class="money-amount__main">49,95 EUR</span></div>'; }, 400);</script></body></html>` }
    : { status: 403, body: '<html><head><title>Access Denied</title></head><body>Reference #18.abc</body></html>' }),
  // Похоже на Adidas: и страница, и JSON товара закрыты для простых запросов
  '/sapatilhas-samba-og/JI2734.html': (req) => (isBrowserNav(req) ? { body: '<!doctype html><title>Sapatilhas Samba OG | adidas PT</title><body>ok</body>' }
    : { status: 403, body: '<title>Access Denied</title>' }),
  '/api/products/JI2734': (req) => (isSameOrigin(req) ? { type: 'application/json', body: JSON.stringify({
    name: 'Sapatilhas Samba OG', pricing_information: { currentPrice: 130, standard_price: 130 },
    attribute_list: { search_color: 'Castanho' }, view_list: [{ type: 'standard', image_url: 'https://assets.adidas.com/x.jpg' }],
    variation_list: [{ size: '40' }, { size: '41 1/3' }] }) } : { status: 403, body: '<title>Access Denied</title>' }),
  '/api/products/JI2734/availability': (req) => (isSameOrigin(req) ? { type: 'application/json', body: JSON.stringify({
    variation_list: [{ size: '40', availability_status: 'IN_STOCK' }, { size: '41 1/3', availability_status: 'NOT_AVAILABLE' }] }) }
    : { status: 403, body: '' }),
  // Разметка товара появляется только после скрипта
  '/pt/produto-ld.html': (req) => (isBrowserNav(req) ? { body: `<!doctype html><title>Mala</title><script>
      setTimeout(() => { const s = document.createElement('script'); s.type = 'application/ld+json';
      s.textContent = JSON.stringify({ '@type': 'Product', name: 'Mala tote', offers: { price: '248.00', priceCurrency: 'EUR' } });
      document.head.appendChild(s); }, 500);</script>` } : { status: 503, body: '<title>Just a moment...</title> captcha' }),
  // Похоже на Pull&Bear: страница сама запрашивает каталог (по адресу видно номера магазина и каталога),
  // размеры и наличие — только в API
  '/pt/jeans-l07662706': (req) => (isBrowserNav(req) ? { body: `<!doctype html><html><head><title>Jeans wide leg | Pull&Bear Portugal</title>
      <meta property="og:image" content="https://static.pullandbear.net/jeans.jpg">
      <script type="application/ld+json">{"@type":"Product","name":"Jeans wide leg","offers":{"price":"35.99","priceCurrency":"EUR"}}</script>
      <script>const x = new XMLHttpRequest(); x.open('GET', '/itxrest/2/catalog/store/111/222/category?languageId=-6', false); x.send();</script>
      </head><body></body></html>` } : { status: 403, body: '' }),
  '/itxrest/2/catalog/store/111/222/category': () => ({ type: 'application/json', body: '{}' }),
  '/itxrest/2/catalog/store/111/222/category/0/product/760089372/detail': (req) => (isSameOrigin(req) ? { type: 'application/json', body: JSON.stringify({
    name: 'Jeans wide leg com tachas', mainColorid: '400', bundleProductSummaries: [{ detail: { colors: [
      { id: '400', name: 'Azul', sizes: [{ sku: 1, name: '36', price: '3999', isBuyable: true }] },
      { id: '800', name: 'Preto', sizes: [{ sku: 2, name: '36', price: '3599', oldPrice: '4599', isBuyable: true }, { sku: 3, name: '38', price: '3599', isBuyable: true }] },
    ] } }] }) } : { status: 403, body: '' }),
  '/itxrest/2/catalog/store/111/222/product/760089372/stock': (req) => (isSameOrigin(req) ? { type: 'application/json', body: JSON.stringify({
    stocks: [{ productId: 760089372, stocks: [{ id: 2, availability: 'in_stock' }, { id: 3, availability: 'out_of_stock' }] }] }) } : { status: 403, body: '' }),
};

let server;
let parser;
let stores;

before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    const route = ROUTES[req.url.split('?')[0]];
    const r = route ? route(req) : { status: 404, body: 'not found' };
    res.writeHead(r.status || 200, { 'content-type': r.type || 'text/html; charset=utf-8' });
    res.end(r.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PARSER_DEV_MAP = `zara.com=${base},adidas.pt=${base},shop-ld.com=${base},pullandbear.com=${base}`;
  parser = require('../src/lib/parser');
  stores = [
    { url: 'http://www.zara.com/pt/', sel_price: '.price-current__amount .money-amount__main || .money-amount__main',
      sel_old_price: '.price-old__amount .money-amount__main', sel_title: 'h1.product-detail-info__header-name || h1',
      sel_image: 'meta[property="og:image"]@content' },
    { url: 'https://www.adidas.pt' },
    { url: 'https://www.shop-ld.com/pt/' },
    { url: 'https://www.pullandbear.com/pt/' },
  ];
});

after(async () => {
  if (skip) return;
  await browser.close();
  server.close();
});

test('страница закрыта для простого запроса, цена рисуется скриптом — берём по тегам через браузер', { skip, timeout: 60000 }, async () => {
  const r = await parser.parseProduct('https://www.zara.com/pt/pt/casaco-p1.html', stores, { noCache: true });
  assert.equal(r.ok, true, JSON.stringify(r.trace));
  assert.equal(r.via, 'browser');
  assert.equal(r.method, 'selectors');
  assert.equal(r.priceEur, 49.95);
  assert.equal(r.oldPriceEur, 69.95);
  assert.equal(r.title, 'Casaco de lã com cinto');
  assert.equal(r.image, 'https://static.zara.net/casaco.jpg');
  assert.equal(r.trace[0].ok, false);
  assert.match(r.trace[0].note, /403/);
});

test('Adidas: данные товара запрашиваются изнутри открытой страницы', { skip, timeout: 60000 }, async () => {
  const r = await parser.parseProduct('https://www.adidas.pt/sapatilhas-samba-og/JI2734.html', stores, { noCache: true });
  assert.equal(r.ok, true, JSON.stringify(r.trace));
  assert.equal(r.via, 'browser');
  assert.equal(r.method, 'adidas');
  assert.equal(r.priceEur, 130);
  assert.deepEqual(r.sizes, [{ name: '40', available: true }, { name: '41 1/3', available: false }]);
});

test('разметка товара, добавленная скриптом', { skip, timeout: 60000 }, async () => {
  const r = await parser.parseProduct('https://www.shop-ld.com/pt/produto-ld.html', stores, { noCache: true });
  assert.equal(r.ok, true, JSON.stringify(r.trace));
  assert.equal(r.method, 'json-ld');
  assert.equal(r.priceEur, 248);
});

test('Inditex: размеры и наличие из API, номера магазина — из запросов страницы', { skip, timeout: 60000 }, async () => {
  const r = await parser.parseProduct('https://www.pullandbear.com/pt/jeans-l07662706?cS=800&pelement=760089372', stores, { noCache: true });
  assert.equal(r.ok, true, JSON.stringify(r.trace));
  assert.equal(r.method, 'inditex');
  assert.equal(r.priceEur, 35.99);
  assert.equal(r.oldPriceEur, 45.99);
  assert.equal(r.selectedColor, 'Preto');
  assert.deepEqual(r.sizes, [{ name: '36', available: true }, { name: '38', available: false }]);
  assert.equal(r.image, 'https://static.pullandbear.net/jeans.jpg');
});
