'use strict';

/* ============================================================
 * 購物清單：跟著每日行程走（每個 LINE 帳號各自一份，旅伴的只能看）
 * 也放了購物與行程共用的照片挑選、看大圖
 * ============================================================ */
/* ---------- 購物清單（跟著每日行程走） ---------- */
const MAX_SHOPPING = 200;
const MAX_QTY = 999;
// 付款狀態：先付（出發前就付了，例如網購、預購）／後付（到現場才付）／不確定
const PAYMENTS = {
  pre: { label: '先付', cls: 'pay-pre' },
  post: { label: '後付', cls: 'pay-post' },
  unsure: { label: '不確定', cls: 'pay-unsure' },
};

function payKey(s) {
  return Object.hasOwn(PAYMENTS, s.payment) ? s.payment : 'unsure';
}

function cleanQty(v) {
  const n = Math.round(Number(v));
  return n >= 1 && n <= MAX_QTY ? n : 1;
}

/** 備註只寫數量時回傳那個數字（「2」「2個」「x3」「×3」「3盒」），否則回傳 0（和後端 qtyFromNote_ 一樣） */
function qtyFromNote(note) {
  const s = String(note || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  const m = s.match(/^(?:[xX×*＊✕ｘ]\s*)?(\d{1,3})\s*(?:個|盒|包|瓶|件|組|份|罐|袋|條|張|雙|支|台|片|入|顆|本|枚|pcs?)?$/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_QTY ? n : 0;
}

// 存檔前整理：有指定行程的，把日期更新成行程目前那一天；行程被刪掉的就留在最後那一天
// 舊資料沒有數量（quantity）的：備註只寫數量的搬過去、備註清空（雲端的資料後端升級時已經搬過）
function syncShopping(t) {
  const where = new Map();
  for (const [d, list] of Object.entries(t.days || {})) list.forEach((a) => where.set(a.id, d));
  t.shopping = (t.shopping || []).map((s) => {
    const d = s.activityId && where.get(s.activityId);
    const fromNote = s.quantity == null ? qtyFromNote(s.note) : 0;
    const out = {
      id: s.id, text: s.text, date: d || s.date || '', activityId: d ? s.activityId : '', price: Math.max(0, Number(s.price) || 0), done: !!s.done,
      note: fromNote ? '' : (s.note || ''), fileId: s.fileId || '',
      quantity: fromNote || cleanQty(s.quantity), priceCurrency: CURRENCIES.includes(s.priceCurrency) ? s.priceCurrency : '', payment: payKey(s),
      paidBy: s.paidBy || '', splitWith: Array.isArray(s.splitWith) ? s.splitWith : [],
    };
    if (s.image) out.image = s.image; // 還沒上傳到雲端的照片
    return out;
  });
}

// 這一樣的幣別（沒填就是旅程的）、小計（單價 × 數量）
function shopCur(s, currency) {
  return s.priceCurrency || currency;
}

function shopSubtotal(s) {
  return Math.max(0, Number(s.price) || 0) * cleanQty(s.quantity);
}

// 購物金額合計（單價 × 數量，換算成台幣）
function shopCost(items, currency) {
  return items.reduce((sum, s) => sum + twdOrRaw(shopSubtotal(s), shopCur(s, currency)), 0);
}

// 原幣寫法：台幣用 NT$，其他沿用 origMoney（¥500）
function curMoney(n, cur) {
  return !cur || cur === 'TWD' ? ntd(n) : origMoney(n, cur);
}

// 清單上的金額：「NT$330（¥1,500）」，數量多於 1 時後面加「¥500 × 3」
function shopMoneyHtml(s, currency) {
  const q = cleanQty(s.quantity);
  if (!Number(s.price)) return q > 1 ? `<span class="shop-qty">×${q}</span>` : '';
  const cur = shopCur(s, currency);
  return `${showMoney(shopSubtotal(s), cur)}${q > 1 ? `<small class="shop-unit">${esc(curMoney(s.price, cur))} × ${q}</small>` : ''}`;
}

function payChip(s) {
  const p = PAYMENTS[payKey(s)];
  return `<span class="pay-chip ${p.cls}">${p.label}</span>`;
}

// 依「哪一站、哪一天」分好：byAct（行程 id → 東西）、byDay（日期 → 沒指定行程的東西）、loose（不指定日期）
function shoppingIndex(t, dates, items = t.shopping || []) {
  const actDate = new Map();
  for (const d of dates) for (const a of t.days[d] || []) actDate.set(a.id, d);
  const idx = { byAct: new Map(), byDay: new Map(), loose: [] };
  const add = (map, key, s) => map.set(key, (map.get(key) || []).concat([s]));
  for (const s of items) {
    if (s.activityId && actDate.has(s.activityId)) add(idx.byAct, s.activityId, s);
    else if (dates.includes(s.date)) add(idx.byDay, s.date, s);
    else idx.loose.push(s);
  }
  return idx;
}

// 某一天所有要買的東西（依行程順序，最後是沒指定行程的）
function shoppingOn(t, idx, date) {
  return (t.days[date] || []).flatMap((a) => idx.byAct.get(a.id) || []).concat(idx.byDay.get(date) || []);
}

// 照片：已經有圖就直接顯示；只有雲端的檔案 id 時先留空，畫面畫好後由 ShopPhotos.load 補上
function shopImg(s, cls) {
  const photos = typeof ShopPhotos !== 'undefined' ? ShopPhotos : null;
  const src = photos ? photos.src(s) : (s.image || '');
  if (!src && !(s.fileId && photos)) return '';
  return `<button type="button" class="${cls}" data-action="view-shop-photo" data-id="${esc(s.id)}" title="看大圖" aria-label="看 ${esc(s.text)} 的照片">
    <img ${src ? `src="${esc(src)}"` : `data-shop-file="${esc(s.fileId)}"`} alt="" loading="lazy"></button>`;
}

// 每日行程裡用的精簡版（一列）
function shopItem(s, currency, where = '') {
  return `
    <li class="shop-item${s.done ? ' done' : ''}">
      ${shopImg(s, 'shop-thumb')}
      <label><input type="checkbox" data-action="toggle-shop" data-id="${esc(s.id)}" ${s.done ? 'checked' : ''}><span>${esc(s.text)}${cleanQty(s.quantity) > 1 && !Number(s.price) ? ` ×${cleanQty(s.quantity)}` : ''}${s.note ? `<small class="shop-note">${esc(s.note)}</small>` : ''}</span></label>
      ${where ? `<span class="shop-where muted">${where}</span>` : ''}
      ${Number(s.price) ? `<span class="shop-price">${shopMoneyHtml(s, currency)}</span>` : ''}
      <span class="shop-actions no-print">
        <button class="icon-btn" data-action="edit-shop" data-id="${esc(s.id)}" title="編輯" aria-label="編輯">✎</button>
        <button class="icon-btn" data-action="delete-shop" data-id="${esc(s.id)}" title="刪除" aria-label="刪除">✕</button>
      </span>
    </li>`;
}

// 購物清單分頁用的卡片：照片、勾選、名稱、備註、單價與數量可以直接改（幣別、付款狀態、誰付的在 ✎ 裡改）
function shopCard(s, currency, where = '') {
  const cur = shopCur(s, currency);
  const sub = shopSubtotal(s);
  const twd = sub && cur !== 'TWD' ? toTWD(sub, cur) : null;
  const payer = typeof shopPayerChip === 'function' ? shopPayerChip(currentTrip(), s) : '';
  return `
    <li class="shop-card${s.done ? ' done' : ''}">
      <div class="shop-photo">
        ${shopImg(s, 'shop-photo-btn') || `<button type="button" class="shop-photo-add no-print" data-action="pick-shop-photo" data-id="${esc(s.id)}">＋ 加照片</button>`}
        <span class="shop-card-actions no-print">
          <button class="icon-btn" data-action="edit-shop" data-id="${esc(s.id)}" title="編輯（改日期、在哪買、換照片）" aria-label="編輯">✎</button>
          <button class="icon-btn" data-action="delete-shop" data-id="${esc(s.id)}" title="刪除" aria-label="刪除">✕</button>
        </span>
      </div>
      <label class="shop-card-name"><input type="checkbox" data-action="toggle-shop" data-id="${esc(s.id)}" ${s.done ? 'checked' : ''}><span>${esc(s.text)}</span></label>
      ${where ? `<div class="shop-where muted">${where}</div>` : ''}
      <div class="shop-chips">${payChip(s)}${payer}</div>
      <input class="shop-card-input" data-change="shop-note" data-id="${esc(s.id)}" value="${esc(s.note || '')}" maxlength="200" placeholder="顏色／尺寸／備註…" aria-label="${esc(s.text)} 的備註">
      <div class="shop-card-price">
        <input class="shop-card-input" type="number" min="0" step="any" inputmode="decimal" data-change="shop-price" data-id="${esc(s.id)}" value="${Number(s.price) || ''}" placeholder="單價" aria-label="${esc(s.text)} 的單價（${esc(cur)}）">
        <span class="muted">${esc(cur)}</span>
        <span class="muted" aria-hidden="true">×</span>
        <input class="shop-card-input shop-qty-input" type="number" min="1" max="${MAX_QTY}" step="1" inputmode="numeric" data-change="shop-qty" data-id="${esc(s.id)}" value="${cleanQty(s.quantity)}" aria-label="${esc(s.text)} 的數量">
      </div>
      ${sub ? `<div class="shop-subtotal muted">小計 ${esc(curMoney(sub, cur))}${twd != null ? ` ≈ ${ntd(twd)}` : ''}</div>` : ''}
    </li>`;
}

// 旅伴的購物項目：只能看，不能勾、不能改
function shopCardReadonly(s, currency, where = '') {
  return `
    <li class="shop-card readonly${s.done ? ' done' : ''}">
      ${shopImg(s, 'shop-photo-btn') ? `<div class="shop-photo">${shopImg(s, 'shop-photo-btn')}</div>` : ''}
      <div class="shop-card-name"><span class="shop-ro-check" aria-hidden="true">${s.done ? '☑' : '☐'}</span><span>${esc(s.text)}</span></div>
      ${where ? `<div class="shop-where muted">${where}</div>` : ''}
      <div class="shop-chips">${payChip(s)}${typeof shopPayerChip === 'function' ? shopPayerChip(currentTrip(), s) : ''}</div>
      ${s.note ? `<div class="shop-ro-note">${esc(s.note)}</div>` : ''}
      ${Number(s.price) || cleanQty(s.quantity) > 1 ? `<div class="shop-ro-price">${shopMoneyHtml(s, currency)}</div>` : ''}
    </li>`;
}

/** 一個人的購物清單，依天分組。editable＝自己的（可以改、可以新增），否則是旅伴的（只能看） */
function shopDaySections(t, dates, items, editable) {
  const idx = shoppingIndex(t, dates, items);
  const card = editable ? shopCard : shopCardReadonly;
  const days = dates.map((d, i) => {
    const acts = (t.days[d] || []).filter((a) => idx.byAct.has(a.id));
    const dayTotal = shopCost(shoppingOn(t, idx, d), t.currency);
    const rest = idx.byDay.get(d) || [];
    if (!acts.length && !rest.length) return '';
    return `
      <section class="panel">
        <div class="shop-day-head">
          <h3>Day ${i + 1}・${prettyDate(d)}${dayTotal ? `<span class="muted shop-day-total">${ntd(dayTotal)}</span>` : ''}</h3>
          ${editable ? `<button class="btn btn-sm no-print" data-action="add-shop" data-date="${d}">＋ 這天要買</button>` : ''}
        </div>
        <ul class="shop-grid">
          ${acts.map((a) => idx.byAct.get(a.id).map((s) => card(s, t.currency, `📍 ${a.time ? `${esc(a.time)} ` : ''}${esc(a.title)}`)).join('')).join('')}
          ${rest.map((s) => card(s, t.currency)).join('')}
        </ul>
      </section>`;
  }).join('');
  return `${days}
    ${idx.loose.length ? `
      <section class="panel">
        <h3>不指定日期</h3>
        <ul class="shop-grid">${idx.loose.map((s) => card(s, t.currency)).join('')}</ul>
      </section>` : ''}`;
}

function shopSummary(items, currency) {
  const total = shopCost(items, currency);
  return `已買 ${items.filter((s) => s.done).length} / ${items.length}${total ? `・預估 ${ntd(total)}（已買 ${ntd(shopCost(items.filter((s) => s.done), currency))}）` : ''}`;
}

// 付款狀態各自的合計：「先付 NT$1,200・後付 NT$800・不確定 NT$300」
function paySummary(items, currency) {
  const parts = Object.entries(PAYMENTS).map(([k, p]) => {
    const list = items.filter((s) => payKey(s) === k);
    return list.length ? `<span class="pay-sum"><span class="pay-chip ${p.cls}">${p.label}</span>${ntd(shopCost(list, currency))}<small class="muted">（${list.length} 樣）</small></span>` : '';
  }).filter(Boolean);
  return parts.length ? `<div class="pay-summary">${parts.join('')}</div>` : '';
}

function shoppingView(t, dates) {
  const items = t.shopping || [];
  const done = items.filter((s) => s.done).length;
  const pct = items.length ? (done / items.length) * 100 : 0;
  const total = shopCost(items, t.currency);
  const shared = cloudOn() && Array.isArray(t.members) && t.members.length > 1;
  const me = shared ? (t.members.find((m) => m.me) || {}).name : '';
  // 旅伴的清單（雲端才有）：一人一區，只能看
  const others = (shared ? t.othersShopping || [] : []).filter((g) => g && Array.isArray(g.items) && g.items.length);
  const othersHtml = others.map((g, i) => `
    <details class="shop-owner shop-owner-other owner-${i % 4}" open>
      <summary><span class="shop-owner-name">👤 ${esc(g.name)} 的購物清單</span><span class="chip">只能看</span><span class="muted shop-owner-sum">${shopSummary(g.items, t.currency)}</span></summary>
      ${shopDaySections(t, dates, g.items, false)}
    </details>`).join('');

  return `
    ${shared ? `<div class="shop-owner shop-owner-me"><div class="shop-owner-title"><span class="shop-owner-name">🙋 我的購物清單${me ? `（${esc(me)}）` : ''}</span><span class="chip">可以修改</span></div>` : ''}
    <section class="panel">
      <div class="shop-day-head">
        <div class="packing-summary">${shopSummary(items, t.currency)}</div>
        <button class="btn btn-primary no-print" data-action="add-shop" data-date="">＋ 新增要買的東西</button>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      ${paySummary(items, t.currency)}
      ${items.length ? '' : '<p class="muted shop-empty">還沒有要買的東西。可以指定哪一天、在哪一站買，每日行程裡也會跟著顯示。</p>'}
      ${items.length ? `<p class="muted hint">卡片上的備註、單價和數量可以直接改；幣別、付款狀態（先付／後付／不確定）${splitMembers(t).length ? '、誰付的' : ''}按 ✎ 修改。點「＋ 加照片」放上商品照片，點照片可以看大圖。小計（單價 × 數量）會計入「💰 預算」的購物分類。</p>` : ''}
      ${shared ? '<p class="muted hint">👥 每個人各有一份購物清單：自己的可以改，旅伴的列在下面、只能看。預算裡的購物金額只算你自己的；有填「誰付的」的會算進預算頁的分帳（旅伴的也算）。</p>' : ''}
      <p class="muted hint no-print">${cloudOn()
        ? '也可以在 LINE 官方帳號輸入「買 明天 抹茶粉」「買 面膜 @藥妝店」「買到 抹茶粉」。'
        : '在「每日行程」每一站的 🛒 也能直接加。'}</p>
    </section>
    ${shopDaySections(t, dates, items, true)}
    ${shared ? '</div>' : ''}
    ${othersHtml}
    ${shared && !others.length ? '<p class="muted hint shop-others-empty">旅伴還沒有加購物清單。</p>' : ''}`;
}

/* ---------- 表單：購物清單 ---------- */
function fillShopActivities(date, selected) {
  const t = currentTrip();
  const list = (t && date && t.days[date]) || [];
  shopForm.elements.activityId.innerHTML = `<option value="">${date ? '（不指定，這天都可以）' : '（先選日期才能指定行程）'}</option>`
    + list.map((a) => `<option value="${esc(a.id)}">${a.time ? `${esc(a.time)} ` : ''}${esc(a.title)}</option>`).join('');
  shopForm.elements.activityId.value = list.some((a) => a.id === selected) ? selected : '';
  shopForm.elements.activityId.disabled = !list.length;
}

// 表單裡的照片：image＝這次新選的（還沒存）、removed＝按了移除、item＝正在編輯的項目
let shopDialogPhoto = { image: '', removed: false, item: null };
let shopPhotoTarget = '';   // 選照片是給誰用的：'dialog' 或購物項目的 id
const shopPhotoFile = $('#shop-photo-file');
const photoDialog = $('#photo-dialog');

function updateShopPhotoPreview() {
  const img = $('#shop-photo-preview');
  if (!img) return;
  const it = shopDialogPhoto.item;
  const src = shopDialogPhoto.image || (!shopDialogPhoto.removed && it && typeof ShopPhotos !== 'undefined' ? ShopPhotos.src(it) : '');
  const has = !!src || (!shopDialogPhoto.removed && !!(it && it.fileId));
  img.hidden = !src;
  if (src) img.src = src; else img.removeAttribute('src');
  $('#shop-photo-remove').hidden = !has;
}

// 把照片放到某個購物項目上（換照片時舊的雲端檔案會在存檔後由後端丟掉）
function setShopPhoto(item, dataUrl) {
  item.image = dataUrl;
  item.fileId = '';
}

shopPhotoFile?.addEventListener('change', async () => {
  const file = shopPhotoFile.files[0];
  shopPhotoFile.value = '';
  if (!file) return;
  try {
    const dataUrl = await shopImageFromFile(file);
    if (shopPhotoTarget === 'dialog') {
      shopDialogPhoto.image = dataUrl;
      shopDialogPhoto.removed = false;
      shopForm.dataset.dirty = '1';
      return updateShopPhotoPreview();
    }
    if (shopPhotoTarget === 'act-dialog') {
      actDialogPhoto.image = dataUrl;
      actDialogPhoto.removed = false;
      activityForm.dataset.dirty = '1';
      return updateActPhotoPreview();
    }
    const t = currentTrip();
    const item = t && (t.shopping || []).find((s) => s.id === shopPhotoTarget);
    if (!item) return;
    setShopPhoto(item, dataUrl);
    commitTrip(t);
    renderTrip(t);
    toast('已加上照片');
  } catch (err) {
    toast(err.message || '照片處理失敗');
  }
});

photoDialog?.addEventListener('click', () => photoDialog.close());

// 卡片上直接改備註、金額。改完不馬上重畫，免得正要點下一格時游標跑掉；離開輸入框後再更新合計
let shopNeedsRender = false;
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change="shop-note"], [data-change="shop-price"], [data-change="shop-qty"]');
  const t = currentTrip();
  const item = el && t && (t.shopping || []).find((s) => s.id === el.dataset.id);
  if (!item) return;
  if (el.dataset.change === 'shop-note') item.note = el.value.trim().slice(0, 200);
  else if (el.dataset.change === 'shop-qty') item.quantity = cleanQty(el.value);
  else item.price = Math.max(0, Number(el.value) || 0);
  commitTrip(t);
  shopNeedsRender = true;
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    const t = currentTrip();
    if (!shopNeedsRender || !t || document.querySelector('dialog[open]')) return;
    if (document.activeElement && document.activeElement.closest('.shop-card-input')) return; // 還在填下一格
    shopNeedsRender = false;
    if (currentTab === 'shopping') renderTrip(t);
  }, 0);
});

