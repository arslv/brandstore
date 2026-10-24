(function () {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const csrf = () => (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  const fmtRub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
  const toRub = (eur, rate, markup) => (eur > 0 ? Math.ceil((eur * rate * (1 + markup / 100)) / 10) * 10 : 0);

  // ---------- Уведомление ----------
  let toastTimer;
  function toast(html) {
    const t = $('#toast');
    if (!t) return;
    t.innerHTML = html;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 4000);
  }
  function setCartCount(n) {
    $$('[data-cart-count]').forEach((el) => { el.textContent = n || ''; el.dataset.count = n; });
  }
  async function post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data || {}),
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  }

  // ---------- Иконки магазинов: favicon → запасной сервис → монограмма ----------
  function setupIcon(img) {
    const box = img.closest('[data-store-icon]');
    if (!box) return;
    const domain = box.dataset.domain;
    const isService = /google\.com\/s2\/favicons|icons\.duckduckgo\.com/.test(img.src);
    const check = () => {
      const w = img.naturalWidth;
      const minW = img.src.includes('duckduckgo') ? 24 : 32;
      if (!isService || w >= minW) { box.classList.add('has-img'); return; }
      fallback();
    };
    const fallback = () => {
      if (domain && !img.dataset.tried) {
        img.dataset.tried = '1';
        img.src = 'https://icons.duckduckgo.com/ip3/' + domain + '.ico';
      } else {
        img.remove();
        box.classList.remove('has-img');
      }
    };
    img.addEventListener('load', check);
    img.addEventListener('error', fallback);
    if (img.complete) { img.naturalWidth ? check() : fallback(); }
  }
  $$('[data-store-icon] img').forEach(setupIcon);

  // ---------- Меню на телефоне ----------
  const burger = $('[data-burger]');
  if (burger) burger.addEventListener('click', () => {
    const h = $('#header');
    const open = h.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ---------- Автоотправка сортировки ----------
  $$('form[data-autosubmit] select').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // ---------- Калькулятор ----------
  $$('[data-calc]').forEach((box) => {
    const rate = parseFloat(box.dataset.rate), markup = parseFloat(box.dataset.markup);
    const input = $('[data-calc-eur]', box), out = $('[data-calc-rub]', box);
    const upd = () => { out.textContent = fmtRub(toRub(parseFloat(input.value) || 0, rate, markup)); };
    input.addEventListener('input', upd);
  });

  // ---------- Избранное ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-fav]');
    if (!btn) return;
    e.preventDefault();
    const r = await post('/favorites/' + btn.dataset.fav + '/toggle');
    if (r.status === 401) { window.location.href = '/login'; return; }
    if (r.ok) {
      $$('[data-fav="' + btn.dataset.fav + '"]').forEach((b) => b.setAttribute('aria-pressed', r.json.active ? 'true' : 'false'));
      toast(r.json.active ? 'Добавлено в избранное. <a href="/favorites">Открыть</a>' : 'Убрано из избранного');
    }
  });

  // ---------- Карточка товара: выбор размера и цвета ----------
  const addForm = $('form[data-add-product]');
  if (addForm) {
    $$('[data-choice]', addForm).forEach((group) => {
      const name = group.dataset.choice;
      const hidden = $('input[name="' + name + '"]', addForm);
      group.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        $$('.chip', group).forEach((c) => c.setAttribute('aria-pressed', 'false'));
        chip.setAttribute('aria-pressed', 'true');
        hidden.value = chip.dataset.value;
        $('[data-error]', addForm).textContent = '';
      });
    });
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('[data-error]', addForm);
      const color = $('input[name="color"]', addForm), size = $('input[name="size"]', addForm);
      if (color && !color.value) { err.textContent = 'Выберите цвет'; return; }
      if (size && !size.value) { err.textContent = 'Выберите размер'; return; }
      const r = await post('/cart/add-product', Object.fromEntries(new FormData(addForm)));
      if (r.ok) {
        setCartCount(r.json.count);
        toast('Товар в корзине. <a href="/cart">Перейти в корзину</a>');
      } else {
        err.textContent = r.json.error || 'Не получилось добавить товар. Обновите страницу.';
      }
    });
  }

  // ---------- Заказ по ссылке: страница «Заказ по ссылке» и блок «Вставьте ссылку» на главной ----------
  const ICON_OK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4 10-10"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4M12 17v.5"/></svg>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FAIL_TEXT = {
    blocked: 'Сайт магазина не отдаёт данные автоматически. Введите цену вручную — как на странице товара.',
    no_price: 'Не нашли цену на этой странице. Проверьте, что это страница товара, и введите цену вручную.',
    not_found: 'Страница не открывается: возможно, товар сняли с продажи. Проверьте ссылку.',
    timeout: 'Сайт магазина долго не отвечает. Введите цену вручную.',
    network: 'Не получилось открыть сайт магазина. Введите цену вручную.',
    redirected: 'Ссылка ведёт на другой сайт. Скопируйте ссылку прямо со страницы товара.',
    rate_limit: 'Слишком много проверок подряд. Подождите минуту или введите цену вручную.',
  };
  const UNKNOWN_STORE = 'Этого магазина нет в нашем списке — заказать из него не получится. Выберите магазин на странице <a class="link" href="/stores">«Бренды»</a>.';

  $$('form[data-link-form]').forEach((linkForm) => {
    // На главной (data-paste) форма отправляется без перезагрузки, поля размера и цены появляются после вставки ссылки
    const paste = linkForm.hasAttribute('data-paste');
    const rate = parseFloat(linkForm.dataset.rate), markup = parseFloat(linkForm.dataset.markup);
    const urlInput = $('[data-url]', linkForm);
    const detect = $('[data-detect]', linkForm);
    const detectText = $('[data-detect-text]', linkForm);
    const detectIcon = $('[data-detect-icon]', linkForm);
    const select = $('[data-store-select]', linkForm);
    const price = $('[data-price]', linkForm), qty = $('[data-qty]', linkForm);
    const sum = $('[data-sum]', linkForm), sumNote = $('[data-sum-note]', linkForm);
    const details = $('[data-details]', linkForm);
    const formError = $('[data-form-error]', linkForm);
    const fullForm = $('[data-full-form]', linkForm);
    const submits = $$('button[type="submit"]', linkForm);
    // '' — ссылку ещё не проверяли, ok — магазин из списка, other — не та версия сайта, unknown — магазина нет в списке, bad — не ссылка
    let storeState = '';
    let parsing = false;

    const setBlocked = (on) => submits.forEach((b) => { b.disabled = on; });
    const clearErrors = () => {
      if (formError) formError.textContent = '';
      $$('.is-invalid', linkForm).forEach((el) => el.classList.remove('is-invalid'));
    };
    const showError = (msg, field) => {
      if (formError) formError.textContent = msg;
      if (field) { field.classList.add('is-invalid'); field.focus(); }
    };

    const updSum = () => {
      const eur = parseFloat(String(price.value).replace(',', '.')) || 0;
      const q = Math.max(1, parseInt(qty.value, 10) || 1);
      const rub = toRub(eur, rate, markup) * q;
      if (sum) sum.textContent = rub ? fmtRub(rub) : '—';
      if (sumNote) sumNote.textContent = rub ? (q > 1 ? q + ' шт. · ' : '') + 'без учёта доставки в Россию' : 'Введите цену в евро';
    };
    price.addEventListener('input', updSum);
    qty.addEventListener('input', updSum);

    // --- Автоматическая цена по ссылке ---
    const parseBox = $('[data-parse]', linkForm);
    const parseLoading = $('[data-parse-loading]', linkForm);
    const parseCard = $('[data-parse-card]', linkForm);
    const parseFail = $('[data-parse-fail]', linkForm);
    const titleInput = $('[data-title]', linkForm);
    const sizeInput = $('[data-size]', linkForm), colorInput = $('[data-color]', linkForm);
    const sizeChips = $('[data-size-chips]', linkForm), colorChips = $('[data-color-chips]', linkForm);
    const sizeDefault = $('[data-size-default]', linkForm);
    const imageUrl = $('[data-image-url]', linkForm), parsedPrice = $('[data-parsed-price]', linkForm);
    const photoInput = $('#photo', linkForm);
    const auto = { price: '', title: '', color: '' };
    let parseSeq = 0;

    const setIfAuto = (input, key, value) => {
      if (!value) return;
      if (!input.value || input.value === auto[key]) {
        input.value = value;
        auto[key] = value;
      }
    };

    const renderChips = (box, items, input) => {
      box.innerHTML = '';
      items.forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = it.name;
        if (it.available === false) { b.disabled = true; b.title = 'Нет в наличии'; }
        b.setAttribute('aria-pressed', input.value === it.name ? 'true' : 'false');
        b.addEventListener('click', () => {
          input.value = it.name;
          input.classList.remove('is-invalid');
          $$('.chip', box).forEach((c) => c.setAttribute('aria-pressed', c === b ? 'true' : 'false'));
        });
        box.appendChild(b);
      });
    };

    const resetParse = () => {
      parseSeq += 1;
      parsing = false;
      parseBox.hidden = true;
      sizeChips.innerHTML = '';
      colorChips.innerHTML = '';
      sizeDefault.hidden = false;
      imageUrl.value = '';
      parsedPrice.value = '';
    };

    const runParse = async (url) => {
      const seq = ++parseSeq;
      parsing = true;
      parseBox.hidden = false;
      parseLoading.hidden = false;
      parseCard.hidden = true;
      parseFail.hidden = true;
      const loadingText = parseLoading.lastChild;
      loadingText.textContent = 'Смотрим цену на сайте магазина…';
      const slowTimer = setTimeout(() => {
        if (seq === parseSeq) loadingText.textContent = 'Открываем страницу как обычный посетитель — это может занять до 20 секунд…';
      }, 2500);
      const r = await fetch('/api/parse?url=' + encodeURIComponent(url), { headers: { Accept: 'application/json' } })
        .then((x) => x.json()).catch(() => ({ ok: false, reason: 'network' }));
      clearTimeout(slowTimer);
      if (seq !== parseSeq) return;
      parsing = false;
      parseLoading.hidden = true;

      if (!r.ok || !r.priceEur) {
        parseFail.hidden = false;
        parseFail.textContent = r.ok && r.currency && r.currency !== 'EUR'
          ? 'На странице цена в ' + r.currency + ' — откройте португальскую версию сайта или введите цену в евро вручную.'
          : (FAIL_TEXT[r.reason] || FAIL_TEXT.no_price);
        if (r.ok) setIfAuto(titleInput, 'title', r.title);
        return;
      }

      // Цена и данные найдены
      setIfAuto(price, 'price', String(r.priceEur));
      setIfAuto(titleInput, 'title', r.title);
      parsedPrice.value = String(r.priceEur);
      imageUrl.value = r.image || '';
      price.classList.remove('is-invalid');
      updSum();

      parseCard.hidden = false;
      const img = $('[data-parse-img]', parseCard);
      if (r.image) { img.src = r.image; img.hidden = false; parseCard.classList.remove('no-img'); }
      else { img.hidden = true; parseCard.classList.add('no-img'); }
      img.onerror = () => { img.hidden = true; parseCard.classList.add('no-img'); };
      $('[data-parse-title]', parseCard).textContent = r.title || 'Товар';
      $('[data-parse-rub]', parseCard).textContent = fmtRub(r.priceRub || toRub(r.priceEur, rate, markup));
      $('[data-parse-eur]', parseCard).innerHTML = esc(String(r.priceEur).replace('.', ',')) + ' €'
        + (r.oldPriceEur ? ' <s>' + esc(String(r.oldPriceEur).replace('.', ',')) + ' €</s>' : '');
      const notes = [paste ? 'Цена с сайта магазина. Выберите размер и цвет.' : 'Цена с сайта магазина — проверьте перед добавлением.'];
      if (r.available === false) notes.unshift('Похоже, товара сейчас нет в наличии.');
      if (r.image && !paste) notes.push('Фото подставим в заказ.');
      $('[data-parse-note]', parseCard).textContent = notes.join(' ');

      if (r.sizes && r.sizes.length) {
        renderChips(sizeChips, r.sizes, sizeInput);
        sizeDefault.hidden = true;
      }
      if (r.colors && r.colors.length) {
        if (r.selectedColor) setIfAuto(colorInput, 'color', r.selectedColor);
        else if (r.colors.length === 1) setIfAuto(colorInput, 'color', r.colors[0].name);
        renderChips(colorChips, r.colors, colorInput);
      }
    };

    const warn = (html) => {
      detect.classList.add('detect--warn');
      detectIcon.innerHTML = ICON_WARN;
      detectText.innerHTML = html;
    };

    let timer;
    const runDetect = async () => {
      const v = urlInput.value.trim();
      clearErrors();
      setBlocked(false);
      if (fullForm) fullForm.href = '/order-link' + (v ? '?url=' + encodeURIComponent(v) : '');
      if (!v) {
        storeState = '';
        detect.classList.remove('is-visible');
        resetParse();
        if (details) details.hidden = true;
        return;
      }
      const res = await fetch('/api/detect?url=' + encodeURIComponent(v)).then((r) => r.json()).catch(() => null);
      if (!res || urlInput.value.trim() !== v) return;
      detect.classList.add('is-visible');
      detect.classList.remove('detect--warn');
      resetParse();
      if (!res.ok) {
        storeState = 'bad';
        warn(esc(res.error));
      } else if (!res.store) {
        // Заказываем только из магазинов списка
        storeState = 'unknown';
        warn(UNKNOWN_STORE);
        setBlocked(true);
      } else if (res.regionOk) {
        storeState = 'ok';
        detectIcon.innerHTML = ICON_OK;
        detectText.innerHTML = '<b>' + esc(res.store.name) + '</b> — ' + (res.store.region === 'PT' ? 'португальская версия сайта, всё верно.' : 'европейский сайт магазина, всё верно.');
        if (select) select.value = res.store.id;
        runParse(v);
      } else {
        storeState = 'other';
        warn('Это не та версия сайта <b>' + esc(res.store.name) + '</b>. Откройте товар на <a class="link" target="_blank" rel="noopener" href="' + esc(res.store.url) + '">португальском сайте магазина</a> и скопируйте ссылку оттуда — цены там другие.');
        if (select) select.value = res.store.id;
      }
      if (details) details.hidden = storeState !== 'ok' && storeState !== 'other';
    };
    urlInput.addEventListener('input', () => {
      storeState = '';
      clearTimeout(timer);
      timer = setTimeout(runDetect, 500);
    });
    if (urlInput.value) runDetect();

    // Если покупатель загрузил своё фото — оно важнее фото с сайта
    if (photoInput) photoInput.addEventListener('change', () => { if (photoInput.files.length) imageUrl.value = ''; });

    $$('[data-fill]', linkForm).forEach((chip) => chip.addEventListener('click', () => {
      const input = $('[name="' + chip.dataset.fill + '"]', linkForm);
      input.value = chip.dataset.value;
      input.classList.remove('is-invalid');
      input.focus();
    }));
    [sizeInput, colorInput, price].forEach((el) => el.addEventListener('input', () => el.classList.remove('is-invalid')));

    linkForm.addEventListener('submit', async (e) => {
      if (!paste) {
        if (storeState === 'unknown') { e.preventDefault(); urlInput.focus(); }
        return;
      }
      e.preventDefault();
      clearErrors();
      if (!urlInput.value.trim()) { showError('Вставьте ссылку на страницу товара.', urlInput); return; }
      if (!storeState) { clearTimeout(timer); await runDetect(); }
      if (storeState === 'unknown' || storeState === 'bad') { urlInput.focus(); return; }
      const eur = parseFloat(String(price.value).replace(',', '.'));
      if (!(eur > 0)) {
        if (parsing) showError('Секунду — смотрим цену на сайте магазина.');
        else showError('Укажите цену в евро, как на сайте магазина.', price);
        return;
      }
      if (!sizeInput.value.trim()) { showError('Выберите размер или «Без размера».', sizeInput); return; }
      if (!colorInput.value.trim()) { showError('Укажите цвет, как он назван на сайте магазина.', colorInput); return; }

      setBlocked(true);
      const r = await post('/cart/add-link', Object.fromEntries(new FormData(linkForm))).catch(() => null);
      setBlocked(false);
      if (r && r.ok) {
        setCartCount(r.json.count);
        toast('Товар в корзине. <a href="/cart">Перейти в корзину</a>');
        linkForm.reset();
        titleInput.value = '';
        auto.price = auto.title = auto.color = '';
        runDetect();
        return;
      }
      if (r && r.status === 403) { showError('Страница устарела. Обновите её и попробуйте ещё раз.'); return; }
      const errs = (r && r.json && r.json.errors) || {};
      const key = Object.keys(errs)[0];
      showError(key ? errs[key] : 'Не получилось добавить товар. Обновите страницу и попробуйте ещё раз.', key ? $('[name="' + key + '"]', linkForm) : null);
    });
    updSum();
  });

  // ---------- Список брендов: поиск, категории, подкатегории красоты ----------
  const filterBox = $('[data-stores-filter]');
  if (filterBox) {
    const q = $('[data-filter-q]', filterBox);
    const chips = $$('[data-cat]', filterBox);
    const subBox = $('[data-filter-subs]', filterBox);
    const subChips = $$('[data-sub]', filterBox);
    const cards = $$('[data-stores-list] .store-card');
    const groups = $$('[data-letter-group]');
    const empty = $('[data-stores-empty]');
    const pressed = (list) => (list.find((c) => c.getAttribute('aria-pressed') === 'true') || { dataset: {} });
    let cat = pressed(chips).dataset.cat || '';
    let sub = pressed(subChips).dataset.sub || '';
    const syncUrl = () => {
      const url = new URL(window.location.href);
      cat ? url.searchParams.set('cat', cat) : url.searchParams.delete('cat');
      sub ? url.searchParams.set('sub', sub) : url.searchParams.delete('sub');
      history.replaceState(null, '', url);
    };
    const apply = () => {
      const term = q.value.trim().toLowerCase();
      subBox.hidden = cat !== 'beauty';
      let visible = 0;
      cards.forEach((c) => {
        const ok = (!term || c.dataset.name.includes(term))
          && (!cat || c.dataset.cats.includes(',' + cat + ','))
          && (cat !== 'beauty' || !sub || c.dataset.subs.includes(',' + sub + ','));
        c.hidden = !ok;
        if (ok) visible++;
        const t = $('.store-card__cats', c);
        if (t) t.textContent = cat === 'beauty' && t.dataset.subsText ? t.dataset.subsText : t.dataset.catsText;
      });
      groups.forEach((g) => {
        const any = $$('.store-card', g).some((c) => !c.hidden);
        g.hidden = !any;
        const link = $('[data-letter-link="' + g.dataset.letterGroup + '"]');
        if (link) link.style.opacity = any ? '' : '.3';
      });
      empty.hidden = visible > 0;
    };
    q.addEventListener('input', apply);
    chips.forEach((chip) => chip.addEventListener('click', () => {
      cat = chip.dataset.cat;
      sub = '';
      chips.forEach((c) => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
      subChips.forEach((c) => c.setAttribute('aria-pressed', c.dataset.sub === '' ? 'true' : 'false'));
      syncUrl();
      apply();
    }));
    subChips.forEach((chip) => chip.addEventListener('click', () => {
      sub = chip.dataset.sub;
      subChips.forEach((c) => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
      syncUrl();
      apply();
    }));
    apply();
  }

  // ---------- Плитки брендов: надпись на всю плитку, последний ряд растворяется ----------
  // Подбираем самый крупный размер, при котором надпись помещается в плитку по ширине и высоте
  // (слова не разрываются, длинные названия переносятся по словам).
  function fitText(el) {
    const box = el.parentElement;
    const cs = getComputedStyle(box);
    const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w <= 0 || h <= 0) return;
    const cap = h * 0.6; // короткие названия (COS, LEGO) не выше 60% плитки
    let lo = 6, hi = Math.min(h, 400);
    for (let i = 0; i < 14; i += 1) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = mid + 'px';
      if (el.scrollWidth <= el.clientWidth + 0.5 && el.scrollHeight <= h + 0.5) lo = mid; else hi = mid;
    }
    el.style.fontSize = Math.floor(Math.min(lo, cap) * 10) / 10 + 'px';
  }
  const fitAll = () => $$('[data-fit]').forEach(fitText);

  const brandGrid = $('[data-brand-grid]');
  const markFade = () => {
    if (!brandGrid) return;
    const all = $$('.brand-tile', brandGrid);
    all.forEach((t) => t.classList.remove('is-fade', 'is-extra'));
    let tiles = all.filter((t) => t.offsetParent !== null);
    // Неполный последний ряд прячем (эти бренды — по кнопке «Ещё бренды»), растворяется последний полный
    const tops = tiles.map((t) => t.offsetTop);
    const cols = tops.filter((top) => top === tops[0]).length;
    const inLast = tops.filter((top) => top === tops[tops.length - 1]).length;
    if (tiles.length > cols && inLast < cols) {
      tiles.slice(-inLast).forEach((t) => t.classList.add('is-extra'));
      tiles = tiles.slice(0, -inLast);
    }
    const rows = new Set(tiles.map((t) => t.offsetTop)).size;
    brandGrid.classList.toggle('has-fade', rows > 1);
    if (rows > 1) {
      const lastTop = tiles[tiles.length - 1].offsetTop;
      tiles.filter((t) => t.offsetTop === lastTop).forEach((t) => t.classList.add('is-fade'));
    }
  };
  if ($('[data-fit]')) {
    let raf = 0;
    const refresh = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { fitAll(); markFade(); }); };
    refresh();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    if (window.ResizeObserver) new ResizeObserver(refresh).observe(brandGrid || document.body);
    else window.addEventListener('resize', refresh);
    document.addEventListener('bs:fit', refresh); // превью плитки в админке
  }

  // ---------- Ленты товаров на главной ----------
  $$('[data-rail]').forEach((rail) => {
    const track = $('[data-rail-track]', rail), prev = $('[data-rail-prev]', rail), next = $('[data-rail-next]', rail);
    const upd = () => {
      prev.hidden = track.scrollLeft <= 4;
      next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    const step = () => track.clientWidth * 0.8;
    prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
    track.addEventListener('scroll', upd, { passive: true });
    window.addEventListener('resize', upd);
    upd();
  });

  // ---------- Подтверждение действий ----------
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset && e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
})();
