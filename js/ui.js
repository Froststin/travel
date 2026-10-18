'use strict';

/* ============================================================
 * 共用的介面小工具
 *  - ⋯ 選單（<details class="menu">）：點外面或點了項目就收起來
 *  - 刪除後「復原」：withUndo
 *  - 表單改過沒存就要關掉時先問一下：closeDialog
 *  - 上方固定列的高度（分頁列要貼在它下面）
 * ============================================================ */

/* ---------- ⋯ 選單 ---------- */
function closeMenus(except) {
  for (const m of document.querySelectorAll('details.menu[open]')) if (m !== except) m.open = false;
}

document.addEventListener('click', (e) => {
  const inMenu = e.target.closest('details.menu');
  // 點了選單裡的項目：讓動作照常執行，選單收起來
  if (inMenu && e.target.closest('.menu-pop button, .menu-pop a')) {
    setTimeout(() => { inMenu.open = false; }, 0);
    return;
  }
  closeMenus(inMenu);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('details.menu[open]') && !document.querySelector('dialog[open]')) closeMenus();
});

// 選單靠近畫面右邊或下面時往另一邊開，避免被切掉
document.addEventListener('toggle', (e) => {
  const m = e.target;
  if (!(m instanceof HTMLDetailsElement) || !m.classList.contains('menu') || !m.open) return;
  const pop = m.querySelector('.menu-pop');
  pop.classList.remove('up', 'left');
  const r = pop.getBoundingClientRect();
  if (r.left < 8) pop.classList.add('left');
  if (r.bottom > window.innerHeight - 8 && m.getBoundingClientRect().top > r.height + 16) pop.classList.add('up');
}, true);

/* ---------- 刪除後復原 ---------- */
/**
 * 先記下旅程現在的樣子，執行 mutate（刪除），存檔並重畫，再跳出「復原」。
 * 按了復原就把旅程換回刪除前的內容再存一次（雲端的照片會從垃圾桶拿回來，見後端 restoreFile_）。
 */
function withUndo(t, message, mutate) {
  const { othersShopping, ...rest } = t;
  const before = JSON.parse(JSON.stringify(rest));
  mutate();
  commitTrip(t);
  if (currentTripId === t.id) renderTrip(t);
  toast(message, {
    action: '復原',
    duration: 6000,
    onAction: () => {
      // 版本號、角色、成員以現在的為準，其他換回刪除前
      const keep = { updatedAt: t.updatedAt, role: t.role, members: t.members, othersShopping: t.othersShopping };
      for (const k of Object.keys(t)) delete t[k];
      Object.assign(t, before, keep);
      if (!keep.updatedAt) delete t.updatedAt;
      commitTrip(t);
      if (currentTripId === t.id) renderTrip(t);
      toast('已復原');
    },
  });
}

/* ---------- 表單改過沒存 ---------- */
// 打開對話框時歸零，表單裡有輸入就記下來
for (const dlg of document.querySelectorAll('dialog')) {
  const form = dlg.querySelector('form');
  if (!form) continue;
  new MutationObserver(() => { if (dlg.open) form.dataset.dirty = ''; }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
  form.addEventListener('input', () => { form.dataset.dirty = '1'; });
  form.addEventListener('change', () => { form.dataset.dirty = '1'; });
  // 按 Esc
  dlg.addEventListener('cancel', (e) => {
    if (!confirmDiscard(dlg)) e.preventDefault();
  });
}

function confirmDiscard(dlg) {
  const form = dlg && dlg.querySelector('form');
  return !(form && form.dataset.dirty === '1') || confirm('有修改還沒儲存，確定要關閉嗎？');
}

function closeDialog(dlg) {
  if (dlg && confirmDiscard(dlg)) dlg.close();
}

/* ---------- 固定在上方的列 ---------- */
// 分頁列貼在網站標題下面；標題在手機上可能換行，所以量實際高度
(() => {
  const header = document.querySelector('.site-header');
  if (!header) return;
  const set = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  set();
  if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(header);
})();
