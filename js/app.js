'use strict';

/* ============================================================
 * 旅程手帖：純前端旅遊行程規劃
 * 資料結構（存在 localStorage）：
 *   { trips: [ { id, name, destination, startDate, endDate, budget, currency, notes,
 *                days: { 'YYYY-MM-DD': [activity] }, packing: [{ id, text, done }], createdAt } ] }
 *   activity = { id, time, title, category, location, cost, notes }
 * ============================================================ */

const STORAGE_KEY = 'travel-planner:v1';
const MAX_DAYS = 60;
const CURRENCIES = ['TWD', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'CNY', 'HKD', 'THB', 'SGD'];
const CATEGORIES = {
  sight: { label: '景點', icon: '🏞️' },
  food: { label: '餐飲', icon: '🍜' },
  transport: { label: '交通', icon: '🚆' },
  stay: { label: '住宿', icon: '🏨' },
  shopping: { label: '購物', icon: '🛍️' },
  other: { label: '其他', icon: '📌' },
};
const PACKING_PRESET = [
  '護照／身分證', '機票／車票', '錢包、信用卡、外幣', '手機與充電器', '行動電源',
  '轉接頭', '換洗衣物', '盥洗用品', '常備藥品', '雨具',
];
const WEEKDAYS = '日一二三四五六';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const tripDialog = $('#trip-dialog');
const tripForm = $('#trip-form');
const activityDialog = $('#activity-dialog');
const activityForm = $('#activity-form');
const importFile = $('#import-file');

let state = loadState();
let currentTripId = null;
let currentTab = 'plan';
let editingTripId = null;       // null = 新增旅程
let editingActivity = null;     // { date, id } 或 null = 新增項目

