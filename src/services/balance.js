// Баланс покупателя. Покупатель пополняет баланс на любую сумму (аванс), заказы оплачиваются с баланса.
// Все суммы — целые рубли. Баланс = сумма операций со status = 'done' (таблица balance_ops, см. src/db.js).
// node:sqlite синхронный, поэтому проверка остатка и списание внутри db.transaction не пересекаются с другими запросами.
const db = require('../db');

const MIN_TOPUP = 100;
const MAX_TOPUP = 500000;

function get(userId) {
  if (!userId) return 0;
  return db.prepare("SELECT COALESCE(SUM(amount_rub), 0) AS b FROM balance_ops WHERE user_id = ? AND status = 'done'").get(userId).b;
}

// История для покупателя: проведённые операции и заявки на перевод, которые ждут зачисления.
// Брошенные и отменённые оплаты картой не показываем — они ничего не меняют.
function history(userId, limit = 100) {
  return db.prepare(`SELECT b.*, o.number AS order_number FROM balance_ops b LEFT JOIN orders o ON o.id = b.order_id
    WHERE b.user_id = ? AND (b.status = 'done' OR (b.status = 'pending' AND b.provider = 'manual'))
    ORDER BY b.id DESC LIMIT ?`).all(userId, limit);
}

function getOp(id) {
  return db.prepare('SELECT * FROM balance_ops WHERE id = ?').get(id) || null;
}

