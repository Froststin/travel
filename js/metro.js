'use strict';

/* ============================================================
 * 地鐵圖：每趟旅程可以放幾張自己存的路線圖圖片（整個旅程共用）
 *   metroMaps = [{ id, name, image | fileId, mine, byName }]
 *   還沒上傳（或沒登入）：image 是縮小過的 JPEG data URL；上傳後是 fileId（和購物照片同一套，見 js/shopphoto.js）
 *   雲端模式：成員都能新增；只有上傳的人或旅程主人能改名、刪除（後端 mergeMetro_ 也會擋）
 * 各地官方路線圖有著作權，網站不內建，只提供「搜尋官方路線圖」幫忙找
 * ============================================================ */

const MAX_METRO_MAPS = 10;
const metroFile = $('#metro-file');
const metroViewer = $('#metro-viewer');
let metroAdding = false;

/**
 * 常用城市的地鐵圖（目的地或旅程名稱符合時顯示在最上面）
 *   maps：授權允許轉載的圖（直接從 Wikimedia 載入，不存進 repo），圖下註明作者與授權
 *   links：官方路線圖（有著作權，只放連結）
 */
const CITY_METRO = [{
  match: /東京|东京|tokyo/i,
  title: '東京常用地鐵圖',
  note: 'Wikimedia 的圖是 2020 年版，之後新開的路段或改名的車站可能沒有，最新請看官方路線圖。',
  maps: [
    {
      id: 'city-tokyo-ja', name: '東京地鐵路線圖（日文）',
      thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Tokyo_metro_map.png/500px-Tokyo_metro_map.png',
      image: 'https://upload.wikimedia.org/wikipedia/commons/8/8a/Tokyo_metro_map.png',
      page: 'https://commons.wikimedia.org/wiki/File:Tokyo_metro_map.png',
      credit: 'Hisagi（氷鷺）, CC BY-SA 3.0, via Wikimedia Commons',
    },
    {
      id: 'city-tokyo-en', name: '東京地鐵路線圖（英文）',
      thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Tokyo_metro_map_en.png/500px-Tokyo_metro_map_en.png',
      image: 'https://upload.wikimedia.org/wikipedia/commons/5/53/Tokyo_metro_map_en.png',
      page: 'https://commons.wikimedia.org/wiki/File:Tokyo_metro_map_en.png',
      credit: 'Hisagi（氷鷺）, CC BY-SA 3.0, via Wikimedia Commons',
    },
  ],
  links: [
    { name: '東京 Metro 路線圖（英文頁面）', url: 'https://www.tokyometro.jp/en/subwaymap/index.html' },
    { name: '東京 Metro 路線圖 PDF（英文）', url: 'https://www.tokyometro.jp/station/pdf/202305/202305_number_en.pdf' },
    { name: '都營地下鐵 路線圖（東京都交通局）', url: 'https://www.kotsu.metro.tokyo.jp/subway/map/' },
    { name: '都營＋Metro 全路線圖 PDF（日文）', url: 'https://www.kotsu.metro.tokyo.jp/subway/line.pdf' },
    { name: 'JR 東日本 首都圈鐵道＋地鐵路線圖 PDF（英文）', url: 'https://www.jreast.co.jp/e/routemaps/pdf/routemap_majorrailsub.pdf' },
  ],
}];

function cityMetro(t) {
  const text = `${t.destination || ''} ${t.name || ''}`;
  return CITY_METRO.find((c) => c.match.test(text)) || null;
}

