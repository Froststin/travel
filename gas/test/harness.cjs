/* 測試用：以假的 Google／LINE 服務載入所有 .gs */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

/* ---------- 假服務 ---------- */
function makeSheet() {
  const data = [];
  const sheet = {
    data,
    getLastRow: () => data.length,
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return { setNumberFormat: () => this.getRange(1, 1) };
      return {
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
        getDisplayValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => String((data[r - 1 + i] || [])[c - 1 + j] ?? ''))),
        setValues(vals) {
          vals.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((v, j) => { data[r - 1 + i][c - 1 + j] = v; }); });
          return this;
        },
        clearContent() {
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

const sheets = { Trips: makeSheet(), Activities: makeSheet(), Journal: makeSheet() };
Object.entries(sheets).forEach(([name, sh]) => sh.getRange(1, 1, 1, 1).setValues([[name]]));

const props = { SHEET_ID: 'sheet1', PHOTO_FOLDER_ID: 'folder1', WEBHOOK_KEY: 'k', CHANNEL_ACCESS_TOKEN: 'tok', ALLOWED_USERS: '' };
const sent = [];
const flags = { failFlex: false, today: '2026-10-29' };

const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: {
    formatDate: (d, tz, fmt) => (fmt === 'yyyy-MM-dd' ? flags.today : '14:05'),
    getUuid: () => crypto.randomUUID(),
    computeDigest: (a, s) => [...crypto.createHash('sha256').update(s).digest()],
    base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
    base64Encode: (b) => Buffer.from(b).toString('base64'),
    DigestAlgorithm: { SHA_256: 'sha256' },
  },
  SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  DriveApp: {
    getFolderById: () => ({ createFile: () => ({ getId: () => `file-${sent.length}` }) }),
    getFileById: () => ({ setTrashed() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => [1, 2, 3] }) }),
  },
  ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  UrlFetchApp: {
    fetch(url, opt = {}) {
      if (url.includes('oauth2/v2.1/verify')) {
        const ok = opt.payload.id_token.startsWith('good:');
        return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => JSON.stringify({ sub: opt.payload.id_token.slice(5), exp: Date.now() / 1000 + 3600 }) };
      }
      if (url.includes('/v2/bot/profile/')) {
        const id = url.split('/').pop();
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ displayName: `Name-${id}` }) };
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


module.exports = { ctx, run, sheets, props, sent, flags };
