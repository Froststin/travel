/* ============================================================
 * 資料存取：Google 試算表（每個工作表一種資料，全部以純文字格式儲存）
 *
 * 共用旅程：Trips.userId 是建立者（主人），其他旅伴記在 Members。
 * 主人與成員都能查看、編輯行程；只有主人能刪除旅程、移除成員。
 * 日誌以 tripId 歸屬到旅程，同旅程的成員都看得到。
 * 購物清單是個人的：Shopping 每一列記 tripId＋userId，每個人只讀寫自己的，旅伴互相看不到。
 * ============================================================ */

const TABLES = {
  Trips: ['id', 'userId', 'name', 'destination', 'startDate', 'endDate', 'budget', 'currency', 'notes', 'packing', 'createdAt', 'updatedAt', 'inviteCode', 'shopping', 'places'],
  Activities: ['id', 'tripId', 'userId', 'date', 'time', 'title', 'category', 'location', 'cost', 'notes', 'mapUrl', 'endTime', 'travelMin', 'travelMode', 'travelCost', 'travelCostCurrency'],
  Journal: ['id', 'userId', 'date', 'time', 'type', 'text', 'fileId', 'createdAt', 'tripId'],
  Members: ['tripId', 'userId', 'role', 'joinedAt'],
  Users: ['userId', 'name', 'updatedAt'],
  Shopping: ['id', 'tripId', 'userId', 'text', 'date', 'activityId', 'price', 'done', 'note', 'fileId'],
};
const SCHEMA_VERSION = '9';
const CURRENCY_CODES = ['TWD', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'CNY', 'HKD', 'THB', 'SGD'];
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O、1/I/L

const MAX_SHOPPING = 200; // 每個旅程的購物清單上限
const MAX_PLACES = 100; // 每個旅程的待去清單上限
const MAX_BLANK_ROWS = 100; // 中間的空列超過這個數量就整理一次

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
    // 舊版購物清單存在 Trips.shopping（整個旅程共用）：搬到 Shopping，歸給旅程主人
    const shop = readTable_('Shopping');
    const have = new Set(shop.map((s) => `${s.tripId}:${s.id}`));
    const moved = [];
    for (const t of trips) {
      if (!t.shopping) continue;
      let items = [];
      try {
        items = JSON.parse(t.shopping);
      } catch (err) {
        items = [];
      }
      for (const s of Array.isArray(items) ? items : []) {
        if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
        const row = shopRow_(t.id, t.userId, Object.assign({}, s, { id: cleanId_(s.id) || Utilities.getUuid() }));
        if (!have.has(`${t.id}:${row.id}`)) moved.push(row); // 搬到一半失敗再重跑時不會重複
      }
      t.shopping = '';
    }
    if (moved.length) writeTable_('Shopping', shop.concat(moved));
    if (trips.some((t) => t.shopping === '')) writeTable_('Trips', trips);
    PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
  });
}

// 記住每筆資料在試算表的第幾列，之後只改那幾列（不可列舉，不會被送到網站）
function setRowNo_(obj, rowNo) {
  Object.defineProperty(obj, '__row', { value: rowNo, writable: true, enumerable: false, configurable: true });
  return obj;
}

function readTable_(name) {
  if (tableCache_[name]) return tableCache_[name];
  const sh = sheet_(name);
  const cols = TABLES[name];
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, cols.length).getDisplayValues() : [];
  const out = [];
  rows.forEach((r, i) => {
    if (r[0]) out.push(setRowNo_(Object.fromEntries(cols.map((c, j) => [c, r[j]])), i + 2)); // 空列略過
  });
  tableCache_[name] = out;
  return out;
}

function toRow_(name, obj) {
  return TABLES[name].map((c) => (obj[c] == null ? '' : String(obj[c])));
}

// 工作表列數不夠時先補足，避免寫到範圍外
function ensureRows_(sh, lastRowNo) {
  const max = sh.getMaxRows();
  if (max < lastRowNo) sh.insertRowsAfter(max, lastRowNo - max + 200);
}

