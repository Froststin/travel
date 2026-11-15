/* ============================================================
 * 資料存取：Google 試算表（每個工作表一種資料，全部以純文字格式儲存）
 *
 * 共用旅程：Trips.userId 是建立者（主人），其他旅伴記在 Members。
 * 主人與成員都能查看、編輯行程；只有主人能刪除旅程、移除成員。
 * 備忘（原本叫日誌，工作表沿用 Journal）以 tripId 歸屬到旅程，同旅程的成員都看得到；date 空字串＝整趟旅程通用。
 * 購物清單每個人各一份：Shopping 每一列記 tripId＋userId，只能改自己的；同旅程的成員看得到彼此的（唯讀）。
 * 地鐵圖（Trips.metroMaps）整個旅程共用：成員都能新增，只有上傳的人或主人能刪除。
 * 記帳（Trips.expenses）整個旅程共用：成員都能新增、修改、刪除；算進預算與分帳（結清的不算分帳）。
 * ============================================================ */

const TABLES = {
  Trips: ['id', 'userId', 'name', 'destination', 'startDate', 'endDate', 'budget', 'currency', 'notes', 'packing', 'createdAt', 'updatedAt', 'inviteCode', 'shopping', 'places', 'bookings', 'metroMaps', 'expenses'],
  Activities: ['id', 'tripId', 'userId', 'date', 'time', 'title', 'category', 'location', 'cost', 'notes', 'mapUrl', 'endTime', 'travelMin', 'travelMode', 'travelCost', 'travelCostCurrency', 'costCurrency', 'fileId', 'paidBy', 'splitWith', 'lat', 'lng', 'geo', 'geoKey'],
  Journal: ['id', 'userId', 'date', 'time', 'type', 'text', 'fileId', 'createdAt', 'tripId'],
  Members: ['tripId', 'userId', 'role', 'joinedAt'],
  Users: ['userId', 'name', 'updatedAt', 'sessionsFrom'], // sessionsFrom：這個時間以前發的網站登入憑證一律失效（登出）
  // price 是單價（priceCurrency，空＝旅程幣別），小計＝單價 × quantity；payment：pre 先付／post 後付／unsure 不確定
  Shopping: ['id', 'tripId', 'userId', 'text', 'date', 'activityId', 'price', 'done', 'note', 'fileId', 'payment', 'quantity', 'priceCurrency', 'paidBy', 'splitWith'],
  Views: ['token', 'tripId', 'userId', 'createdAt'], // 免登入的線上檢視連結
  Packing: ['id', 'tripId', 'userId', 'text', 'done'], // 個人的行李清單（共用的那份在 Trips.packing）
};
const SCHEMA_VERSION = '14';
const CURRENCY_CODES = ['TWD', 'JPY', 'KRW', 'USD', 'EUR', 'GBP', 'CNY', 'HKD', 'THB', 'SGD'];
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O、1/I/L

const MAX_SHOPPING = 200; // 每個旅程的購物清單上限
const MAX_PLACES = 100; // 每個旅程的待去清單上限
const MAX_BOOKINGS = 50; // 每個旅程的住宿／交通資訊上限
const MAX_METRO_MAPS = 10; // 每個旅程的地鐵圖上限
const MAX_EXPENSES = 300; // 每個旅程的記帳上限
const PAYMENTS = ['pre', 'post', 'unsure'];
const MAX_QTY = 999;
const BOOKING_TYPES = ['flight', 'stay', 'train', 'bus', 'car', 'ticket', 'other'];
const MEMBER_KEY_RE = /^[\w-]{12}$/; // 成員代號（memberKey_），分帳記的是這個
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
    // 第 13 版要搬購物清單的備註（數量），搬之前先備份一份工作表
    const oldShop = ss.getSheetByName('Shopping');
    if (Number(prop_('SCHEMA_VERSION')) < 13 && oldShop && oldShop.getLastRow() > 1 && !ss.getSheetByName('Shopping_backup_v13')) {
      oldShop.copyTo(ss).setName('Shopping_backup_v13');
    }
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
    // 舊購物項目沒有數量：備註只寫數量的（「2」「x3」「3盒」）搬到數量、備註清空，其他數量當 1
    const shopNow = readTable_('Shopping');
    let qtyChanged = false;
    for (const s of shopNow) {
      if (s.quantity) continue;
      const q = qtyFromNote_(s.note);
      s.quantity = String(q || 1);
      if (q) s.note = '';
      if (!s.payment) s.payment = 'unsure';
      qtyChanged = true;
    }
    if (qtyChanged) writeTable_('Shopping', shopNow);
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
    costCurrency: CURRENCY_CODES.includes(a.costCurrency) ? a.costCurrency : '', // 空＝旅程的幣別
    fileId: cleanFileId_(a.fileId), // 行程的照片；能不能用，存檔時（saveTrip_）才檢查
    notes: str_(a.notes),
    ...splitFields_(a),
    ...geoFields_(a),
  };
}

/**
 * 行程的座標（地圖分頁用）：geo＝'ok' 已定位、'none' 找不到、'' 還沒定位；
 * geoKey 記下定位時的「地點|地圖連結」，之後地點或連結改了就不算數（網站會重新定位）
 */
