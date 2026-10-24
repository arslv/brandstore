// Встроенный Chrome без окна (Playwright Chromium) — открывает страницу магазина как обычный посетитель.
// Нужен для сайтов, которые не отдают страницу простым запросом (Zara, Adidas и т. п.).
//
// Установка браузера (один раз, ~150 МБ): npm run browser
// Настройки (.env): PARSER_BROWSER=off — не использовать; PARSER_PROXY — тот же прокси, что и для обычных запросов;
//   PARSER_BROWSER_CHANNEL=msedge|chrome — открывать страницы в установленном на компьютере Edge или Google Chrome
//   вместо скачанного Chromium; тогда управление идёт через Patchright (Playwright, который не выдаёт автоматизацию);
//   PARSER_BROWSER_WINDOW=on — с окном, но за пределами экрана (так проходит защита Akamai у Adidas);
//   visible — окно видно. С окном нужен рабочий стол — на сервере без экрана не работает.
// С Patchright профиль постоянный (data/browser-profile): куки защиты (Akamai _abck и т. п.) сохраняются,
// и сайт видит «вернувшегося посетителя». Если товар ответил 403 — сначала заходим на главную, потом снова на товар.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rootDomain } = require('./urls');

const PROFILE_DIR = path.join(__dirname, '..', '..', 'data', 'browser-profile');

const MAX_PAGES = 2;
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const NAV_TIMEOUT = Number(process.env.PARSER_BROWSER_TIMEOUT_MS || 25000);
const CHANNELS = { chromium: 'chromium', chrome: 'chrome', msedge: 'msedge', edge: 'msedge' };
const CHANNEL = CHANNELS[(process.env.PARSER_BROWSER_CHANNEL || '').toLowerCase()] || 'chromium';
const WINDOW_MODE = (process.env.PARSER_BROWSER_WINDOW || '').toLowerCase();
const WINDOW = WINDOW_MODE === 'on' || WINDOW_MODE === 'visible';
const CHANNEL_NAMES = { chrome: 'Google Chrome', msedge: 'Microsoft Edge' };

let pw = null;
let stealth = false; // true — загружен Patchright
let browserPromise = null;
let idleTimer = null;
let active = 0;
const waiting = [];

function loadPlaywright() {
  if (pw) return pw;
  // С установленным Edge/Chrome — Patchright: защиты вроде Akamai не видят, что браузером управляет программа
  if (CHANNEL !== 'chromium') {
    try { pw = require('patchright'); stealth = true; return pw; } catch { /* нет пакета — обычный Playwright */ }
  }
  try { pw = require('playwright'); } catch { pw = null; }
  return pw;
}

function status() {
  if ((process.env.PARSER_BROWSER || '').toLowerCase() === 'off') return { available: false, reason: 'выключен в .env (PARSER_BROWSER=off)' };
  const p = loadPlaywright();
  if (!p) return { available: false, reason: 'не установлен пакет playwright — выполните npm install' };
  if (CHANNEL !== 'chromium') return { available: true }; // установленный браузер — проверится при запуске
  try {
    if (!fs.existsSync(p.chromium.executablePath())) return { available: false, reason: 'не скачан Chrome — выполните npm run browser' };
  } catch {
    return { available: false, reason: 'не скачан Chrome — выполните npm run browser' };
  }
  return { available: true };
}

function proxyOption() {
  if (!process.env.PARSER_PROXY) return undefined;
  try {
    const u = new URL(process.env.PARSER_PROXY);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return undefined;
  }
}

function getBrowser() {
  if (!browserPromise) {
    const p = loadPlaywright();
    // Patchright сам убирает признаки автоматизации — свои флаги ему только мешают
    const args = stealth ? [] : ['--disable-blink-features=AutomationControlled', '--no-default-browser-check', '--disable-dev-shm-usage'];
    if (WINDOW && WINDOW_MODE !== 'visible') args.push('--window-position=-32000,-32000');
    const options = {
      channel: CHANNEL, // по умолчанию полноценный Chromium в новом режиме без окна — его сложнее отличить от обычного
      headless: !WINDOW,
      proxy: proxyOption(),
      ...(stealth ? {} : { ignoreDefaultArgs: ['--enable-automation'] }),
      args,
    };
    // Patchright — постоянный профиль. Если он занят (например, сайт запущен и одновременно идёт npm run check) —
    // временный профиль на этот запуск.
    const launch = stealth
      ? p.chromium.launchPersistentContext(PROFILE_DIR, { ...options, viewport: null })
        .catch(() => p.chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'brandstore-browser-')), { ...options, viewport: null }))
      : p.chromium.launch(options);
    browserPromise = launch.then((b) => {
      b.on(stealth ? 'close' : 'disconnected', () => { browserPromise = null; });
      return b;
    }).catch((e) => {
      browserPromise = null;
      if (CHANNEL !== 'chromium' && /not found|executable doesn't exist|distribution/i.test(String(e.message))) {
        throw new Error(`не найден ${CHANNEL_NAMES[CHANNEL]} на компьютере — установите его или уберите PARSER_BROWSER_CHANNEL`);
      }
      throw e;
    });
  }
  return browserPromise;
}