// 把遞增的列號切成連續的區段：fn(起始列號, 在 rowNos 裡的位置, 列數)
function eachRun_(rowNos, fn) {
  let i = 0;
  while (i < rowNos.length) {
    let j = i + 1;
    while (j < rowNos.length && rowNos[j] === rowNos[j - 1] + 1) j++;
    fn(rowNos[i], i, j - i);
    i = j;
  }
}

/**
 * 整表重寫（只用在資料搬移與整理空列，平常的修改一律用 replaceRows_）
 * 先寫入新資料、再清掉多出來的舊列，中途失敗也不會留下空表
 */
function writeTable_(name, objs) {
  const sh = sheet_(name);
  const cols = TABLES[name];
  const n = sh.getLastRow() - 1;
  if (objs.length) {
    ensureRows_(sh, objs.length + 1);
    sh.getRange(2, 1, objs.length, cols.length).setNumberFormat('@').setValues(objs.map((o) => toRow_(name, o)));
  }
  if (n > objs.length) sh.getRange(2 + objs.length, 1, n - objs.length, cols.length).clearContent();
  objs.forEach((o, i) => setRowNo_(o, i + 2));
  tableCache_[name] = objs;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const rowNo = sh.getLastRow() + 1;
  ensureRows_(sh, rowNo);
  sh.getRange(rowNo, 1, 1, TABLES[name].length).setNumberFormat('@').setValues([toRow_(name, obj)]);
  setRowNo_(obj, rowNo);
  if (tableCache_[name]) tableCache_[name].push(obj);
}

/**
 * 把符合條件的舊資料換成 newObjs，只寫入有變動的那幾列，其他列（別的旅程、別人的資料）完全不動：
 *   內容不同的舊列就地覆寫 → 多出來的接在最後 → 用不到的舊列清空（讀取時會略過空列）
 * newObjs 要傳新物件，不要直接修改 readTable_ 拿到的物件再傳進來（會被當成沒有變動）
 */
function replaceRows_(name, match, newObjs) {
  const all = readTable_(name);
  const old = all.filter(match);
  const keep = all.filter((o) => !match(o));
  const oldRowNos = old.map((o) => o.__row);
  const sh = sheet_(name);
  const width = TABLES[name].length;
  const values = newObjs.map((o) => toRow_(name, o));
  const reuse = Math.min(old.length, newObjs.length);

  const changed = [];
  for (let i = 0; i < reuse; i++) {
    if (toRow_(name, old[i]).join('\u0000') !== values[i].join('\u0000')) changed.push(i);
  }
  eachRun_(changed.map((i) => oldRowNos[i]), (rowNo, at, count) => {
    sh.getRange(rowNo, 1, count, width).setNumberFormat('@').setValues(values.slice(changed[at], changed[at] + count));
  });
  for (let i = 0; i < reuse; i++) setRowNo_(newObjs[i], oldRowNos[i]);

  if (newObjs.length > reuse) {
    const start = sh.getLastRow() + 1;
    ensureRows_(sh, start + newObjs.length - reuse - 1);
    sh.getRange(start, 1, newObjs.length - reuse, width).setNumberFormat('@').setValues(values.slice(reuse));
    for (let i = reuse; i < newObjs.length; i++) setRowNo_(newObjs[i], start + i - reuse);
  }
  eachRun_(oldRowNos.slice(reuse), (rowNo, at, count) => sh.getRange(rowNo, 1, count, width).clearContent());

  const rows = keep.concat(newObjs).sort((a, b) => a.__row - b.__row);
  tableCache_[name] = rows;
  // 清空的列累積太多時整理一次
  if (old.length > reuse && sh.getLastRow() - 1 - rows.length > MAX_BLANK_ROWS) writeTable_(name, rows);
}

let lockHeld_ = false;
function withLock_(fn) {
  if (lockHeld_) return fn(); // 已在鎖內（例如機器人事件中又呼叫需要鎖的函式）
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw apiError_(503, '系統正在忙，請稍後再試一次'); // 網站收到 503 會自動重試
  }
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

// id 會被網站放進 HTML 屬性與網址，只接受英數、底線、連字號
function cleanId_(v) {
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : '';
}

