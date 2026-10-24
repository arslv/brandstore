require('dotenv').config({ quiet: true });
const path = require('path');

const root = path.join(__dirname, '..');

module.exports = {
  root,
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  siteUrl: (process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  // Куки «только https» и переход на https — только когда сайт и правда на https (до покупки домена сервер открывают по IP)
  https: /^https:\/\//i.test(process.env.SITE_URL || ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'brandstore.db'),
  uploadsDir: path.join(root, 'public', 'uploads'),
  outboxDir: path.join(root, 'data', 'outbox'),

  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@brandstore.local',
    password: process.env.ADMIN_PASSWORD || 'admin12345',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Brand Store <no-reply@brandstore.local>',
    notifyTo: process.env.ORDER_NOTIFY_EMAIL || '',
  },

  yookassa: {
    shopId: process.env.YOOKASSA_SHOP_ID || '',
    secretKey: process.env.YOOKASSA_SECRET_KEY || '',
    sendReceipt: (process.env.YOOKASSA_SEND_RECEIPT || 'false') === 'true',
    vatCode: Number(process.env.YOOKASSA_VAT_CODE || 1),
  },

  rates: {
    // Официальный курс ЦБ РФ в формате JSON (зеркало cbr-xml-daily.ru)
    url: process.env.RATES_URL || 'https://www.cbr-xml-daily.ru/daily_json.js',
    refreshHours: Number(process.env.RATES_REFRESH_HOURS || 6),
  },
};
