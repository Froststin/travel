'use strict';

/* ============================================================
 * 記帳（預算頁的「🧾 記帳」）：整趟旅程共用的帳，可以在 LINE 打「晚餐 1700 我付」記，也可以在這裡新增
 *   expense = { id, date（空＝不指定）, title, amount, currency（空＝旅程幣別）, paidBy, splitWith（空＝所有成員）, settled, createdAt }
 * 算進預算（預估花費、分類、每日、每人花費）；待分帳的算進分帳，結清的不算（跟購物「已買」一樣）
 * ============================================================ */

const MAX_EXPENSES = 300;
const expenseDialog = $('#expense-dialog');
const expenseForm = $('#expense-form');
let editingExpenseId = null;

function expenseCur(x, t) {
  return x.currency || t.currency;
}

function expensesPanel(t, dates) {
  const list = (t.expenses || []).slice().sort((a, b) => Number(a.settled) - Number(b.settled)
    || (a.date || '9').localeCompare(b.date || '9') || (a.createdAt || 0) - (b.createdAt || 0));
  const ms = splitMembers(t);
  const name = (k) => { const m = ms.find((x) => x.key === k); return m ? (m.me ? '我' : m.name) : (k ? '已退出的旅伴' : ''); };
  const total = list.reduce((s, x) => s + twdOrRaw(x.amount, expenseCur(x, t)), 0);
  const open = list.filter((x) => !x.settled).length;
  const row = (x) => {
    const n = Array.isArray(x.splitWith) && x.splitWith.length ? x.splitWith.length : ms.length;
    const self = n === 1 && x.splitWith[0] === x.paidBy; // 只有付款人自己＝不分帳
    const day = dates.indexOf(x.date);
    return `
      <li class="expense-item${x.settled ? ' settled' : ''}">
        <div class="expense-main">
          <span class="expense-title">${esc(x.title)}</span>
          <span class="muted small">${day >= 0 ? `Day ${day + 1}・${prettyDate(x.date)}` : '不指定日期'}${ms.length && x.paidBy ? `・👤 ${esc(name(x.paidBy))}付${self ? '・🙋 不分帳' : n > 1 ? `・${n} 人分` : ''}` : ''}</span>
        </div>
        <span class="expense-amount">${costLabel(x.amount, expenseCur(x, t))}</span>
        <span class="expense-actions no-print">
          ${ms.length && !self ? `<button class="btn btn-sm${x.settled ? '' : ' btn-primary'}" data-action="settle-expense" data-id="${esc(x.id)}" title="${x.settled ? '改回待分帳' : '已經付清了，不列入分帳'}">${x.settled ? '✅ 已結清' : '⏳ 待分帳'}</button>` : ''}
          <button class="icon-btn" data-action="edit-expense" data-id="${esc(x.id)}" title="修改" aria-label="修改">✎</button>
          <button class="icon-btn" data-action="delete-expense" data-id="${esc(x.id)}" title="刪除" aria-label="刪除">✕</button>
        </span>
      </li>`;
  };
  return `
    <section class="panel">
      <div class="shop-day-head">
        <h3>🧾 記帳${list.length ? `<span class="muted shop-day-total">${list.length} 筆・${ntd(total)}${ms.length && open ? `・待分帳 ${open} 筆` : ''}</span>` : ''}</h3>
        <button class="btn btn-sm no-print" data-action="add-expense">＋ 記一筆</button>
      </div>
      ${list.length ? `<ul class="expense-list">${list.map(row).join('')}</ul>` : '<p class="muted">還沒有記帳。旅途中臨時的花費（晚餐、計程車、門票……）可以記在這裡。</p>'}
      <p class="muted hint no-print">${cloudOn() ? '在 LINE 官方帳號打「晚餐 1700 我付」「12/4 計程車 2300円 小明付」就會記一筆；' : ''}記帳會算進預算${ms.length ? '與分帳；付清後按「待分帳」改成「已結清」，就不再列入分帳（預算照算）' : ''}。</p>
    </section>`;
}