function sanitizeActivity_(a) {
  if (!a || typeof a.title !== 'string' || !a.title.trim()) return null;
  return {
    id: cleanId_(a.id) || Utilities.getUuid(),
    time: /^\d{2}:\d{2}$/.test(a.time) ? a.time : '',
    endTime: /^\d{2}:\d{2}$/.test(a.time) && /^\d{2}:\d{2}$/.test(a.endTime) && a.endTime >= a.time ? a.endTime : '',
    travelMin: Math.min(1440, Math.max(0, Math.round(Number(a.travelMin) || 0))),
    travelMode: travelModeKey_(a.travelMode),
    travelCost: Math.max(0, Number(a.travelCost) || 0),
    travelCostCurrency: CURRENCY_CODES.includes(a.travelCostCurrency) ? a.travelCostCurrency : '',
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
  if (raw.id != null && raw.id !== '' && !cleanId_(raw.id)) return null;
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
      .map((p) => ({ id: cleanId_(p.id) || Utilities.getUuid(), text: str_(p.text, 80), done: !!p.done }))
    : [];
  // 購物清單（存檔者自己的）：date 是預計哪一天買（空＝不指定），activityId 是預計在哪一站買（要是這個旅程裡的行程），price 是預估金額（旅程幣別）
  const actIds = new Set(Object.values(days).flat().map((a) => a.id));
  const shopping = Array.isArray(raw.shopping)
    ? raw.shopping
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .slice(0, MAX_SHOPPING)
      .map((s) => ({
        id: cleanId_(s.id) || Utilities.getUuid(),
        text: str_(s.text, 80).trim(),
        date: valid.has(s.date) ? s.date : '',
        activityId: actIds.has(s.activityId) ? s.activityId : '',
        price: Math.max(0, Number(s.price) || 0),
        note: str_(s.note, 200).trim(),
        fileId: cleanFileId_(s.fileId), // 是不是自己上傳的照片，存檔時（saveTrip_）才檢查
        done: !!s.done,
      }))
    : [];
  const places = sanitizePlaces_(raw.places, actIds);
  return {
    id: cleanId_(raw.id) || Utilities.getUuid(),
    name: str_(raw.name, 60) || '未命名旅程',
    destination: str_(raw.destination, 60),
    startDate: raw.startDate,
    endDate: raw.endDate,
    budget: Math.max(0, Number(raw.budget) || 0),
    currency: CURRENCY_CODES.includes(raw.currency) ? raw.currency : 'TWD',
    notes: str_(raw.notes),
    days,
    packing,
    shopping,
    places,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

/* ---------- 待去清單（整個旅程共用） ---------- */
/**
 * 想去但還沒排進行程的地方。geo：''＝還沒定位、'ok'＝已定位（lat/lng/area/geoName 有值）、'none'＝找不到
 * activityId：已排入行程時指向那個行程，行程被刪掉就清空
 */
function sanitizePlaces_(list, actIds) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .slice(0, MAX_PLACES)
    .map((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      const ok = p.geo === 'ok' && p.lat !== '' && p.lng !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      return {
        id: cleanId_(p.id) || Utilities.getUuid(),
        name: str_(p.name, 80).trim(),
        address: str_(p.address, 200).trim(), // Google 地圖用的地址（空＝用名稱搜尋）
        mapUrl: cleanUrl_(p.mapUrl),          // Google 地圖分享連結（選填）
        geo: ok ? 'ok' : (p.geo === 'none' ? 'none' : ''),
        lat: ok ? Math.round(lat * 1e6) / 1e6 : '',
        lng: ok ? Math.round(lng * 1e6) / 1e6 : '',
        area: ok ? str_(p.area, 40) : '',
        geoName: ok ? str_(p.geoName, 80) : '',
        activityId: actIds.has(p.activityId) ? p.activityId : '',
      };
    });
}

/* ---------- 購物清單（每個人各自一份） ---------- */
function shopRow_(tripId, userId, s) {
  return {
    id: s.id, tripId, userId, text: str_(s.text, 80).trim(), date: isValidDate_(s.date) ? s.date : '',
    activityId: cleanId_(s.activityId), price: Math.max(0, Number(s.price) || 0), done: s.done ? '1' : '',
    note: str_(s.note, 200).trim(), fileId: cleanFileId_(s.fileId),
  };
}

function loadShopping_(tripId, userId) {
  return readTable_('Shopping')
    .filter((s) => s.tripId === tripId && s.userId === userId)
    .map((s) => ({
      id: s.id, text: s.text, date: s.date, activityId: s.activityId, price: Number(s.price) || 0, done: s.done === '1',
      note: s.note || '', fileId: s.fileId || '',
    }));
}

/* ---------- 購物清單的照片（存在 Google 雲端硬碟，只有上傳的人讀得到） ---------- */
const MAX_SHOP_IMAGE_CHARS = 2800000; // data URL 的長度上限，約 2 MB 的圖

function cleanFileId_(v) {
  return typeof v === 'string' && /^[\w-]{10,100}$/.test(v) ? v : '';
}

/**
 * 取得存檔用的雲端硬碟資料夾。資料夾是用 id 記的（指令碼屬性 propKey），所以在雲端硬碟改名、搬到別的資料夾都沒關係；
 * 還沒建立、被丟到垃圾桶或永久刪除時，重新建一個同名的，之後的檔案存到新的資料夾。
 */
function driveFolder_(propKey, name) {
  const id = prop_(propKey);
  if (id) {
    try {
      const folder = DriveApp.getFolderById(id);
      if (!folder.isTrashed()) return folder;
    } catch (err) {
      console.warn(`找不到資料夾 ${propKey}（${id}），重新建立`, err);
    }
  }
  const folder = DriveApp.createFolder(name);
  PropertiesService.getScriptProperties().setProperty(propKey, folder.getId());
  return folder;
}

function shopFolder_() {
  return driveFolder_('SHOP_FOLDER_ID', '旅程手帖購物清單照片');
}

/** 這個人可以用的照片：已經存在自己購物清單裡的，或是 6 小時內自己剛上傳、還沒存檔的 */
function ownsShopFile_(userId, fileId, mine) {
  if (!fileId) return false;
  if (mine.has(fileId)) return true;
  return CacheService.getScriptCache().get(`up_${fileId}`) === userId;
}

function myShopFiles_(userId) {
  return new Set(readTable_('Shopping').filter((s) => s.userId === userId && s.fileId).map((s) => s.fileId));
}

/** 上傳一張照片（網站先縮小成 JPEG 再傳），回傳檔案 id；之後存檔時把 id 記在購物項目上 */
function uploadShopImage_(userId, dataUrl) {
  const m = typeof dataUrl === 'string' && dataUrl.length <= MAX_SHOP_IMAGE_CHARS && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw apiError_(400, '照片格式不對或檔案太大');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], `shop_${Date.now()}.${m[1].split('/')[1]}`);
  const id = shopFolder_().createFile(blob).getId();
  CacheService.getScriptCache().put(`up_${id}`, userId, 21600);
  return id;
}

