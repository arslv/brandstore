// Выкладка сайта на сервер. Адрес сервера — DEPLOY_HOST в .env (например root@123.45.67.89),
// ключ — DEPLOY_KEY (по умолчанию ~/.ssh/brandstore_ed25519).
//
//   npm run deploy                        выложить текущую версию (последний коммит) и перезапустить сайт
//   npm run deploy -- --setup             первый раз: поставить на сервер всё нужное (Node, Chrome, nginx…)
//   npm run deploy -- --data              перенести базу и загруженные фото с этого компьютера
//                                         (только если на сервере базы ещё нет; --force — заменить)
//   npm run deploy -- --domain brandstore.ru --email you@mail.ru
//                                         подключить домен и бесплатный HTTPS (Let's Encrypt)
//   npm run deploy -- --proxy "http://логин:пароль@адрес:порт"
//                                         прокси в ЕС для цен по ссылке ("" — убрать)
//   npm run deploy -- --check "ссылка"    проверить цену по ссылке уже на сервере
//   npm run deploy -- --logs              последние строки журнала сайта
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ quiet: true });

const root = path.join(__dirname, '..');
const APP = '/opt/brandstore';
const host = process.env.DEPLOY_HOST;
const key = process.env.DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'brandstore_ed25519');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (!host) {
  console.log('Укажите сервер в .env: DEPLOY_HOST=root@адрес-сервера');
  process.exit(1);
}
const sshOpts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', ...(fs.existsSync(key) ? ['-i', key] : [])];