function cityMetroPanel(t) {
  const c = cityMetro(t);
  if (!c) return '';
  return `
    <section class="panel">
      <h3>🗾 ${esc(c.title)}</h3>
      <ul class="metro-grid">${c.maps.map((m) => `
        <li class="metro-card">
          <button type="button" class="metro-thumb" data-action="view-city-metro" data-id="${esc(m.id)}" aria-label="放大看 ${esc(m.name)}"><img src="${esc(m.thumb)}" alt="${esc(m.name)}" loading="lazy"></button>
          <div class="metro-meta"><span class="metro-name">${esc(m.name)}</span></div>
          <small class="muted metro-credit">圖：<a href="${esc(m.page)}" target="_blank" rel="noopener">「${esc(m.name)}」${esc(m.credit)}</a>・<a href="https://creativecommons.org/licenses/by-sa/3.0/deed.zh_TW" target="_blank" rel="noopener">CC BY-SA 3.0 授權條款</a></small>
        </li>`).join('')}</ul>
      <p class="muted hint">${esc(c.note)}</p>
      <h4 class="metro-links-title">官方路線圖</h4>
      <ul class="metro-links">${c.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join('')}</ul>
      <p class="muted hint">官方圖有著作權，這裡只放連結；可以下載後用下面的「上傳地鐵圖」存進這趟旅程（離線也能看）。</p>
    </section>`;
}

function canEditMetro(t, m) {
  return !cloudOn() || m.mine !== false || isTripOwner(t);
}

