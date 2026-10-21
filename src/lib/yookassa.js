// Интеграция с ЮKassa (https://yookassa.ru/developers). Включается, если в .env заданы
// YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY. Покупатель платит картой или через СБП на странице ЮKassa.
const crypto = require('crypto');
const config = require('../config');

const API = 'https://api.yookassa.ru/v3';

function enabled() {
  return Boolean(config.yookassa.shopId && config.yookassa.secretKey);
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${config.yookassa.shopId}:${config.yookassa.secretKey}`).toString('base64');
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotence-Key': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.description || `ЮKassa: HTTP ${res.status}`);
  return data;
}

const money = (n) => ({ value: Number(n).toFixed(2), currency: 'RUB' });

async function createPayment(order, items, methodType) {
  const body = {
    amount: money(order.total_rub),
    capture: true,
    confirmation: { type: 'redirect', return_url: `${config.siteUrl}/account/orders/${order.id}?paid=1` },
    ...(methodType ? { payment_method_data: { type: methodType } } : {}),
    description: `Заказ ${order.number}`.slice(0, 128),
    metadata: { order_id: String(order.id), order_number: order.number },
  };
  if (config.yookassa.sendReceipt) {
    const lines = items
      .filter((it) => it.item_status !== 'unavailable')
      .map((it) => ({
        description: `${it.store_name ? it.store_name + ': ' : ''}${it.title || 'Товар'}`.slice(0, 128),
        quantity: '1.00',
        amount: money(it.line_total_rub),
        vat_code: config.yookassa.vatCode,
        payment_mode: 'full_prepayment',
        payment_subject: 'commodity',
      }));
    if (order.delivery_rub > 0) {
      lines.push({ description: 'Доставка', quantity: '1.00', amount: money(order.delivery_rub), vat_code: config.yookassa.vatCode, payment_mode: 'full_prepayment', payment_subject: 'service' });
    }
    body.receipt = { customer: { email: order.email }, items: lines };
  }
  return api('POST', '/payments', body);
}

async function getPayment(id) {
  return api('GET', `/payments/${encodeURIComponent(id)}`);
}

module.exports = { enabled, createPayment, getPayment };
