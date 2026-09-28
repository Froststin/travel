'use strict';

/* ============================================================
 * 雲端同步：用 LINE 登入後，資料改存在 Google Apps Script（Google 試算表），
 * 與 LINE 官方帳號共用同一份資料。config.js 沒有 apiUrl 時不啟用。
 * ============================================================ */

const API_URL = (window.TRAVEL_CONFIG && window.TRAVEL_CONFIG.apiUrl) || '';
const RELOAD_FLAG = 'travel-planner:auth-reloaded';

const Cloud = {
  enabled: false,
  pending: 0,
  queue: Promise.resolve(),
  photoCache: new Map(),

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
        if (!this.pending) this.setStatus('saved');
      })
      .catch((err) => {
        this.pending--;
        this.handleError(err);
      });
    return this.queue;
  },

  saveTrip(trip) {
    return this.enqueue(async () => {
      const r = await this.call('saveTrip', { trip, baseUpdatedAt: trip.updatedAt || '' });
      trip.updatedAt = r.updatedAt;
    });
  },

  deleteTrip(id) {
    return this.enqueue(() => this.call('deleteTrip', { id }));
  },

  addJournal(entry) {
    return this.enqueue(() => this.call('addJournal', { entry }));
  },

  deleteJournal(id) {
    return this.enqueue(() => this.call('deleteJournal', { id }));
  },

  async start() {
    this.setStatus('syncing');
    app.innerHTML = '<p class="loading">☁️ 正在從雲端載入旅程……</p>';
    try {
      const data = await this.call('list');
      const local = state;
      this.enabled = true;
      state = { trips: data.trips, journal: data.journal };
      document.getElementById('site-footer').textContent = '資料已同步到雲端，LINE 官方帳號也能查詢與修改。';
      sessionStorage.removeItem(RELOAD_FLAG);
      this.setStatus('saved');
      if (!data.trips.length && local.trips.length
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
    openTripFromQuery();
    route();
  },

  async refresh() {
    try {
      const data = await this.call('list');
      if (this.pending || document.querySelector('dialog[open]')) return;
      state.trips = data.trips;
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
      toast('這個旅程剛在 LINE 上被更新，已重新載入，請再操作一次');
      return this.refresh();
    }
    this.setStatus('error');
    toast(`同步失敗：${err.message}`);
  },

  relogin() {
    if (!liff.isInClient()) return liff.login({ redirectUri: location.href });
    if (!sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, '1');
      return location.reload();
    }
    this.setStatus('error');
    toast('登入驗證失敗，請關閉網頁後重新開啟');
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
    el.textContent = { syncing: '☁️ 同步中…', saved: '☁️ 已同步', error: '⚠️ 同步失敗' }[s] || '';
  },
};

// 從 LINE 傳來的連結（?trip=<id>）直接開啟該旅程
function openTripFromQuery() {
  const id = new URLSearchParams(location.search).get('trip');
  if (id && getTrip(id) && location.hash !== `#/trip/${id}`) location.hash = `#/trip/${id}`;
}

// 切回網頁時重新載入，拿到在 LINE 上做的修改
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Cloud.enabled && !Cloud.pending) Cloud.refresh();
});
