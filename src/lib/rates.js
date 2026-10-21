// Курс евро ЦБ РФ. Обновляется при старте и затем каждые N часов.
const config = require('../config');
const settings = require('./settings');

async function refreshRate() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(config.rates.url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const eur = data && data.Valute && data.Valute.EUR && data.Valute.EUR.Value;
    if (!eur) throw new Error('EUR не найден в ответе');
    settings.set('rate_eur_auto', eur.toFixed(4));
    settings.set('rate_updated_at', new Date().toISOString());
    console.log(`[rates] Курс ЦБ: 1 € = ${eur.toFixed(2)} ₽`);
    return eur;
  } catch (e) {
    console.warn(`[rates] Не удалось получить курс ЦБ: ${e.message}. Используется последний сохранённый или ручной курс.`);
    return null;
  }
}

function startRateUpdates() {
  refreshRate();
  setInterval(refreshRate, config.rates.refreshHours * 3600 * 1000).unref();
}

module.exports = { refreshRate, startRateUpdates };
