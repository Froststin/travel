/* 測試用：以假的 Google／LINE 服務載入所有 .gs */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

/* ---------- 假服務 ---------- */
// writes：記錄每次寫入／清空了哪幾列；flags.failWriteIn = n 時，第 n 次寫入會失敗（模擬逾時）
const writes = [];
function logWrite(name, op, row, count) {
  if (flags.failWriteIn > 0 && --flags.failWriteIn === 0) throw new Error('模擬寫入失敗');
  writes.push({ sheet: name, op, row, count });
}

function makeSheet(name) {
  const data = [];
  let maxRows = 20; // 故意設很小，確認寫入前會先補足列數
  const sheet = {
    data,
    getLastRow: () => data.length,
    getMaxRows: () => maxRows,
    insertRowsAfter(after, n) { maxRows += n; },
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return { setNumberFormat: () => this.getRange(1, 1) };
      return {
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => String((data[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        setValues(vals) {
          if (r - 1 + vals.length > maxRows) throw new Error('範圍超出工作表的列數');
          logWrite(name, 'set', r, vals.length);
          vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; }); });
          return this;
        },
        clearContent() {
          logWrite(name, 'clear', r, nr);
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = '';
          while (data.length && data[data.length - 1].every((v) => v === '')) data.pop();
          return this;
        },
      };
    },
    setName() { return this; },
    setFrozenRows() {},
  };
  return sheet;
}

const flags = { failFlex: false, today: '2026-10-29', finmindBanned: false, failWriteIn: 0 };
const sheets = { Trips: makeSheet('Trips'), Activities: makeSheet('Activities'), Journal: makeSheet('Journal') };
Object.entries(sheets).forEach(([name, sh]) => sh.getRange(1, 1, 1, 1).setValues([[name]]));

const props = { SHEET_ID: 'sheet1', PHOTO_FOLDER_ID: 'folder1', WEBHOOK_KEY: 'k', CHANNEL_ACCESS_TOKEN: 'tok', ALLOWED_USERS: '' };
const sent = [];
const cache = new Map();
const files = [];
const lockLog = [];

const folderSeq = {};
const folderParents = {}; // 資料夾 id → 建在哪個資料夾裡（空字串＝最上層）
function newFolder(name, parentId) {
  const n = (folderSeq[name] = (folderSeq[name] || 0) + 1);
  const id = n === 1 ? `folder-${name}` : `folder-${name}-${n}`;
  folderParents[id] = parentId;
  return makeFolder(id);
}
// 建立的檔案都記在 files，測試可以檢查內容、放在哪個資料夾、分享設定與是否被丟到垃圾桶
function makeFolder(folderId) {
  return {
    getId: () => folderId,
    createFolder: (name) => newFolder(name, folderId),
    isTrashed: () => (flags.trashedFolders || []).includes(folderId),
    createFile: (blob) => {
      const file = { id: `drivefile-${files.length}-${sent.length}`, folderId, blob, sharing: null, trashed: false,
        getId() { return this.id; }, getUrl() { return `https://drive.google.com/file/d/${this.id}/view`; },
        setSharing(a, p) { this.sharing = `${a}/${p}`; return this; }, setTrashed(v) { this.trashed = v; return this; },
        getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => [1, 2, 3] }) };
      files.push(file);
      return file;
    },
  };
}