// preset：{ date, activityId } 新增時的預設位置；item：要編輯的項目
function openShopDialog(preset, item) {
  const t = currentTrip();
  if (!t) return;
  if (!shopForm) return toast('網頁有更新，請重新整理後再試一次');
  const dates = dateRange(t.startDate, t.endDate);
  editingShopId = item ? item.id : null;
  $('#shop-dialog-title').textContent = item ? '編輯要買的東西' : '新增要買的東西';
  $('#shop-multi-hint').hidden = !!item;
  shopForm.reset();
  shopForm.elements.date.innerHTML = '<option value="">（不指定日期）</option>'
    + dates.map((d, i) => `<option value="${d}">Day ${i + 1}・${prettyDate(d)}</option>`).join('');
  const src = item || preset || {};
  // 有指定行程的，以行程目前那一天為準
  const actDate = src.activityId && dates.find((d) => (t.days[d] || []).some((a) => a.id === src.activityId));
  const date = actDate || (dates.includes(src.date) ? src.date : '');
  shopForm.elements.text.value = item ? item.text : '';
  shopForm.elements.price.value = (item && item.price) || '';
  if (shopForm.elements.note) shopForm.elements.note.value = (item && item.note) || '';
  shopDialogPhoto = { image: '', removed: false, item: item || null };
  updateShopPhotoPreview();
  if (shopForm.elements.quantity) {
    shopForm.elements.quantity.value = item ? cleanQty(item.quantity) : 1;
    const curs = [...new Set(['JPY', 'TWD', t.currency, ...(item && item.priceCurrency ? [item.priceCurrency] : [])])];
    shopForm.elements.priceCurrency.innerHTML = curs.map((c) => `<option value="${c}">${c === 'JPY' ? '¥ 日幣' : c === 'TWD' ? 'NT$ 台幣' : c}</option>`).join('');
    shopForm.elements.priceCurrency.value = item ? shopCur(item, t.currency) : lastShopCurrency(t);
    shopForm.elements.payment.value = item ? payKey(item) : 'unsure';
    if (typeof fillSplitFields === 'function') fillSplitFields(t, item, shopForm, '#shop-split-fields', '#shop-split-with-list');
    updateShopPriceHint();
  }
  shopForm.elements.date.value = date;
  fillShopActivities(date, actDate ? src.activityId : '');
  shopDialog.showModal();
  shopForm.elements.text.focus();
}