function metroSearchUrl(t) {
  const q = `${(t.destination || t.name || '').trim()} 地鐵路線圖`.trim();
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function metroThumb(m) {
  const src = ShopPhotos.src(m);
  return `<img ${src ? `src="${esc(src)}"` : `data-shop-file="${esc(m.fileId)}"`} alt="${esc(m.name || '地鐵圖')}" loading="lazy">`;
}

function metroView(t) {
  const maps = t.metroMaps || [];
  const full = maps.length >= MAX_METRO_MAPS;
  return `
    ${cityMetroPanel(t)}
    <section class="panel">
      <div class="shop-day-head">
        <div class="packing-summary">共 ${maps.length} 張地鐵圖</div>
        <span class="metro-actions no-print">
          <a class="btn" href="${esc(metroSearchUrl(t))}" target="_blank" rel="noopener">🔍 搜尋官方路線圖</a>
          <button class="btn btn-primary" data-action="add-metro" ${full || metroAdding ? 'disabled' : ''}>${metroAdding ? '處理中…' : '＋ 上傳地鐵圖'}</button>
        </span>
      </div>
      <p class="muted hint">把官方網站下載的路線圖（或截圖）存成圖片上傳，點圖片可以全螢幕放大、拖曳；手機用兩指縮放，電腦用滑鼠滾輪。${cloudOn() ? '旅伴也看得到、也可以新增；只有上傳的人或旅程主人可以改名、刪除。' : '沒登入時圖片存在這台裝置，用 LINE 登入後會上傳到雲端。'}每趟旅程最多 ${MAX_METRO_MAPS} 張。</p>
      ${maps.length ? '' : '<p class="muted shop-empty">還沒有地鐵圖。可以先按「搜尋官方路線圖」找到圖檔，存到手機或電腦後再上傳。</p>'}
    </section>
    ${maps.length ? `<ul class="metro-grid">${maps.map((m) => `
      <li class="metro-card">
        <button type="button" class="metro-thumb" data-action="view-metro" data-id="${esc(m.id)}" aria-label="放大看 ${esc(m.name || '地鐵圖')}">${metroThumb(m)}</button>
        <div class="metro-meta">
          <span class="metro-name">${esc(m.name || '未命名')}</span>
          ${cloudOn() && m.mine === false && m.byName ? `<small class="muted">👤 ${esc(m.byName)}</small>` : ''}
          ${canEditMetro(t, m) ? `<span class="shop-actions no-print">
            <button class="icon-btn" data-action="rename-metro" data-id="${esc(m.id)}" title="改名稱" aria-label="改名稱">✎</button>
            <button class="icon-btn" data-action="delete-metro" data-id="${esc(m.id)}" title="刪除" aria-label="刪除">✕</button>
          </span>` : ''}
        </div>
      </li>`).join('')}</ul>` : ''}`;
}

const MAX_METRO_CHARS = 6000000; // 和後端 MAX_METRO_IMAGE_CHARS 一樣

function fitsInBrowser() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// 路線圖要看得清楚：雲端存在雲端硬碟可以大一點；沒登入時跟著旅程存在瀏覽器裡，空間有限要小一點
function metroImageFromFile(file) {
  return cloudOn() ? compressImage(file, 2400, 0.85) : compressImage(file, 1600, 0.72);
}

metroFile?.addEventListener('change', async () => {
  const file = metroFile.files[0];
  metroFile.value = '';
  const tripId = currentTripId;
  if (!file || !tripId) return;
  metroAdding = true;
  if (currentTab === 'metro') renderTrip(getTrip(tripId));
  try {
    const image = await metroImageFromFile(file);
    if (image.length > MAX_METRO_CHARS) throw new Error('這張圖太大了，請先裁掉不需要的部分或縮小後再上傳');
    const name = (prompt('幫這張地鐵圖取個名字（例如：東京地鐵）', file.name.replace(/\.[^.]+$/, '').slice(0, 30)) || '').trim().slice(0, 30);
    // 雲端模式：先上傳，成功才加進清單（失敗不會留下半成品，也不會卡住整個旅程的同步）
    let fileId = '';
    if (cloudOn()) {
      toast('正在上傳地鐵圖…');
      try {
        ({ fileId } = await Cloud.call('uploadShopImage', { dataUrl: image, kind: 'metro' }));
      } catch (err) {
        throw new Error(`上傳失敗：${err.message}`);
      }
      ShopPhotos.remember(fileId, image);
    }
    const t = getTrip(tripId);
    if (!t) return;
    t.metroMaps ||= [];
    if (t.metroMaps.length >= MAX_METRO_MAPS) return toast(`每趟旅程最多 ${MAX_METRO_MAPS} 張地鐵圖`);
    const entry = fileId ? { id: uid(), name: name || '地鐵圖', fileId, mine: true } : { id: uid(), name: name || '地鐵圖', image, fileId: '', mine: true };
    t.metroMaps.push(entry);
    // 沒登入時圖存在瀏覽器（localStorage 只有幾 MB），先試存一次，放不下就不加
    if (!cloudOn() && !fitsInBrowser()) {
      t.metroMaps = t.metroMaps.filter((x) => x !== entry);
      return toast('瀏覽器的儲存空間不夠放這張圖了。刪掉幾張舊的，或用 LINE 登入改存雲端');
    }
    commitTrip(t);
    toast('已加上地鐵圖');
  } catch (err) {
    toast(err.message || '圖片處理失敗');
  } finally {
    metroAdding = false;
    const t = currentTrip();
    if (t && t.id === tripId && currentTab === 'metro') renderTrip(t);
  }
});

/* ---------- 全螢幕檢視：縮放、拖曳 ---------- */
const metroImg = $('#metro-viewer-img');
const metroStage = $('#metro-stage');
const metroZoom = { scale: 1, x: 0, y: 0, min: 0.1, fit: 1 };
const metroPointers = new Map();
let metroPinch = null;

function applyView() {
  metroImg.style.transform = `translate(${metroZoom.x}px, ${metroZoom.y}px) scale(${metroZoom.scale})`;
}

function fitView() {
  const sw = metroStage.clientWidth;
  const sh = metroStage.clientHeight;
  const iw = metroImg.naturalWidth || 1;
  const ih = metroImg.naturalHeight || 1;
  metroZoom.fit = Math.min(sw / iw, sh / ih, 1);
  metroZoom.min = metroZoom.fit * 0.5;
  metroZoom.scale = metroZoom.fit;
  metroZoom.x = (sw - iw * metroZoom.scale) / 2;
  metroZoom.y = (sh - ih * metroZoom.scale) / 2;
  applyView();
}

// 以畫面上的 (cx, cy) 為中心縮放
function zoomAt(factor, cx, cy) {
  const next = Math.min(4, Math.max(metroZoom.min, metroZoom.scale * factor));
  const k = next / metroZoom.scale;
  metroZoom.x = cx - (cx - metroZoom.x) * k;
  metroZoom.y = cy - (cy - metroZoom.y) * k;
  metroZoom.scale = next;
  applyView();
}

function openMetroViewer(m) {
  const src = ShopPhotos.src(m);
  if (!src) return toast('圖片還在載入，請稍等一下');
  $('#metro-viewer-title').textContent = m.name || '地鐵圖';
  metroImg.onload = fitView;
  metroImg.src = src;
  metroViewer.showModal();
  if (metroImg.complete && metroImg.naturalWidth) fitView();
}

metroViewer?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-metro-zoom]');
  if (!btn) return;
  const z = btn.dataset.metroZoom;
  const cx = metroStage.clientWidth / 2;
  const cy = metroStage.clientHeight / 2;
  if (z === 'close') metroViewer.close();
  else if (z === 'fit') fitView();
  else zoomAt(z === 'in' ? 1.5 : 1 / 1.5, cx, cy);
});

