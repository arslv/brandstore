// Смена почты и пароля администратора: npm run admin-password
// Спрашивает почту (Enter — оставить как есть) и новый пароль дважды; пароль на экране не виден.
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
const write = rl._writeToOutput.bind(rl);
// Пока вводится пароль, символы на экран не печатаем
rl._writeToOutput = (s) => { if (!muted) write(s); };

// Строки копим в очередь: при вводе из файла они приходят все сразу
const lines = [];
let waiter = null;
rl.on('line', (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } else lines.push(line); });
rl.on('close', () => { if (waiter) waiter(''); });

function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  return new Promise((resolve) => {
    const done = (line) => {
      if (muted) { muted = false; process.stdout.write('\n'); }
      resolve(String(line).trim());
    };
    if (lines.length) done(lines.shift()); else waiter = done;
  });
}

(async () => {
  const admin = db.prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) {
    console.log('Администратор не найден. Запустите сайт один раз (npm start) — он создастся сам.');
    process.exit(1);
  }
  console.log(`Сейчас вход в админку: ${admin.email}`);
  const email = (await ask('Новая почта (Enter — оставить): ')).toLowerCase() || admin.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log('Почта указана с ошибкой — ничего не изменено.');
    process.exit(1);
  }
  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, admin.id);
  if (taken) {
    console.log('Эта почта уже занята покупателем — укажите другую.');
    process.exit(1);
  }
  const password = await ask('Новый пароль (не короче 10 символов): ', { hidden: true });
  if (password.length < 10) {
    console.log('Пароль короче 10 символов — ничего не изменено.');
    process.exit(1);
  }
  const again = await ask('Повторите пароль: ', { hidden: true });
  if (again !== password) {
    console.log('Пароли не совпали — ничего не изменено.');
    process.exit(1);
  }
  db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(email, bcrypt.hashSync(password, 10), admin.id);
  // Входы администратора под старым паролем закрываем (покупателей не трогаем)
  for (const s of db.prepare('SELECT sid, sess FROM sessions').all()) {
    try { if (JSON.parse(s.sess).userId === admin.id) db.prepare('DELETE FROM sessions WHERE sid = ?').run(s.sid); } catch { /* битая сессия */ }
  }
  console.log(`Готово. Вход в админку: ${email} и новый пароль.`);
  process.exit(0);
})();
