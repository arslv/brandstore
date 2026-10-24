// Почта: отправка через SMTP (настраивается в .env). Если SMTP не настроен —
// письма сохраняются в data/outbox, чтобы их можно было посмотреть при разработке.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');
const settings = require('./settings');
const { rub, eur, ORDER_STATUSES, DELIVERY_METHODS, PAYMENT_METHODS } = require('./format');

let transporter = null;
if (config.mail.host) {
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notifyAddress() {
  return settings.get('notify_email') || config.mail.notifyTo || settings.get('shop_email');
}

function mailStatus() {
  return {
    smtp: Boolean(transporter),
    notifyTo: notifyAddress(),
  };
}

async function sendMail({ to, subject, html, replyTo }) {
  if (!to) return { skipped: true };
  if (transporter) {
    try {
      await transporter.sendMail({ from: config.mail.from, to, subject, html, replyTo });
      return { sent: true };
    } catch (e) {
      console.error(`[mail] Ошибка отправки на ${to}: ${e.message}`);
      saveToOutbox(to, subject, html, e.message);
      return { sent: false, error: e.message };
    }
  }
  saveToOutbox(to, subject, html);
  return { sent: false, outbox: true };
}

function saveToOutbox(to, subject, html, error) {
  fs.mkdirSync(config.outboxDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.outboxDir, `${stamp}_${to.replace(/[^a-z0-9@.]/gi, '_')}.html`);
  const head = `<!-- To: ${esc(to)} | Subject: ${esc(subject)}${error ? ` | SMTP error: ${esc(error)}` : ''} -->\n`;
  fs.writeFileSync(file, head + html);
  console.log(`[mail] SMTP не настроен — письмо «${subject}» для ${to} сохранено в ${path.relative(config.root, file)}`);
}

// ---------- Шаблоны ----------
const C = { bg: '#F5F5F5', ink: '#000000', muted: '#6B6B6B', line: '#E5E5E5', accent: '#7D1D2D' };

function frame(title, body) {
  return `<!doctype html><html><body style="margin:0;background:${C.bg};font-family:Arial,Helvetica,sans-serif;color:${C.ink}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 0"><tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden">
    <tr><td style="background:#FFFFFF;padding:18px 28px;border-bottom:1px solid ${C.line};font-size:20px;font-weight:bold;letter-spacing:-0.3px"><span style="color:${C.ink}">brand</span> <span style="color:${C.accent}">store</span></td></tr>
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${esc(title)}</h1>
      ${body}
    </td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid ${C.line};color:${C.muted};font-size:12px">Brand Store — покупки в магазинах Португалии с доставкой в Россию</td></tr>
  </table></td></tr></table></body></html>`;
}

function itemsTable(items, { showLinks = true } = {}) {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid ${C.line};vertical-align:top">
        <div style="font-weight:bold">${esc(it.title || 'Товар по ссылке')}</div>
        <div style="color:${C.muted};font-size:13px;margin-top:2px">${esc(it.store_name || '')}</div>
        <div style="font-size:13px;margin-top:4px">Размер: <b>${esc(it.size || '—')}</b> · Цвет: <b>${esc(it.color || '—')}</b> · Кол-во: <b>${it.qty}</b></div>
        ${it.comment ? `<div style="font-size:13px;margin-top:4px;color:${C.muted}">Комментарий: ${esc(it.comment)}</div>` : ''}
        ${showLinks && it.url ? `<div style="font-size:13px;margin-top:4px"><a href="${esc(it.url)}" style="color:${C.ink}">Открыть товар в магазине</a>${it.region_ok ? '' : ' <span style="color:#B3261E">— ссылка не из португальской версии сайта</span>'}</div>` : ''}
        ${showLinks && it.image_url && it.type === 'link' ? `<div style="font-size:13px;margin-top:4px"><a href="${esc(it.image_url.startsWith('/') ? config.siteUrl + it.image_url : it.image_url)}" style="color:${C.ink}">Фото от покупателя</a></div>` : ''}
      </td>
      <td style="padding:10px 0 10px 16px;border-bottom:1px solid ${C.line};vertical-align:top;text-align:right;white-space:nowrap">
        <div>${eur(it.price_eur)} × ${it.qty}${showLinks && it.type === 'link' ? `<div style="font-size:11px;color:${C.muted}">${it.price_auto ? 'цена с сайта' : 'цена от покупателя'}</div>` : ''}</div>
        <div style="font-weight:bold">${rub(it.line_total_rub)}</div>
      </td>
    </tr>`).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>`;
}

function totals(order, { forShop = false } = {}) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:12px">
    <tr><td>Товары</td><td align="right">${rub(order.subtotal_rub)}</td></tr>
    <tr><td>Доставка</td><td align="right">${order.delivery_rub ? rub(order.delivery_rub) : 'рассчитает менеджер'}</td></tr>
    <tr><td style="font-size:16px;font-weight:bold;padding-top:6px">Итого</td><td align="right" style="font-size:16px;font-weight:bold;padding-top:6px">${rub(order.total_rub)}</td></tr>
  </table>
  ${forShop ? `<p style="color:${C.muted};font-size:12px;margin-top:8px">Курс в заказе: 1 € = ${Number(order.rate_eur).toFixed(2)} ₽, наценка ${order.markup_pct}%.</p>` : ''}`;
}

function button(href, text) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${C.ink};color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;margin-top:16px">${esc(text)}</a>`;
}

