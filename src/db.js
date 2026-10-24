const fs = require('fs');
const path = require('path');
const Database = require('./lib/sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');
const storesData = require('./data/stores');
const { beautySubcats } = storesData;
const { slugify, regionPrefix, safeUrl, rootDomain } = require('./lib/urls');
const { NO_RANK, formatHomeTabs } = require('./lib/format');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new Database(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'PT',
  link_prefix TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '',
  subcategories TEXT NOT NULL DEFAULT '',
  icon_domain TEXT NOT NULL DEFAULT '',
  logo_path TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  is_popular INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'clothes',
  subcategory TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'women',
  description TEXT NOT NULL DEFAULT '',
  price_eur REAL NOT NULL,
  old_price_eur REAL,
  sizes TEXT NOT NULL DEFAULT '',
  colors TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  source_url TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  type TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  price_eur REAL NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  region_ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cart_owner ON cart_items(owner);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new',
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  delivery_method TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  subtotal_rub INTEGER NOT NULL DEFAULT 0,
  delivery_rub INTEGER NOT NULL DEFAULT 0,
  total_rub INTEGER NOT NULL DEFAULT 0,
  rate_eur REAL NOT NULL,
  markup_pct REAL NOT NULL,
  manager_comment TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  payment_url TEXT NOT NULL DEFAULT '',
  payment_id TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  product_id INTEGER,
  store_id INTEGER,
  store_name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  price_eur REAL NOT NULL DEFAULT 0,
  unit_price_rub INTEGER NOT NULL DEFAULT 0,
  line_total_rub INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  region_ok INTEGER NOT NULL DEFAULT 1,
  item_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

// ---------- Миграции для баз, созданных прошлой версией ----------
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('stores', 'subcategories', "TEXT NOT NULL DEFAULT ''");
addColumn('products', 'subcategory', "TEXT NOT NULL DEFAULT ''");
addColumn('orders', 'payment_method', "TEXT NOT NULL DEFAULT ''");
// v3: автоматическое получение цены по ссылке
addColumn('stores', 'parse_ok', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stores', 'parse_fail', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stores', 'parse_last', "TEXT NOT NULL DEFAULT ''");
addColumn('stores', 'parse_last_at', "TEXT NOT NULL DEFAULT ''");
addColumn('cart_items', 'price_auto', 'INTEGER NOT NULL DEFAULT 0');
addColumn('order_items', 'price_auto', 'INTEGER NOT NULL DEFAULT 0');
// v4: теги цены для каждого магазина (CSS-селекторы, «@атрибут» — взять атрибут, варианты через «||»)
for (const col of ['sel_price', 'sel_old_price', 'sel_title', 'sel_image', 'sel_sizes']) addColumn('stores', col, "TEXT NOT NULL DEFAULT ''");
// v5: вкладки главной, на которых виден магазин, и его место в сетке («all:1,women:3»)
addColumn('stores', 'home_tabs', "TEXT NOT NULL DEFAULT ''");
// v6: плитка бренда на главной — фон, цвет надписи, шрифт, надпись (пусто — название магазина)
for (const col of ['tile_bg', 'tile_fg', 'tile_font', 'tile_text']) addColumn('stores', col, "TEXT NOT NULL DEFAULT ''");

// ---------- Настройки по умолчанию ----------
const DEFAULT_SETTINGS = {
  markup_pct: '20',
  rate_mode: 'auto', // auto — курс ЦБ, manual — ручной
  rate_eur_manual: '100',
  rate_eur_auto: '',
  rate_updated_at: '',
  delivery_fee_rub: '0',
  notify_email: '',
  eu_limit_eur: '300',
  payment_mode: 'demo', // demo — тестовая оплата, link — ссылка от менеджера, yookassa — ЮKassa
  pay_flow: 'after_check', // after_check — оплата после проверки менеджером, instant — сразу при оформлении
  payment_methods: 'card,sbp,sberpay,tpay,yoomoney',
  shop_email: 'info@brandstore.ru',
  shop_phone: '',
  shop_telegram: '',
  payment_instructions:
    'После проверки заказа менеджер пришлёт ссылку на оплату. Оплатить можно картой любого российского банка или через СБП.',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// ---------- Администратор ----------
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync(config.admin.password, 10);
  db.prepare("INSERT OR IGNORE INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')")
    .run(config.admin.email.toLowerCase(), hash, 'Администратор');
  console.log(`[db] Создан администратор: ${config.admin.email}`);
}

// ---------- Магазины ----------
const POPULAR = new Set(['zara', 'mango', 'massimo-dutti', 'cos', 'sephora', 'farfetch', 'el-corte-ingles', 'adidas',
  'h-and-m', 'uniqlo', 'veja', 'pandora', 'gucci', 'prada', 'notino', 'lacoste', 'sezane', 'zara-home']);
const storeCount = db.prepare('SELECT COUNT(*) AS n FROM stores').get().n;
if (storeCount === 0) {
  const tx = db.transaction(() => { for (const row of storesData) insertStore(row); });
  tx();
  console.log(`[db] Добавлено магазинов: ${storesData.length}`);
}

function insertStore([name, url, region, categories, iconDomain]) {
  const slug = slugify(name);
  const u = safeUrl(url);
  db.prepare(`INSERT OR IGNORE INTO stores (slug, name, url, region, link_prefix, categories, subcategories, icon_domain, is_popular)
    VALUES (@slug, @name, @url, @region, @link_prefix, @categories, @subcategories, @icon_domain, @is_popular)`).run({
    slug, name, url, region,
    link_prefix: regionPrefix(url),
    categories,
    subcategories: beautySubcats[slug] || '',
    icon_domain: iconDomain || (u ? rootDomain(u.hostname) : ''),
    is_popular: POPULAR.has(slug) ? 1 : 0,
  });
}

// ---------- Демо-товары (для витрины; удаляются в админке одной кнопкой) ----------
const EXTRA_DEMO = [
  ['Ароматическая свеча в стекле', 'zara-home', 'home', 'unisex', 25.99, null, '200 г', 'Белый чай,Инжир', 'candle', 1, ''],
  ['Набор столовых приборов, 24 предмета', 'cutipol', 'home', 'unisex', 189, 236, 'Один размер', 'Матовое золото,Сталь', 'cutlery', 0, ''],
  ['Парфюмерная вода 50 мл', 'byredo', 'beauty', 'unisex', 210, null, '50 мл,100 мл', 'Без цвета', 'perfume', 1, 'perfume'],
];

function insertDemo([title, slug, cat, gender, price, old, sizes, colors, img, featured, subcategory]) {
  const store = db.prepare('SELECT id, url FROM stores WHERE slug = ?').get(slug) || {};
  db.prepare(`INSERT INTO products (title, store_id, category, subcategory, gender, description, price_eur, old_price_eur, sizes, colors, images, source_url, is_featured, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(title, store.id || null, cat, subcategory || (img === 'soap' ? 'body' : ''), gender,
      'Пример товара для витрины. Замените на настоящий в админке: фото, цена, размеры и ссылка на товар в магазине.',
      price, old, sizes, colors, JSON.stringify([`/img/demo/${img}.svg`]), store.url || '', featured);
}

const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
const demoSeeded = db.prepare("SELECT value FROM settings WHERE key = 'demo_seeded'").get();
if (productCount === 0 && !demoSeeded) {
  const demo = [
    ['Тренч из хлопка с поясом', 'massimo-dutti', 'clothes', 'women', 169, null, 'XS,S,M,L,XL', 'Бежевый,Чёрный', 'trench', 1],
    ['Кожаные лоферы', 'pretty-ballerinas', 'shoes', 'women', 189, 229, '36,37,38,39,40,41', 'Шоколадный,Чёрный', 'loafer', 1],
    ['Сумка-шопер из гладкой кожи', 'furla', 'accessories', 'women', 248, 310, 'Один размер', 'Карамельный,Чёрный,Молочный', 'tote', 1],
    ['Кашемировый свитер оверсайз', 'cos', 'clothes', 'men', 135, null, 'S,M,L,XL', 'Серый меланж,Тёмно-синий', 'sweater', 1],
    ['Кеды из кожи V-10', 'veja', 'shoes', 'unisex', 150, null, '36,37,38,39,40,41,42,43,44', 'Белый,Белый/зелёный', 'sneaker', 1],
    ['Платье миди с запахом', 'mango', 'clothes', 'women', 59.99, 79.99, 'XS,S,M,L', 'Терракотовый,Чёрный', 'dress', 1],
    ['Набор мыла ручной работы', 'claus-porto', 'beauty', 'unisex', 45, null, '3 × 150 г', 'Классический', 'soap', 0],
    ['Солнцезащитные очки в оправе кошачий глаз', 'multiopticas', 'accessories', 'women', 95, null, 'Один размер', 'Черепаховый,Чёрный', 'glasses', 0],
    ['Детская стёганая куртка', 'zippy', 'kids', 'kids', 39.99, 49.99, '2-3 года,4-5 лет,6-7 лет,8-9 лет', 'Горчичный,Синий', 'kidsjacket', 0],
    ['Ботинки челси из замши', 'timberland', 'shoes', 'men', 179, null, '40,41,42,43,44,45', 'Коричневый', 'boots', 0],
    ['Шёлковый платок с принтом', 'lanidor', 'accessories', 'women', 49, null, '90 × 90 см', 'Шоколадный,Голубой', 'scarf', 0],
    ['Часы с кожаным ремешком', 'swatch', 'jewelry', 'unisex', 120, null, 'Один размер', 'Коричневый ремешок', 'watch', 0],
    ...EXTRA_DEMO,
  ];
  const tx = db.transaction(() => { for (const row of demo) insertDemo(row); });
  tx();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_seeded', '1')").run();
  console.log('[db] Добавлены демо-товары');
}

// ---------- Обновление данных до версии 2: товары для дома, подкатегории красоты ----------
if (Number((db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() || {}).value || 1) < 2) {
  const tx = db.transaction(() => {
    const upd = db.prepare('UPDATE stores SET categories = ?, subcategories = ? WHERE slug = ?');
    for (const row of storesData) {
      const slug = slugify(row[0]);
      if (db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(slug)) upd.run(row[3], beautySubcats[slug] || '', slug);
      else insertStore(row);
    }
    db.prepare("UPDATE products SET subcategory = 'body' WHERE is_demo = 1 AND images LIKE '%soap.svg%'").run();
    db.prepare("UPDATE stores SET is_popular = 1 WHERE slug IN ('h-and-m', 'zara-home')").run();
    db.prepare("UPDATE stores SET is_popular = 0 WHERE slug = 'swarovski'").run();
    const hasDemo = db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_demo = 1').get().n > 0;
    if (hasDemo) {
      for (const row of EXTRA_DEMO) {
        if (!db.prepare('SELECT 1 FROM products WHERE title = ?').get(row[0])) insertDemo(row);
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '2')").run();
  });
  tx();
  console.log('[db] База обновлена до версии 2');
}

// ---------- Версия 3: заготовки тегов цены для популярных магазинов ----------
// Используются, только если в разметке страницы цены нет. Проверить и поправить можно в админке.
const DEFAULT_SELECTORS = {
  zara: {
    sel_price: '.price-current__amount .money-amount__main || .price__amount--on-sale .money-amount__main || .money-amount__main',
    sel_old_price: '.price-old__amount .money-amount__main || .price__amount--old .money-amount__main',
    sel_title: 'h1.product-detail-info__header-name || h1',
    sel_image: 'meta[property="og:image"]@content',
    sel_sizes: '',
  },
};
if (Number((db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() || {}).value || 1) < 3) {
  const upd = db.prepare(`UPDATE stores SET sel_price = @sel_price, sel_old_price = @sel_old_price, sel_title = @sel_title, sel_image = @sel_image, sel_sizes = @sel_sizes
    WHERE slug = @slug AND sel_price = ''`);
  for (const [slug, sel] of Object.entries(DEFAULT_SELECTORS)) upd.run({ slug, ...sel });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '3')").run();
}

// ---------- Версия 4: теги размеров, проверенные на живых сайтах (21.10.2026) ----------
// Цена у этих магазинов находится в разметке, теги нужны только для размеров. Классы Mango меняются
// при обновлении сайта, поэтому — по части имени ([class*=…]).
const SIZE_SELECTORS = {
  mango: 'ol[class*="ChipSizes"] button',
  bershka: '.size-selector__list button.size-button',
};
if (Number((db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() || {}).value || 1) < 4) {
  const upd = db.prepare("UPDATE stores SET sel_sizes = @sel_sizes WHERE slug = @slug AND sel_sizes = ''");
  for (const [slug, sel_sizes] of Object.entries(SIZE_SELECTORS)) upd.run({ slug, sel_sizes });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '4')").run();
}

// ---------- Версия 5: главная — сетка брендов по вкладкам Женщинам / Мужчинам / Детям / Для дома ----------
// Порядок — как в эскизе владельца (Zara, H&M, Mango…). Меняется в админке: «Магазины → магазин → На главной».
// Трогаем только магазины, у которых вкладки ещё не заданы.
const HOME_SEED = {
  all: ['zara', 'h-and-m', 'mango', 'massimo-dutti', 'zara-home', 'cos', 'uniqlo', 'adidas', 'sephora', 'farfetch',
    'el-corte-ingles', 'lacoste', 'veja', 'sezane', 'gucci', 'prada', 'notino', 'pandora'],
  women: ['zara', 'h-and-m', 'mango', 'massimo-dutti', 'bershka', 'pull-and-bear', 'stradivarius', 'cos', 'sezane',
    'and-other-stories', 'uniqlo', 'sephora', 'adidas', 'farfetch', 'el-corte-ingles', 'pandora'],
  men: ['zara', 'h-and-m', 'mango', 'massimo-dutti', 'pull-and-bear', 'cos', 'uniqlo', 'adidas', 'lacoste', 'hugo-boss',
    'ralph-lauren', 'levis', 'timberland', 'el-corte-ingles', 'farfetch', 'veja'],
  kids: ['zara', 'h-and-m', 'c-and-a', 'kiabi', 'zippy', 'boboli', 'jacadi', 'chicco', 'prenatal', 'lego', 'beppi',
    'dr-kid', 'the-baby-concept'],
  home: ['zara-home', 'h-and-m', 'el-corte-ingles', 'arket', 'maisons-du-monde', 'vista-alegre', 'cutipol', 'castelbel',
    'claus-porto', 'la-redoute', 'smeg', 'dyson', 'byredo'],
};
if (Number((db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() || {}).value || 1) < 5) {
  const tx = db.transaction(() => {
    const tabs = {};
    const add = (slug, key, rank) => { (tabs[slug] = tabs[slug] || {})[key] = rank; };
    for (const [key, slugs] of Object.entries(HOME_SEED)) {
      if (key !== 'all') slugs.forEach((slug, i) => add(slug, key, i + 1));
    }
    // Без вкладки — магазины с галочкой «Популярный» (владелец мог её менять), по порядку из списка
    for (const { slug } of db.prepare('SELECT slug FROM stores WHERE is_popular = 1').all()) {
      const i = HOME_SEED.all.indexOf(slug);
      add(slug, 'all', i >= 0 ? i + 1 : NO_RANK);
    }
    const upd = db.prepare("UPDATE stores SET home_tabs = ? WHERE slug = ? AND home_tabs = ''");
    for (const [slug, t] of Object.entries(tabs)) upd.run(formatHomeTabs(t), slug);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '5')").run();
  });
  tx();
}

// ---------- Версия 6: плитки брендов на главной в цветах логотипов ----------
// [фон, цвет надписи, шрифт, надпись]. Цвета — как у подложки и надписи логотипа бренда; поправить можно
// в админке: «Магазины → магазин → Плитка на главной». Трогаем только магазины без своих настроек плитки.
const TILE_SEED = {
  zara: ['#000000', '#FFFFFF', 'didone', 'ZARA'],
  'h-and-m': ['#E50010', '#FFFFFF', 'italic', 'H&M'],
  mango: ['#FFFFFF', '#000000', 'geometric', 'MANGO'],
  'massimo-dutti': ['#FFFFFF', '#000000', 'didone', 'MASSIMO DUTTI'],
  'zara-home': ['#FFFFFF', '#000000', 'didone', 'ZARA HOME'],
  cos: ['#FFFFFF', '#000000', 'geometric', 'COS'],
  uniqlo: ['#FF0000', '#FFFFFF', 'heavy', 'UNIQLO'],
  adidas: ['#000000', '#FFFFFF', 'heavy', 'adidas'],
  sephora: ['#000000', '#FFFFFF', 'geometric', 'SEPHORA'],
  farfetch: ['#FFFFFF', '#000000', 'geometric', 'FARFETCH'],
  'el-corte-ingles': ['#00843D', '#FFFFFF', 'italic', 'El Corte Inglés'],
  lacoste: ['#FFFFFF', '#004E3C', 'geometric', 'LACOSTE'],
  veja: ['#FFFFFF', '#000000', 'heavy', 'VEJA'],
  sezane: ['#FFFFFF', '#000000', 'didone', 'Sézane'],
  gucci: ['#000000', '#FFFFFF', 'didone', 'GUCCI'],
  prada: ['#FFFFFF', '#000000', 'didone', 'PRADA'],
  pandora: ['#FFFFFF', '#000000', 'geometric', 'PANDORA'],
  bershka: ['#000000', '#FFFFFF', 'geometric', 'BERSHKA'],
  'pull-and-bear': ['#FFFFFF', '#000000', 'geometric', 'PULL&BEAR'],
  stradivarius: ['#FFFFFF', '#000000', 'didone', 'STRADIVARIUS'],
  'and-other-stories': ['#FFFFFF', '#000000', 'didone', '& Other Stories'],
  'hugo-boss': ['#000000', '#FFFFFF', 'heavy', 'HUGO BOSS'],
  'ralph-lauren': ['#041E42', '#FFFFFF', 'didone', 'RALPH LAUREN'],
  levis: ['#C41230', '#FFFFFF', 'heavy', "Levi's"],
  timberland: ['#FFFFFF', '#000000', 'heavy', 'Timberland'],
  lego: ['#E3000B', '#FFFFFF', 'heavy', 'LEGO'],
  arket: ['#FFFFFF', '#000000', 'geometric', 'ARKET'],
  'vista-alegre': ['#FFFFFF', '#000000', 'didone', 'VISTA ALEGRE'],
  'claus-porto': ['#FFFFFF', '#000000', 'didone', 'CLAUS PORTO'],
  smeg: ['#FFFFFF', '#000000', 'heavy', 'SMEG'],
  dyson: ['#FFFFFF', '#000000', 'heavy', 'dyson'],
  byredo: ['#FFFFFF', '#000000', 'geometric', 'BYREDO'],
};
if (Number((db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() || {}).value || 1) < 6) {
  const tx = db.transaction(() => {
    const upd = db.prepare(`UPDATE stores SET tile_bg = ?, tile_fg = ?, tile_font = ?, tile_text = ?
      WHERE slug = ? AND tile_bg = '' AND tile_fg = '' AND tile_font = '' AND tile_text = ''`);
    for (const [slug, [bg, fg, font, text]] of Object.entries(TILE_SEED)) upd.run(bg, fg, font, text, slug);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '6')").run();
  });
  tx();
}

module.exports = db;
