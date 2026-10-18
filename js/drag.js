'use strict';

/* ============================================================
 * 拖曳行程：按住卡片左邊的 ⠿ 拖到別的位置或別天（手機、電腦都可以，用 Pointer Events）
 *  - 同一天換順序：時段不動、人換位置——把這天原本的開始時間依新順序重新分配，每個行程的長度不變
 *  - 拖到別天：時間不變（排在那天對應的時段），沒有時間的排在最後
 * 放開後可以按「復原」
 * ============================================================ */

let drag = null; // { li, id, fromDate, startY, active, x, y, raf }

document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle || e.button > 0) return;
  const li = handle.closest('li.activity');
  if (!li) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  drag = { li, handle, id: li.dataset.id, fromDate: li.dataset.date, startY: e.clientY, active: false, x: e.clientX, y: e.clientY, raf: 0 };
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    if (Math.abs(e.clientY - drag.startY) < 6) return;
    drag.active = true;
    document.body.classList.add('drag-mode');
    drag.li.classList.add('dragging');
    autoScroll();
  }
  e.preventDefault();
  placeDragged();
});

function placeDragged() {
  const under = document.elementFromPoint(drag.x, drag.y);
  if (!under) return;
  const day = under.closest('.day');
  const list = day && day.querySelector('ol.timeline');
  if (!list) return;
  const target = under.closest('li.activity');
  if (target && target !== drag.li && list.contains(target)) {
    const r = target.getBoundingClientRect();
    list.insertBefore(drag.li, drag.y < r.top + r.height / 2 ? target : target.nextSibling);
  } else if (!target && drag.li.parentElement !== list) {
    list.appendChild(drag.li);
  }
  for (const ol of document.querySelectorAll('ol.timeline')) ol.classList.toggle('drop-target', ol === drag.li.parentElement);
}

// 拖到畫面上下邊緣時自動捲動
function autoScroll() {
  if (!drag || !drag.active) return;
  const edge = 70;
  const sticky = document.querySelector('.trip-sticky');
  const top = sticky ? Math.max(0, sticky.getBoundingClientRect().bottom) : 0;
  let dy = 0;
  if (drag.y < top + edge) dy = -Math.ceil((top + edge - drag.y) / 6);
  else if (drag.y > window.innerHeight - edge) dy = Math.ceil((drag.y - (window.innerHeight - edge)) / 6);
  if (dy) {
    window.scrollBy(0, dy);
    placeDragged();
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag(cancel) {
  if (!drag) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  document.body.classList.remove('drag-mode');
  d.li.classList.remove('dragging');
  for (const ol of document.querySelectorAll('ol.timeline.drop-target')) ol.classList.remove('drop-target');
  const t = currentTrip();
  if (!d.active || !t) return;
  const ol = d.li.parentElement;
  const toDate = ol && ol.dataset.day;
  if (cancel || !toDate) return renderTrip(t);
  const order = [...ol.querySelectorAll(':scope > li.activity')].map((x) => x.dataset.id);
  const before = (t.days[d.fromDate] || []).map((a) => a.id).join();
  if (toDate === d.fromDate && order.join() === before) return renderTrip(t);
  const item = (t.days[d.fromDate] || []).find((a) => a.id === d.id);
  if (!item) return renderTrip(t);
  withUndo(t, toDate === d.fromDate ? '已調整順序' : `已把「${item.title}」移到 ${prettyDate(toDate)}`, () => moveActivity(t, d.fromDate, toDate, d.id, order));
}

document.addEventListener('pointerup', () => endDrag(false));
document.addEventListener('pointercancel', () => endDrag(true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(true); });

/** 套用拖曳的結果；order 是放開時那一天的行程 id 順序 */
function moveActivity(t, fromDate, toDate, id, order) {
  const item = t.days[fromDate].find((a) => a.id === id);
  if (fromDate !== toDate) {
    // 移到別天：時間不變，依時間排
    t.days[fromDate] = t.days[fromDate].filter((a) => a.id !== id);
    t.days[toDate] = sortDay([...(t.days[toDate] || []), item]);
    return;
  }
  const byId = new Map(t.days[toDate].map((a) => [a.id, a]));
  const ordered = order.map((x) => byId.get(x)).filter(Boolean);
  retime(ordered);
  t.days[toDate] = sortDay(ordered);
}

// 時段不動、人換位置：原本的開始時間由早到晚，依新順序重新分給有時間的行程，結束時間跟著平移
function retime(list) {
  const timed = list.filter((a) => a.time);
  const slots = timed.map((a) => a.time).sort();
  timed.forEach((a, i) => {
    const len = a.endTime ? toMin(a.endTime) - toMin(a.time) : null;
    a.time = slots[i];
    if (len != null) a.endTime = fromMin(toMin(a.time) + len);
  });
}
