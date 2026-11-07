// Баланс: пополнение, оплата заказа, возвраты, чеки зачёта аванса. Своя временная база.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlic-balance-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.PARSER_BROWSER = 'off';
require('../src/config').outboxDir = path.join(dir, 'outbox'); // письма — во временную папку, не в data/outbox
const origLog = console.log;
console.log = () => {}; // без сообщений базы и писем в выводе тестов
const db = require('../src/db');
const balance = require('../src/services/balance');
const orders = require('../src/services/orders');
const yookassa = require('../src/lib/yookassa');
console.log = origLog;

const store = db.prepare("SELECT id FROM stores WHERE slug = 'zara'").get();
function newUser() {
  const email = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.ru`;
  return db.prepare("INSERT INTO users (email, password_hash, name) VALUES (?, 'x', 'Тест')").run(email).lastInsertRowid;
}
function addToCart(userId, priceEur, title = 'Платье') {
  db.prepare("INSERT INTO cart_items (owner, type, store_id, url, title, size, color, qty, price_eur) VALUES (?, 'link', ?, 'https://www.zara.com/pt/pt/x-p1.html', ?, 'M', 'Preto', 1, ?)")
    .run(`u:${userId}`, store.id, title, priceEur);
}
const form = { name: 'Тест', phone: '+79000000000', email: 'buyer@test.ru', city: 'Москва', address: 'ул. 1', delivery: 'pickup', comment: '' };
const topup = (userId, amount, provider = 'demo', paymentId = '') => {
  const id = balance.createTopup({ userId, amount, method: 'card', provider });
  if (paymentId) balance.setPaymentId(id, paymentId);
  balance.confirmTopup(id);
  return id;
};
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test('пополнение зачисляется один раз; отменённое не считается', () => {
  const u = newUser();
  const id = balance.createTopup({ userId: u, amount: 1000, provider: 'demo' });
  assert.strictEqual(balance.get(u), 0, 'пока платёж не прошёл, баланс не меняется');
  assert.strictEqual(balance.confirmTopup(id), true);
  assert.strictEqual(balance.confirmTopup(id), false, 'повторное уведомление ничего не меняет');
  const bad = balance.createTopup({ userId: u, amount: 500, provider: 'demo' });
  balance.failTopup(bad);
  assert.strictEqual(balance.confirmTopup(bad), false, 'отменённый платёж не зачисляется');
  assert.strictEqual(balance.get(u), 1000);
});

test('заказ оплачивается с баланса; не хватает — заказ не создаётся, корзина остаётся', async () => {
  const u = newUser();
  addToCart(u, 50);
  assert.throws(() => orders.createFromCart({ owner: `u:${u}`, userId: u, form }), (e) => e.code === 'balance' && e.shortfall > 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(u).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE owner = ?').get(`u:${u}`).n, 1);
  let shortfall;
  try { orders.createFromCart({ owner: `u:${u}`, userId: u, form }); } catch (e) { shortfall = e.shortfall; }
  topup(u, shortfall + 300);
  const order = await quiet(() => orders.createFromCart({ owner: `u:${u}`, userId: u, form }));
  assert.strictEqual(order.status, 'paid');
  assert.ok(order.paid_at);
  assert.strictEqual(order.payment_method, 'balance');
  assert.strictEqual(balance.get(u), 300, 'остаток после оплаты');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE owner = ?').get(`u:${u}`).n, 0);
});

test('нет в наличии: стоимость позиции на баланс; последняя позиция — отмена и возврат доставки', async () => {
  const u = newUser();
  addToCart(u, 40, 'Юбка'); addToCart(u, 60, 'Пальто');
  topup(u, 100000);
  const order = await quiet(() => orders.createFromCart({ owner: `u:${u}`, userId: u, form }));
  const before = balance.get(u);
  const [a, b] = order.items;
  const r1 = await quiet(() => orders.refundItem(order.id, a.id, null));
  assert.strictEqual(r1.amount, a.line_total_rub);
  assert.strictEqual(balance.get(u), before + a.line_total_rub);
  assert.strictEqual(orders.refundItem(order.id, a.id, null), null, 'дважды за одну позицию не возвращаем');
  const r2 = await quiet(() => orders.refundItem(order.id, b.id, null));
  assert.ok(r2.cancelled);
  const fresh = orders.getOrder(order.id);
  assert.strictEqual(fresh.status, 'cancelled');
  assert.strictEqual(balance.get(u), before + order.total_rub, 'вернули всё, включая доставку');
  assert.strictEqual(fresh.refunded_rub, order.total_rub);
  assert.strictEqual(orders.cancel(order.id), null, 'отменённый заказ второй раз не отменяется');
  assert.strictEqual(balance.get(u), before + order.total_rub);
});

test('отмена оплаченного заказа возвращает всю сумму; корректировка не уводит баланс в минус', async () => {
  const u = newUser();
  addToCart(u, 30);
  topup(u, 50000);
  const order = await quiet(() => orders.createFromCart({ owner: `u:${u}`, userId: u, form }));
  const r = await quiet(() => orders.cancel(order.id, { notify: false }));
  assert.strictEqual(r.refunded, order.total_rub);
  assert.strictEqual(balance.get(u), 50000);
  assert.ok(balance.adjust(u, -60000, 'Возврат на карту', null).error);
  assert.strictEqual(balance.adjust(u, -50000, 'Возврат на карту', null).balance, 0);
});

test('чеки зачёта аванса: сумма заказа раскладывается по пополнениям ЮKassa по очереди', async () => {
  assert.deepStrictEqual(
    balance.allocate([{ amount_rub: 5000, settled_rub: 4000 }, { amount_rub: 3000, settled_rub: 0 }, { amount_rub: 9000, settled_rub: 0 }], 6000).map((p) => p.amount),
    [1000, 3000, 2000],
  );
  const parts = balance.splitLines([{ description: 'A', amount: 2500 }, { description: 'B', amount: 1500 }, { description: 'Доставка', amount: 2000 }], [1000, 3000, 2000]);
  assert.deepStrictEqual(parts.map((p) => p.map((l) => `${l.description}:${l.amount}`)), [['A:1000'], ['A:1500', 'B:1500'], ['Доставка:2000']]);

  const sent = [];
  const orig = { on: yookassa.receiptsOn, send: yookassa.createSettlementReceipt };
  yookassa.receiptsOn = () => true;
  yookassa.createSettlementReceipt = async (r) => { sent.push(r); return {}; };
  try {
    const u = newUser();
    addToCart(u, 50);
    topup(u, 1000, 'yookassa', 'pay-1');
    topup(u, 100000, 'yookassa', 'pay-2');
    const order = await quiet(() => orders.createFromCart({ owner: `u:${u}`, userId: u, form }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(sent.map((r) => r.paymentId), ['pay-1', 'pay-2']);
    assert.strictEqual(sent.reduce((s, r) => s + r.amount, 0), order.total_rub);
    for (const r of sent) assert.strictEqual(r.lines.reduce((s, l) => s + l.amount, 0), r.amount, 'позиции чека = сумма зачёта');
    const settled = db.prepare("SELECT SUM(settled_rub) AS s FROM balance_ops WHERE user_id = ? AND type = 'topup'").get(u).s;
    assert.strictEqual(settled, order.total_rub);
  } finally {
    yookassa.receiptsOn = orig.on;
    yookassa.createSettlementReceipt = orig.send;
  }
});

test.after(() => { try { db.close && db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
