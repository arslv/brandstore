const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { mergeGuestCart } = require('../services/cart');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('error', { title: 'Слишком много попыток', message: 'Подождите 15 минут и попробуйте снова.' }) });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signIn(req, res, user) {
  const guestOwner = req.session.guestId ? `g:${req.session.guestId}` : null;
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: 'Ошибка', message: 'Не удалось войти. Попробуйте ещё раз.' });
    req.session.userId = user.id;
    mergeGuestCart(guestOwner, `u:${user.id}`);
    const dest = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : (user.role === 'admin' ? '/admin' : '/account');
    req.session.save(() => res.redirect(dest));
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('auth/login', { title: 'Вход', values: {}, error: null });
});

router.post('/login', limiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).render('auth/login', { title: 'Вход', values: { email }, error: 'Неверная почта или пароль.' });
  }
  signIn(req, res, user);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/account');
  res.render('auth/register', { title: 'Регистрация', values: {}, errors: {} });
});

router.post('/register', limiter, (req, res) => {
  const values = {
    name: String(req.body.name || '').trim().slice(0, 100),
    email: String(req.body.email || '').trim().toLowerCase().slice(0, 200),
    phone: String(req.body.phone || '').trim().slice(0, 40),
  };
  const password = String(req.body.password || '');
  const errors = {};
  if (!values.name) errors.name = 'Укажите имя.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Проверьте адрес почты.';
  if (password.length < 8) errors.password = 'Пароль — не короче 8 символов.';
  if (!req.body.agree) errors.agree = 'Нужно согласие на обработку персональных данных.';
  if (!errors.email && db.prepare('SELECT id FROM users WHERE email = ?').get(values.email)) {
    errors.email = 'Эта почта уже зарегистрирована. Войдите в аккаунт.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('auth/register', { title: 'Регистрация', values, errors });
  }
  const info = db.prepare('INSERT INTO users (email, password_hash, name, phone) VALUES (?, ?, ?, ?)')
    .run(values.email, bcrypt.hashSync(password, 10), values.name, values.phone);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  signIn(req, res, user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
