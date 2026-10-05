'use strict';

/* ============================================================
 * 購物清單的照片
 *   還沒上傳（或沒登入）：item.image 是縮小過的 JPEG data URL，跟著旅程存在這台裝置
 *   已上傳到雲端：item.fileId 是 Google 雲端硬碟的檔案 id，照片內容另外讀
 * 讀過的照片會記在這台裝置（IndexedDB），下次開啟不用再跟雲端要。
 * ============================================================ */

const ShopPhotos = {
  mem: new Map(),      // fileId → data URL
  missing: new Set(),  // 這次開啟期間讀不到的，不要一直重試
  busy: new Set(),
  dbPromise: null,

  db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('travel-planner-photos', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('photos');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (err) {
          resolve(null); // 無痕模式等情況沒有 IndexedDB，就只記在記憶體
        }
      });
    }
    return this.dbPromise;
  },

  async dbGet(id) {
    const db = await this.db();
    if (!db) return '';
    return new Promise((resolve) => {
      const req = db.transaction('photos').objectStore('photos').get(id);
      req.onsuccess = () => resolve(req.result || '');
      req.onerror = () => resolve('');
    });
  },

  async dbSet(id, dataUrl) {
    const db = await this.db();
    if (!db) return;
    try {
      db.transaction('photos', 'readwrite').objectStore('photos').put(dataUrl, id);
    } catch (err) { /* 空間不夠就算了 */ }
  },

  remember(fileId, dataUrl) {
    this.mem.set(fileId, dataUrl);
    this.dbSet(fileId, dataUrl);
  },

  /** 這個項目現在可以直接顯示的圖（沒有就回傳空字串，等 load 補上） */
  src(item) {
    return item.image || this.mem.get(item.fileId) || '';
  },

  /** 把一批 fileId 的照片準備好：先看這台裝置記過的，沒有的再分批跟雲端要 */
  async fetch(ids) {
    const want = [...new Set(ids)].filter((id) => id && !this.mem.has(id) && !this.missing.has(id) && !this.busy.has(id));
    want.forEach((id) => this.busy.add(id));
    try {
      for (const id of want) {
        const saved = await this.dbGet(id);
        if (saved) this.mem.set(id, saved);
      }
      const remote = want.filter((id) => !this.mem.has(id));
      for (let i = 0; i < remote.length && cloudOn(); i += 5) {
        const batch = remote.slice(i, i + 5);
        try {
          const { photos } = await Cloud.call('shopPhotos', { fileIds: batch });
          batch.forEach((id) => (photos[id] ? this.remember(id, photos[id]) : this.missing.add(id)));
        } catch (err) {
          console.warn('購物照片讀取失敗', err);
          break;
        }
      }
    } finally {
      want.forEach((id) => this.busy.delete(id));
    }
  },

  /** 畫面畫好後呼叫：把還沒有圖的 <img data-shop-file> 補上 */
  async load(root) {
    const pending = () => [...root.querySelectorAll('img[data-shop-file]:not([src])')];
    const ids = pending().map((img) => img.dataset.shopFile);
    if (!ids.length) return;
    await this.fetch(ids);
    for (const img of pending()) {
      const src = this.mem.get(img.dataset.shopFile);
      if (src) img.src = src;
      else if (this.missing.has(img.dataset.shopFile)) img.closest('.shop-photo, .shop-thumb')?.classList.add('failed');
    }
  },
};

/** 把使用者選的照片縮小成 JPEG data URL（長邊 maxSide 像素） */
async function compressImage(file, maxSide, quality) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('請選擇圖片檔');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('這張圖片打不開，請換一張（HEIC 請先轉成 JPG）'));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // 透明背景的 PNG 轉 JPEG 時補白底
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 雲端模式照片存在雲端硬碟，可以大一點；沒登入時跟著旅程存在瀏覽器裡，空間有限要小一點
function shopImageFromFile(file) {
  return cloudOn() ? compressImage(file, 1000, 0.78) : compressImage(file, 560, 0.7);
}
