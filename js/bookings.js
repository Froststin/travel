'use strict';

/* ============================================================
 * 住宿與交通資訊：航班、飯店、車票、租車……連同確認碼，整個旅程共用
 * booking = { id, type, title, date, endDate（住宿的退房日）, time, endTime, code, place, notes }
 * 「每日行程」最上面有一覽，當天的也會列在那天的標題下面（住宿從入住到退房每天都列）
 * 後端與 LINE 的寫法見 gas/Split.gs
 * ============================================================ */

const BOOKING_TYPES = {
  flight: { icon: '✈️', label: '航班', date: '出發日期', time: '起飛', endTime: '抵達', ph: '例如：CI154 桃園→關西' },
  stay: { icon: '🏨', label: '住宿', date: '入住日期', time: '入住時間', endTime: '退房時間', ph: '例如：京都站前飯店' },
  train: { icon: '🚄', label: '火車', date: '日期', time: '出發', endTime: '抵達', ph: '例如：新幹線 希望號 東京→京都' },
  bus: { icon: '🚌', label: '巴士', date: '日期', time: '出發', endTime: '抵達', ph: '例如：機場巴士 關西機場→京都站' },
  car: { icon: '🚗', label: '租車', date: '取車日期', time: '取車', endTime: '還車', ph: '例如：TOYOTA 租車 京都站前店' },
  ticket: { icon: '🎫', label: '票券', date: '日期', time: '入場', endTime: '結束', ph: '例如：USJ 門票、快速通關' },
  other: { icon: '📌', label: '其他', date: '日期', time: '開始', endTime: '結束', ph: '例如：保險、網卡' },
};
const MAX_BOOKINGS = 50;
const bookingDialog = $('#booking-dialog');
const bookingForm = $('#booking-form');
let editingBookingId = null;

const bookingType = (b) => BOOKING_TYPES[b.type] || BOOKING_TYPES.other;

