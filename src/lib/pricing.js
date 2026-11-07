// Ценообразование: цена в евро × курс × (1 + наценка), наценка 15% (настройка). Итог округляется вверх до 10 ₽.
const settings = require('./settings');

function currentRate() {
  const mode = settings.get('rate_mode', 'auto');
  const auto = parseFloat(settings.get('rate_eur_auto', ''));
  const manual = parseFloat(settings.get('rate_eur_manual', '100'));
  if (mode === 'auto' && Number.isFinite(auto) && auto > 0) return { rate: auto, source: 'cbr' };
  return { rate: manual, source: mode === 'auto' ? 'fallback' : 'manual' };
}

function markupPct() {
  const m = parseFloat(settings.get('markup_pct', '15'));
  return Number.isFinite(m) ? m : 15;
}

function roundUp10(n) {
  return Math.ceil(n / 10) * 10;
}

function eurToRub(eur, rate = currentRate().rate, markup = markupPct()) {
  const v = Number(eur);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return roundUp10(v * rate * (1 + markup / 100));
}

// Доставка в Россию — фиксированная сумма в евро за заказ (от количества товаров не зависит).
// В рубли — по текущему курсу, без наценки, с округлением вверх до 10 ₽.
function deliveryEur() {
  const d = parseFloat(settings.get('delivery_fee_eur', '50'));
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function deliveryFee(rate = currentRate().rate) {
  const eur = deliveryEur();
  return eur > 0 ? roundUp10(eur * rate) : 0;
}

function quote() {
  const { rate, source } = currentRate();
  return { rate, source, markup: markupPct(), delivery: deliveryFee(rate), deliveryEur: deliveryEur() };
}

module.exports = { currentRate, markupPct, eurToRub, deliveryEur, deliveryFee, quote, roundUp10 };