function geoFields_(a) {
  const lat = Number(a.lat);
  const lng = Number(a.lng);
  const ok = a.geo === 'ok' && a.lat !== '' && a.lng !== '' && a.lat != null && a.lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const geo = ok ? 'ok' : (a.geo === 'none' ? 'none' : '');
  return {
    lat: ok ? Math.round(lat * 1e6) / 1e6 : '',
    lng: ok ? Math.round(lng * 1e6) / 1e6 : '',
    geo,
    geoKey: geo ? str_(a.geoKey, 720) : '',
  };
}

/** 備註只寫數量時回傳那個數字（「2」「2個」「x3」「×3」「3盒」），否則回傳 0 */
function qtyFromNote_(note) {
  const s = String(note || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  const m = s.match(/^(?:[xX×*＊✕ｘ]\s*)?(\d{1,3})\s*(?:個|盒|包|瓶|件|組|份|罐|袋|條|張|雙|支|台|片|入|顆|本|枚|pcs?)?$/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_QTY ? n : 0;
}

function cleanQty_(v) {
  const n = Math.round(Number(v));
  return n >= 1 && n <= MAX_QTY ? n : 1;
}

/** 購物項目共用的欄位整理（網站存檔、LINE 新增、從試算表讀出來都用這個） */
function shopExtra_(s) {
  return {
    payment: PAYMENTS.includes(s.payment) ? s.payment : 'unsure',
    quantity: cleanQty_(s.quantity),
    priceCurrency: CURRENCY_CODES.includes(s.priceCurrency) ? s.priceCurrency : '',
    ...splitFields_(s),
  };
}

/** 分帳：paidBy＝誰付的（成員代號，空＝還沒填），splitWith＝哪些人分攤（空＝所有成員） */
function splitFields_(a) {
  const keys = (Array.isArray(a.splitWith) ? a.splitWith : String(a.splitWith || '').split(','))
    .filter((k) => MEMBER_KEY_RE.test(k));
  return { paidBy: MEMBER_KEY_RE.test(a.paidBy) ? a.paidBy : '', splitWith: [...new Set(keys)].slice(0, 30) };
}

/**
 * 住宿與交通資訊：type 見 BOOKING_TYPES；date 是出發或入住日，endDate 是退房日（住宿才有），
 * time／endTime 是出發與抵達（或入住、退房）時間，code 是訂位代號、確認碼
 */
function sanitizeBookings_(list) {
  if (!Array.isArray(list)) return [];
  const time = (v) => (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');
  return list
    .filter((b) => b && typeof b.title === 'string' && b.title.trim())
    .slice(0, MAX_BOOKINGS)
    .map((b) => {
      const date = isValidDate_(b.date) ? b.date : '';
      return {
        id: cleanId_(b.id) || Utilities.getUuid(),
        type: BOOKING_TYPES.includes(b.type) ? b.type : 'other',
        title: str_(b.title, 80).trim(),
        date,
        endDate: date && isValidDate_(b.endDate) && b.endDate >= date ? b.endDate : '',
        time: time(b.time),
        endTime: time(b.endTime),
        code: str_(b.code, 40).trim(),
        place: str_(b.place, 200).trim(),
        notes: str_(b.notes, 300).trim(),
      };
    });
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
        ...shopExtra_(s),
        // 舊版網頁送來的項目沒有這些欄位：存檔時沿用試算表原本的值，不要被重設成預設值
        legacyFields: !['payment', 'quantity', 'priceCurrency', 'paidBy', 'splitWith'].some((k) => k in s),
      }))
    : [];
  const places = sanitizePlaces_(raw.places, actIds);
  const bookings = sanitizeBookings_(raw.bookings);
  // 地鐵圖：誰上傳的、照片能不能用，存檔時（saveTrip_）對照原本的資料再決定
  const metroMaps = Array.isArray(raw.metroMaps)
    ? raw.metroMaps
      .filter((m) => m && cleanId_(m.id))
      .slice(0, 50)
      .map((m) => ({ id: m.id, name: str_(m.name, 30).trim(), fileId: cleanFileId_(m.fileId) }))
    : null; // null＝沒送這個欄位（舊版網頁），存檔時沿用原本的
  // 記帳：一樣，舊版網頁沒送就沿用原本的
  const expenses = Array.isArray(raw.expenses) ? sanitizeExpenses_(raw.expenses, valid) : null;
  // 個人行李（存檔者自己的）：舊版網頁沒送就不動
  const myPacking = Array.isArray(raw.myPacking) ? sanitizePacking_(raw.myPacking) : null;
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
    bookings,
    metroMaps,
    expenses,
    myPacking,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function sanitizePacking_(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .slice(0, 300)
    .map((p) => ({ id: cleanId_(p.id) || Utilities.getUuid(), text: str_(p.text, 80).trim(), done: !!p.done }));
}

function loadPacking_(tripId, userId) {
  return readTable_('Packing').filter((p) => p.tripId === tripId && p.userId === userId)
    .map((p) => ({ id: p.id, text: p.text, done: p.done === '1' }));
}

/**
 * 記帳：{ id, date（空＝不指定）, title, amount, currency（空＝旅程幣別）, paidBy, splitWith（空＝所有成員）, settled, createdAt }
 * valid：旅程的日期（Set），不在裡面的日期改成不指定
 */
function sanitizeExpenses_(list, valid) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.title === 'string' && x.title.trim())
    .slice(0, MAX_EXPENSES)
    .map((x) => ({
      id: cleanId_(x.id) || Utilities.getUuid(),
      date: valid && valid.has(x.date) ? x.date : '',
      title: str_(x.title, 40).trim(),
      amount: Math.max(0, Math.round((Number(x.amount) || 0) * 100) / 100),
      currency: CURRENCY_CODES.includes(x.currency) ? x.currency : '',
      ...splitFields_(x),
      settled: !!x.settled,
      createdAt: Number(x.createdAt) || Date.now(),
    }));
}