function parseAmount(v) {
  const n = Math.round(parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')));
  return Number.isFinite(n) ? n : 0;
}

// Заявка на пополнение: зачисляется, когда платёж прошёл (confirmTopup)
function createTopup({ userId, amount, method = '', provider = '' }) {
  return db.prepare("INSERT INTO balance_ops (user_id, type, amount_rub, status, method, provider) VALUES (?, 'topup', ?, 'pending', ?, ?)")
    .run(userId, amount, method, provider).lastInsertRowid;
}

function setPaymentId(id, paymentId) {
  db.prepare('UPDATE balance_ops SET payment_id = ? WHERE id = ?').run(paymentId, id);
}

// Зачислить пополнение. Повторный вызов (уведомление ЮKassa + возврат покупателя) ничего не меняет.
function confirmTopup(id, note = '') {
  const r = db.prepare("UPDATE balance_ops SET status = 'done', done_at = datetime('now'), note = CASE WHEN ? != '' THEN ? ELSE note END WHERE id = ? AND type = 'topup' AND status = 'pending'")
    .run(note, note, id);
  return r.changes > 0;
}

function failTopup(id, note = '') {
  const r = db.prepare("UPDATE balance_ops SET status = 'failed', done_at = datetime('now'), note = CASE WHEN ? != '' THEN ? ELSE note END WHERE id = ? AND type = 'topup' AND status = 'pending'")
    .run(note, note, id);
  return r.changes > 0;
}

class InsufficientBalance extends Error {
  constructor(balance, amount) {
    super('Недостаточно денег на балансе');
    this.code = 'balance';
    this.balance = balance;
    this.shortfall = amount - balance;
  }
}

// Списание за заказ. Вызывать внутри транзакции оформления: если денег не хватает — исключение, заказ не создаётся.
function charge(userId, orderId, amount) {
  const bal = get(userId);
  if (bal < amount) throw new InsufficientBalance(bal, amount);
  db.prepare("INSERT INTO balance_ops (user_id, type, amount_rub, order_id) VALUES (?, 'order', ?, ?)").run(userId, -amount, orderId);
}

// Возврат по заказу на баланс (товар закончился, отмена)
function refund(userId, orderId, amount, note = '', adminId = null) {
  if (!userId || !(amount > 0)) return false;
  db.prepare("INSERT INTO balance_ops (user_id, type, amount_rub, order_id, note, created_by) VALUES (?, 'refund', ?, ?, ?, ?)")
    .run(userId, amount, orderId, note, adminId);
  db.prepare('UPDATE orders SET refunded_rub = refunded_rub + ? WHERE id = ?').run(amount, orderId);
  return true;
}

// Корректировка менеджером: + зачислить (например, перевод по реквизитам), − списать (вернули деньги на карту).
// В минус баланс не уходит.
function adjust(userId, amount, note, adminId) {
  const bal = get(userId);
  if (!amount) return { error: 'Укажите сумму.' };
  if (bal + amount < 0) return { error: `На балансе ${bal.toLocaleString('ru-RU')} ₽ — списать больше нельзя.` };
  db.prepare("INSERT INTO balance_ops (user_id, type, amount_rub, note, created_by) VALUES (?, 'adjust', ?, ?, ?)").run(userId, amount, note, adminId);
  return { ok: true, balance: bal + amount };
}

// ---------- Чеки зачёта аванса (54-ФЗ) ----------
// Пополнение — аванс: при оплате ЮKassa выдаёт чек «аванс». Когда заказ оплачивается с баланса, нужен второй чек —
// «полный расчёт» с зачётом аванса. Чек в ЮKassa привязан к одному платежу, поэтому сумму заказа раскладываем по
// пополнениям по очереди (сначала старые), а позиции заказа — по этим частям.

// Какие пополнения покрывают сумму: [{ op, amount }]. Учитывает и не-ЮKassa пополнения, чтобы очередь совпадала с деньгами.
function allocate(topups, total) {
  const out = [];
  let left = total;
  for (const op of topups) {
    if (left <= 0) break;
    const free = op.amount_rub - op.settled_rub;
    if (free <= 0) continue;
    const take = Math.min(free, left);
    out.push({ op, amount: take });
    left -= take;
  }
  return out;
}

// Позиции чека на сумму part: берём позиции заказа по очереди, последнюю при необходимости делим по сумме
function splitLines(lines, parts) {
  const queue = lines.map((l) => ({ ...l }));
  return parts.map((part) => {
    const res = [];
    let left = part;
    while (left > 0 && queue.length) {
      const l = queue[0];
      const take = Math.min(l.amount, left);
      res.push({ ...l, amount: take });
      l.amount -= take;
      left -= take;
      if (l.amount <= 0) queue.shift();
    }
    return res;
  });
}

// Отправить чеки зачёта аванса по оплаченному заказу (асинхронно, ошибки — в историю заказа для менеджера)
async function settleReceipts(order) {
  const yookassa = require('../lib/yookassa');
  if (!yookassa.receiptsOn() || !order.user_id) return;
  const lines = order.items.filter((it) => it.item_status !== 'unavailable').map((it) => ({
    description: `${it.store_name ? it.store_name + ': ' : ''}${it.title || 'Товар'}`.slice(0, 128), amount: it.line_total_rub, subject: 'commodity',
  }));
  if (order.delivery_rub > 0) lines.push({ description: 'Доставка', amount: order.delivery_rub, subject: 'service' });
  const total = lines.reduce((s, l) => s + l.amount, 0);

  const plan = db.transaction(() => {
    const topups = db.prepare("SELECT * FROM balance_ops WHERE user_id = ? AND type = 'topup' AND status = 'done' AND settled_rub < amount_rub ORDER BY id").all(order.user_id);
    const parts = allocate(topups, total);
    const upd = db.prepare('UPDATE balance_ops SET settled_rub = settled_rub + ? WHERE id = ?');
    for (const p of parts) upd.run(p.amount, p.op.id);
    return parts;
  })();
  const chunks = splitLines(lines, plan.map((p) => p.amount));
  for (let i = 0; i < plan.length; i++) {
    const { op, amount } = plan[i];
    if (op.provider !== 'yookassa' || !op.payment_id) continue; // тестовые и ручные пополнения — без чеков ЮKassa
    try {
      await yookassa.createSettlementReceipt({ paymentId: op.payment_id, email: order.email, lines: chunks[i], amount });
    } catch (e) {
      console.error('[yookassa receipt]', e.message);
      db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)')
        .run(order.id, order.status, `Чек зачёта аванса на ${amount} ₽ (платёж ${op.payment_id}) не отправлен: ${e.message}. Сформируйте его в кабинете ЮKassa.`);
    }
  }
}

module.exports = {
  MIN_TOPUP, MAX_TOPUP, get, history, getOp, parseAmount, createTopup, setPaymentId, confirmTopup, failTopup,
  charge, refund, adjust, InsufficientBalance, allocate, splitLines, settleReceipts,
};
