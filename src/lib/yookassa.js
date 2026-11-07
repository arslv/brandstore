// Интеграция с ЮKassa (https://yookassa.ru/developers). Включается, если в .env заданы
// YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY. Через ЮKassa покупатель пополняет баланс (картой, СБП, SberPay, T-Pay, ЮMoney).
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

// Чеки 54-ФЗ (YOOKASSA_SEND_RECEIPT=true). Пополнение баланса — аванс: товары ещё не известны, поэтому признак
// способа расчёта «аванс» и предмет расчёта «платёж». При оплате заказа с баланса — второй чек «полный расчёт»
// с зачётом аванса (createSettlementReceipt). Какие признаки нужны именно вам (в т. ч. агентские), уточните у бухгалтера.
const TOPUP_RECEIPT = { description: 'Пополнение баланса (аванс)', payment_mode: 'advance', payment_subject: 'payment' };

function receiptsOn() {
  return enabled() && config.yookassa.sendReceipt;
}

// Платёж на пополнение баланса. После оплаты ЮKassa возвращает покупателя на returnUrl и присылает уведомление.
async function createTopupPayment({ topupId, userId, amount, email, methodType, returnUrl }) {
  const body = {
    amount: money(amount),
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    ...(methodType ? { payment_method_data: { type: methodType } } : {}),
    description: `Пополнение баланса QLIC, ${email}`.slice(0, 128),
    metadata: { topup_id: String(topupId), user_id: String(userId) },
  };
  if (config.yookassa.sendReceipt) {
    body.receipt = {
      customer: { email },
      items: [{ description: TOPUP_RECEIPT.description, quantity: '1.00', amount: money(amount), vat_code: config.yookassa.vatCode,
        payment_mode: TOPUP_RECEIPT.payment_mode, payment_subject: TOPUP_RECEIPT.payment_subject }],
    };
  }
  return api('POST', '/payments', body);
}

// Чек зачёта аванса: позиции заказа с признаком «полный расчёт», оплата — ранее внесённым авансом (settlements: prepayment).
// lines: [{ description, amount (₽ за позицию), subject: commodity|service }], сумма lines = amount.
async function createSettlementReceipt({ paymentId, email, lines, amount }) {
  return api('POST', '/receipts', {
    type: 'payment',
    payment_id: paymentId,
    send: true,
    customer: { email },
    items: lines.map((l) => ({
      description: l.description, quantity: '1.00', amount: money(l.amount), vat_code: config.yookassa.vatCode,
      payment_mode: 'full_payment', payment_subject: l.subject || 'commodity',
    })),
    settlements: [{ type: 'prepayment', amount: money(amount) }],
  });
}

async function getPayment(id) {
  return api('GET', `/payments/${encodeURIComponent(id)}`);
}

module.exports = { enabled, receiptsOn, createTopupPayment, createSettlementReceipt, getPayment };