function expensesOf_(row) {
  try {
    const list = JSON.parse((row && row.expenses) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
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
  const x = shopExtra_(s);
  return {
    id: s.id, tripId, userId, text: str_(s.text, 80).trim(), date: isValidDate_(s.date) ? s.date : '',
    activityId: cleanId_(s.activityId), price: Math.max(0, Number(s.price) || 0), done: s.done ? '1' : '',
    note: str_(s.note, 200).trim(), fileId: cleanFileId_(s.fileId),
    payment: x.payment, quantity: String(x.quantity), priceCurrency: x.priceCurrency, paidBy: x.paidBy, splitWith: x.splitWith.join(','),
  };
}

function loadShopping_(tripId, userId) {
  return readTable_('Shopping')
    .filter((s) => s.tripId === tripId && s.userId === userId)
    .map((s) => ({
      id: s.id, text: s.text, date: s.date, activityId: s.activityId, price: Number(s.price) || 0, done: s.done === '1',
      note: s.note || '', fileId: s.fileId || '', ...shopExtra_(s),
    }));
}

/** 同旅程其他成員的購物清單（唯讀，依人分組）；已經退出或被移出的人不列 */
function loadOthersShopping_(tripRow, viewerId) {
  const rows = readTable_('Shopping').filter((s) => s.tripId === tripRow.id);
  return membersOf_(tripRow)
    .filter((m) => m.userId !== viewerId)
    .map((m) => ({ name: m.name, key: memberKey_(tripRow.id, m.userId), items: loadShopping_(tripRow.id, m.userId) }))
    .filter((g) => rows.length && g.items.length);
}

/* ---------- 購物清單的照片（存在 Google 雲端硬碟；自己的可以換，同旅程成員的只能看） ---------- */
const MAX_SHOP_IMAGE_CHARS = 2800000; // data URL 的長度上限，約 2 MB 的圖
const MAX_METRO_IMAGE_CHARS = 6000000; // 地鐵圖要看得清楚，放寬到約 4.5 MB

function cleanFileId_(v) {
  return typeof v === 'string' && /^[\w-]{10,100}$/.test(v) ? v : '';
}

/**
 * 取得存檔用的雲端硬碟資料夾。資料夾是用 id 記的（指令碼屬性 propKey），所以在雲端硬碟改名、搬到別的資料夾都沒關係；
 * 還沒建立、被丟到垃圾桶或永久刪除時，重新建一個同名的，之後的檔案存到新的資料夾。
 * 新資料夾建在「旅程手帖資料」試算表所在的資料夾裡（例如使用者整理到「旅遊」），找不到才建在雲端硬碟最上層。
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
  const folder = (homeFolder_() || DriveApp).createFolder(name);
  PropertiesService.getScriptProperties().setProperty(propKey, folder.getId());
  return folder;
}

/** 試算表所在的資料夾；試算表在最上層、在垃圾桶裡或查不到時回傳 null */
function homeFolder_() {
  try {
    const parents = DriveApp.getFileById(prop_('SHEET_ID')).getParents();
    const parent = parents.hasNext() ? parents.next() : null;
    return parent && !parent.isTrashed() ? parent : null;
  } catch (err) {
    console.warn('查不到試算表所在的資料夾，新資料夾改建在最上層', err);
    return null;
  }
}

function shopFolder_() {
  return driveFolder_('SHOP_FOLDER_ID', '旅程手帖購物清單照片');
}

/** 這個人可以用的照片：已經存在自己購物清單裡的，或是 6 小時內自己剛上傳、還沒存檔的 */
function ownsShopFile_(userId, fileId, mine) {
  if (!fileId) return false;
  if (mine.has(fileId)) return true;
  if (CacheService.getScriptCache().get(`up_${fileId}`) === userId) return true;
  return restoreFile_(fileId, `s:${userId}`);
}

/**
 * 被刪掉的項目在網站上按「復原」時，照片也要救回來：丟到垃圾桶時記下是誰的（6 小時），
 * 同一個人（購物）或同一個旅程（行程）存回這張照片時，把它從垃圾桶拿出來
 */
function restoreFile_(fileId, owner) {
  const cache = CacheService.getScriptCache();
  if (!fileId || cache.get(`tr_${fileId}`) !== owner) return false;
  try {
    DriveApp.getFileById(fileId).setTrashed(false);
  } catch (err) {
    console.warn(`還原照片失敗：${fileId}`, err);
    return false;
  }
  cache.remove(`tr_${fileId}`);
  return true;
}

function myShopFiles_(userId) {
  return new Set(readTable_('Shopping').filter((s) => s.userId === userId && s.fileId).map((s) => s.fileId));
}

/** 上傳一張照片（網站先縮小成 JPEG 再傳），回傳檔案 id；之後存檔時把 id 記在購物項目、行程或地鐵圖上。kind：'shop'｜'activity'｜'metro' */
function uploadShopImage_(userId, dataUrl, kind) {
  const max = kind === 'metro' ? MAX_METRO_IMAGE_CHARS : MAX_SHOP_IMAGE_CHARS;
  const m = typeof dataUrl === 'string' && dataUrl.length <= max && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw apiError_(400, '照片格式不對或檔案太大');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], `${kind === 'metro' ? 'metro' : 'shop'}_${Date.now()}.${m[1].split('/')[1]}`);
  const folder = kind === 'activity' ? driveFolder_('ACTIVITY_FOLDER_ID', '旅程手帖行程照片')
    : kind === 'metro' ? driveFolder_('METRO_FOLDER_ID', '旅程手帖地鐵圖') : shopFolder_();
  const id = folder.createFile(blob).getId();
  CacheService.getScriptCache().put(`up_${id}`, userId, 21600);
  return id;
}

