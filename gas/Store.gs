/* ============================================================
 * 資料存取：Google 試算表（每個工作表一種資料，全部以純文字格式儲存）
 *
 * 共用旅程：Trips.userId 是建立者（主人），其他旅伴記在 Members。
 * 主人與成員都能查看、編輯行程；只有主人能刪除旅程、移除成員。
 * 日誌以 tripId 歸屬到旅程，同旅程的成員都看得到。
 * ============================================================ */

const TABLES = {
  Trips: ['id', 'userId', 'name', 'destination', 'startDate', 'endDate', 'budget', 'currency', 'notes', 'packing', 'createdAt', 'updatedAt', 'inviteCode'],
  Activities: ['id', 'tripId', 'userId', 'date', 'time', 'title', 'category', 'location', 'cost', 'notes', 'mapUrl', 'endTime', 'travelMin'],
  Journal: ['id', 'userId', 'date', 'time', 'type', 'text', 'fileId', 'createdAt', 'tripId'],
  Members: ['tripId', 'userId', 'role', 'joinedAt'],
  Users: ['userId', 'name', 'updatedAt'],
};
const SCHEMA_VERSION = '3';
const CURRENCY_CODES = ['TWD', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'CNY', 'HKD', 'THB', 'SGD'];
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O、1/I/L

const tableCache_ = {};

function spreadsheet_() {
  return SpreadsheetApp.openById(prop_('SHEET_ID'));
}

function sheet_(name) {
  return spreadsheet_().getSheetByName(name);
}