/** 一次讀幾張照片（最多 6 張），只回傳自己的 */
function shopPhotos_(userId, fileIds) {
  const mine = myShopFiles_(userId);
  const out = {};
  for (const id of (Array.isArray(fileIds) ? fileIds : []).slice(0, 6).map(cleanFileId_)) {
    if (!ownsShopFile_(userId, id, mine)) continue;
    try {
      const blob = DriveApp.getFileById(id).getBlob();
      out[id] = `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`;
    } catch (err) {
      console.warn(`讀取購物照片失敗：${id}`, err);
    }
  }
  return out;
}

function trashFiles_(ids) {
  for (const id of ids) {
    try {
      DriveApp.getFileById(id).setTrashed(true);
    } catch (err) {
      console.warn(`刪除照片失敗：${id}`, err);
    }
  }
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
    replaceRows_('Users', (x) => x === row, [Object.assign({}, row, { name: clean, updatedAt: String(Date.now()) })]);
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
      id: a.id, time: a.time, endTime: a.endTime || '', travelMin: Number(a.travelMin) || 0, travelMode: travelModeKey_(a.travelMode), travelCost: Number(a.travelCost) || 0,
      travelCostCurrency: a.travelCostCurrency || '', title: a.title, category: catKey_(a.category), location: a.location, mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes,
    });
  }
  Object.values(days).forEach(sortDay_);
  let packing = [];
  try {
    packing = JSON.parse(row.packing || '[]');
  } catch (err) {
    packing = [];
  }
  const shopping = loadShopping_(row.id, viewerId); // 只有自己的
  let places = [];
  try {
    places = JSON.parse(row.places || '[]');
  } catch (err) {
    places = [];
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
    shopping,
    places,
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

/** 儲存整個旅程（含所有行程項目），只寫入這個旅程有變動的列，回傳新的 updatedAt。主人與成員都可以 */
function saveTrip_(userId, trip) {
  const trips = readTable_('Trips');
  const existing = trips.find((t) => t.id === trip.id);
  // 版本號一定要遞增，同一毫秒內連續存檔也能正確偵測衝突
  const now = String(Math.max(Date.now(), existing ? Number(existing.updatedAt) + 1 || 0 : 0));
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
    shopping: '', // 舊欄位，已改存 Shopping 工作表
    places: JSON.stringify(sanitizePlaces_(trip.places, new Set(Object.values(trip.days || {}).flat().map((a) => a.id)))),
  };
  // 購物清單只換掉存檔這個人自己的，旅伴的不動；照片只能用自己上傳的
  const mineFiles = myShopFiles_(userId);
  const before = readTable_('Shopping').filter((s) => s.tripId === trip.id && s.userId === userId && s.fileId).map((s) => s.fileId);
  const shopRows = syncShopping_(trip).map((s) => {
    const r = shopRow_(trip.id, userId, s);
    if (!ownsShopFile_(userId, r.fileId, mineFiles)) r.fileId = '';
    return r;
  });
  replaceRows_('Shopping', (s) => s.tripId === trip.id && s.userId === userId, shopRows);
  const kept = new Set(shopRows.map((r) => r.fileId));
  trashFiles_(before.filter((id) => !kept.has(id))); // 被換掉或跟著項目刪掉的照片
  const acts = [];
  for (const [date, list] of Object.entries(trip.days || {})) {
    for (const a of list) {
      acts.push({
        id: a.id, tripId: trip.id, userId: ownerId, date, time: a.time || '', endTime: a.endTime || '', travelMin: Number(a.travelMin) || 0,
        travelMode: travelModeKey_(a.travelMode), travelCost: Number(a.travelCost) || 0,
        travelCostCurrency: CURRENCY_CODES.includes(a.travelCostCurrency) ? a.travelCostCurrency : '', title: a.title,
        category: catKey_(a.category), location: a.location || '', mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes || '',
      });
    }
  }
  replaceRows_('Activities', (a) => a.tripId === trip.id, acts);
  // 版本號最後才更新：行程寫到一半失敗時版本不變，網站重新存檔就能補回來
  replaceRows_('Trips', (t) => t.id === trip.id, [row]);
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
  replaceRows_('Trips', (t) => t.id === tripId, []);
  replaceRows_('Activities', (a) => a.tripId === tripId, []);
  replaceRows_('Members', (m) => m.tripId === tripId, []);
  trashFiles_(readTable_('Shopping').filter((s) => s.tripId === tripId && s.fileId).map((s) => s.fileId));
  replaceRows_('Shopping', (s) => s.tripId === tripId, []);
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
    replaceRows_('Trips', (t) => t === row, [Object.assign({}, row, { inviteCode: code })]);
    return code;
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
  replaceRows_('Members', (m) => m.tripId === tripId && m.userId === userId, []);
}

/** 主人移除成員；member 可以是 userId 或網站用的成員代號 */
function removeMember_(ownerId, tripId, member) {
  const row = findTripRow_(tripId);
  if (!row || row.userId !== ownerId) throw apiError_(403, '只有旅程主人可以移除成員');
  const rows = readTable_('Members');
  const target = rows.find((m) => m.tripId === tripId && (m.userId === member || memberKey_(tripId, m.userId) === member));
  if (!target) return null;
  replaceRows_('Members', (m) => m === target, []);
  // 舊邀請碼作廢，被移除的人不能用同一組再加入；下次邀請會產生新的
  if (row.inviteCode) replaceRows_('Trips', (t) => t === row, [Object.assign({}, row, { inviteCode: '' })]);
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
    id: cleanId_(entry.id) || Utilities.getUuid(),
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
  replaceRows_('Journal', (j) => j.id === id, []);
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
