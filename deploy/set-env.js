// Записать значение в .env на сервере: node deploy/set-env.js КЛЮЧ <значение в base64>
// (base64 — чтобы пароли в адресе прокси не ломали кавычки в командной строке)
const fs = require('fs');
const path = require('path');

const [key, b64 = ''] = process.argv.slice(2);
if (!/^[A-Z_][A-Z0-9_]*$/.test(key || '')) { console.log('Неверное имя настройки'); process.exit(1); }
const value = Buffer.from(b64, 'base64').toString('utf8').replace(/[\r\n]/g, '');
const file = path.join(__dirname, '..', '.env');
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
const i = lines.findIndex((l) => l.startsWith(`${key}=`));
if (i >= 0) lines[i] = `${key}=${value}`; else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
