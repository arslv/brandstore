const db = require('../db');
const pricing = require('../lib/pricing');
const mailer = require('../lib/mailer');
const { getCart } = require('./cart');

function getOrder(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  order.items = db.prepare(`SELECT oi.*, s.slug AS store_slug, s.icon_domain, s.logo_path, s.region, s.url AS store_url
    FROM order_items oi LEFT JOIN stores s ON s.id = oi.store_id WHERE oi.order_id = ? ORDER BY oi.id`).all(id);
  order.events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(id);
  return order;
}

function createFromCart({ owner, userId, form, status = 'new' }) {
  const cart = getCart(owner);
  if (!cart.items.length) throw new Error('Корзина пуста');
  const q = cart.quote;

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO orders (number, user_id, status, customer_name, phone, email, city, address, delivery_method, comment,
        subtotal_rub, delivery_rub, total_rub, rate_eur, markup_pct)
      VALUES ('tmp', @userId, @status, @name, @phone, @email, @city, @address, @delivery, @comment, @subtotal, @deliveryRub, @total, @rate, @markup)`)
      .run({
        userId, status, ...form,
        subtotal: cart.subtotal, deliveryRub: cart.delivery, total: cart.total, rate: q.rate, markup: q.markup,
      });
    const orderId = info.lastInsertRowid;
    const number = `BS-${100000 + Number(orderId)}`;
    db.prepare('UPDATE orders SET number = ? WHERE id = ?').run(number, orderId);

    const insItem = db.prepare(`INSERT INTO order_items (order_id, type, product_id, store_id, store_name, url, title, image_url, size, color, qty, price_eur, unit_price_rub, line_total_rub, comment, region_ok, price_auto)
      VALUES (@orderId, @type, @product_id, @store_id, @store_name, @url, @title, @image, @size, @color, @qty, @price_eur, @unit_rub, @line_rub, @comment, @region_ok, @price_auto)`);
    for (const it of cart.items) {
      insItem.run({
        orderId, type: it.type, product_id: it.product_id, store_id: it.store_id, store_name: it.store_name || '',
        url: it.url || '', title: it.title || '', image: it.image || '', size: it.size, color: it.color, qty: it.qty,
        price_eur: it.price_eur, unit_rub: it.unit_rub, line_rub: it.line_rub, comment: it.comment || '', region_ok: it.region_ok,
        price_auto: it.type === 'product' ? 1 : (it.price_auto || 0),
      });
    }
    db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)').run(orderId, status, 'Заказ оформлен');
    db.prepare('DELETE FROM cart_items WHERE owner = ?').run(owner);
    return orderId;
  });

  const orderId = tx();
  const order = getOrder(orderId);
  // Письма отправляем асинхронно, чтобы не задерживать покупателя
  mailer.sendNewOrderToShop(order, order.items).catch((e) => console.error('[mail]', e));
  mailer.sendOrderConfirmation(order, order.items).catch((e) => console.error('[mail]', e));
  return order;
}

// Пересчёт заказа после правки цен менеджером (курс и наценка — зафиксированные в заказе)
function recalc(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  let subtotal = 0;
  const upd = db.prepare('UPDATE order_items SET unit_price_rub = ?, line_total_rub = ? WHERE id = ?');
  for (const it of items) {
    const unit = pricing.eurToRub(it.price_eur, order.rate_eur, order.markup_pct);
    const line = it.item_status === 'unavailable' ? 0 : unit * it.qty;
    upd.run(unit, line, it.id);
    subtotal += line;
  }
  db.prepare("UPDATE orders SET subtotal_rub = ?, total_rub = ? + delivery_rub, updated_at = datetime('now') WHERE id = ?")
    .run(subtotal, subtotal, orderId);
}

function setStatus(orderId, status, { note = '', notify = true } = {}) {
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
  if (status === 'paid') db.prepare("UPDATE orders SET paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?").run(orderId);
  db.prepare('INSERT INTO order_events (order_id, status, note) VALUES (?, ?, ?)').run(orderId, status, note);
  if (notify) {
    const order = getOrder(orderId);
    mailer.sendStatusUpdate(order, note).catch((e) => console.error('[mail]', e));
  }
}

module.exports = { getOrder, createFromCart, recalc, setStatus };
