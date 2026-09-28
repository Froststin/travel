/* ============================================================
 * 資料存取：Google 試算表（每個工作表一種資料，全部以純文字格式儲存）
 * ============================================================ */

const TABLES = {
  Trips: ['id', 'userId', 'name', 'destination', 'startDate', 'endDate', 'budget', 'currency', 'notes', 'packing', 'createdAt', 'updatedAt'],
  Activities: ['id', 'tripId', 'userId', 'date', 'time', 'title', 'category', 'location', 'cost', 'notes', 'mapUrl'],
  Journal: ['id', 'userId', 'date', 'time', 'type', 'text', 'fileId', 'createdAt'],
};
const CURRENCY_CODES = ['TWD', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'CNY', 'HKD', 'THB', 'SGD'];

const tableCache_ = {};

function sheet_(name) {
  return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName(name);
}

function readTable_(name) {
  if (tableCache_[name]) return tableCache_[name];
  const sh = sheet_(name);
  const cols = TABLES[name];
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, cols.length).getDisplayValues() : [];
  tableCache_[name] = rows
    .filter((r) => r[0])
    .map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  return tableCache_[name];
}

function toRow_(name, obj) {
  return TABLES[name].map((c) => (obj[c] == null ? '' : String(obj[c])));
}

function writeTable_(name, objs) {
  const sh = sheet_(name);
  const cols = TABLES[name];
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, cols.length).clearContent();
  if (objs.length) {
    sh.getRange(2, 1, objs.length, cols.length).setNumberFormat('@').setValues(objs.map((o) => toRow_(name, o)));
  }
  tableCache_[name] = objs;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, 1, TABLES[name].length).setNumberFormat('@').setValues([toRow_(name, obj)]);
  if (tableCache_[name]) tableCache_[name].push(obj);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 驗證／清理 ---------- */
function str_(v, max) {
  return typeof v === 'string' ? v.slice(0, max || 500) : '';
}

function sanitizeActivity_(a) {
  if (!a || typeof a.title !== 'string' || !a.title.trim()) return null;
  return {
    id: str_(a.id, 64) || Utilities.getUuid(),
    time: /^\d{2}:\d{2}$/.test(a.time) ? a.time : '',
    title: str_(a.title, 100),
    category: catKey_(a.category),
    location: str_(a.location, 200),
    mapUrl: cleanUrl_(a.mapUrl),
    cost: Math.max(0, Number(a.cost) || 0),
    notes: str_(a.notes),
  };
}

