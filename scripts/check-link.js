// Проверка автоматической цены по ссылке: npm run check -- "https://www.adidas.pt/.../JI2734.html"
const db = require('../src/db');
const { parseProduct } = require('../src/lib/parser');
const { PARSE_RESULTS, parseLabel } = require('../src/lib/format');

const url = process.argv[2];
if (!url) {
  console.log('Укажите ссылку: npm run check -- "https://www.adidas.pt/sapatilhas-samba-og/JI2734.html"');
  process.exit(1);
}

(async () => {
  const stores = db.prepare('SELECT url, link_prefix, sel_price, sel_old_price, sel_title, sel_image, sel_sizes FROM stores WHERE is_active = 1').all();
  const started = Date.now();
  const r = await parseProduct(url, stores, { noCache: true });
  const ms = Date.now() - started;
  console.log('\nШаги:');
  for (const t of r.trace || []) console.log(`  ${t.ok ? '✓' : '✗'} ${t.step}${t.ms ? ` (${(t.ms / 1000).toFixed(1)} с)` : ''}${t.note ? ' — ' + t.note : ''}`);
  if (r.ok && r.priceEur) {
    console.log(`\nГотово за ${(ms / 1000).toFixed(1)} с, способ: ${parseLabel(r.method + (r.via === 'browser' ? '@browser' : ''))}`);
    console.log(`Название: ${r.title}`);
    console.log(`Цена: ${r.priceEur} €${r.oldPriceEur ? ` (было ${r.oldPriceEur} €)` : ''}`);
    if (r.colors.length) console.log(`Цвета: ${r.colors.map((c) => c.name + (c.available === false ? ' (нет)' : '')).join(', ')}`);
    if (r.sizes.length) console.log(`Размеры: ${r.sizes.map((s) => s.name + (s.available === false ? ' (нет)' : '')).join(', ')}`);
    if (r.image) console.log(`Фото: ${r.image}`);
  } else {
    console.log(`\nЦену получить не удалось за ${(ms / 1000).toFixed(1)} с: ${PARSE_RESULTS[r.reason] || r.reason || (r.currency ? 'цена не в евро: ' + r.currency : 'неизвестно')}`);
    if (r.detail) console.log(`Подробности: ${r.detail}`);
  }
  console.log('');
  process.exit(0);
})();