function userAgent(version) {
  const major = String(version || '141').split('.')[0];
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function acquire() {
  if (active < MAX_PAGES) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve)).then(() => { active += 1; });
}

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (active === 0 && browserPromise) {
      const b = await browserPromise.catch(() => null);
      browserPromise = null;
      if (b) b.close().catch(() => {});
    }
  }, IDLE_CLOSE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// Адреса внутренней сети браузер не открывает (защита сервера)
function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

// Открывает страницу и вызывает fn(page, response). allowed — корневые домены магазинов.
async function withPage(url, allowed, fn, { devMode = false } = {}) {
  await acquire();
  let context; // свой контекст на страницу (обычный Playwright) — закрывается после
  let page;
  try {
    const browser = await getBrowser();
    if (stealth) {
      // Patchright: общий постоянный профиль, ничего не подменяем — любая подмена (язык, размер окна, заголовки)
      // расходится с остальными признаками браузера
      page = await browser.newPage();
    } else {
      context = await browser.newContext({
        // Без окна браузер называет себя HeadlessChrome — подменяем; с окном оставляем родной (он совпадает с остальными признаками)
        userAgent: WINDOW ? undefined : userAgent(browser.version()),
        locale: 'pt-PT',
        timezoneId: 'Europe/Lisbon',
        viewport: { width: 1366, height: 900 },
        extraHTTPHeaders: { 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8' },
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      page = await context.newPage();
    }
    page.setDefaultTimeout(NAV_TIMEOUT);
    await page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      let host = '';
      try { host = new URL(req.url()).hostname; } catch { return route.abort(); }
      if (!devMode && isPrivateHost(host)) return route.abort();
      // Главную страницу можно открывать только на сайтах магазинов из списка
      if (!devMode && req.isNavigationRequest() && req.frame() === page.mainFrame() && !allowed.has(rootDomain(host))) return route.abort();
      return route.continue();
    });
    let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (stealth && response && response.status() === 403) {
      // Защита не знает этого посетителя: главная выдаёт куки защиты, после неё товар обычно открывается
      await page.goto(new URL(url).origin + '/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
      await page.waitForTimeout(3000);
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }
    return await fn(page, response);
  } finally {
    if (context) await context.close().catch(() => {});
    else if (page) await page.close().catch(() => {});
    release();
  }
}

// Ждём, пока на странице появится цена: разметка товара, мета-теги или тег из настроек магазина
async function waitForPrice(page, priceSelector) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.waitForFunction((sel) => {
        if (sel) {
          for (const part of sel.split('||')) {
            const css = part.split('@')[0].trim();
            try {
              const el = css && document.querySelector(css);
              if (el && (el.textContent.trim() || el.getAttribute('content'))) return true;
            } catch { /* неверный селектор */ }
          }
        }
        const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].some((s) => /"price"/i.test(s.textContent));
        return ld || !!document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"],[itemprop="price"]');
      }, priceSelector || '', { timeout: 9000 });
      return true;
    } catch (e) {
      // Страница перезагрузилась (например, после проверки «не робот») — ждём ещё раз
      if (!/context was destroyed|navigation/i.test(String(e.message))) return false;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  return false;
}

// Значения по тегам из настроек магазина. Формат: CSS-селектор, «@атрибут» в конце — взять атрибут,
// несколько вариантов через «||».
async function readSelectors(page, sel) {
  return page.evaluate((s) => {
    const parts = (spec) => (spec || '').split('||').map((p) => p.trim()).filter(Boolean);
    const one = (spec) => {
      for (const part of parts(spec)) {
        const at = part.lastIndexOf('@');
        const css = at > 0 ? part.slice(0, at).trim() : part;
        const attr = at > 0 ? part.slice(at + 1).trim() : '';
        let el = null;
        try { el = document.querySelector(css); } catch { continue; }
        if (!el) continue;
        const v = attr ? el.getAttribute(attr) : (el.innerText || el.textContent);
        if (v && v.trim()) return v.trim();
      }
      return '';
    };
    const many = (spec) => {
      for (const part of parts(spec)) {
        let els = [];
        try { els = [...document.querySelectorAll(part)]; } catch { continue; }
        if (!els.length) continue;
        return els.map((el) => {
          const cls = `${el.className || ''} ${(el.parentElement && el.parentElement.className) || ''}`;
          return {
            // Первая строка: в кнопке размера бывают подписи вроде «Avisa-me» или «Últimas unidades»
            name: (el.innerText || el.textContent || '').trim().split('\n')[0].trim(),
            disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'
              || /disabled|unavailable|out-of-stock|outofstock|sold-out|soldout|esgotad|not-available|notavailable|nostock/i.test(String(cls)),
          };
        }).filter((x) => x.name && x.name.length < 40);
      }
      return [];
    };
    return { price: one(s.price), oldPrice: one(s.oldPrice), title: one(s.title), image: one(s.image), sizes: many(s.sizes) };
  }, sel);
}

// fetch изнутри страницы — с куками и «отпечатком» настоящего браузера (для JSON-адресов магазинов)
function pageGetter(page) {
  return async (url, accept) => {
    const u = new URL(url);
    return page.evaluate(async ({ path, acc }) => {
      try {
        const r = await fetch(path, { headers: { Accept: acc || '*/*' }, credentials: 'include' });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: '' };
      }
    }, { path: u.pathname + u.search, acc: accept });
  };
}

async function close() {
  clearTimeout(idleTimer);
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { status, withPage, waitForPrice, readSelectors, pageGetter, close };