/** 看得到的照片：自己的購物照片、同旅程目前成員的購物照片，加上自己參加的旅程裡的行程照片 */
function readableShopFiles_(userId) {
  const trips = tripIdsFor_(userId);
  const memberOf = {}; // tripId:userId → 是不是那個旅程目前的成員
  const isMember = (tripId, uid) => {
    const k = `${tripId}:${uid}`;
    if (!(k in memberOf)) memberOf[k] = !!roleIn_(uid, findTripRow_(tripId));
    return memberOf[k];
  };
  const files = new Set(readTable_('Shopping')
    .filter((s) => s.fileId && (s.userId === userId || (trips.has(s.tripId) && isMember(s.tripId, s.userId))))
    .map((s) => s.fileId));
  readTable_('Activities').filter((a) => a.fileId && trips.has(a.tripId)).forEach((a) => files.add(a.fileId));
  readTable_('Trips').filter((t) => trips.has(t.id)).forEach((t) => metroOf_(t).forEach((m) => files.add(m.fileId)));
  return files;
}

/** 試算表裡存的地鐵圖：[{ id, name, fileId, userId }] */
function metroOf_(row) {
  let list = [];
  try {
    list = JSON.parse((row && row.metroMaps) || '[]');
  } catch (err) {
    list = [];
  }
  return (Array.isArray(list) ? list : []).filter((m) => m && cleanId_(m.id) && cleanFileId_(m.fileId));
}

/**
 * 存檔時決定地鐵圖清單：原本就有的沿用原本的照片與上傳者（名稱只有上傳者或主人能改）；
 * 新的要是存檔的人剛上傳的照片；網站送來的清單裡少了的，只有上傳者或主人才算刪除，否則留著
 * @return {{list: Array, removed: Array<string>}} removed：要丟到垃圾桶的檔案
 */
function mergeMetro_(userId, existing, incoming) {
  const prev = metroOf_(existing);
  const owner = !existing || existing.userId === userId;
  const byId = new Map(prev.map((m) => [m.id, m]));
  const uploadedBy = (id) => CacheService.getScriptCache().get(`up_${id}`) === userId;
  const list = [];
  const seen = new Set();
  for (const m of incoming || []) {
    if (seen.has(m.id)) continue;
    const old = byId.get(m.id);
    if (old) {
      const canEdit = owner || old.userId === userId;
      list.push({ id: old.id, name: canEdit ? m.name : old.name, fileId: old.fileId, userId: old.userId });
    } else if (m.fileId && uploadedBy(m.fileId) && !prev.some((p) => p.fileId === m.fileId)) {
      list.push({ id: m.id, name: m.name, fileId: m.fileId, userId });
    } else {
      continue;
    }
    seen.add(m.id);
  }
  const removed = [];
  for (const old of prev) {
    if (seen.has(old.id)) continue;
    if (owner || old.userId === userId) removed.push(old.fileId);
    else list.push(old); // 別人上傳的，旅伴不能刪
  }
  // 超過上限時只能捨棄這次新加的（原本就有的不會因為名額被刪掉）
  const prevIds = new Set(prev.map((m) => m.id));
  let extra = list.length - MAX_METRO_MAPS;
  for (let i = list.length - 1; i >= 0 && extra > 0; i--) {
    if (prevIds.has(list[i].id)) continue;
    removed.push(list[i].fileId);
    list.splice(i, 1);
    extra--;
  }
  return { list, removed };
}

