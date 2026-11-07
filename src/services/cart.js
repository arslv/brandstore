const db = require('../db');
const pricing = require('../lib/pricing');

const SMALL_ORDER = 3; // меньше 3 товаров — предупреждение о сроке доставки

function getCart(owner) {
  const rows = db.prepare(`
    SELECT c.*, s.name AS store_name, s.slug AS store_slug, s.icon_domain, s.logo_path, s.region
    FROM cart_items c
    LEFT JOIN stores s ON s.id = c.store_id
    WHERE c.owner = ? AND c.type = 'link'
    ORDER BY c.id`).all(owner);
  const q = pricing.quote();
  const items = rows.map((r) => {
    const title = r.title;
    const image = r.image_url;
    const unitRub = pricing.eurToRub(r.price_eur, q.rate, q.markup);
    return { ...r, title, image, unit_rub: unitRub, line_rub: unitRub * r.qty };
  });
  const subtotal = items.reduce((s, it) => s + it.line_rub, 0);
  const count = items.reduce((s, it) => s + it.qty, 0);
  // Заказ из 1–2 товаров может ехать дольше: такие посылки собираются вместе с другими
  return { items, subtotal, delivery: q.delivery, total: subtotal + q.delivery, count, quote: q, smallOrder: count > 0 && count < SMALL_ORDER };
}

function mergeGuestCart(guestOwner, userOwner) {
  if (!guestOwner || guestOwner === userOwner) return;
  db.prepare('UPDATE cart_items SET owner = ? WHERE owner = ?').run(userOwner, guestOwner);
}

module.exports = { getCart, mergeGuestCart };
