const fs = require('fs');
const path = require('path');
const config = require('../config');

// Иконка магазина: своя загруженная → скачанная скриптом fetch-icons → favicon-сервис.
function storeIcon(store) {
  if (!store) return '';
  if (store.logo_path) return store.logo_path;
  const local = path.join(config.root, 'public', 'icons', `${store.slug}.png`);
  if (fs.existsSync(local)) return `/icons/${store.slug}.png`;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(store.icon_domain)}&sz=128`;
}

function categoryList(store) {
  return (store.categories || '').split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { storeIcon, categoryList };
