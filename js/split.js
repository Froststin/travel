'use strict';

/* ============================================================
 * 分帳：每筆花費可以記「誰付的」和「哪些人分攤」（沒選＝所有成員），預算頁算出誰該給誰多少
 * 成員用後端給的代號（members[].key）辨識；只有雲端共用、兩個人以上的旅程才有
 * 算法和後端 gas/Split.gs 的 settlement_ 一樣；購物清單（自己的與旅伴的）有填「誰付的」才算（單價 × 數量），沒填的當作自己買的
 * ============================================================ */

// 可以分帳的成員（沒有就回傳空陣列）
function splitMembers(t) {
  const ms = (t && Array.isArray(t.members) ? t.members : []).filter((m) => m && m.key);
  return ms.length > 1 ? ms : [];
}

// 一筆行程的花費（含車資），換算成台幣
function activityTotal(a, currency) {
  return twdOrRaw(a.cost, costCurrency(a, currency)) + twdOrRaw(a.travelCost, fareCurrency(a, currency));
}

function settlement(t) {
  const members = splitMembers(t);
  const everyone = members.map((m) => m.key);
  const people = new Map(members.map((m) => [m.key, { key: m.key, name: m.name, me: !!m.me, paid: 0, share: 0 }]));
  const person = (k) => {
    if (!people.has(k)) people.set(k, { key: k, name: '已退出的旅伴', me: false, paid: 0, share: 0 });
    return people.get(k);
  };
  let unassigned = 0;
  let total = 0;
  for (const a of allActivities(t)) {
    const amount = activityTotal(a, t.currency);
    if (!(amount > 0)) continue;
    if (!a.paidBy) {
      unassigned++;
      continue;
    }
    const who = Array.isArray(a.splitWith) && a.splitWith.length ? a.splitWith : everyone;
    if (!who.length) continue;
    total += amount;
    person(a.paidBy).paid += amount;
    who.forEach((k) => { person(k).share += amount / who.length; });
  }
  const shops = (t.shopping || []).concat(...(t.othersShopping || []).map((g) => g.items || []));
  for (const s of shops) {
    const amount = shopCost([s], t.currency);
    if (!(amount > 0) || !s.paidBy) continue;
    const who = Array.isArray(s.splitWith) && s.splitWith.length ? s.splitWith : everyone;
    if (!who.length) continue;
    total += amount;
    person(s.paidBy).paid += amount;
    who.forEach((k) => { person(k).share += amount / who.length; });
  }
  const rows = [...people.values()].map((p) => ({ ...p, net: p.paid - p.share }));
  return { rows, transfers: settleTransfers(rows), unassigned, total };
}

/**
 * 每人花費（預算頁用）：每筆金額照「分攤的人」平分（沒勾＝全部成員），跟分帳一樣；
 * 購物沒填「誰付的」算在清單主人身上（自己買的）。行程花費有沒有填誰付的都一樣分。
 * 和後端 gas/Split.gs 的 memberShares_ 同算法。
 * @return {null | { rows: [{ key, name, me, days: {日期: 金額}, loose, total }], total }} 不是共用旅程時回傳 null
 */
function memberShares(t, dates) {
  const members = splitMembers(t);
  if (!members.length) return null;
  const everyone = members.map((m) => m.key);
  // 自己的購物清單屬於誰：網站上是「我」，線上檢視頁是分享連結的人
  const ownerOfMine = (members.find((m) => m.me) || members.find((m) => m.sharer) || {}).key || '';
  const people = new Map(members.map((m) => [m.key, { key: m.key, name: m.name, me: !!m.me, days: {}, loose: 0, total: 0 }]));
  const person = (k) => {
    if (!people.has(k)) people.set(k, { key: k, name: '已退出的旅伴', me: false, days: {}, loose: 0, total: 0, gone: true });
    return people.get(k);
  };
  let total = 0;
  const add = (keys, amount, date) => {
    if (!(amount > 0) || !keys.length) return;
    total += amount;
    for (const k of keys) {
      const p = person(k);
      if (date) p.days[date] = (p.days[date] || 0) + amount / keys.length;
      else p.loose += amount / keys.length;
      p.total += amount / keys.length;
    }
  };
  const split = (x) => (Array.isArray(x.splitWith) && x.splitWith.length ? x.splitWith : everyone);
  for (const d of dates) for (const a of t.days[d] || []) add(split(a), activityTotal(a, t.currency), d);
  const lists = [{ owner: ownerOfMine, items: t.shopping || [] }]
    .concat((t.othersShopping || []).map((g) => ({ owner: g.key, items: g.items || [] })));
  for (const g of lists) {
    const who = (s) => (s.paidBy ? split(s) : (g.owner ? [g.owner] : everyone));
    const idx = shoppingIndex(t, dates, g.items);
    for (const d of dates) for (const s of shoppingOn(t, idx, d)) add(who(s), shopCost([s], t.currency), d);
    for (const s of idx.loose) add(who(s), shopCost([s], t.currency), '');
  }
  return { rows: [...people.values()].filter((p) => !p.gone || p.total > 0.005), total };
}

// 欠錢的人依序付給被欠最多的人，筆數最少；不到 1 元的零頭略過
function settleTransfers(rows) {
  const debtors = rows.filter((p) => p.net < -0.5).map((p) => ({ p, left: -p.net })).sort((a, b) => b.left - a.left);
  const creditors = rows.filter((p) => p.net > 0.5).map((p) => ({ p, left: p.net })).sort((a, b) => b.left - a.left);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    if (amount >= 0.5) out.push({ from: debtors[i].p, to: creditors[j].p, amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left < 0.5) i++;
    if (creditors[j].left < 0.5) j++;
  }
  return out;
}