/* ---------- 儲存 ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.trips)) return data;
    }
  } catch (err) {
    console.warn('讀取資料失敗', err);
  }
  return { trips: [] };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('無法儲存到瀏覽器，請確認沒有使用無痕模式或空間已滿');
  }
}

/* ---------- 工具 ---------- */
function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function dateRange(start, end) {
  const out = [];
  const d = parseDate(start);
  const last = parseDate(end);
  while (d <= last && out.length <= MAX_DAYS) {
    out.push(fmtDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function prettyDate(s) {
  const d = parseDate(s);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

function money(n, currency) {
  try {
    return new Intl.NumberFormat('zh-TW', {
      style: 'currency', currency: currency || 'TWD', maximumFractionDigits: 2, minimumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

function mapUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function catKey(a) {
  return Object.hasOwn(CATEGORIES, a.category) ? a.category : 'other';
}

function sortDay(list) {
  // 有時間的依時間排序，沒填時間的排最後（保持原順序）
  return list.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

function sumCost(list) {
  return list.reduce((s, a) => s + (Number(a.cost) || 0), 0);
}

function allActivities(t) {
  return dateRange(t.startDate, t.endDate).flatMap((d) => t.days[d] || []);
}

function getTrip(id) {
  return state.trips.find((t) => t.id === id);
}

function currentTrip() {
  return getTrip(currentTripId);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 路由 ---------- */
function route() {
  const m = location.hash.match(/^#\/trip\/([\w-]+)/);
  if (m) {
    const trip = getTrip(m[1]);
    if (trip) {
      if (currentTripId !== trip.id) currentTab = 'plan';
      currentTripId = trip.id;
      renderTrip(trip);
      return;
    }
    location.hash = '#/';
    return;
  }
  currentTripId = null;
  renderHome();
}

/* ---------- 首頁 ---------- */
function renderHome() {
  document.title = '旅程手帖';
  if (!state.trips.length) {
    app.innerHTML = `
      <section class="empty">
        <div class="empty-icon" aria-hidden="true">🗺️</div>
        <h1>開始規劃你的下一趟旅程</h1>
        <p class="muted">建立旅程後，就能安排每日行程、掌握預算、準備行李清單。</p>
        <div class="btns">
          <button class="btn btn-primary" data-action="new-trip">＋ 新增旅程</button>
          <button class="btn" data-action="load-sample">載入範例行程</button>
        </div>
      </section>`;
    return;
  }
  const trips = [...state.trips].sort((a, b) => a.startDate.localeCompare(b.startDate));
  app.innerHTML = `
    <div class="page-head">
      <h1>我的旅程</h1>
      <span class="muted">共 ${trips.length} 個</span>
    </div>
    <div class="trip-grid">${trips.map(tripCard).join('')}</div>`;
}

function tripStatus(t) {
  const today = fmtDate(new Date());
  if (today < t.startDate) {
    const diff = daysBetween(today, t.startDate);
    return { kind: 'upcoming', text: diff === 1 ? '明天出發' : `${diff} 天後出發` };
  }
  if (today > t.endDate) return { kind: 'past', text: '已結束' };
  return { kind: 'ongoing', text: '旅行中' };
}

function durationText(n) {
  return n > 1 ? `${n} 天 ${n - 1} 夜` : '一日遊';
}

function tripCard(t) {
  const days = dateRange(t.startDate, t.endDate).length;
  const count = allActivities(t).length;
  const status = tripStatus(t);
  return `
    <a class="trip-card" href="#/trip/${t.id}">
      <span class="badge badge-${status.kind}">${status.text}</span>
      <h2>${esc(t.name)}</h2>
      <p class="muted">📍 ${esc(t.destination || '未設定目的地')}</p>
      <p class="muted">🗓️ ${prettyDate(t.startDate)} – ${prettyDate(t.endDate)}・${durationText(days)}</p>
      <p class="muted">📝 ${count} 個行程項目</p>
    </a>`;
}

/* ---------- 旅程頁 ---------- */
function renderTrip(t) {
  document.title = `${t.name}｜旅程手帖`;
  const dates = dateRange(t.startDate, t.endDate);
  const tab = (key, label) =>
    `<button class="tab" role="tab" aria-selected="${currentTab === key}" data-action="tab" data-tab="${key}">${label}</button>`;
  let body;
  if (currentTab === 'budget') body = budgetView(t, dates);
  else if (currentTab === 'packing') body = packingView(t);
  else body = planView(t, dates);

  app.innerHTML = `
    <a href="#/" class="back no-print">← 所有旅程</a>
    <div class="trip-title">
      <div>
        <h1>${esc(t.name)}</h1>
        <p class="muted">📍 ${esc(t.destination || '未設定目的地')}・${prettyDate(t.startDate)} – ${prettyDate(t.endDate)}・${durationText(dates.length)}</p>
        ${t.notes ? `<p class="trip-notes">${esc(t.notes)}</p>` : ''}
      </div>
      <div class="actions no-print">
        <button class="btn btn-line" data-action="share-line">分享到 LINE</button>
        <button class="btn" data-action="edit-trip">編輯</button>
        <button class="btn" data-action="export-trip">匯出</button>
        <button class="btn" data-action="print">列印</button>
        <button class="btn btn-danger" data-action="delete-trip">刪除</button>
      </div>
    </div>
    <nav class="tabs no-print" role="tablist">
      ${tab('plan', '🗓️ 每日行程')}${tab('budget', '💰 預算')}${tab('packing', '🧳 行李清單')}
    </nav>
    ${body}`;
}

function planView(t, dates) {
  const nav = dates.length > 3
    ? `<nav class="day-nav no-print">${dates.map((d, i) => `<a href="#day-${d}" data-action="jump" data-date="${d}">Day ${i + 1}</a>`).join('')}</nav>`
    : '';
  const days = dates.map((d, i) => {
    const list = t.days[d] || [];
    const total = sumCost(list);
    return `
      <section class="day" id="day-${d}">
        <header class="day-head">
          <div>
            <span class="day-no">DAY ${i + 1}</span>
            <h3>${prettyDate(d)}</h3>
          </div>
          <div class="day-meta">
            ${total ? `<span class="muted">${money(total, t.currency)}</span>` : ''}
            <button class="btn btn-sm btn-line no-print" data-action="share-day" data-date="${d}" title="把這天的行程分享到 LINE">LINE</button>
            <button class="btn btn-sm no-print" data-action="add-activity" data-date="${d}">＋ 新增</button>
          </div>
        </header>
        ${list.length
          ? `<ol class="timeline">${list.map((a) => activityItem(a, d, t.currency)).join('')}</ol>`
          : '<p class="day-empty muted">還沒有安排，點「新增」加入第一個行程。</p>'}
      </section>`;
  }).join('');
  return `${nav}<div class="days">${days}</div>`;
}

function activityItem(a, date, currency) {
  const key = catKey(a);
  const c = CATEGORIES[key];
  return `
    <li class="activity cat-${key}">
      <div class="act-time">${a.time ? esc(a.time) : '—'}</div>
      <div class="act-body">
        <div class="act-title"><span aria-hidden="true">${c.icon}</span>${esc(a.title)}<span class="chip">${c.label}</span></div>
        ${a.location ? `<a class="act-loc" href="${mapUrl(a.location)}" target="_blank" rel="noopener">📍 ${esc(a.location)}</a>` : ''}
        ${a.notes ? `<p class="act-notes">${esc(a.notes)}</p>` : ''}
      </div>
      <div class="act-side">
        ${a.cost ? `<span class="act-cost">${money(a.cost, currency)}</span>` : ''}
        <div class="act-actions no-print">
          <button class="icon-btn" data-action="edit-activity" data-date="${date}" data-id="${a.id}" title="編輯" aria-label="編輯">✎</button>
          <button class="icon-btn" data-action="delete-activity" data-date="${date}" data-id="${a.id}" title="刪除" aria-label="刪除">✕</button>
        </div>
      </div>
    </li>`;
}

function budgetView(t, dates) {
  const all = allActivities(t);
  const spent = sumCost(all);
  const budget = Number(t.budget) || 0;
  const remain = budget - spent;
  const over = budget > 0 && remain < 0;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;

  const byCat = Object.entries(CATEGORIES)
    .map(([k, c]) => ({ ...c, sum: sumCost(all.filter((a) => catKey(a) === k)), key: k }))
    .filter((x) => x.sum > 0)
    .sort((a, b) => b.sum - a.sum);
  const maxCat = Math.max(1, ...byCat.map((x) => x.sum));

  return `
    <div class="stats">
      <div class="stat"><div class="label">總預算</div><div class="value">${budget ? money(budget, t.currency) : '未設定'}</div></div>
      <div class="stat"><div class="label">預估花費</div><div class="value">${money(spent, t.currency)}</div></div>
      <div class="stat">
        <div class="label">${over ? '超出預算' : '剩餘'}</div>
        <div class="value ${over ? 'over' : ''}">${budget ? money(Math.abs(remain), t.currency) : '—'}</div>
      </div>
    </div>
    ${budget ? `
      <section class="panel">
        <h3>預算使用率 ${Math.round((spent / budget) * 100)}%</h3>
        <div class="progress ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div>
      </section>` : ''}
    <section class="panel">
      <h3>分類花費</h3>
      ${byCat.length ? byCat.map((x) => `
        <div class="bar-row">
          <span>${x.icon} ${x.label}</span>
          <div class="progress"><span style="width:${(x.sum / maxCat) * 100}%;background:var(--cat-${x.key})"></span></div>
          <span class="amount">${money(x.sum, t.currency)}</span>
        </div>`).join('') : '<p class="muted">行程項目還沒有填寫花費。</p>'}
    </section>
    <section class="panel">
      <h3>每日花費</h3>
      <table class="table">
        <thead><tr><th>日期</th><th>項目數</th><th>花費</th></tr></thead>
        <tbody>
          ${dates.map((d, i) => {
            const list = t.days[d] || [];
            return `<tr><td>Day ${i + 1}・${prettyDate(d)}</td><td>${list.length}</td><td>${money(sumCost(list), t.currency)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </section>`;
}

function packingView(t) {
  const items = t.packing || [];
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? (done / items.length) * 100 : 0;
  return `
    <section class="panel">
      <form id="packing-form" class="packing-form no-print">
        <input name="text" placeholder="新增物品，例如：相機" maxlength="80" required aria-label="物品名稱">
        <button type="submit" class="btn btn-primary">加入</button>
      </form>
      <div class="packing-summary">已準備 ${done} / ${items.length}</div>
      <div class="progress" style="margin-bottom:16px"><span style="width:${pct}%"></span></div>
      ${items.length ? `
        <ul class="packing-list">
          ${items.map((i) => `
            <li class="${i.done ? 'done' : ''}">
              <label><input type="checkbox" data-action="toggle-pack" data-id="${i.id}" ${i.done ? 'checked' : ''}><span>${esc(i.text)}</span></label>
              <button class="icon-btn no-print" data-action="delete-pack" data-id="${i.id}" title="刪除" aria-label="刪除">✕</button>
            </li>`).join('')}
        </ul>` : '<p class="muted">清單是空的，可以自己新增，或加入常用物品。</p>'}
      <button class="btn no-print" data-action="pack-preset">＋ 加入常用物品</button>
    </section>`;
}

/* ---------- 表單：旅程 ---------- */
function openTripDialog(trip) {
  editingTripId = trip ? trip.id : null;
  $('#trip-dialog-title').textContent = trip ? '編輯旅程' : '新增旅程';
  tripForm.reset();
  const today = fmtDate(new Date());
  const values = trip || {
    name: '', destination: '', startDate: addDays(today, 7), endDate: addDays(today, 9),
    budget: '', currency: 'TWD', notes: '',
  };
  for (const key of ['name', 'destination', 'startDate', 'endDate', 'budget', 'currency', 'notes']) {
    tripForm.elements[key].value = values[key] || (key === 'currency' ? 'TWD' : '');
  }
  tripDialog.showModal();
}

tripForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(tripForm);
  const data = {
    name: f.get('name').trim(),
    destination: f.get('destination').trim(),
    startDate: f.get('startDate'),
    endDate: f.get('endDate'),
    budget: Math.max(0, Number(f.get('budget')) || 0),
    currency: f.get('currency'),
    notes: f.get('notes').trim(),
  };
  if (!data.name) return toast('請填寫旅程名稱');
  if (data.endDate < data.startDate) return toast('回程日期不能早於出發日期');
  if (daysBetween(data.startDate, data.endDate) + 1 > MAX_DAYS) return toast(`單一旅程最長 ${MAX_DAYS} 天`);

  if (editingTripId) {
    const t = getTrip(editingTripId);
    const valid = new Set(dateRange(data.startDate, data.endDate));
    const orphans = Object.keys(t.days).filter((d) => !valid.has(d) && t.days[d].length);
    if (orphans.length) {
      const n = orphans.reduce((s, d) => s + t.days[d].length, 0);
      if (!confirm(`新的日期範圍外還有 ${n} 個行程項目，儲存後會被刪除，確定要繼續嗎？`)) return;
    }
    for (const d of Object.keys(t.days)) if (!valid.has(d)) delete t.days[d];
    Object.assign(t, data);
    saveState();
    tripDialog.close();
    toast('旅程已更新');
    route();
  } else {
    const t = { id: uid(), ...data, days: {}, packing: [], createdAt: Date.now() };
    state.trips.push(t);
    saveState();
    tripDialog.close();
    toast('旅程已建立');
    location.hash = `#/trip/${t.id}`;
  }
});

/* ---------- 表單：行程項目 ---------- */
function openActivityDialog(date, activity) {
  const t = currentTrip();
  if (!t) return;
  editingActivity = activity ? { date, id: activity.id } : null;
  $('#activity-dialog-title').textContent = activity ? '編輯行程' : '新增行程';
  activityForm.reset();
  activityForm.elements.date.innerHTML = dateRange(t.startDate, t.endDate)
    .map((d, i) => `<option value="${d}">Day ${i + 1}・${prettyDate(d)}</option>`).join('');
  const a = activity || { title: '', time: '', category: 'sight', location: '', cost: '', notes: '' };
  activityForm.elements.date.value = date;
  activityForm.elements.title.value = a.title;
  activityForm.elements.time.value = a.time || '';
  activityForm.elements.category.value = catKey(a);
  activityForm.elements.location.value = a.location || '';
  activityForm.elements.cost.value = a.cost || '';
  activityForm.elements.notes.value = a.notes || '';
  activityDialog.showModal();
  activityForm.elements.title.focus();
}

activityForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = currentTrip();
  if (!t) return;
  const f = new FormData(activityForm);
  const date = f.get('date');
  const activity = {
    id: editingActivity ? editingActivity.id : uid(),
    time: f.get('time') || '',
    title: f.get('title').trim(),
    category: f.get('category'),
    location: f.get('location').trim(),
    cost: Math.max(0, Number(f.get('cost')) || 0),
    notes: f.get('notes').trim(),
  };
  if (!activity.title) return toast('請填寫標題');

  if (editingActivity) {
    const old = editingActivity.date;
    t.days[old] = (t.days[old] || []).filter((x) => x.id !== activity.id);
  }
  (t.days[date] ||= []).push(activity);
  sortDay(t.days[date]);
  saveState();
  activityDialog.close();
  toast(editingActivity ? '行程已更新' : '行程已新增');
  renderTrip(t);
});

/* ---------- 匯入／匯出 ---------- */
function normalizeTrip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !DATE_RE.test(raw.startDate) || !DATE_RE.test(raw.endDate)) return null;
  if (raw.endDate < raw.startDate || daysBetween(raw.startDate, raw.endDate) + 1 > MAX_DAYS) return null;
  const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

  const days = {};
  if (raw.days && typeof raw.days === 'object') {
    for (const [d, list] of Object.entries(raw.days)) {
      if (!DATE_RE.test(d) || !Array.isArray(list)) continue;
      days[d] = sortDay(list
        .filter((a) => a && typeof a.title === 'string')
        .map((a) => ({
          id: uid(),
          time: /^\d{2}:\d{2}$/.test(a.time) ? a.time : '',
          title: str(a.title, 100),
          category: catKey(a),
          location: str(a.location, 200),
          cost: Math.max(0, Number(a.cost) || 0),
          notes: str(a.notes),
        })));
    }
  }
  const packing = Array.isArray(raw.packing)
    ? raw.packing.filter((p) => p && typeof p.text === 'string').map((p) => ({ id: uid(), text: str(p.text, 80), done: !!p.done }))
    : [];
  return {
    id: uid(),
    name: str(raw.name, 60) || '未命名旅程',
    destination: str(raw.destination, 60),
    startDate: raw.startDate,
    endDate: raw.endDate,
    budget: Math.max(0, Number(raw.budget) || 0),
    currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'TWD',
    notes: str(raw.notes),
    days,
    packing,
    createdAt: Date.now(),
  };
}

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data?.trips) ? data.trips : [data];
    const trips = list.map(normalizeTrip).filter(Boolean);
    if (!trips.length) return toast('檔案裡沒有可匯入的旅程');
    state.trips.push(...trips);
    saveState();
    toast(`已匯入 ${trips.length} 個旅程`);
    location.hash = trips.length === 1 ? `#/trip/${trips[0].id}` : '#/';
    route();
  } catch {
    toast('匯入失敗：檔案不是有效的 JSON');
  }
});

/* ---------- 範例資料 ---------- */
function buildSampleTrip() {
  const start = addDays(fmtDate(new Date()), 30);
  const d = (n) => addDays(start, n);
  const act = (time, title, category, location, cost, notes = '') =>
    ({ id: uid(), time, title, category, location, cost, notes });
  return {
    id: uid(),
    name: '京都三日小旅行',
    destination: '日本京都',
    startDate: start,
    endDate: d(2),
    budget: 30000,
    currency: 'TWD',
    notes: '住宿：京都車站附近商務旅館（已付款）',
    days: {
      [d(0)]: [
        act('09:30', '桃園機場出發', 'transport', '桃園國際機場', 8500, '記得提早 2 小時報到'),
        act('14:00', 'HARUKA 前往京都', 'transport', '關西國際機場', 900),
        act('16:00', '飯店 Check-in', 'stay', '京都車站', 4200),
        act('18:30', '晚餐：拉麵小路', 'food', '京都拉麵小路', 350),
      ],
      [d(1)]: [
        act('08:00', '清水寺', 'sight', '清水寺', 110, '早點去人比較少'),
        act('10:30', '二年坂・三年坂散步', 'sight', '三年坂', 0),
        act('12:30', '午餐：湯豆腐', 'food', '南禪寺 順正', 900),
        act('15:00', '伏見稻荷大社', 'sight', '伏見稻荷大社', 0, '千本鳥居，預留 2 小時'),
        act('19:00', '錦市場晚餐', 'food', '錦市場', 600),
      ],
      [d(2)]: [
        act('09:00', '嵐山竹林小徑', 'sight', '嵐山竹林小徑', 0),
        act('11:30', '買伴手禮', 'shopping', '京都車站', 2000),
        act('15:00', '返程', 'transport', '關西國際機場', 900),
      ],
    },
    packing: PACKING_PRESET.map((text, i) => ({ id: uid(), text, done: i < 3 })),
    createdAt: Date.now(),
  };
}

/* ---------- 事件委派 ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;
  const t = currentTrip();

  switch (action) {
    case 'new-trip':
      openTripDialog(null);
      break;
    case 'load-sample': {
      const sample = buildSampleTrip();
      state.trips.push(sample);
      saveState();
      location.hash = `#/trip/${sample.id}`;
      break;
    }
    case 'close-dialog':
      el.closest('dialog').close();
      break;
    case 'import':
      importFile.click();
      break;
    case 'export-all':
      if (!state.trips.length) return toast('目前沒有旅程可以匯出');
      download(`travel-backup-${fmtDate(new Date())}.json`, state);
      break;
    case 'tab':
      currentTab = el.dataset.tab;
      if (t) renderTrip(t);
      break;
    case 'jump':
      e.preventDefault();
      document.getElementById(`day-${el.dataset.date}`)?.scrollIntoView({ behavior: 'smooth' });
      break;
    case 'edit-trip':
      if (t) openTripDialog(t);
      break;
    case 'share-line':
      if (t) shareToLine(t, dateRange(t.startDate, t.endDate));
      break;
    case 'share-day':
      if (t) shareToLine(t, [el.dataset.date]);
      break;
    case 'export-trip':
      if (t) download(`${t.name}.json`, t);
      break;
    case 'print':
      if (!t) break;
      currentTab = 'plan';
      renderTrip(t);
      window.print();
      break;
    case 'delete-trip':
      if (t && confirm(`確定要刪除「${t.name}」嗎？此動作無法復原。`)) {
        state.trips = state.trips.filter((x) => x.id !== t.id);
        saveState();
        toast('旅程已刪除');
        location.hash = '#/';
      }
      break;
    case 'add-activity':
      openActivityDialog(el.dataset.date, null);
      break;
    case 'edit-activity': {
      const a = t?.days[el.dataset.date]?.find((x) => x.id === el.dataset.id);
      if (a) openActivityDialog(el.dataset.date, a);
      break;
    }
    case 'delete-activity': {
      const list = t?.days[el.dataset.date];
      const a = list?.find((x) => x.id === el.dataset.id);
      if (a && confirm(`刪除「${a.title}」？`)) {
        t.days[el.dataset.date] = list.filter((x) => x.id !== a.id);
        saveState();
        renderTrip(t);
      }
      break;
    }
    case 'toggle-pack': {
      const item = t?.packing.find((x) => x.id === el.dataset.id);
      if (item) {
        item.done = el.checked;
        saveState();
        renderTrip(t);
      }
      break;
    }
    case 'delete-pack':
      if (t) {
        t.packing = t.packing.filter((x) => x.id !== el.dataset.id);
        saveState();
        renderTrip(t);
      }
      break;
    case 'pack-preset':
      if (t) {
        const existing = new Set(t.packing.map((x) => x.text));
        const added = PACKING_PRESET.filter((text) => !existing.has(text));
        t.packing.push(...added.map((text) => ({ id: uid(), text, done: false })));
        saveState();
        renderTrip(t);
        toast(added.length ? `已加入 ${added.length} 項常用物品` : '常用物品都已經在清單裡了');
      }
      break;
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'packing-form') return;
  e.preventDefault();
  const t = currentTrip();
  const text = e.target.elements.namedItem('text').value.trim();
  if (!t || !text) return;
  t.packing.push({ id: uid(), text: text.slice(0, 80), done: false });
  saveState();
  renderTrip(t);
  $('#packing-form input').focus();
});

// 點對話框外圍（backdrop）時關閉
for (const dlg of [tripDialog, activityDialog]) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

/* ---------- 初始化 ---------- */
function fillSelects() {
  tripForm.elements.currency.innerHTML = CURRENCIES.map((c) => `<option value="${c}">${c}</option>`).join('');
  activityForm.elements.category.innerHTML = Object.entries(CATEGORIES)
    .map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`).join('');
}

fillSelects();
window.addEventListener('hashchange', route);
route();
