'use strict';

/* ============================================================
 * 雲端同步：用 LINE 登入後，資料改存在 Google Apps Script（Google 試算表），
 * 與 LINE 官方帳號共用同一份資料。config.js 沒有 apiUrl 時不啟用。
 * ============================================================ */

const API_URL = (window.TRAVEL_CONFIG && window.TRAVEL_CONFIG.apiUrl) || '';
const RELOAD_FLAG = 'travel-planner:auth-reloaded';
const UNSYNCED_KEY = 'travel-planner:unsynced';

const Cloud = {
  enabled: false,
  pending: 0,
  queue: Promise.resolve(),
  photoCache: new Map(),
  // 還沒成功存到雲端的旅程（id → 旅程）：同步失敗會自動重試，也會記在這台裝置，重新整理後補傳
  unsynced: new Map(),
  saving: new Map(), // id → 排隊中的存檔次數
  retryDelay: 0,
  retryTimer: null,

  async call(action, payload = {}) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS 預檢，Apps Script 不支援 OPTIONS
      body: JSON.stringify({ action, idToken: liff.getIDToken(), ...payload }),
    });
    if (!res.ok) throw Object.assign(new Error(`連線失敗（${res.status}）`), { status: res.status });
    const data = await res.json();
    if (!data.ok) throw Object.assign(new Error(data.error || '未知錯誤'), { status: data.status });
    return data;
  },

  /** 依序送出寫入，避免同一個旅程的更新互相覆蓋 */
  enqueue(fn) {
    this.pending++;
    this.setStatus('syncing');
    this.queue = this.queue
      .then(fn)
      .then(() => {
        this.pending--;
        if (!this.pending) this.setStatus(this.unsynced.size ? 'error' : 'saved');
      })
      .catch((err) => {
        this.pending--;
        this.handleError(err);
      });
    return this.queue;
  },

  saveTrip(trip, isRetry = false) {
    this.unsynced.set(trip.id, trip);
    this.saving.set(trip.id, (this.saving.get(trip.id) || 0) + 1);
    this.persistUnsynced();
    return this.enqueue(async () => {
      let saved = false;
      try {
        const r = await this.call('saveTrip', { trip, baseUpdatedAt: trip.updatedAt || '' });
        trip.updatedAt = r.updatedAt;
        saved = true;
        this.retryDelay = 0;
      } catch (err) {
        throw Object.assign(err, { tripId: trip.id, quiet: isRetry });
      } finally {
        const left = this.saving.get(trip.id) - 1;
        this.saving.set(trip.id, left);
        // 後面沒有同一個旅程的存檔在排隊，才算同步完成
        if (saved && !left && this.unsynced.get(trip.id) === trip) this.unsynced.delete(trip.id);
        this.persistUnsynced();
      }
    });
  },

  deleteTrip(id) {
    this.unsynced.delete(id);
    this.persistUnsynced();
    return this.enqueue(() => this.call('deleteTrip', { id }));
  },

  userKey() {
    try {
      return (liff.getDecodedIDToken() || {}).sub || '';
    } catch (err) {
      return '';
    }
  },

  persistUnsynced() {
    try {
      if (!this.unsynced.size) localStorage.removeItem(UNSYNCED_KEY);
      else localStorage.setItem(UNSYNCED_KEY, JSON.stringify({ user: this.userKey(), trips: [...this.unsynced.values()] }));
    } catch (err) { /* 存不了就只靠自動重試 */ }
  },

  /** 登入後把上次沒同步成功的修改補傳；雲端在這期間被改過的就放棄（以雲端為準） */
  restoreUnsynced() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(UNSYNCED_KEY));
    } catch (err) { /* 忽略 */ }
    if (!saved || !Array.isArray(saved.trips) || !saved.user || saved.user !== this.userKey()) return;
    let dropped = 0;
    for (const local of saved.trips) {
      if (!local || typeof local.id !== 'string' || !local.days) continue;
      const i = state.trips.findIndex((t) => t.id === local.id);
      const server = state.trips[i];
      if (server ? server.updatedAt === local.updatedAt : !local.updatedAt) {
        if (server) state.trips[i] = Object.assign(local, { role: server.role, members: server.members });
        else state.trips.push(local);
        this.saveTrip(local);
      } else {
        dropped++;
      }
    }
    if (dropped) toast('上次有未同步的修改，但雲端已經有更新的版本，已改用雲端的資料');
    if (!this.unsynced.size) this.persistUnsynced();
  },

  scheduleRetry() {
    if (this.retryTimer || !this.unsynced.size) return;
    this.retryDelay = Math.min(60000, (this.retryDelay || 2500) * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryUnsynced();
    }, this.retryDelay);
  },

  retryUnsynced() {
    if (!this.enabled) return;
    for (const [id, trip] of this.unsynced) {
      if (!this.saving.get(id)) this.saveTrip(trip, true);
    }
  },

  addJournal(entry) {
    return this.enqueue(() => this.call('addJournal', { entry }));
  },

  deleteJournal(id) {
    return this.enqueue(() => this.call('deleteJournal', { id }));
  },

  /** 產生邀請訊息，開啟 LINE 分享畫面傳給旅伴 */
  async invite(tripId) {
    try {
      await this.queue;
      const r = await this.call('invite', { tripId });
      toast(`邀請碼：${r.code}，選擇要傳給哪位旅伴`);
      openLineShareUrl(r.text);
    } catch (err) {
      this.handleError(err);
    }
  },

  removeMember(tripId, member) {
    return this.enqueue(async () => {
      await this.call('removeMember', { tripId, member });
      toast('已移出旅程');
      this.refresh();
    });
  },

  async profileName() {
    try {
      return (await liff.getProfile()).displayName || '';
    } catch (err) {
      return '';
    }
  },

  async start() {
    this.setStatus('syncing');
    app.innerHTML = '<p class="loading">☁️ 正在從雲端載入旅程……</p>';
    try {
      // 憑證已經過期就不用白跑一趟，直接換新的
      if (this.tokenExpired()) throw Object.assign(new Error('登入已過期'), { status: 401 });
      const data = await this.listWithRetry({ name: await this.profileName() });
      const local = state;
      this.enabled = true;
      state = { trips: data.trips, journal: data.journal };
      document.getElementById('site-footer').textContent = '資料已同步到雲端，LINE 官方帳號也能查詢與修改。';
      sessionStorage.removeItem(RELOAD_FLAG);
      this.setStatus('saved');
      this.restoreUnsynced();
      if (!state.trips.length && local.trips.length
        && confirm(`雲端還沒有旅程。要把這台裝置上的 ${local.trips.length} 個旅程上傳到雲端嗎？`)) {
        for (const t of local.trips) {
          delete t.updatedAt;
          state.trips.push(t);
          this.saveTrip(t);
        }
        for (const j of local.journal || []) {
          if (j.type !== 'text') continue;
          state.journal.push(j);
          this.addJournal(j);
        }
      }
    } catch (err) {
      this.enabled = false;
      this.handleError(err);
    }
    cloudPending = false;
    reportRate();
    openTripFromQuery();
    route();
  },

  /** 載入旅程；後端忙碌或網路不穩時多試幾次（登入過期與權限問題不重試） */
  async listWithRetry(payload) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call('list', payload);
      } catch (err) {
        if (attempt >= 3 || [401, 403].includes(err.status)) throw err;
        console.warn(`載入失敗，第 ${attempt} 次重試`, err);
        app.innerHTML = '<p class="loading">☁️ 雲端有點忙，正在重試……</p>';
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  },

  async refresh() {
    try {
      const data = await this.call('list');
      if (this.pending || document.querySelector('dialog[open]')) return;
      // 還沒同步成功的旅程保留這台裝置上的版本；已經存過、雲端卻沒有的代表被刪除或被移出了
      const ids = new Set(data.trips.map((t) => t.id));
      for (const [id, t] of this.unsynced) {
        if (!ids.has(id) && t.updatedAt) this.unsynced.delete(id);
      }
      this.persistUnsynced();
      state.trips = data.trips.map((t) => this.unsynced.get(t.id) || t)
        .concat([...this.unsynced.values()].filter((t) => !ids.has(t.id)));
      state.journal = data.journal;
      const y = window.scrollY;
      route();
      window.scrollTo(0, y);
    } catch (err) {
      this.handleError(err);
    }
  },

  handleError(err) {
    console.warn('雲端同步錯誤', err);
    if (err.status === 401) return this.relogin();
    if (err.status === 409) {
      if (err.tripId) {
        this.unsynced.delete(err.tripId);
        this.persistUnsynced();
      }
      toast('這個旅程剛在其他地方被更新，已重新載入，請再操作一次');
      return this.refresh();
    }
    this.setStatus('error');
    if (!err.quiet) toast(this.unsynced.size ? '同步失敗，修改先留在這台裝置，會自動重試' : `同步失敗：${err.message}`);
    this.scheduleRetry();
  },

  // LINE 的 ID token 只有 1 小時有效，但 LIFF 在一般瀏覽器會一直留著舊的；過期就要先登出再登入才會換新
  tokenExpired() {
    try {
      const exp = (liff.getDecodedIDToken() || {}).exp;
      return !exp || exp * 1000 < Date.now() + 60 * 1000;
    } catch (err) {
      return true;
    }
  },

  /** 重新取得登入憑證。每個分頁只自動試一次（成功載入後會歸零），避免一直跳去登入 */
  relogin() {
    const tried = sessionStorage.getItem(RELOAD_FLAG);
    if (!tried) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      if (liff.isInClient()) return location.reload(); // LINE 內建瀏覽器：重新開啟就會拿到新的
      if (liff.isLoggedIn()) liff.logout();            // 一般瀏覽器：不先登出的話，登入後拿到的還是舊的
      return liff.login({ redirectUri: location.href });
    }
    this.enabled = false;
    this.setStatus('error');
    const btn = document.getElementById('login-btn');
    if (btn && !liff.isInClient()) btn.hidden = false;
    toast(liff.isInClient() ? '登入驗證失敗，請關閉網頁後重新開啟' : '登入驗證失敗，請按右上角「LINE 登入同步」再登入一次');
  },

  async loadPhotos(root) {
    for (const img of root.querySelectorAll('img[data-file-id]:not([src])')) {
      const id = img.dataset.fileId;
      try {
        if (!this.photoCache.has(id)) this.photoCache.set(id, (await this.call('photo', { fileId: id })).dataUrl);
        img.src = this.photoCache.get(id);
      } catch (err) {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '（照片載入失敗）' }));
      }
    }
  },

  setStatus(s) {
    this.status = s;
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.hidden = false;
    el.dataset.state = s;
    el.textContent = { syncing: '☁️ 同步中…', saved: '☁️ 已同步', error: this.unsynced.size ? '⚠️ 尚未同步，自動重試中' : '⚠️ 同步失敗' }[s] || '';
  },
};