function sanitizeTrip_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isValidDate_(raw.startDate) || !isValidDate_(raw.endDate) || raw.endDate < raw.startDate) return null;
  if (daysBetween_(raw.startDate, raw.endDate) + 1 > 60) return null;
  const valid = new Set(dateRange_(raw.startDate, raw.endDate));
  const days = {};
  for (const [d, list] of Object.entries(raw.days || {})) {
    if (!valid.has(d) || !Array.isArray(list)) continue;
    const clean = list.map(sanitizeActivity_).filter(Boolean);
    if (clean.length) days[d] = sortDay_(clean);
  }
  const packing = Array.isArray(raw.packing)
    ? raw.packing
      .filter((p) => p && typeof p.text === 'string')
      .slice(0, 300)
      .map((p) => ({ id: str_(p.id, 64) || Utilities.getUuid(), text: str_(p.text, 80), done: !!p.done }))
    : [];
  return {
    id: str_(raw.id, 64) || Utilities.getUuid(),
    name: str_(raw.name, 60) || '未命名旅程',
    destination: str_(raw.destination, 60),
    startDate: raw.startDate,
    endDate: raw.endDate,
    budget: Math.max(0, Number(raw.budget) || 0),
    currency: CURRENCY_CODES.includes(raw.currency) ? raw.currency : 'TWD',
    notes: str_(raw.notes),
    days,
    packing,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/* ---------- 旅程 ---------- */
function rowToTrip_(row, acts) {
  const days = {};
  for (const a of acts) {
    (days[a.date] = days[a.date] || []).push({
      id: a.id, time: a.time, title: a.title, category: catKey_(a.category),
      location: a.location, mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes,
    });
  }
  Object.values(days).forEach(sortDay_);
  let packing = [];
  try {
    packing = JSON.parse(row.packing || '[]');
  } catch (err) {
    packing = [];
  }
  return {
    id: row.id,
    name: row.name,
    destination: row.destination,
    startDate: row.startDate,
    endDate: row.endDate,
    budget: Number(row.budget) || 0,
    currency: row.currency || 'TWD',
    notes: row.notes,
    days,
    packing,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: row.updatedAt,
  };
}

function loadTrips_(userId) {
  const acts = readTable_('Activities').filter((a) => a.userId === userId);
  return readTable_('Trips')
    .filter((t) => t.userId === userId)
    .map((t) => rowToTrip_(t, acts.filter((a) => a.tripId === t.id)))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function findTripRow_(tripId) {
  return readTable_('Trips').find((t) => t.id === tripId) || null;
}

/** 覆寫整個旅程（含所有行程項目），回傳新的 updatedAt。呼叫前須已取得 lock 並確認擁有者 */
function saveTrip_(userId, trip) {
  const now = String(Date.now());
  const trips = readTable_('Trips');
  const existing = trips.find((t) => t.id === trip.id);
  if (existing && existing.userId !== userId) throw apiError_(403, '沒有權限修改這個旅程');
  const row = {
    id: trip.id,
    userId,
    name: trip.name,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    budget: trip.budget,
    currency: trip.currency,
    notes: trip.notes,
    packing: JSON.stringify(trip.packing || []),
    createdAt: existing ? existing.createdAt : String(trip.createdAt || now),
    updatedAt: now,
  };
  writeTable_('Trips', existing ? trips.map((t) => (t.id === trip.id ? row : t)) : trips.concat([row]));

  const acts = readTable_('Activities').filter((a) => a.tripId !== trip.id);
  for (const [date, list] of Object.entries(trip.days || {})) {
    for (const a of list) {
      acts.push({
        id: a.id, tripId: trip.id, userId, date, time: a.time || '', title: a.title,
        category: catKey_(a.category), location: a.location || '', mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes || '',
      });
    }
  }
  writeTable_('Activities', acts);
  trip.updatedAt = now;
  return now;
}

function deleteTrip_(userId, tripId) {
  const row = findTripRow_(tripId);
  if (!row) return;
  if (row.userId !== userId) throw apiError_(403, '沒有權限刪除這個旅程');
  writeTable_('Trips', readTable_('Trips').filter((t) => t.id !== tripId));
  writeTable_('Activities', readTable_('Activities').filter((a) => a.tripId !== tripId));
}

/* ---------- 旅遊日誌 ---------- */
function loadJournal_(userId) {
  return readTable_('Journal')
    .filter((j) => j.userId === userId)
    .map((j) => ({ id: j.id, date: j.date, time: j.time, type: j.type, text: j.text, fileId: j.fileId, createdAt: Number(j.createdAt) || 0 }))
    .sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt));
}

function addJournal_(userId, entry) {
  const row = {
    id: str_(entry.id, 64) || Utilities.getUuid(),
    userId,
    date: isValidDate_(entry.date) ? entry.date : todayStr_(),
    time: /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : nowTime_(),
    type: entry.type === 'image' ? 'image' : 'text',
    text: str_(entry.text, 2000),
    fileId: str_(entry.fileId, 100),
    createdAt: String(Date.now()),
  };
  appendRow_('Journal', row);
  return row;
}

function deleteJournal_(userId, id) {
  const rows = readTable_('Journal');
  const row = rows.find((j) => j.id === id);
  if (!row) return null;
  if (row.userId !== userId) throw apiError_(403, '沒有權限刪除這則日誌');
  writeTable_('Journal', rows.filter((j) => j.id !== id));
  if (row.fileId) {
    try {
      DriveApp.getFileById(row.fileId).setTrashed(true);
    } catch (err) {
      console.warn('刪除照片失敗', err);
    }
  }
  return row;
}

function apiError_(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