/** 一次讀幾張照片（最多 6 張），只回傳自己的與同旅程成員的 */
function shopPhotos_(userId, fileIds) {
  const mine = readableShopFiles_(userId);
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

/** owner：記下是誰的照片，之後按「復原」可以拿回來（見 restoreFile_）；整個旅程刪掉時不用記 */
function trashFiles_(ids, owner) {
  for (const id of ids) {
    try {
      DriveApp.getFileById(id).setTrashed(true);
      if (owner) CacheService.getScriptCache().put(`tr_${id}`, owner, 21600);
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

/** 登出：這個時間以前發給網站的登入憑證全部失效 */
function revokeSessions_(userId) {
  const row = readTable_('Users').find((x) => x.userId === userId);
  const now = String(Date.now());
  if (row) replaceRows_('Users', (x) => x === row, [Object.assign({}, row, { sessionsFrom: now })]);
  else appendRow_('Users', { userId, name: '', updatedAt: now, sessionsFrom: now });
}

function sessionsFrom_(userId) {
  const u = readTable_('Users').find((x) => x.userId === userId);
  return Number(u && u.sessionsFrom) || 0;
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
      costCurrency: CURRENCY_CODES.includes(a.costCurrency) ? a.costCurrency : '', fileId: a.fileId || '',
      ...splitFields_(a), ...geoFields_(a),
    });
  }
  Object.values(days).forEach(sortDay_);
  let packing = [];
  try {
    packing = JSON.parse(row.packing || '[]');
  } catch (err) {
    packing = [];
  }
  const shopping = loadShopping_(row.id, viewerId); // 自己的，可以改
  const othersShopping = loadOthersShopping_(row, viewerId); // 旅伴的，只能看
  let places = [];
  try {
    places = JSON.parse(row.places || '[]');
  } catch (err) {
    places = [];
  }
  let bookings = [];
  try {
    bookings = JSON.parse(row.bookings || '[]');
  } catch (err) {
    bookings = [];
  }
  const expenses = expensesOf_(row).map((x) => Object.assign({}, x, splitFields_(x)));
  // 行李：packing＝共用的；myPacking＝自己的（可以改）；othersPacking＝旅伴的（只能看）
  const myPacking = loadPacking_(row.id, viewerId);
  const members = membersOf_(row);
  const metroMaps = metroOf_(row).map((m) => ({
    id: m.id, name: m.name, fileId: m.fileId, by: m.userId === viewerId ? 'me' : memberKey_(row.id, m.userId),
    byName: userName_(m.userId), mine: m.userId === viewerId,
  }));
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
    othersShopping,
    places,
    bookings,
    metroMaps,
    expenses,
    myPacking,
    othersPacking: membersOf_(row).filter((m) => m.userId !== viewerId)
      .map((m) => ({ name: m.name, key: memberKey_(row.id, m.userId), items: loadPacking_(row.id, m.userId) }))
      .filter((g) => g.items.length),
    createdAt: Number(row.createdAt) || 0,
    updatedAt: row.updatedAt,
    role: roleIn_(viewerId, row),
    members: members.map((m) => ({ name: m.name, role: m.role, me: m.userId === viewerId, id: m.userId === viewerId ? 'me' : memberKey_(row.id, m.userId), key: memberKey_(row.id, m.userId) })),
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
    bookings: JSON.stringify(sanitizeBookings_(trip.bookings)),
    // 記帳：網站（sanitizeTrip_ 後是陣列）或 LINE 機器人（loadTrips_ 讀出來的）送來的才換；沒送（舊版網頁）沿用原本的
    expenses: Array.isArray(trip.expenses)
      ? JSON.stringify(sanitizeExpenses_(trip.expenses, new Set(dateRange_(trip.startDate, trip.endDate))))
      : (existing ? existing.expenses || '' : '[]'),
  };
  // 網站送來的才有 metroMaps；LINE 機器人存檔時（沒有這個欄位）沿用原本的
  // （舊版網頁也沒有，sanitizeTrip_ 會給 null，不能當成「全部刪掉」）
  const metro = Array.isArray(trip.metroMaps)
    ? mergeMetro_(userId, existing, trip.metroMaps.map((m) => ({ id: cleanId_(m.id), name: str_(m.name, 30).trim(), fileId: cleanFileId_(m.fileId) })).filter((m) => m.id))
    : { list: metroOf_(existing), removed: [] };
  row.metroMaps = JSON.stringify(metro.list);
  // 購物清單只換掉存檔這個人自己的，旅伴的不動；照片只能用自己上傳的
  const mineFiles = myShopFiles_(userId);
  const before = readTable_('Shopping').filter((s) => s.tripId === trip.id && s.userId === userId && s.fileId).map((s) => s.fileId);
  const oldShop = new Map(readTable_('Shopping').filter((s) => s.tripId === trip.id && s.userId === userId).map((s) => [s.id, s]));
  const legacy = new Set((trip.shopping || []).filter((s) => s.legacyFields).map((s) => s.id));
  const shopRows = syncShopping_(trip).map((s) => {
    const old = legacy.has(s.id) && oldShop.get(s.id);
    if (old) Object.assign(s, { payment: old.payment, quantity: old.quantity, priceCurrency: old.priceCurrency, paidBy: old.paidBy, splitWith: old.splitWith });
    const r = shopRow_(trip.id, userId, s);
    if (!ownsShopFile_(userId, r.fileId, mineFiles)) r.fileId = '';
    return r;
  });
  replaceRows_('Shopping', (s) => s.tripId === trip.id && s.userId === userId, shopRows);
  // 個人行李：只換存檔這個人自己的（網站或 LINE 機器人送來的才換）
  if (Array.isArray(trip.myPacking)) {
    replaceRows_('Packing', (p) => p.tripId === trip.id && p.userId === userId,
      sanitizePacking_(trip.myPacking).map((p) => ({ id: p.id, tripId: trip.id, userId, text: p.text, done: p.done ? '1' : '' })));
  }
  const kept = new Set(shopRows.map((r) => r.fileId));
  trashFiles_(before.filter((id) => !kept.has(id)), `s:${userId}`); // 被換掉或跟著項目刪掉的照片
  // 行程的照片：原本就掛在同一個行程上的，或是存檔的人剛上傳的，才收；被換掉或跟著行程刪掉的丟到垃圾桶
  const prevActs = readTable_('Activities').filter((a) => a.tripId === trip.id);
  const prevFile = new Map(prevActs.map((a) => [a.id, a.fileId]));
  const uploadedBy = (id) => CacheService.getScriptCache().get(`up_${id}`) === userId;
  const acts = [];
  for (const [date, list] of Object.entries(trip.days || {})) {
    for (const a of list) {
      const fileId = cleanFileId_(a.fileId);
      const split = splitFields_(a);
      const geo = geoFields_(a);
      acts.push({
        lat: geo.lat, lng: geo.lng, geo: geo.geo, geoKey: geo.geoKey,
        costCurrency: CURRENCY_CODES.includes(a.costCurrency) ? a.costCurrency : '',
        fileId: fileId && (prevFile.get(a.id) === fileId || uploadedBy(fileId) || restoreFile_(fileId, `a:${trip.id}`)) ? fileId : '',
        paidBy: split.paidBy, splitWith: split.splitWith.join(','),
        id: a.id, tripId: trip.id, userId: ownerId, date, time: a.time || '', endTime: a.endTime || '', travelMin: Number(a.travelMin) || 0,
        travelMode: travelModeKey_(a.travelMode), travelCost: Number(a.travelCost) || 0,
        travelCostCurrency: CURRENCY_CODES.includes(a.travelCostCurrency) ? a.travelCostCurrency : '', title: a.title,
        category: catKey_(a.category), location: a.location || '', mapUrl: cleanUrl_(a.mapUrl), cost: Number(a.cost) || 0, notes: a.notes || '',
      });
    }
  }
  replaceRows_('Activities', (a) => a.tripId === trip.id, acts);
  const keptActFiles = new Set(acts.map((a) => a.fileId));
  trashFiles_(prevActs.map((a) => a.fileId).filter((id) => id && !keptActFiles.has(id)), `a:${trip.id}`);
  // 版本號最後才更新：行程寫到一半失敗時版本不變，網站重新存檔就能補回來
  replaceRows_('Trips', (t) => t.id === trip.id, [row]);
  trashFiles_(metro.removed, '');
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
  trashFiles_(metroOf_(row).map((m) => m.fileId));
  replaceRows_('Trips', (t) => t.id === tripId, []);
  replaceRows_('Activities', (a) => a.tripId === tripId, []);
  replaceRows_('Members', (m) => m.tripId === tripId, []);
  replaceRows_('Views', (v) => v.tripId === tripId, []);
  trashFiles_(readTable_('Shopping').filter((s) => s.tripId === tripId && s.fileId).map((s) => s.fileId));
  trashFiles_(readTable_('Activities').filter((a) => a.tripId === tripId && a.fileId).map((a) => a.fileId));
  replaceRows_('Shopping', (s) => s.tripId === tripId, []);
  replaceRows_('Packing', (p) => p.tripId === tripId, []);
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

/* ---------- 線上檢視連結（免登入、唯讀） ---------- */
/**
 * 每個人在每個旅程有一個連結，知道連結的人不用登入就能看（內容以產生連結的人看到的為準，含他自己的購物清單）。
 * reset＝換一個新的，舊連結立刻失效。產生連結的人退出旅程或旅程被刪掉後，連結也跟著失效。
 */
function viewTokenFor_(userId, tripId, reset) {
  if (!roleIn_(userId, findTripRow_(tripId))) throw apiError_(403, '沒有權限產生這個旅程的連結');
  const mine = (v) => v.tripId === tripId && v.userId === userId;
  const cur = readTable_('Views').find(mine);
  if (cur && !reset) return cur.token;
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
  replaceRows_('Views', mine, [{ token, tripId, userId, createdAt: String(Date.now()) }]);
  return token;
}

// 檢視頁放在網站上（GitHub Pages），由網頁跟後端要資料再畫出來。
// 不直接用後端的網址當頁面：瀏覽器登入多個 Google 帳號時，Apps Script 的網頁會被導到 /u/1/ 而打不開
function viewUrl_(token) {
  return `${SITE_URL}?view=${token}`;
}

/** 檢視頁要的資料（免登入，憑連結上的代碼）：行程本身、產生連結那個人的購物清單、文字日誌 */
function viewData_(token) {
  const v = typeof token === 'string' && /^[a-f0-9]{40}$/.test(token) ? readTable_('Views').find((x) => x.token === token) : null;
  const trip = v ? loadTrips_(v.userId).find((t) => t.id === v.tripId) : null;
  if (!trip) throw apiError_(404, '這個連結已經失效（可能被換新、旅程已刪除，或分享的人已退出旅程）');
  // 旅伴的購物（有填誰付的、或有分給別人的才帶：分帳與每人花費要用；他自己買的不外流）
  const others = (trip.othersShopping || []).map((g) => ({ name: g.name, key: g.key, items: g.items.filter((s) => s.paidBy || (s.splitWith || []).some((k) => k !== g.key)) })).filter((g) => g.items.length);
  delete trip.othersShopping;
  delete trip.othersPacking;
  delete trip.myPacking; // 分享者的個人行李不公開
  delete trip.role;
  delete trip.metroMaps;
  // 成員代號換成這一頁專用的（v0、v1……），分帳照樣算得出來，但不外流真正的代號
  const alias = new Map(trip.members.map((m, i) => [m.key, `v${i}`]));
  const hide = (k) => alias.get(k) || (k ? 'gone' : '');
  for (const a of Object.values(trip.days).flat().concat(trip.shopping || [], trip.expenses || [])) {
    a.paidBy = hide(a.paidBy);
    a.splitWith = a.splitWith.map(hide);
  }
  trip.othersShopping = others.map((g) => ({
    name: g.name, key: hide(g.key),
    items: g.items.map((s) => ({ id: s.id, text: s.text, price: s.price, quantity: s.quantity, priceCurrency: s.priceCurrency, paidBy: hide(s.paidBy), splitWith: s.splitWith.map(hide), done: s.done })),
  }));
  // sharer：產生連結的人（他的購物清單沒填誰付的，每人花費要算在他身上）
  const sharerKey = memberKey_(trip.id, v.userId);
  trip.members = trip.members.map((m) => Object.assign({ name: m.name, role: m.role, key: alias.get(m.key) }, m.key === sharerKey ? { sharer: true } : {}));
  const journal = loadJournal_(v.userId)
    .filter((j) => j.tripId === trip.id && j.type === 'text')
    .map((j) => ({ id: j.id, tripId: j.tripId, date: j.date, time: j.time, type: 'text', text: j.text, author: j.author, mine: false }));
  return { trip, journal };
}

/** 連結對應的旅程（用產生連結那個人的身分讀）；連結不對或已失效回傳 null */
function tripForView_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{40}$/.test(token)) return null;
  const v = readTable_('Views').find((x) => x.token === token);
  return v ? (loadTrips_(v.userId).find((t) => t.id === v.tripId) || null) : null;
}