/** 補上新版本需要的工作表與欄位（只在版本不同時執行一次） */
function ensureSchema_() {
  if (prop_('SCHEMA_VERSION') === SCHEMA_VERSION) return;
  withLock_(() => {
    if (prop_('SCHEMA_VERSION') === SCHEMA_VERSION) return;
    const ss = spreadsheet_();
    for (const [name, cols] of Object.entries(TABLES)) {
      const sh = ss.getSheetByName(name) || ss.insertSheet(name);
      sh.getRange('A:Z').setNumberFormat('@');
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // 舊日誌：依作者自己的旅程日期補上 tripId
    const trips = readTable_('Trips');
    const journal = readTable_('Journal');
    let changed = false;
    for (const j of journal) {
      if (j.tripId) continue;
      const t = trips.find((x) => x.userId === j.userId && x.startDate <= j.date && j.date <= x.endDate);
      if (t) { j.tripId = t.id; changed = true; }
    }
    if (changed) writeTable_('Journal', journal);
    PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
  });
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

let lockHeld_ = false;
function withLock_(fn) {
  if (lockHeld_) return fn(); // 已在鎖內（例如機器人事件中又呼叫需要鎖的函式）
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  lockHeld_ = true;
  try {
    return fn();
  } finally {
    lockHeld_ = false;
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
    endTime: /^\d{2}:\d{2}$/.test(a.time) && /^\d{2}:\d{2}$/.test(a.endTime) && a.endTime >= a.time ? a.endTime : '',
    travelMin: Math.min(1440, Math.max(0, Math.round(Number(a.travelMin) || 0))),
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

/* ---------- 使用者名稱 ---------- */
function userName_(userId) {
  const u = readTable_('Users').find((x) => x.userId === userId);
  return (u && u.name) || '旅伴';
}

function setUserName_(userId, name) {
  const clean = str_(name, 40).trim();
  if (!userId || !clean) return;
  const rows = readTable_('Users');
  const row = rows.find((x) => x.userId === userId);
  if (row && row.name === clean) return;
  if (row) {
    row.name = clean;
    row.updatedAt = String(Date.now());
    writeTable_('Users', rows);
  } else {
    appendRow_('Users', { userId, name: clean, updatedAt: String(Date.now()) });
  }
}

function hasUserName_(userId) {
  return readTable_('Users').some((x) => x.userId === userId && x.name);
}

/* ---------- 權限 ---------- */
function findTripRow_(tripId) {
  return readTable_('Trips').find((t) => t.id === tripId) || null;
}

function roleIn_(userId, tripRow) {
  if (!tripRow) return '';
  if (tripRow.userId === userId) return 'owner';
  const m = readTable_('Members').find((x) => x.tripId === tripRow.id && x.userId === userId);
  return m ? (m.role || 'editor') : '';
}

function tripIdsFor_(userId) {
  const ids = new Set(readTable_('Trips').filter((t) => t.userId === userId).map((t) => t.id));
  readTable_('Members').filter((m) => m.userId === userId).forEach((m) => ids.add(m.tripId));
  return ids;
}

function membersOf_(tripRow) {
  const list = [{ userId: tripRow.userId, name: userName_(tripRow.userId), role: 'owner' }];
  readTable_('Members')
    .filter((m) => m.tripId === tripRow.id && m.userId !== tripRow.userId)
    .forEach((m) => list.push({ userId: m.userId, name: userName_(m.userId), role: m.role || 'editor' }));
  return list;
}

/* ---------- 旅程 ---------- */
function rowToTrip_(row, acts, viewerId) {
  const days = {};
  for (const a of acts) {
    (days[a.date] = days[a.date] || []).push({
      id: a.id, time: a.time, endTime: a.endTime || '', travelMin: Number(a.travelMin) || 0, title: a.title, category: catKey_(a.category),
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
  const members = membersOf_(row);
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
    role: roleIn_(viewerId, row),
    members: members.map((m) => ({ name: m.name, role: m.role, me: m.userId === viewerId, id: m.userId === viewerId ? 'me' : memberKey_(row.id, m.userId) })),
  };
}

// 給網站用的成員代號（不直接外流 LINE userId）
function memberKey_(tripId, userId) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${tripId}:${userId}`);
  return Utilities.base64EncodeWebSafe(digest).slice(0, 12);
}

function loadTrips_(userId) {
  const ids = tripIdsFor_(userId);
  const acts = readTable_('Activities').filter((a) => ids.has(a.tripId));
  return readTable_('Trips')
    .filter((t) => ids.has(t.id))
    .map((t) => rowToTrip_(t, acts.filter((a) => a.tripId === t.id), userId))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** 覆寫整個旅程（含所有行程項目），回傳新的 updatedAt。主人與成員都可以 */
function saveTrip_(userId, trip) {
  const now = String(Date.now());
  const trips = readTable_('Trips');
  const existing = trips.find((t) => t.id === trip.id);
  if (existing && !roleIn_(userId, existing)) throw apiError_(403, '沒有權限修改這個旅程');
  const ownerId = existing ? existing.userId : userId;
  const row = {
    id: trip.id,
    userId: ownerId,
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
    inviteCode: existing ? existing.inviteCode : '',
  };
  writeTable_('Trips', existing ? trips.map((t) => (t.id === trip.id ? row : t)) : trips.concat([row]));

  const acts = readTable_('Activities').filter((a) => a.tripId !== trip.id);
  for (const [date, list] of Object.entries(trip.days || {})) {
    for (const a of list) {
      acts.push({
        id: a.id, tripId: trip.id, userId: ownerId, date, time: a.time || '', endTime: a.endTime || '', travelMin: Number(a.travelMin) || 0, title: a.title,
        category: catKey_(a.category), location: a.location || '', mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes || '',
      });
    }
  }
  writeTable_('Activities', acts);
  trip.updatedAt = now;
  return now;
}

/** 主人：刪除整個旅程；成員：退出旅程 */
function deleteTrip_(userId, tripId) {
  const row = findTripRow_(tripId);
  if (!row) return 'none';
  const role = roleIn_(userId, row);
  if (!role) throw apiError_(403, '沒有權限刪除這個旅程');
  if (role !== 'owner') {
    leaveTrip_(userId, tripId);
    return 'left';
  }
  writeTable_('Trips', readTable_('Trips').filter((t) => t.id !== tripId));
  writeTable_('Activities', readTable_('Activities').filter((a) => a.tripId !== tripId));
  writeTable_('Members', readTable_('Members').filter((m) => m.tripId !== tripId));
  return 'deleted';
}

/* ---------- 邀請與成員 ---------- */
function inviteCodeFor_(userId, tripId) {
  const trips = readTable_('Trips');
  const row = trips.find((t) => t.id === tripId);
  if (!roleIn_(userId, row)) throw apiError_(403, '沒有權限邀請旅伴');
  if (!row.inviteCode) {
    const used = new Set(trips.map((t) => t.inviteCode));
    let code;
    do {
      code = Array.from({ length: 6 }, () => INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]).join('');
    } while (used.has(code) || !/\d/.test(code) || !/[A-Z]/.test(code));
    row.inviteCode = code;
    writeTable_('Trips', trips);
  }
  return row.inviteCode;
}

/** @return {{trip: Object, already: boolean} | null} */
function joinTrip_(userId, code) {
  const row = readTable_('Trips').find((t) => t.inviteCode && t.inviteCode === String(code).toUpperCase());
  if (!row) return null;
  if (roleIn_(userId, row)) return { row, already: true };
  appendRow_('Members', { tripId: row.id, userId, role: 'editor', joinedAt: String(Date.now()) });
  return { row, already: false };
}

function leaveTrip_(userId, tripId) {
  writeTable_('Members', readTable_('Members').filter((m) => !(m.tripId === tripId && m.userId === userId)));
}

/** 主人移除成員；member 可以是 userId 或網站用的成員代號 */
function removeMember_(ownerId, tripId, member) {
  const row = findTripRow_(tripId);
  if (!row || row.userId !== ownerId) throw apiError_(403, '只有旅程主人可以移除成員');
  const rows = readTable_('Members');
  const target = rows.find((m) => m.tripId === tripId && (m.userId === member || memberKey_(tripId, m.userId) === member));
  if (!target) return null;
  writeTable_('Members', rows.filter((m) => m !== target));
  return target.userId;
}

/* ---------- 旅遊日誌 ---------- */
function loadJournal_(userId) {
  const ids = tripIdsFor_(userId);
  return readTable_('Journal')
    .filter((j) => j.userId === userId || (j.tripId && ids.has(j.tripId)))
    .map((j) => ({
      id: j.id, tripId: j.tripId, date: j.date, time: j.time, type: j.type, text: j.text, fileId: j.fileId,
      createdAt: Number(j.createdAt) || 0, author: userName_(j.userId), mine: j.userId === userId,
    }))
    .sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt));
}

function addJournal_(userId, entry) {
  const date = isValidDate_(entry.date) ? entry.date : todayStr_();
  let tripId = str_(entry.tripId, 64);
  if (tripId && !roleIn_(userId, findTripRow_(tripId))) tripId = '';
  if (!tripId) {
    const ids = tripIdsFor_(userId);
    const t = readTable_('Trips').find((x) => ids.has(x.id) && x.startDate <= date && date <= x.endDate);
    tripId = t ? t.id : '';
  }
  const row = {
    id: str_(entry.id, 64) || Utilities.getUuid(),
    userId,
    date,
    time: /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : nowTime_(),
    type: entry.type === 'image' ? 'image' : 'text',
    text: str_(entry.text, 2000),
    fileId: str_(entry.fileId, 100),
    createdAt: String(Date.now()),
    tripId,
  };
  appendRow_('Journal', row);
  return row;
}

/** 作者本人或旅程主人可以刪除 */
function deleteJournal_(userId, id) {
  const rows = readTable_('Journal');
  const row = rows.find((j) => j.id === id);
  if (!row) return null;
  const trip = row.tripId ? findTripRow_(row.tripId) : null;
  if (row.userId !== userId && !(trip && trip.userId === userId)) throw apiError_(403, '只能刪除自己寫的日誌');
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

function canSeeJournal_(userId, row) {
  return row.userId === userId || (row.tripId && tripIdsFor_(userId).has(row.tripId));
}

function apiError_(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
