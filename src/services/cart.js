const db = require('../db');
const pricing = require('../lib/pricing');

function getCart(owner) {
  const rows = db.prepare(`
    SELECT c.*, s.name AS store_name, s.slug AS store_slug, s.icon_domain, s.logo_path, s.region,
           p.title AS product_title, p.images AS product_images, p.is_active AS product_active
    FROM cart_items c
    LEFT JOIN stores s ON s.id = c.store_id
    LEFT JOIN products p ON p.id = c.product_id
    WHERE c.owner = ?
    ORDER BY c.id`).all(owner);
  const q = pricing.quote();
  const items = rows.map((r) => {
    const title = r.type === 'product' ? r.product_title : r.title;
    let image = r.image_url;
    if (r.type === 'product' && !image) {
      try { image = JSON.parse(r.product_images || '[]')[0] || ''; } catch { image = ''; }
    }
    const unitRub = pricing.eurToRub(r.price_eur, q.rate, q.markup);
    return { ...r, title, image, unit_rub: unitRub, line_rub: unitRub * r.qty };
  });
  const subtotal = items.reduce((s, it) => s + it.line_rub, 0);
  const count = items.reduce((s, it) => s + it.qty, 0);
  return { items, subtotal, delivery: q.delivery, total: subtotal + q.delivery, count, quote: q };
}

function mergeGuestCart(guestOwner, userOwner) {
  if (!guestOwner || guestOwner === userOwner) return;
  db.prepare('UPDATE cart_items SET owner = ? WHERE owner = ?').run(userOwner, guestOwner);
}

module.exports = { getCart, mergeGuestCart };