function cleanBookings(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
  const time = (v) => (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');
  return list.filter((b) => b && typeof b.title === 'string' && b.title.trim()).slice(0, MAX_BOOKINGS).map((b) => {
    const date = DATE_RE.test(b.date || '') ? b.date : '';
    return {
      id: typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : uid(),
      type: Object.hasOwn(BOOKING_TYPES, b.type) ? b.type : 'other',
      title: str(b.title, 80),
      date,
      endDate: date && DATE_RE.test(b.endDate || '') && b.endDate >= date ? b.endDate : '',
      time: time(b.time),
      endTime: time(b.endTime),
      code: str(b.code, 40),
      place: str(b.place, 200),
      notes: str(b.notes, 300),
    };
  });
}

function sortedBookings(t) {
  return (t.bookings || []).slice().sort((a, b) => `${a.date || '9'}${a.time}`.localeCompare(`${b.date || '9'}${b.time}`));
}

// 這一天要知道的：住宿從入住到退房每天都列，其他只列當天
function bookingsOn(t, date) {
  return (t.bookings || [])
    .filter((b) => (b.type === 'stay' && b.date && b.endDate ? b.date <= date && date <= b.endDate : b.date === date))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

// 例如「✈️ 08:30→12:10 CI154」「🏨 入住 京都站前飯店 15:00」；date 空的話用一覽的寫法
function bookingText(b, date) {
  const { icon } = bookingType(b);
  if (b.type === 'stay') {
    if (date && date === b.endDate && date !== b.date) return `${icon} 退房 ${b.title}${b.endTime ? ` ${b.endTime}` : ''}`;
    if (date && date !== b.date) return `${icon} 住 ${b.title}`;
    return `${icon} 入住 ${b.title}${b.time ? ` ${b.time}` : ''}`;
  }
  return `${icon} ${b.time ? `${b.time}${b.endTime ? `→${b.endTime}` : ''} ` : ''}${b.title}`;
}

function bookingButton(b, date) {
  return `<button type="button" class="booking-line" data-action="edit-booking" data-id="${esc(b.id)}" title="點了可以修改">
    <span>${esc(bookingText(b, date))}</span>${b.code && (!date || date === b.date) ? `<span class="booking-code">${esc(b.code)}</span>` : ''}</button>`;
}

// 每日行程最上面：整趟的住宿與交通
function bookingsPanel(t) {
  const list = sortedBookings(t);
  if (!list.length) {
    return `<p class="bookings-empty no-print"><button type="button" class="btn btn-sm btn-ghost" data-action="add-booking" data-date="">🧾 ＋ 住宿／交通資訊</button><span class="muted">航班、飯店、確認碼記在這裡，當天會自動提醒</span></p>`;
  }
  return `
    <details class="bookings panel"${bookingsOpen() ? ' open' : ''}>
      <summary><span>🧾 住宿與交通</span><span class="muted">${list.length} 筆</span></summary>
      <ul class="bookings-list">${list.map((b) => `
        <li><span class="booking-date muted">${b.date ? prettyDate(b.date) : '未定'}${b.type === 'stay' && b.endDate ? `–${prettyDate(b.endDate)}` : ''}</span>${bookingButton(b, '')}</li>`).join('')}
      </ul>
      <button type="button" class="btn btn-sm no-print" data-action="add-booking" data-date="">＋ 新增</button>
    </details>`;
}

function bookingsOpen() {
  try {
    return localStorage.getItem('travel-planner:bookings-open') !== '0';
  } catch {
    return true;
  }
}

document.addEventListener('toggle', (e) => {
  if (!e.target.classList || !e.target.classList.contains('bookings')) return;
  try {
    localStorage.setItem('travel-planner:bookings-open', e.target.open ? '1' : '0');
  } catch { /* 忽略 */ }
}, true);

// 那天的標題下面
function dayBookings(t, d) {
  const list = bookingsOn(t, d);
  return list.length ? `<div class="day-bookings">${list.map((b) => bookingButton(b, d)).join('')}</div>` : '';
}

/* ---------- 表單 ---------- */
function updateBookingLabels() {
  const type = BOOKING_TYPES[bookingForm.elements.type.value] || BOOKING_TYPES.other;
  for (const el of bookingForm.querySelectorAll('[data-booking-label]')) el.textContent = type[el.dataset.bookingLabel];
  bookingForm.elements.title.placeholder = type.ph;
  $('#booking-end-wrap').hidden = bookingForm.elements.type.value !== 'stay';
}

function openBookingDialog(date, b) {
  const t = currentTrip();
  if (!t || !bookingForm) return toast('網頁有更新，請重新整理後再試一次');
  editingBookingId = b ? b.id : null;
  $('#booking-dialog-title').textContent = b ? '修改住宿／交通' : '新增住宿／交通';
  bookingForm.reset();
  const v = b || { type: 'flight', date: date || t.startDate };
  for (const k of ['type', 'title', 'date', 'endDate', 'time', 'endTime', 'code', 'place', 'notes']) bookingForm.elements[k].value = v[k] || '';
  bookingForm.elements.type.value = v.type || 'flight';
  $('#booking-delete').hidden = !b;
  updateBookingLabels();
  bookingDialog.showModal();
  if (!b) bookingForm.elements.title.focus();
}

if (bookingForm) {
  bookingForm.elements.type.innerHTML = Object.entries(BOOKING_TYPES).map(([k, x]) => `<option value="${k}">${x.icon} ${x.label}</option>`).join('');
  bookingForm.elements.type.addEventListener('change', () => {
    updateBookingLabels();
    // 住宿預設住到隔天
    const f = bookingForm.elements;
    if (f.type.value === 'stay' && f.date.value && !f.endDate.value) f.endDate.value = addDays(f.date.value, 1);
  });
  bookingForm.elements.date.addEventListener('change', () => {
    const f = bookingForm.elements;
    if (f.type.value === 'stay' && f.date.value && (!f.endDate.value || f.endDate.value < f.date.value)) f.endDate.value = addDays(f.date.value, 1);
  });
  bookingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = currentTrip();
    if (!t) return;
    const f = Object.fromEntries(new FormData(bookingForm));
    if (f.type !== 'stay') f.endDate = '';
    if (f.endDate && f.date && f.endDate < f.date) return toast('退房日期不能早於入住日期');
    const [b] = cleanBookings([{ ...f, id: editingBookingId || uid() }]);
    if (!b) return toast('請填寫名稱');
    t.bookings ||= [];
    if (!editingBookingId && t.bookings.length >= MAX_BOOKINGS) return toast(`住宿與交通最多 ${MAX_BOOKINGS} 筆`);
    const i = t.bookings.findIndex((x) => x.id === b.id);
    if (i >= 0) t.bookings[i] = b;
    else t.bookings.push(b);
    commitTrip(t);
    bookingDialog.close();
    toast(editingBookingId ? '已更新' : '已新增，那天的行程上面也會顯示');
    renderTrip(t);
  });
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const t = currentTrip();
  if (!t) return;
  if (el.dataset.action === 'add-booking') openBookingDialog(el.dataset.date || '', null);
  if (el.dataset.action === 'edit-booking') {
    const b = (t.bookings || []).find((x) => x.id === el.dataset.id);
    if (b) openBookingDialog('', b);
  }
  if (el.dataset.action === 'booking-dialog-delete') {
    const b = (t.bookings || []).find((x) => x.id === editingBookingId);
    if (!b) return;
    bookingDialog.close();
    withUndo(t, `已刪除「${b.title}」`, () => { t.bookings = t.bookings.filter((x) => x.id !== b.id); });
  }
});

/* ---------- 複製這天的行程到別天 ---------- */
const dayDialog = $('#day-dialog');
const dayForm = $('#day-form');
let copyDayFrom = '';

function openCopyDay(t, date) {
  if (!dayForm) return toast('網頁有更新，請重新整理後再試一次');
  copyDayFrom = date;
  const dates = dateRange(t.startDate, t.endDate);
  const n = (t.days[date] || []).length;
  $('#day-dialog-info').textContent = `Day ${dates.indexOf(date) + 1}・${prettyDate(date)} 的 ${n} 個行程（不含照片與分帳）`;
  dayForm.elements.date.innerHTML = dates.filter((d) => d !== date)
    .map((d) => `<option value="${d}">Day ${dates.indexOf(d) + 1}・${prettyDate(d)}${(t.days[d] || []).length ? `（已有 ${t.days[d].length} 個）` : ''}</option>`).join('');
  dayDialog.showModal();
}

dayForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = currentTrip();
  const to = dayForm.elements.date.value;
  if (!t || !to) return;
  const copies = (t.days[copyDayFrom] || []).map((a) => {
    const { fileId, image, paidBy, splitWith, ...rest } = a;
    return { ...rest, id: uid(), fileId: '' };
  });
  dayDialog.close();
  withUndo(t, `已複製 ${copies.length} 個行程到 ${prettyDate(to)}`, () => {
    t.days[to] = sortDay([...(t.days[to] || []), ...copies]);
  });
});