// 瀏覽器還留著舊版 index.html（沒有購物清單表單）時，shopForm 會是 null，其他功能要照常運作
shopForm?.elements.date.addEventListener('change', () => fillShopActivities(shopForm.elements.date.value, ''));

shopForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = currentTrip();
  if (!t) return;
  const f = new FormData(shopForm);
  const date = f.get('date') || '';
  const activityId = date ? (f.get('activityId') || '') : '';
  const raw = f.get('text').trim();
  const price = Math.max(0, Number(f.get('price')) || 0);
  const note = (f.get('note') || '').trim().slice(0, 200);
  // 數量、幣別、付款狀態、分帳（瀏覽器還留著舊版表單時沒有這些欄位，沿用原本的）
  const prevItem = editingShopId ? (t.shopping || []).find((s) => s.id === editingShopId) : null;
  const extra = shopForm.elements.quantity ? {
    quantity: cleanQty(f.get('quantity')),
    priceCurrency: (() => { const c = CURRENCIES.includes(f.get('priceCurrency')) ? f.get('priceCurrency') : ''; return c && c !== t.currency ? c : ''; })(),
    payment: Object.hasOwn(PAYMENTS, f.get('payment')) ? f.get('payment') : 'unsure',
    ...(typeof readSplitFields === 'function' ? readSplitFields(t, prevItem, shopForm, '#shop-split-fields') : {}),
  } : {};
  // 新增時可以用「、」一次加好幾樣；編輯時整段都是同一樣
  const names = editingShopId ? [raw.slice(0, 80)] : [...new Set(raw.split(/[、，,]+/).map((s) => s.trim().slice(0, 80)).filter(Boolean))];
  if (!names.length || !names[0]) return toast('請填寫要買什麼');
  t.shopping ||= [];
  if (editingShopId) {
    const item = t.shopping.find((s) => s.id === editingShopId);
    if (item) {
      Object.assign(item, { text: names[0], date, activityId, price, note, ...extra });
      if (shopDialogPhoto.image) setShopPhoto(item, shopDialogPhoto.image);
      else if (shopDialogPhoto.removed) { delete item.image; item.fileId = ''; }
    }
  } else {
    if (t.shopping.length + names.length > MAX_SHOPPING) return toast(`購物清單最多 ${MAX_SHOPPING} 樣`);
    const added = names.map((text) => ({ id: uid(), text, date, activityId, price, done: false, note, fileId: '', quantity: 1, priceCurrency: '', payment: 'unsure', paidBy: '', splitWith: [], ...extra }));
    if (shopDialogPhoto.image) setShopPhoto(added[0], shopDialogPhoto.image); // 照片只放第一樣
    t.shopping.push(...added);
  }
  commitTrip(t);
  shopDialog.close();
  toast(editingShopId ? '已更新' : `已加入 ${names.length} 樣要買的東西`);
  renderTrip(t);
});