function run(cmd, cmdArgs, { quiet = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: quiet ? 'pipe' : 'inherit', cwd: root, encoding: 'utf8' });
  if (r.error) { console.log(`Не удалось запустить ${cmd}: ${r.error.message}`); process.exit(1); }
  return r;
}
function ssh(script, { allowFail = false, tty = false } = {}) {
  const r = run('ssh', [...sshOpts, ...(tty ? ['-t'] : []), host, script]);
  if (r.status !== 0 && !allowFail) { console.log(`\nНа сервере что-то пошло не так (код ${r.status}) — пришлите вывод выше.`); process.exit(1); }
  return r;
}
function upload(local, remote) {
  const r = run('scp', [...sshOpts, '-q', local, `${host}:${remote}`]);
  if (r.status !== 0) { console.log('Не удалось передать файл на сервер.'); process.exit(1); }
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // строка для bash на сервере
// Команда записи настройки в .env на сервере
const setEnv = (k, v) => `node ${APP}/deploy/set-env.js ${k} ${Buffer.from(String(v)).toString('base64')}`;

// ---------- Отдельные действия ----------
if (flag('--logs')) {
  ssh('journalctl -u brandstore -n 80 --no-pager');
  process.exit(0);
}

if (flag('--check')) {
  ssh(`cd ${APP} && sudo -u brandstore -H env DISPLAY=:99 node scripts/check-link.js ${q(value('--check') || '')}`);
  process.exit(0);
}

if (args.includes('--proxy')) {
  const proxy = value('--proxy') || '';
  if (proxy && !/^(https?|socks5?):\/\/[^\s]+$/i.test(proxy)) { console.log('Прокси пишется так: http://логин:пароль@адрес:порт'); process.exit(1); }
  ssh(`${setEnv('PARSER_PROXY', proxy)} && systemctl restart brandstore && echo 'Прокси ${proxy ? 'записан' : 'убран'}, сайт перезапущен.'`);
  process.exit(0);
}

if (flag('--domain')) {
  const domain = String(value('--domain') || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const email = value('--email');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || !email) { console.log('Пример: npm run deploy -- --domain brandstore.ru --email you@mail.ru'); process.exit(1); }
  ssh([
    'set -e',
    `sed -i "s|server_name .*;|server_name ${domain} www.${domain};|" /etc/nginx/sites-available/brandstore`,
    'nginx -t && systemctl reload nginx',
    `certbot --nginx -n --agree-tos -m ${q(email)} --redirect -d ${domain} -d www.${domain}`,
    setEnv('SITE_URL', `https://${domain}`),
    'systemctl restart brandstore',
    `echo "Готово: https://${domain}"`,
  ].join(' && '));
  process.exit(0);
}

// ---------- Выкладка кода ----------
const dirty = run('git', ['status', '--porcelain'], { quiet: true }).stdout.trim();
if (dirty) console.log('Внимание: есть изменения без коммита — на сервер уйдёт только последний коммит.\n');
const commit = run('git', ['log', '-1', '--format=%h %s'], { quiet: true }).stdout.trim();
console.log(`Выкладываю: ${commit}`);

const tmp = path.join(os.tmpdir(), `brandstore-${Date.now()}.tar.gz`);
if (run('git', ['archive', '--format=tar.gz', '-o', tmp, 'HEAD']).status !== 0) { console.log('Не удалось собрать архив (git archive).'); process.exit(1); }
upload(tmp, '/tmp/brandstore.tar.gz');
fs.unlinkSync(tmp);

if (flag('--setup')) {
  ssh(`mkdir -p ${APP} && tar -xzf /tmp/brandstore.tar.gz -C ${APP} && bash ${APP}/deploy/setup.sh`);
}

if (flag('--data')) {
  // Целостная копия базы (с данными из WAL) — VACUUM INTO
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = process.env.DB_FILE || path.join(root, 'data', 'brandstore.db');
  const copy = path.join(os.tmpdir(), `brandstore-db-${Date.now()}.db`);
  new DatabaseSync(dbFile).exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  upload(copy, '/tmp/brandstore-upload.db');
  fs.unlinkSync(copy);
  const uploads = path.join(root, 'public', 'uploads');
  const hasUploads = fs.existsSync(uploads) && fs.readdirSync(uploads).length > 0;
  if (hasUploads) {
    const tarFile = path.join(os.tmpdir(), `brandstore-uploads-${Date.now()}.tar.gz`);
    run('tar', ['-czf', tarFile, '-C', path.join(root, 'public'), 'uploads']);
    upload(tarFile, '/tmp/brandstore-uploads.tar.gz');
    fs.unlinkSync(tarFile);
  }
  const force = flag('--force');
  const r = ssh([
    'set -e',
    `if [ -f ${APP}/data/brandstore.db ] && [ "${force ? 1 : 0}" = 0 ]; then echo 'На сервере уже есть база — не трогаю. Заменить: --data --force'; exit 3; fi`,
    'systemctl stop brandstore || true',
    `if [ -f ${APP}/data/brandstore.db ]; then cp ${APP}/data/brandstore.db ${APP}/data/brandstore.db.before-upload-$(date +%F-%H%M); fi`,
    `rm -f ${APP}/data/brandstore.db-wal ${APP}/data/brandstore.db-shm`,
    `mv /tmp/brandstore-upload.db ${APP}/data/brandstore.db`,
    hasUploads ? `tar -xzf /tmp/brandstore-uploads.tar.gz -C ${APP}/public && rm -f /tmp/brandstore-uploads.tar.gz` : 'true',
    `chown -R brandstore:brandstore ${APP}/data ${APP}/public/uploads`,
    'echo "База перенесена."',
  ].join('\n'), { allowFail: true });
  if (r.status === 3) process.exit(1);
  if (r.status !== 0) { console.log('\nНе удалось перенести базу — пришлите вывод выше.'); process.exit(1); }
}

ssh([
  'set -e',
  `cd ${APP}`,
  'tar -xzf /tmp/brandstore.tar.gz -C . && rm -f /tmp/brandstore.tar.gz',
  `chown -R brandstore:brandstore ${APP}`,
  'sudo -u brandstore -H npm ci --omit=dev --no-audit --no-fund --loglevel=error',
  'cp deploy/brandstore.service deploy/brandstore-xvfb.service /etc/systemd/system/ && systemctl daemon-reload',
  'systemctl restart brandstore-xvfb brandstore',
  'sleep 3',
  'if curl -fsS -o /dev/null http://127.0.0.1:3000/; then echo "Сайт работает."; else echo "Сайт не ответил — последние строки журнала:"; journalctl -u brandstore -n 30 --no-pager; exit 1; fi',
].join('\n'));