/* ---------- 表單 ---------- */
function openExpenseDialog(x) {
  const t = currentTrip();
  if (!t || !expenseForm) return toast('網頁有更新，請重新整理後再試一次');
  editingExpenseId = x ? x.id : null;
  expenseForm.reset();
  $('#expense-dialog-title').textContent = x ? '修改記帳' : '記一筆';
  const dates = dateRange(t.startDate, t.endDate);
  const today = fmtDate(new Date());
  expenseForm.elements.date.innerHTML = '<option value="">（不指定日期）</option>'
    + dates.map((d, i) => `<option value="${d}">Day ${i + 1}・${prettyDate(d)}</option>`).join('');
  expenseForm.elements.date.value = x ? (dates.includes(x.date) ? x.date : '') : (dates.includes(today) ? today : '');
  expenseForm.elements.title.value = x ? x.title : '';
  expenseForm.elements.amount.value = x ? x.amount : '';
  const curs = [...new Set(['JPY', 'TWD', t.currency, ...(x && x.currency ? [x.currency] : [])])];
  expenseForm.elements.currency.innerHTML = curs.map((c) => `<option value="${c}">${c === 'JPY' ? '¥ 日幣' : c === 'TWD' ? 'NT$ 台幣' : c}</option>`).join('');
  expenseForm.elements.currency.value = x ? expenseCur(x, t) : t.currency; // 新的預設旅程幣別（跟 LINE 沒寫單位時一樣）
  // 誰付的、分攤：新的預設「我付、大家平分」
  const me = (splitMembers(t).find((m) => m.me) || {}).key;
  fillSplitFields(t, x || { paidBy: me || '', splitWith: [] }, expenseForm, '#expense-split-fields', '#expense-split-with-list');
  expenseDialog.showModal();
  expenseForm.elements.title.focus();
}

expenseForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = currentTrip();
  if (!t) return;
  const f = new FormData(expenseForm);
  const title = f.get('title').trim().slice(0, 40);
  const amount = Math.max(0, Math.round((Number(f.get('amount')) || 0) * 100) / 100);
  if (!title) return toast('請填寫項目');
  if (!amount) return toast('請填寫金額');
  const cur = CURRENCIES.includes(f.get('currency')) ? f.get('currency') : '';
  t.expenses ||= [];
  const prev = editingExpenseId ? t.expenses.find((x) => x.id === editingExpenseId) : null;
  const data = {
    date: f.get('date') || '', title, amount, currency: cur && cur !== t.currency ? cur : '',
    ...readSplitFields(t, prev, expenseForm, '#expense-split-fields'),
  };
  if (prev) Object.assign(prev, data);
  else {
    if (t.expenses.length >= MAX_EXPENSES) return toast(`每趟旅程最多記 ${MAX_EXPENSES} 筆帳`);
    t.expenses.push({ id: uid(), ...data, settled: false, createdAt: Date.now() });
  }
  commitTrip(t);
  expenseDialog.close();
  toast(prev ? '已更新' : '已記一筆');
  renderTrip(t);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action$="-expense"], [data-action^="expense-"]');
  const t = currentTrip();
  if (!el || !t) return;
  const x = (t.expenses || []).find((y) => y.id === el.dataset.id);
  switch (el.dataset.action) {
    case 'add-expense':
      openExpenseDialog(null);
      break;
    case 'expense-self': {
      // 表單裡的「不分帳」：只勾付款人自己
      const payer = expenseForm.elements.paidBy.value;
      if (!payer) { toast('先選誰付的'); break; }
      for (const c of expenseForm.querySelectorAll('input[name="splitWith"]')) c.checked = c.value === payer;
      break;
    }
    case 'expense-all':
      for (const c of expenseForm.querySelectorAll('input[name="splitWith"]')) c.checked = true;
      break;
    case 'edit-expense':
      if (x) openExpenseDialog(x);
      break;
    case 'settle-expense':
      if (!x) break;
      x.settled = !x.settled;
      commitTrip(t);
      renderTrip(t);
      toast(x.settled ? `「${x.title}」已結清，不列入分帳` : `「${x.title}」改回待分帳`);
      break;
    case 'delete-expense':
      if (x) withUndo(t, `已刪除記帳「${x.title}」`, () => { t.expenses = t.expenses.filter((y) => y.id !== x.id); });
      break;
  }
});