/* ---------- 日幣匯率 ----------
 * 1. 瀏覽器直接向 FinMind 查臺灣銀行現金賣出（FinMind 會封鎖 Google 伺服器，所以不經後端）
 * 2. 查不到再問後端（國際參考匯率）
 * 大致即可：6 小時內查過就不再查 */
const BANK_SOURCE = '臺灣銀行現金賣出';

async function fetchBankRate() {
  const start = fmtDate(new Date(Date.now() - 14 * 86400000));
  const res = await fetch(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=JPY&start_date=${start}`);
  const rows = ((await res.json()).data || []).filter((r) => Number(r.cash_sell) > 0);
  const last = rows[rows.length - 1];
  return last ? { rate: Number(last.cash_sell), date: last.date, source: BANK_SOURCE } : null;
}

// 其他幣別：國際參考匯率（以台幣為基準）
async function fetchReferenceRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/TWD');
  const data = await res.json();
  if (data.result !== 'success') return null;
  const date = fmtDate(new Date(data.time_last_update_unix * 1000));
  const out = {};
  for (const c of CURRENCIES) {
    if (c !== 'TWD' && data.rates[c]) out[c] = { rate: Math.round((1 / data.rates[c]) * 10000) / 10000, date, source: '國際參考匯率' };
  }
  return out;
}

async function fetchServerRate() {
  if (!API_URL) return null;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'rate' }),
  });
  const data = await res.json();
  return data.ok ? data.rate : null;
}

async function loadRate() {
  const jpy = fx.rates.JPY;
  if (jpy && jpy.source === BANK_SOURCE && Date.now() - fx.fetchedAt < 6 * 3600 * 1000) return;
  const [bank, ref] = await Promise.allSettled([fetchBankRate(), fetchReferenceRates()]);
  const rates = { ...((ref.status === 'fulfilled' && ref.value) || {}) };
  if (bank.status === 'fulfilled' && bank.value) rates.JPY = bank.value;
  if (!rates.JPY) {
    try {
      const server = await fetchServerRate();
      if (server) rates.JPY = server;
    } catch (err) {
      console.warn('匯率讀取失敗', err);
    }
  }
  if (!Object.keys(rates).length) return;
  fx = { rates: { ...fx.rates, ...rates }, fetchedAt: Date.now() };
  try {
    localStorage.setItem(FX_KEY, JSON.stringify(fx));
  } catch { /* 忽略 */ }
  reportRate();
  if (!document.querySelector('dialog[open]')) route();
  else updateFareHint();
}

// 把臺銀匯率分享給後端，LINE 機器人也能用（需登入）
function reportRate() {
  const jpy = fx.rates.JPY;
  if (!Cloud.enabled || !jpy || jpy.source !== BANK_SOURCE || Cloud.rateReported) return;
  Cloud.rateReported = true;
  Cloud.call('reportRate', { rate: { rate: jpy.rate, date: jpy.date } }).catch(() => {});
}

loadRate();

// 從 LINE 傳來的連結（?trip=<id>）直接開啟該旅程
function openTripFromQuery() {
  const id = new URLSearchParams(location.search).get('trip');
  if (id && getTrip(id) && location.hash !== `#/trip/${id}`) location.hash = `#/trip/${id}`;
}

// 切回網頁時重新載入，拿到在 LINE 上做的修改
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Cloud.enabled && !Cloud.pending) Cloud.refresh();
});

// 網路恢復時馬上補傳
window.addEventListener('online', () => {
  clearTimeout(Cloud.retryTimer);
  Cloud.retryTimer = null;
  Cloud.retryUnsynced();
});
