// Пополнение баланса. Заказы оплачиваются с баланса (src/services/balance.js), деньги приходят только пополнением.
// Режимы (Админка → Настройки → «Пополнение баланса»):
//   demo     — тестовая страница банка: деньги не списываются, баланс пополняется сразу;
//   manual   — перевод по реквизитам: покупатель создаёт заявку, менеджер зачисляет её в Админке → «Балансы»;
//   yookassa — ЮKassa (ключи в .env): баланс пополняется, когда ЮKassa подтвердит платёж.
const crypto = require('crypto');
const config = require('../config');
const settings = require('../lib/settings');
const yookassa = require('../lib/yookassa');
const balance = require('./balance');
const { PAYMENT_METHODS } = require('../lib/format');

function mode() {
  const m = settings.get('payment_mode', 'demo');
  if (m === 'yookassa') return yookassa.enabled() ? 'yookassa' : 'demo';
  return m === 'manual' || m === 'link' ? 'manual' : 'demo';
}

function enabledMethods() {
  const keys = settings.get('payment_methods', Object.keys(PAYMENT_METHODS).join(','))
    .split(',').map((s) => s.trim()).filter((k) => PAYMENT_METHODS[k]);
  return (keys.length ? keys : ['card']).map((k) => ({ key: k, ...PAYMENT_METHODS[k] }));
}

// Запуск пополнения. Возвращает { redirect, topupId } или { error }
async function startTopup(user, amount, methodKey) {
  if (!Number.isInteger(amount) || amount < balance.MIN_TOPUP) return { error: `Минимальная сумма — ${balance.MIN_TOPUP} ₽.` };
  if (amount > balance.MAX_TOPUP) return { error: `За один раз можно пополнить не больше чем на ${balance.MAX_TOPUP.toLocaleString('ru-RU')} ₽.` };
  const m = mode();
  if (m === 'manual') {
    const id = balance.createTopup({ userId: user.id, amount, provider: 'manual' });
    return { redirect: `/balance?request=${id}`, topupId: id };
  }
  const method = enabledMethods().find((x) => x.key === methodKey);
  if (!method) return { error: 'Выберите способ оплаты.' };
  const id = balance.createTopup({ userId: user.id, amount, method: method.key, provider: m });
  if (m === 'demo') {
    balance.setPaymentId(id, `demo_${crypto.randomBytes(8).toString('hex')}`);
    return { redirect: `/balance/topup/${id}/demo`, topupId: id };
  }
  try {
    const p = await yookassa.createTopupPayment({
      topupId: id, userId: user.id, amount, email: user.email, methodType: method.yk,
      returnUrl: `${config.siteUrl}/balance/topup/${id}/return`,
    });
    balance.setPaymentId(id, p.id);
    return { redirect: p.confirmation.confirmation_url, topupId: id };
  } catch (e) {
    console.error('[yookassa]', e.message);
    balance.failTopup(id, e.message.slice(0, 200));
    return { error: 'Не получилось открыть оплату. Попробуйте другой способ или повторите через пару минут.' };
  }
}

// Проверить пополнение через ЮKassa (возврат покупателя со страницы оплаты, уведомление). true — зачислено сейчас или раньше
async function syncYookassaTopup(op) {
  if (!op || op.provider !== 'yookassa' || !op.payment_id || !yookassa.enabled()) return op && op.status === 'done';
  if (op.status !== 'pending') return op.status === 'done';
  const p = await yookassa.getPayment(op.payment_id);
  if (p.status === 'succeeded') { balance.confirmTopup(op.id); return true; }
  if (p.status === 'canceled') balance.failTopup(op.id, (p.cancellation_details && p.cancellation_details.reason) || 'canceled');
  return false;
}

function methodLabel(key) {
  if (key === 'balance') return 'с баланса';
  return (PAYMENT_METHODS[key] || {}).label || '';
}

module.exports = { mode, enabledMethods, startTopup, syncYookassaTopup, methodLabel };