/* ---------- 表單：單價的幣別與換算 ---------- */
function lastShopCurrency(t) {
  try {
    return localStorage.getItem('travel-planner:shop-currency') || (['JPY', 'TWD'].includes(t.currency) ? t.currency : 'JPY');
  } catch {
    return 'JPY';
  }
}

// 單價下方即時顯示「小計 ¥1,500 ≈ NT$330」
function updateShopPriceHint() {
  const el = $('#shop-price-hint');
  if (!el || !shopForm.elements.quantity) return;
  const price = Number(shopForm.elements.price.value) || 0;
  const qty = cleanQty(shopForm.elements.quantity.value);
  const cur = shopForm.elements.priceCurrency.value;
  const sub = price * qty;
  const conv = sub && cur !== 'TWD' ? toTWD(sub, cur) : null;
  el.textContent = sub ? `小計 ${curMoney(sub, cur)}${cur !== 'TWD' ? (conv == null ? `｜${rateNote(cur)}` : ` ≈ ${ntd(conv)}｜${rateNote(cur)}`) : ''}` : '';
  el.hidden = !el.textContent;
}

for (const name of ['price', 'quantity']) shopForm?.elements[name]?.addEventListener('input', updateShopPriceHint);
shopForm?.elements.priceCurrency?.addEventListener('change', () => {
  try {
    localStorage.setItem('travel-planner:shop-currency', shopForm.elements.priceCurrency.value);
  } catch { /* 忽略 */ }
  updateShopPriceHint();
});

// 沒登入時存在這台裝置的舊資料：一打開就把備註裡的數量搬好（雲端的資料由後端升級時處理）
if (!cloudOn()) state.trips.forEach((t) => { try { syncShopping(t); } catch { /* 資料有問題就等下次存檔再整理 */ } });