const personName = (p) => `${p.name}${p.me ? '（我）' : ''}`;

/** 預算頁的「分帳」區塊；static＝匯出用的（沒有按鈕與操作說明） */
function settleView(t, forStatic = false) {
  if (!splitMembers(t).length) return '';
  const s = settlement(t);
  const help = '在行程的花費下面、或購物清單的 ✎ 裡選「誰付的」，可以再勾哪些人分攤（沒改就是大家平分）。';
  if (!s.total) {
    return forStatic ? '' : `
      <section class="panel">
        <h3>🤝 分帳</h3>
        <p class="muted">${help}填好後這裡會算出誰該給誰多少，LINE 輸入「結算」也查得到。</p>
      </section>`;
  }
  return `
    <section class="panel"${forStatic ? ' id="settle"' : ''}>
      <h3>🤝 分帳<span class="muted shop-day-total">已填付款人 ${ntd(s.total)}</span></h3>
      <table class="table settle-table">
        <thead><tr><th>旅伴</th><th>付了</th><th>應分攤</th><th>差額</th></tr></thead>
        <tbody>${s.rows.map((p) => `<tr><td>${esc(personName(p))}</td><td>${ntd(p.paid)}</td><td>${ntd(p.share)}</td><td class="${p.net < -0.5 ? 'neg' : p.net > 0.5 ? 'pos' : ''}">${p.net > 0.5 ? '+' : ''}${ntd(p.net)}</td></tr>`).join('')}</tbody>
      </table>
      <div class="settle-transfers">
        ${s.transfers.length
          ? s.transfers.map((x) => `<div>💸 <b>${esc(personName(x.from))}</b> 付給 <b>${esc(personName(x.to))}</b> ${ntd(x.amount)}</div>`).join('')
          : '<div>大家都打平了 🎉</div>'}
      </div>
      ${s.unassigned ? `<p class="muted hint">※ 還有 ${s.unassigned} 筆花費沒填誰付的，沒有算進來。</p>` : ''}
      ${forStatic ? '' : `<p class="muted hint">${help}</p>`}
    </section>`;
}

// 行程卡片上的「誰付的」
function payerChip(t, a) {
  const ms = splitMembers(t);
  if (!ms.length || !a.paidBy || !(Number(a.cost) || Number(a.travelCost))) return '';
  const m = ms.find((x) => x.key === a.paidBy);
  const n = Array.isArray(a.splitWith) && a.splitWith.length ? a.splitWith.length : 0;
  return `<span class="payer-chip" title="${n ? `${n} 個人分攤` : '大家平分'}">👤 ${esc(m ? (m.me ? '我' : m.name) : '已退出的旅伴')}付${n && n < ms.length ? `・${n} 人分` : ''}</span>`;
}

// 購物卡片上的「誰付的」（有填才顯示）
function shopPayerChip(t, s) {
  const ms = splitMembers(t);
  if (!ms.length || !s.paidBy) return '';
  const m = ms.find((x) => x.key === s.paidBy);
  const n = Array.isArray(s.splitWith) && s.splitWith.length ? s.splitWith.length : 0;
  return `<span class="payer-chip" title="${n ? `${n} 個人分攤` : '大家平分'}">👤 ${esc(m ? (m.me ? '我' : m.name) : '已退出的旅伴')}付${n && n < ms.length ? `・${n} 人分` : ''}</span>`;
}

/* ---------- 行程與購物表單（form：哪一個表單；box／list：分帳區塊與分攤勾選的位置） ---------- */
function fillSplitFields(t, a, form = activityForm, boxSel = '#split-fields', listSel = '#split-with-list') {
  const box = $(boxSel);
  if (!box) return;
  const ms = splitMembers(t);
  box.hidden = !ms.length;
  if (!ms.length) return;
  const sel = form.elements.paidBy;
  sel.innerHTML = '<option value="">（還沒填）</option>'
    + ms.map((m) => `<option value="${esc(m.key)}">${esc(personName(m))}</option>`).join('')
    + (a && a.paidBy && !ms.some((m) => m.key === a.paidBy) ? `<option value="${esc(a.paidBy)}">已退出的旅伴</option>` : '');
  sel.value = (a && a.paidBy) || '';
  const chosen = new Set(a && Array.isArray(a.splitWith) ? a.splitWith : []);
  $(listSel).innerHTML = ms.map((m) => `
    <label class="chip-check"><input type="checkbox" name="splitWith" value="${esc(m.key)}" ${!chosen.size || chosen.has(m.key) ? 'checked' : ''}><span>${esc(m.me ? '我' : m.name)}</span></label>`).join('');
}

/** 表單裡的分帳欄位；沒顯示時（不是共用旅程）沿用原本的 */
function readSplitFields(t, prev, form = activityForm, boxSel = '#split-fields') {
  const ms = splitMembers(t);
  const box = $(boxSel);
  if (!ms.length || !box || box.hidden) {
    return { paidBy: (prev && prev.paidBy) || '', splitWith: (prev && prev.splitWith) || [] };
  }
  const checked = [...form.querySelectorAll('input[name="splitWith"]:checked')].map((x) => x.value);
  // 全部勾（或全部沒勾）＝大家平分，記成空的，之後加入的旅伴也算在內
  const all = !checked.length || ms.every((m) => checked.includes(m.key));
  return { paidBy: form.elements.paidBy.value || '', splitWith: all ? [] : checked };
}
