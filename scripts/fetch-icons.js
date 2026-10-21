// Скачивает иконки магазинов в public/icons/<slug>.png, чтобы сайт не зависел от внешних сервисов.
// Запуск на сервере с доступом в интернет: npm run icons
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });

const sources = (domain) => [
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
  `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
];

// Ширина PNG из заголовка (байты 16–19); для ICO — первый размер в каталоге
function imageWidth(buf) {
  if (buf.slice(1, 4).toString() === 'PNG') return buf.readUInt32BE(16);
  if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return buf[6] || 256;
  return 0;
}

async function fetchIcon(store) {
  for (const url of sources(store.icon_domain)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const w = imageWidth(buf);
      if (w >= 32) {
        const ext = buf.slice(1, 4).toString() === 'PNG' ? 'png' : 'ico';
        if (ext !== 'png') continue; // сайт показывает только PNG-иконки
        fs.writeFileSync(path.join(dir, `${store.slug}.png`), buf);
        return `ok ${w}px`;
      }
    } catch (e) { /* пробуем следующий источник */ }
  }
  return 'нет иконки нормального размера — будет буква';
}

(async () => {
  const force = process.argv.includes('--force');
  const stores = db.prepare("SELECT slug, name, icon_domain FROM stores WHERE icon_domain != '' AND logo_path = ''").all();
  for (const s of stores) {
    if (!force && fs.existsSync(path.join(dir, `${s.slug}.png`))) continue;
    const r = await fetchIcon(s);
    console.log(`${s.name.padEnd(28)} ${r}`);
  }
  console.log('Готово.');
})();