async function sendNewOrderToShop(order, items) {
  const html = frame(`Новый заказ ${order.number}`, `
    <p style="margin:0 0 12px">${esc(order.customer_name)} · <a href="tel:${esc(order.phone)}" style="color:${C.ink}">${esc(order.phone)}</a> · <a href="mailto:${esc(order.email)}" style="color:${C.ink}">${esc(order.email)}</a></p>
    <p style="margin:0 0 16px;color:${C.muted};font-size:14px">${esc(order.city)}, ${esc(order.address)} · ${esc(DELIVERY_METHODS[order.delivery_method] || order.delivery_method)}</p>
    ${order.comment ? `<p style="background:${C.bg};padding:10px 12px;border-radius:8px;font-size:14px">Комментарий: ${esc(order.comment)}</p>` : ''}
    ${itemsTable(items)}
    ${totals(order, { forShop: true })}
    ${button(`${config.siteUrl}/admin/orders/${order.id}`, 'Открыть заказ в админке')}
  `);
  return sendMail({ to: notifyAddress(), subject: `Новый заказ ${order.number} на ${rub(order.total_rub)}`, html, replyTo: order.email });
}

async function sendOrderConfirmation(order, items) {
  const intro = order.status === 'awaiting_payment'
    ? 'Спасибо! Если оплата не завершилась, оплатить заказ можно в личном кабинете. После оплаты выкупим товары в магазинах.'
    : 'Спасибо! Мы проверим наличие, размеры и цены в магазинах и пришлём письмо, когда заказ можно будет оплатить. Обычно это занимает до 24 часов.';
  const html = frame(`Заказ ${order.number} принят`, `
    <p style="margin:0 0 16px">${intro}</p>
    ${itemsTable(items, { showLinks: false })}
    ${totals(order)}
    ${button(`${config.siteUrl}/account/orders/${order.id}`, 'Посмотреть заказ')}
  `);
  return sendMail({ to: order.email, subject: `Заказ ${order.number} принят`, html });
}

async function sendStatusUpdate(order, note) {
  const st = ORDER_STATUSES[order.status] || { label: order.status };
  const payBlock = order.status === 'awaiting_payment'
    ? `<p style="margin:12px 0 0">Сумма к оплате: <b>${rub(order.total_rub)}</b></p>${button(`${config.siteUrl}/account/orders/${order.id}`, 'Перейти к оплате')}`
    : button(`${config.siteUrl}/account/orders/${order.id}`, 'Посмотреть заказ');
  const html = frame(`Заказ ${order.number}: ${st.label.toLowerCase()}`, `
    ${note ? `<p style="margin:0 0 12px">${esc(note)}</p>` : ''}
    ${order.tracking_number && order.status === 'shipped' ? `<p style="margin:0 0 12px">Трек-номер: <b>${esc(order.tracking_number)}</b></p>` : ''}
    ${payBlock}
  `);
  return sendMail({ to: order.email, subject: `Заказ ${order.number}: ${st.label.toLowerCase()}`, html });
}

async function sendPaidToShop(order) {
  const method = (PAYMENT_METHODS[order.payment_method] || {}).label || '—';
  const html = frame(`Заказ ${order.number} оплачен`, `
    <p style="margin:0 0 8px">Сумма: <b>${rub(order.total_rub)}</b></p>
    <p style="margin:0 0 8px">Способ оплаты: ${esc(method)}${order.payment_id && order.payment_id.startsWith('demo_') ? ' (тестовый режим)' : ''}</p>
    <p style="margin:0 0 16px">${esc(order.customer_name)} · ${esc(order.phone)}</p>
    ${itemsTable(order.items)}
    ${button(`${config.siteUrl}/admin/purchases`, 'Перейти к закупке')}
  `);
  return sendMail({ to: notifyAddress(), subject: `Оплачен заказ ${order.number} на ${rub(order.total_rub)}`, html });
}

async function sendTest(to) {
  return sendMail({ to, subject: 'Проверка почты Brand Store', html: frame('Почта настроена', '<p>Если вы читаете это письмо, уведомления о заказах будут приходить на этот адрес.</p>') });
}

module.exports = { sendMail, sendNewOrderToShop, sendOrderConfirmation, sendStatusUpdate, sendPaidToShop, sendTest, mailStatus, notifyAddress };
