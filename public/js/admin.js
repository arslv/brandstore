(function () {
  'use strict';
  // Клик по строке таблицы открывает запись
  document.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select, textarea, label')) return;
      window.location.href = tr.dataset.href;
    });
  });
  // Живой пересчёт цены позиции в админке
  document.querySelectorAll('[data-item-row]').forEach((row) => {
    const rate = parseFloat(row.dataset.rate), markup = parseFloat(row.dataset.markup);
    const price = row.querySelector('[data-item-price]'), qty = row.querySelector('[data-item-qty]'), out = row.querySelector('[data-item-rub]');
    const status = row.querySelector('[data-item-status]');
    const upd = () => {
      const eur = parseFloat(String(price.value).replace(',', '.')) || 0;
      const q = Math.max(1, parseInt(qty.value, 10) || 1);
      const unit = eur > 0 ? Math.ceil((eur * rate * (1 + markup / 100)) / 10) * 10 : 0;
      const total = status && status.value === 'unavailable' ? 0 : unit * q;
      out.textContent = Math.round(total).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
    };
    [price, qty, status].forEach((el) => el && el.addEventListener('input', upd));
    if (status) status.addEventListener('change', upd);
  });

  // Проверка ссылки в карточке магазина
  const box = document.querySelector('[data-parse-test]');
  if (box) {
    const input = box.querySelector('[data-parse-test-url]');
    const btn = box.querySelector('[data-parse-test-run]');
    const out = box.querySelector('[data-parse-test-out]');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const run = async () => {
      if (!input.value.trim()) { input.focus(); return; }
      btn.disabled = true;
      out.innerHTML = '<span class="muted">Открываем страницу… это может занять до 30 секунд.</span>';
      try {
        const r = await fetch('/admin/parse-test?url=' + encodeURIComponent(input.value.trim()), { headers: { Accept: 'application/json' } }).then((x) => x.json());
        const steps = (r.trace || []).map((t) => `<li>${t.ok ? '✓' : '✗'} ${esc(t.step)}${t.ms ? ` (${(t.ms / 1000).toFixed(1)} с)` : ''}${t.note ? ' — ' + esc(t.note) : ''}</li>`).join('');
        out.innerHTML = (r.ok
          ? `<p style="margin:0 0 6px"><b>Цена: ${esc(r.priceEur)} €</b>${r.oldPriceEur ? ` <s class="muted">${esc(r.oldPriceEur)} €</s>` : ''} · ${esc(r.method)}</p>
             <p style="margin:0 0 6px">${esc(r.title)}</p>
             ${r.sizes.length ? `<p style="margin:0 0 6px">Размеры: ${r.sizes.map((x) => esc(x.name) + (x.available === false ? ' (нет)' : '')).join(', ')}</p>` : ''}
             ${r.image ? `<p style="margin:0 0 6px;word-break:break-all">Фото: ${esc(r.image)}</p>` : ''}`
          : `<p style="margin:0 0 6px"><b>Цену взять не получилось:</b> ${esc(r.reason)}</p>`)
          + `<ul style="margin:6px 0 0;padding-left:18px">${steps}</ul>`
          + (r.browser && !r.browser.available ? `<p class="muted" style="margin:6px 0 0">Браузер: ${esc(r.browser.reason)}</p>` : '');
      } catch (e) {
        out.textContent = 'Не получилось проверить. Обновите страницу и попробуйте ещё раз.';
      }
      btn.disabled = false;
    };
    btn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  }
})();