/* ---------- 備忘（原本叫旅遊日誌） ---------- */
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
  let tripId = str_(entry.tripId, 64);
  if (tripId && !roleIn_(userId, findTripRow_(tripId))) tripId = '';
  // date 明確給空字串、又指定了自己參加的旅程＝整趟旅程通用的備忘
  const date = isValidDate_(entry.date) ? entry.date : (entry.date === '' && tripId ? '' : todayStr_());
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

/** 修改文字備忘（只有作者本人）：內容、日期（空字串＝整趟旅程通用，要有歸屬的旅程） */
function updateJournal_(userId, id, patch) {
  const row = readTable_('Journal').find((j) => j.id === id);
  if (!row) throw apiError_(404, '找不到這則備忘（可能已被刪除）');
  if (row.userId !== userId) throw apiError_(403, '只能修改自己寫的備忘');
  if (row.type !== 'text') throw apiError_(400, '照片不能修改');
  const text = str_(patch && patch.text, 2000).trim();
  if (!text) throw apiError_(400, '備忘內容是空的');
  let date = row.date;
  if (patch && 'date' in patch) {
    if (patch.date === '' && row.tripId) date = '';
    else if (patch.date === '') throw apiError_(400, '這則備忘沒有歸屬的旅程，不能設成整趟通用');
    else if (isValidDate_(patch.date)) date = patch.date;
    else throw apiError_(400, '日期格式錯誤');
  }
  const next = Object.assign({}, row, { text, date });
  replaceRows_('Journal', (j) => j.id === id, [next]);
  return next;
}

