const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./src/config');
require('./src/db');
const SqliteStore = require('./src/lib/session-store');
const { startRateUpdates } = require('./src/lib/rates');
const { loadUser, csrf, flash, locals, requireAdmin } = require('./src/middleware');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (config.isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'https:'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'"],
      'script-src': ["'self'"],
      'form-action': ["'self'", 'https://yoomoney.ru', 'https://*.yookassa.ru'],
      'upgrade-insecure-requests': config.isProd && config.https ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));

app.use(session({
  name: 'bs.sid',
  store: new SqliteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd && config.https, maxAge: 30 * 24 * 3600 * 1000 },
}));

app.use(loadUser);
app.use(flash);
app.use(locals);
// Уведомления платёжной системы приходят без CSRF-токена
app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : csrf(req, res, next)));

app.use('/', require('./src/routes/public'));
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/shop'));
app.use('/admin', requireAdmin, require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Страница не найдена', message: 'Возможно, ссылка устарела. Начните с главной или каталога магазинов.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой. Загрузите изображение до 6 МБ.' : 'Что-то пошло не так. Попробуйте ещё раз через минуту.';
  res.status(err.status || 500).render('error', { title: 'Ошибка', message });
});

app.listen(config.port, () => {
  console.log(`Brand Store запущен: ${config.siteUrl} (порт ${config.port})`);
  startRateUpdates();
});