metroStage?.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = metroStage.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

metroStage?.addEventListener('dblclick', (e) => {
  const r = metroStage.getBoundingClientRect();
  if (metroZoom.scale > metroZoom.fit * 1.5) fitView();
  else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
});

metroStage?.addEventListener('pointerdown', (e) => {
  metroStage.setPointerCapture(e.pointerId);
  metroPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (metroPointers.size === 2) {
    const [a, b] = [...metroPointers.values()];
    metroPinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }
});

metroStage?.addEventListener('pointermove', (e) => {
  const prev = metroPointers.get(e.pointerId);
  if (!prev) return;
  const cur = { x: e.clientX, y: e.clientY };
  metroPointers.set(e.pointerId, cur);
  if (metroPointers.size === 1) {
    metroZoom.x += cur.x - prev.x;
    metroZoom.y += cur.y - prev.y;
    applyView();
  } else if (metroPointers.size === 2 && metroPinch) {
    const [a, b] = [...metroPointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const r = metroStage.getBoundingClientRect();
    if (metroPinch.dist > 0) zoomAt(dist / metroPinch.dist, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    metroPinch.dist = dist;
  }
});

for (const type of ['pointerup', 'pointercancel']) {
  metroStage?.addEventListener(type, (e) => {
    metroPointers.delete(e.pointerId);
    if (metroPointers.size < 2) metroPinch = null;
  });
}

/* ---------- 操作 ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const t = currentTrip();
  const m = t && (t.metroMaps || []).find((x) => x.id === el.dataset.id);
  switch (el.dataset.action) {
    case 'add-metro':
      if (!t) break;
      if ((t.metroMaps || []).length >= MAX_METRO_MAPS) { toast(`每趟旅程最多 ${MAX_METRO_MAPS} 張地鐵圖`); break; }
      metroFile?.click();
      break;
    case 'view-metro':
      if (m) openMetroViewer(m);
      break;
    case 'view-city-metro': {
      const c = t && cityMetro(t);
      const cm = c && c.maps.find((x) => x.id === el.dataset.id);
      if (cm) openMetroViewer({ name: `${cm.name}｜${cm.credit}`, image: cm.image }); // 原圖 4000px，從 Wikimedia 載入；標題列帶出處
      break;
    }
    case 'rename-metro': {
      if (!m || !canEditMetro(t, m)) break;
      const name = prompt('地鐵圖的名稱', m.name || '');
      if (name == null) break;
      m.name = name.trim().slice(0, 30) || '地鐵圖';
      commitTrip(t);
      renderTrip(t);
      break;
    }
    case 'delete-metro':
      // 刪掉後雲端的圖檔會丟到垃圾桶，沒辦法復原，所以先問一下
      if (!m || !canEditMetro(t, m) || !confirm(`刪除地鐵圖「${m.name || '未命名'}」？刪除後無法復原。`)) break;
      t.metroMaps = t.metroMaps.filter((x) => x.id !== m.id);
      commitTrip(t);
      renderTrip(t);
      toast('已刪除地鐵圖');
      break;
  }
});