/** 作者本人或旅程主人可以刪除 */
function deleteJournal_(userId, id) {
  const rows = readTable_('Journal');
  const row = rows.find((j) => j.id === id);
  if (!row) return null;
  const trip = row.tripId ? findTripRow_(row.tripId) : null;
  if (row.userId !== userId && !(trip && trip.userId === userId)) throw apiError_(403, '只能刪除自己寫的備忘');
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

/* ---------- 地點查詢（Google）：OpenStreetMap 查不到時，網站改請後端用 Google 找 ---------- */
/**
 * 用 Apps Script 內建的 Maps 服務查地點（不用金鑰、不用綁付款帳戶；個人帳號每天約 1,000 次）
 * center：{ lat, lng } 目的地附近，優先找這一帶；dest：目的地名稱（例如「日本東京」）
 * 會試幾種寫法：原文 →「原文 目的地」→ 拿掉後面的分店名（「六歌仙 新宿西口總店」→「六歌仙」）；
 * 離目的地超過 300 公里的結果不採用（同名地點跑到別的城市）。結果快取 6 小時
 * @return {{lat, lng, geoName, area} | null}；查詢失敗（例如額度用完）時 geocodePlace_.lastError = 'quota'
 */
function geocodePlace_(q, center, dest) {
  geocodePlace_.lastError = '';
  const query = str_(q, 200).trim();
  if (!query) return null;
  const c = center && typeof center.lat === 'number' && typeof center.lng === 'number' && Math.abs(center.lat) <= 90 && Math.abs(center.lng) <= 180
    ? { lat: Number(center.lat), lng: Number(center.lng) } : null;
  const place = str_(dest, 60).trim();
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `v2|${query}|${place}|${c ? `${c.lat.toFixed(2)},${c.lng.toFixed(2)}` : ''}`);
  const key = `geo_${Utilities.base64EncodeWebSafe(digest).slice(0, 40)}`;
  const hit = cache.get(key);
  if (hit) return hit === 'none' ? null : JSON.parse(hit);
  const parts = query.split(/[\s　]+/).filter(Boolean);
  const tries = [...new Set([query, place && !query.includes(place) ? `${query} ${place}` : '', parts.length > 1 ? `${parts[0]}${place ? ` ${place}` : ''}` : ''].filter(Boolean))];
  const near = (p) => {
    if (!c) return true;
    const rad = (d) => (d * Math.PI) / 180;
    const h = Math.sin(rad(p.lat - c.lat) / 2) ** 2 + Math.cos(rad(c.lat)) * Math.cos(rad(p.lat)) * Math.sin(rad(p.lng - c.lng) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h)) <= 300;
  };
  for (const t of tries) {
    let res;
    try {
      const g = Maps.newGeocoder().setLanguage('zh-TW');
      if (c) g.setBounds(c.lat - 1.3, c.lng - 1.6, c.lat + 1.3, c.lng + 1.6);
      res = g.geocode(t);
    } catch (err) {
      console.warn('Google 地點查詢失敗', err);
      geocodePlace_.lastError = 'quota';
      return null; // 用完額度或暫時失敗：不快取，下次再試
    }
    const top = res && res.status === 'OK' && (res.results || []).find((r) => r.geometry && r.geometry.location
      && near({ lat: Number(r.geometry.location.lat), lng: Number(r.geometry.location.lng) }));
    if (!top) continue;
    const comp = (type) => ((top.address_components || []).find((x) => (x.types || []).includes(type)) || {}).long_name || '';
    const out = {
      lat: Math.round(Number(top.geometry.location.lat) * 1e6) / 1e6,
      lng: Math.round(Number(top.geometry.location.lng) * 1e6) / 1e6,
      geoName: str_(top.formatted_address || t, 80),
      area: str_(comp('sublocality_level_1') || comp('locality') || comp('administrative_area_level_2') || comp('administrative_area_level_1'), 40),
    };
    if (!(Math.abs(out.lat) <= 90 && Math.abs(out.lng) <= 180)) continue;
    cache.put(key, JSON.stringify(out), 21600);
    return out;
  }
  cache.put(key, 'none', 21600);
  return null;
}

