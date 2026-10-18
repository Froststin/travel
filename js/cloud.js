'use strict';

/* ============================================================
 * 雲端同步：用 LINE 登入後，資料改存在 Google Apps Script（Google 試算表），
 * 與 LINE 官方帳號共用同一份資料。config.js 沒有 apiUrl 時不啟用。
 *
 * 登入：第一次用 LINE 的 ID token（只有 1 小時），後端會發一張 30 天的登入憑證（session），
 *       之後都用它，不用一直重新登入 LINE；登出時後端讓舊的全部失效。
 * 離線：每次從雲端載入成功就在這台裝置留一份，沒網路時先顯示這份，修改等連上後再補傳。
 * ============================================================ */

const API_URL = (window.TRAVEL_CONFIG && window.TRAVEL_CONFIG.apiUrl) || '';
const RELOAD_FLAG = 'travel-planner:auth-reloaded';
const UNSYNCED_KEY = 'travel-planner:unsynced';
const SESSION_KEY = 'travel-planner:session';
const CLOUD_CACHE_KEY = 'travel-planner:cloud-cache';

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
  offline: false,
  session: (() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (err) {
      return null;
    }
  })(),

  hasSession() {
    const s = this.session;
    return !!(s && s.token && s.exp > Date.now() + 60 * 1000);
  },

  saveSession(s) {
    this.session = s || null;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) { /* 存不了就每次用 LINE 的 ID token */ }
  },

  // 有效的登入憑證優先，沒有才用 LINE 的 ID token
  auth() {
    if (this.hasSession()) return { session: this.session.token };
    try {
      return { idToken: liff.getIDToken() || '' };
    } catch (err) {
      return { idToken: '' };
    }
  },

  async call(action, payload = {}) {
    const auth = this.auth();
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS 預檢，Apps Script 不支援 OPTIONS
      body: JSON.stringify({ action, ...auth, ...payload }),
    });
    if (!res.ok) throw Object.assign(new Error(`連線失敗（${res.status}）`), { status: res.status });
    const data = await res.json();
    if (!data.ok) {
      // 憑證失效（例如在別的地方登出了）：丟掉，LINE 的登入還有效就改用它再試一次
      if (data.status === 401 && auth.session) {
        this.saveSession(null);
        if (!this.tokenExpired()) return this.call(action, payload);
      }
      throw Object.assign(new Error(data.error || '未知錯誤'), { status: data.status });
    }
    if (data.session) this.saveSession(data.session);
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
        await this.uploadShopImages(trip);
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

  /** 購物清單和行程裡還沒上傳的照片（image）先傳到雲端，換成檔案 id 再存檔 */
  async uploadShopImages(trip) {
    const shops = () => trip.shopping || [];
    const acts = () => Object.values(trip.days || {}).flat();
    for (const [kind, list] of [['shop', shops], ['activity', acts]]) {
      for (const s of list().filter((x) => x.image && !x.fileId)) {
        const { fileId } = await this.call('uploadShopImage', { dataUrl: s.image, kind });
        if (typeof ShopPhotos !== 'undefined') ShopPhotos.remember(fileId, s.image);
        // 上傳期間資料可能被改過（物件換新的），用 id 和圖片內容找回同一筆
        const cur = list().find((x) => x.id === s.id && x.image === s.image);
        if (cur) {
          cur.fileId = fileId;
          delete cur.image;
        }
      }
    }
  },

  deleteTrip(id) {
    this.unsynced.delete(id);
    this.persistUnsynced();
    return this.enqueue(() => this.call('deleteTrip', { id }));
  },

  userKey() {
    if (this.session && this.session.userId) return this.session.userId;
    try {
      return (liff.getDecodedIDToken() || {}).sub || '';
    } catch (err) {
      return '';
    }
  },

  // 這台裝置留一份雲端的資料，沒網路時先用（空間不夠就算了）
  cacheData(data) {
    try {
      localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify({ user: this.userKey(), at: Date.now(), trips: data.trips, journal: data.journal }));
    } catch (err) {
      try {
        localStorage.removeItem(CLOUD_CACHE_KEY);
      } catch (e) { /* 忽略 */ }
    }
  },

  cachedData() {
    try {
      const c = JSON.parse(localStorage.getItem(CLOUD_CACHE_KEY));
      return c && c.user && c.user === this.userKey() && Array.isArray(c.trips) ? c : null;
    } catch (err) {
      return null;
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
      // 沒有登入憑證、LINE 的也過期了，就不用白跑一趟，直接重新登入
      if (!this.hasSession() && this.tokenExpired()) throw Object.assign(new Error('登入已過期'), { status: 401 });
      let data;
      try {
        data = await this.listWithRetry({ name: await this.profileName() });
      } catch (err) {
        // 連不上（沒網路、後端掛了）：有上次的資料就先用
        const cached = ![401, 403].includes(err.status) && this.cachedData();
        if (!cached) throw err;
        data = cached;
        this.offline = true;
      }
      const local = state;
      this.enabled = true;
      state = { trips: data.trips, journal: data.journal };
      if (this.offline) {
        const at = new Date(data.at);
        toast(`📴 連不上雲端，先顯示 ${at.getMonth() + 1}/${at.getDate()} ${fmtTime(at)} 的資料，修改會在連上後補傳`, { duration: 5000 });
      } else {
        this.cacheData(data);
      }
      document.getElementById('site-footer').hidden = true;
      sessionStorage.removeItem(RELOAD_FLAG);
      this.setStatus(this.offline ? 'offline' : 'saved');
      this.showAccount();
      this.restoreUnsynced();
      if (!this.offline && !state.trips.length && local.trips.length
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
        if (attempt >= 3 || [401, 403].includes(err.status) || !navigator.onLine) throw err;
        console.warn(`載入失敗，第 ${attempt} 次重試`, err);
        app.innerHTML = '<p class="loading">☁️ 雲端有點忙，正在重試……</p>';
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  },

  async refresh() {
    try {
      const data = await this.call('list');
      this.cacheData(data);
      if (this.offline) {
        this.offline = false;
        this.setStatus(this.unsynced.size ? 'error' : 'saved');
        this.retryUnsynced();
        toast('☁️ 已重新連上雲端');
      }
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
      if (this.offline && !err.status) return; // 還是連不上，維持離線模式
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
    this.saveSession(null);
    if (!liffReady) {
      this.enabled = false;
      this.setStatus('error');
      return toast('登入已過期，請連上網路後重新整理，再用 LINE 登入');
    }
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
    if (this.offline && s !== 'syncing') s = 'offline';
    el.dataset.state = s;
    el.textContent = {
      syncing: '☁️ 同步中…', saved: '☁️ 已同步', offline: `📴 離線${this.unsynced.size ? `・${this.unsynced.size} 個待同步` : ''}`,
      error: this.unsynced.size ? '⚠️ 尚未同步，自動重試中' : '⚠️ 同步失敗',
    }[s] || '';
  },

  // 登入後才有「登出」（LINE 裡開的網站不需要）
  showAccount() {
    const btn = document.getElementById('logout-btn');
    let inLine = false;
    try {
      inLine = liffReady && liff.isInClient();
    } catch (err) { /* 忽略 */ }
    if (btn) btn.hidden = inLine;
  },

  async logout() {
    const left = this.unsynced.size;
    if (!confirm(`確定要登出嗎？${left ? `\n還有 ${left} 個旅程的修改沒同步到雲端，登出後會不見。` : ''}\n之後要再用 LINE 登入才看得到雲端的旅程。`)) return;
    try {
      await this.queue;
      await this.call('logout');
    } catch (err) {
      console.warn('登出時通知後端失敗', err);
    }
    this.saveSession(null);
    try {
      localStorage.removeItem(CLOUD_CACHE_KEY);
      localStorage.removeItem(UNSYNCED_KEY);
    } catch (err) { /* 忽略 */ }
    try {
      if (liffReady && liff.isLoggedIn()) liff.logout();
    } catch (err) { /* 忽略 */ }
    location.reload();
  },
};

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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
  else {
    updateFareHint();
    if (typeof updateCostHint === 'function') updateCostHint();
  }
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

// 網路恢復時馬上補傳；離線模式就重新載入雲端
window.addEventListener('online', () => {
  clearTimeout(Cloud.retryTimer);
  Cloud.retryTimer = null;
  if (Cloud.offline) Cloud.refresh();
  else Cloud.retryUnsynced();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="logout"]')) Cloud.logout();
});