const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: {
    formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM-dd' ? flags.today : '14:05'),
    getUuid: () => crypto.randomUUID(),
    newBlob: (content, type, name) => {
      const blob = { content, type, name, getAs(t) { lockLog.push('pdf'); if (flags.failPdf) throw new Error('轉檔失敗'); return { ...blob, type: t, setName(n) { this.name = n; return this; } }; } };
      return blob;
    },
    computeDigest: (a, s) => [...crypto.createHash('sha256').update(s).digest()],
    base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
    base64Encode: (b) => Buffer.from(b).toString('base64'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')],
    DigestAlgorithm: { SHA_256: 'sha256' },
  },
  SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) }) },
  // lockLog 記錄拿鎖、放鎖與鎖內做的慢事，測試用來確認慢的事都在鎖外面
  LockService: { getScriptLock: () => ({
    waitLock() { if (flags.lockBusy) throw new Error('Lock timeout'); lockLog.push('lock'); },
    releaseLock() { lockLog.push('unlock'); },
  }) },
  // 只有 postback 暫存（pb_）與照片上傳紀錄（up_）真的存起來；其他（登入、匯率）維持不快取，每次測試都重新查
  CacheService: { getScriptCache: () => ({
    get: (k) => (/^(pb_|up_|invest_rid_)/.test(k) && cache.has(k) ? cache.get(k) : null),
    put(k, v) { cache.set(k, v); },
    remove(k) { cache.delete(k); },
  }) },
  DriveApp: {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    // 第一次建立的資料夾 id 是 folder-<名稱>，同名再建一次是 folder-<名稱>-2……
    createFolder: (name) => newFolder(name, ''),
    // flags.missingFolders：模擬資料夾被永久刪除；flags.trashedFolders：模擬被丟到垃圾桶
    getFolderById: (folderId) => {
      if ((flags.missingFolders || []).includes(folderId)) throw new Error('No item with the given ID could be found');
      return makeFolder(folderId);
    },
    // flags.sheetParent：試算表所在的資料夾 id（空＝在雲端硬碟最上層）；flags.sheetMissing：查不到試算表
    getFileById: (id) => {
      if (id === props.SHEET_ID) {
        if (flags.sheetMissing) throw new Error('No item with the given ID could be found');
        const list = flags.sheetParent ? [makeFolder(flags.sheetParent)] : [];
        return { getParents: () => ({ hasNext: () => list.length > 0, next: () => list.shift() }) };
      }
      return files.find((f) => f.id === id) || { setTrashed() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => [1, 2, 3] }) };
    },
  },
  ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  UrlFetchApp: {
    fetch(url, opt = {}) {
      if (url.includes('oauth2/v2.1/verify')) {
        const ok = opt.payload.id_token.startsWith('good:');
        return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => JSON.stringify({ sub: opt.payload.id_token.slice(5), exp: Date.now() / 1000 + 3600 }) };
      }
      if (url.includes('open.er-api.com')) {
        const twdBase = url.endsWith('/TWD');
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ rates: twdBase ? { JPY: 4.953, USD: 0.0315 } : { TWD: 0.2019 }, time_last_update_unix: 1790553600 }) };
      }
      if (url.includes('finmindtrade')) flags.finmindCalls = (flags.finmindCalls || 0) + 1;
      if (url.includes('finmindtrade') && flags.finmindBanned) {
        return { getResponseCode: () => 403, getContentText: () => '{"msg":"ip banned"}' };
      }
      if (url.includes('finmindtrade')) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ data: [{ date: '2026-09-23', cash_sell: 0.2045 }, { date: '2026-09-24', cash_sell: 0.2044 }] }) };
      }
      if (url.includes('/v2/bot/profile/')) {
        const id = url.split('/').pop();
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ displayName: `Name-${id}` }) };
      }
      if (url.endsWith('.png')) {
        return { getResponseCode: () => (flags.menuImageMissing ? 404 : 200), getBlob: () => ({ getBytes: () => [1, 2, 3] }) };
      }
      if (url.includes('/richmenu/') && url.includes('/content')) {
        sent.push({ url, body: null });
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      }
      if (url.endsWith('/v2/bot/richmenu')) {
        sent.push({ url, body: JSON.parse(opt.payload) });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ richMenuId: `menu-${sent.length}` }) };
      }
      if (url.includes('/content')) {
        return { getResponseCode: () => 200, getBlob: () => ({ getContentType: () => 'image/jpeg', setName() { return this; } }) };
      }
      const body = opt.payload ? JSON.parse(opt.payload) : null;
      const hasFlex = body && body.messages && body.messages.some((m) => m.type === 'flex');
      if (flags.failFlex && hasFlex) return { getResponseCode: () => 400, getContentText: () => 'bad flex' };
      sent.push({ url, body });
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    },
  },
};
vm.createContext(ctx);
const dir = path.join(__dirname, '..');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gs'))) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const run = (code) => vm.runInContext(code, ctx);
run('var __clearCache = () => { for (const k in tableCache_) delete tableCache_[k]; }');


module.exports = { ctx, run, sheets, props, sent, flags, writes, cache, files, lockLog, folderParents };