/* ---------- Google 地圖連結 → 座標（短網址要照轉址展開，網頁不能直接讀別的網站的轉址，所以由後端做） ---------- */
const MAP_URL_HOST_RE = /^https:\/\/(?:maps\.app\.goo\.gl|goo\.gl|g\.co|(?:www\.|maps\.)?google\.[a-z.]+)\//i;

/** 網址裡的座標：!3d…!4d…（地點本身）→ q／query／ll／destination=lat,lng → @lat,lng（畫面中心） */
function coordsInMapUrl_(url) {
  const s = String(url || '');
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
    || s.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i)
    || s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } : null;
}

/**
 * 展開 Google 地圖連結（maps.app.goo.gl 短網址等）找出座標；只接受 Google 的網址，最多跟 6 次轉址。結果快取 1 天
 * @return {{lat, lng} | null}
 */
function resolveMapUrl_(url) {
  let u = cleanUrl_(url);
  if (!u || !MAP_URL_HOST_RE.test(u)) return null;
  const direct = coordsInMapUrl_(u);
  if (direct) return direct;
  const cache = CacheService.getScriptCache();
  const key = `murl_${Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, u)).slice(0, 40)}`;
  const hit = cache.get(key);
  if (hit) return hit === 'none' ? null : JSON.parse(hit);
  let out = null;
  for (let i = 0; i < 6 && !out; i++) {
    let res;
    try {
      res = UrlFetchApp.fetch(u, { followRedirects: false, muteHttpExceptions: true, headers: { 'Accept-Language': 'zh-TW' } });
    } catch (err) {
      console.warn('展開地圖連結失敗', err);
      return null; // 連線問題：不快取
    }
    const code = res.getResponseCode();
    const headers = res.getHeaders ? res.getHeaders() : {};
    const loc = headers.Location || headers.location || '';
    if (code >= 300 && code < 400 && loc) {
      u = /^https?:\/\//i.test(loc) ? loc : `https://www.google.com${loc}`;
      if (!MAP_URL_HOST_RE.test(u.replace(/^http:/i, 'https:'))) break; // 轉到不是 Google 的網址就不跟
      out = coordsInMapUrl_(u);
      continue;
    }
    // 不轉址了：從網頁內容找座標（有些頁面把座標放在內容裡）
    if (code === 200) out = coordsInMapUrl_(res.getContentText().slice(0, 200000));
    break;
  }
  cache.put(key, out ? JSON.stringify(out) : 'none', 86400);
  return out;
}
