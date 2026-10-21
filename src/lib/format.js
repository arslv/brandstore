const rub = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ')} ₽`;
const eur = (n) => `${(Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;

const dateTime = (s) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
};
const date = (s) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
};

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

const ORDER_STATUSES = {
  new: { label: 'Проверяем наличие', short: 'Новый', tone: 'info' },
  awaiting_payment: { label: 'Ожидает оплаты', short: 'Ждёт оплаты', tone: 'warn' },
  paid: { label: 'Оплачен', short: 'Оплачен', tone: 'ok' },
  purchased: { label: 'Выкуплен в магазине', short: 'Выкуплен', tone: 'ok' },
  shipped: { label: 'Отправлен в Россию', short: 'В пути', tone: 'ok' },
  delivered: { label: 'Доставлен', short: 'Доставлен', tone: 'done' },
  cancelled: { label: 'Отменён', short: 'Отменён', tone: 'muted' },
};
const STATUS_FLOW = ['new', 'awaiting_payment', 'paid', 'purchased', 'shipped', 'delivered'];

const ITEM_STATUSES = {
  pending: 'Проверяем',
  available: 'В наличии',
  unavailable: 'Нет в наличии',
  purchased: 'Выкуплен',
};

const CATEGORIES = {
  clothes: 'Одежда',
  shoes: 'Обувь',
  accessories: 'Сумки и аксессуары',
  beauty: 'Красота',
  luxury: 'Премиум',
  sport: 'Спорт',
  kids: 'Детям',
  home: 'Товары для дома',
  jewelry: 'Украшения и часы',
  pharmacy: 'Аптека',
  multibrand: 'Универмаги',
};

const BEAUTY_SUBCATS = {
  perfume: 'Парфюмерия',
  skincare: 'Уход за лицом',
  makeup: 'Макияж',
  hair: 'Волосы',
  body: 'Тело и ванна',
  nails: 'Ногти',
  derma: 'Аптечная косметика',
};

const GENDERS = { women: 'Женщинам', men: 'Мужчинам', kids: 'Детям', unisex: 'Унисекс' };

// Способы оплаты. yk — тип способа оплаты в ЮKassa (payment_method_data.type)
const PAYMENT_METHODS = {
  card: { label: 'Банковская карта', hint: 'Мир, Visa, Mastercard российских банков', yk: 'bank_card', icon: 'card' },
  sbp: { label: 'СБП', hint: 'По QR-коду или в приложении банка', yk: 'sbp', icon: 'qr' },
  sberpay: { label: 'SberPay', hint: 'В приложении СберБанк Онлайн', yk: 'sberbank', icon: 'phone' },
  tpay: { label: 'T-Pay', hint: 'В приложении Т-Банка', yk: 'tinkoff_bank', icon: 'phone' },
  yoomoney: { label: 'ЮMoney', hint: 'Кошелёк ЮMoney', yk: 'yoo_money', icon: 'wallet' },
};

// Результат автоматического получения цены (для админки)
const PARSE_RESULTS = {
  shopify: 'Shopify', adidas: 'данные Adidas', inditex: 'данные Inditex', 'json-ld': 'разметка товара', selectors: 'теги магазина', meta: 'мета-теги', microdata: 'микроразметка',
  blocked: 'сайт блокирует', no_price: 'цена не найдена', not_found: 'страница не найдена', timeout: 'нет ответа',
  network: 'нет связи', redirected: 'ссылка ведёт на другой сайт', currency: 'цена не в евро', unknown_store: '—', error: 'ошибка',
};

function parseLabel(code) {
  if (!code) return '';
  const [base, via] = String(code).split('@');
  const label = base.split('+').map((p) => (p === 'selectors' ? 'теги магазина' : PARSE_RESULTS[p] || p)).join(' + ');
  return via === 'browser' ? `${label}, через браузер` : label;
}

const DELIVERY_METHODS = {
  courier: 'Курьером до двери',
  pickup: 'В пункт выдачи',
};

module.exports = { rub, eur, dateTime, date, plural, ORDER_STATUSES, STATUS_FLOW, ITEM_STATUSES, CATEGORIES, BEAUTY_SUBCATS, GENDERS, DELIVERY_METHODS, PAYMENT_METHODS, PARSE_RESULTS, parseLabel };
