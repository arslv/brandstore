// Оплата заказов. Режимы (Админка → Настройки):
//   demo     — тестовая оплата: покупатель выбирает способ, видит тестовую страницу банка, заказ становится «Оплачен»;
//   link     — менеджер вставляет в заказ платёжную ссылку любого провайдера;
//   yookassa — оплата через ЮKassa (нужны ключи в .env), статус меняется по уведомлению ЮKassa.
const crypto = require('crypto');
const db = require('../db');
const settings = require('../lib/settings');
const yookassa = require('../lib/yookassa');
const mailer = require('../lib/mailer');
const { PAYMENT_METHODS } = require('../lib/format');
const orders = require('./orders');

function mode() {
  const m = settings.get('payment_mode', 'demo');
  if (m === 'yookassa') return yookassa.enabled() ? 'yookassa' : 'demo';
  return m === 'link' ? 'link' : 'demo';
}

function payFlow() {
  return settings.get('pay_flow', 'after_check') === 'instant' ? 'instant' : 'after_check';
}

function enabledMethods() {
  const keys = settings.get('payment_methods', Object.keys(PAYMENT_METHODS).join(','))
    .split(',').map((s) => s.trim()).filter((k) => PAYMENT_METHODS[k]);
  return (keys.length ? keys : ['card']).map((k) => ({ key: k, ...PAYMENT_METHODS[k] }));
}

// Запуск оплаты. Возвращает { redirect } или { error }
async function start(order, methodKey) {
  const method = enabledMethods().find((m) => m.key === methodKey);
  if (!method) return { error: 'Выберите способ оплаты.' };
  if (order.status !== 'awaiting_payment') return { error: 'Этот заказ сейчас нельзя оплатить.' };

  const m = mode();
  if (m === 'demo') {
    const pid = `demo_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare("UPDATE orders SET payment_method = ?, payment_id = ?, updated_at = datetime('now') WHERE id = ?").run(method.key, pid, order.id);
    return { redirect: `/pay/${order.id}/demo` };
  }
  if (m === 'link') {
    if (!order.payment_url) return { error: 'Ссылку на оплату пришлёт менеджер на вашу почту.' };
    db.prepare("UPDATE orders SET payment_method = ?, updated_at = datetime('now') WHERE id = ?").run(method.key, order.id);
    return { redirect: order.payment_url };
  }
  try {
    const p = await yookassa.createPayment(order, order.items, method.yk);
    db.prepare("UPDATE orders SET payment_method = ?, payment_id = ?, updated_at = datetime('now') WHERE id = ?").run(method.key, p.id, order.id);
    return { redirect: p.confirmation.confirmation_url };
  } catch (e) {
    console.error('[yookassa]', e.message);
    return { error: 'Не получилось открыть оплату. Попробуйте другой способ или повторите через пару минут.' };
  }
}

// Отмечает заказ оплаченным: статус, письмо покупателю и магазину
function markPaid(orderId, note) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'awaiting_payment') return false;
  orders.setStatus(orderId, 'paid', { note, notify: true });
  const fresh = orders.getOrder(orderId);
  mailer.sendPaidToShop(fresh).catch((e) => console.error('[mail]', e));
  return true;
}

function methodLabel(key) {
  return (PAYMENT_METHODS[key] || {}).label || '';
}

module.exports = { mode, payFlow, enabledMethods, start, markPaid, methodLabel };
