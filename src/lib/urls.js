// Работа со ссылками магазинов: корневой домен, «португальский префикс», сверка ссылки на товар с магазином.

const TWO_LEVEL_TLDS = new Set(['com.pt', 'co.uk', 'com.br', 'com.au', 'co.jp', 'com.tr']);
// Сегменты пути, которые обозначают регион/язык сайта (pt, pt-pt, en-pt, pt_en, eu, eur, euro, int-en и т.п.)
const REGION_SEGMENT = /^(pt|eu|eur|euro|int|row|global|ww)$|^[a-z]{2}[-_](pt|eu|eur|int|en)$|^(pt|eu|eur|int)[-_][a-z]{2}$/i;

function safeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!u.hostname.includes('.')) return null;
    return u;
  } catch {
    return null;
  }
}

function bareHost(host) {
  return host.toLowerCase().replace(/^(www\d?)\./, '');
}

function rootDomain(host) {
  const parts = bareHost(host).split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

// Префикс португальской версии: хост + первый сегмент пути, если он региональный.
function regionPrefix(storeUrl) {
  const u = safeUrl(storeUrl);
  if (!u) return '';
  const host = bareHost(u.hostname);
  const seg = u.pathname.split('/').filter(Boolean)[0] || '';
  if (seg && REGION_SEGMENT.test(seg)) return `${host}/${seg.toLowerCase()}`;
  return host;
}

// Проверяет ссылку на товар относительно магазина.
// Возвращает { matches: bool, regionOk: bool }
function checkAgainstStore(link, store) {
  const u = safeUrl(link);
  const s = safeUrl(store.url);
  if (!u || !s) return { matches: false, regionOk: false };
  if (rootDomain(u.hostname) !== rootDomain(s.hostname)) return { matches: false, regionOk: false };
  const prefix = (store.link_prefix || regionPrefix(store.url)).toLowerCase();
  const [pHost, ...pPath] = prefix.split('/');
  const host = bareHost(u.hostname);
  if (host !== pHost) return { matches: true, regionOk: false };
  if (pPath.length) {
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (seg !== pPath[0]) return { matches: true, regionOk: false };
  }
  return { matches: true, regionOk: true };
}

function findStoreForLink(link, stores) {
  const u = safeUrl(link);
  if (!u) return null;
  const root = rootDomain(u.hostname);
  const candidates = stores.filter((s) => {
    const su = safeUrl(s.url);
    return su && rootDomain(su.hostname) === root;
  });
  if (!candidates.length) return null;
  // Если у одного домена несколько магазинов — берём тот, чей префикс совпал
  for (const s of candidates) {
    const r = checkAgainstStore(link, s);
    if (r.regionOk) return { store: s, regionOk: true };
  }
  return { store: candidates[0], regionOk: false };
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { safeUrl, bareHost, rootDomain, regionPrefix, checkAgainstStore, findStoreForLink, slugify };
