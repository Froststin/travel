'use strict';

/* ============================================================
 * 地圖分頁：把行程的地點釘在地圖上（Leaflet＋OpenStreetMap，免費、不用金鑰）
 *  - 每一天一個顏色，圖釘標當天的順序（1、2、3…），同一天依行程順序用直線連起來
 *  - 「想去」清單裡已定位、還沒排進行程的地點用灰色圖釘
 *  - 「鐵道」開關疊上 OpenRailwayMap 的鐵路／地鐵路線
 * 座標：Google 地圖連結裡有座標就直接用；否則用 OpenStreetMap 查「地點」（和想去清單同一套，見 js/places.js），
 *       查到的存在行程上（lat、lng、geo、geoKey），旅伴不用再查；geoKey 是查的時候的「地點|連結」，改了就重查
 * Leaflet 只在打開地圖分頁時才載入，不拖慢其他畫面
 * Google 地圖：選某一天時改顯示 Google 的路線圖，依行程時間順序從第 1 站到最後一站沿道路畫線；「全部」與想去清單維持 Leaflet
 *   - 沒金鑰：用 Google 早期不用金鑰的嵌入網址（output=embed）。不是公開保證的功能，失效時用下方的 App 連結
 *   - 登入後後端有給金鑰（指令碼屬性 GOOGLE_MAPS_KEY）：改用官方 Maps Embed API（免費、不限次數，但要綁付款帳戶）
 * ============================================================ */

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
// 子資源完整性（cdnjs 公布的 SRI），CDN 上的檔案被改過瀏覽器就不會執行
const LEAFLET_CSS_SRI = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';
const LEAFLET_JS_SRI = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
const DAY_COLORS = ['#0f766e', '#db2777', '#2563eb', '#ea580c', '#7c3aed', '#16a34a', '#ca8a04', '#0891b2', '#be123c', '#4f46e5'];
const MAP_GEO_RETRY_MS = 60 * 1000; // 定位失敗（連線問題）後，多久內不自動重試

const GMAP_MODES = { driving: '🚗 開車', walking: '🚶 步行', transit: '🚆 大眾運輸' };
const GMAP_MODE_KEY = 'travel-planner:gmap-mode';
const GMAP_MAX_WAYPOINTS = 20; // Embed API 的中途站上限
let gmapMode = (() => {
  try {
    const m = localStorage.getItem(GMAP_MODE_KEY);
    return Object.hasOwn(GMAP_MODES, m) ? m : 'driving';
  } catch {
    return 'driving';
  }
})();
let leafletPromise = null;
let tripMap = null;         // { map, el, tripId, layer, rail }
let mapDay = 'all';         // 'all' 或日期
let mapShowPlaces = true;
let mapRail = false;
let mapGeoStatus = '';      // 定位中的進度文字
let mapGeoBusy = false;
const mapGeoFailed = new Map(); // tripId → 上次定位失敗的時間
const mapViews = new Map();     // `${tripId}|${day}` → { center, zoom }：重新畫面時維持原本看的位置

function dayColor(i) {
  return DAY_COLORS[i % DAY_COLORS.length];
}

// 定位用的「地點|連結」：兩者都沒變，之前查到的座標才算數
function actGeoKey(a) {
  return `${(a.location || '').trim()}|${(a.mapUrl || '').trim()}`;
}

/**
 * 一個行程在地圖上的狀態：
 *   ok＝有座標（{ lat, lng }）、none＝找不到、todo＝還沒定位、skip＝沒有地點也沒有連結（不放在地圖上）
 */
function actGeo(a) {
  const loc = (a.location || '').trim();
  if (!loc && !(a.mapUrl || '').trim()) return { state: 'skip' };
  const fromUrl = typeof coordsFromMapUrl === 'function' ? coordsFromMapUrl(a.mapUrl) : null;
  if (fromUrl) return { state: 'ok', ...fromUrl };
  if (a.geoKey === actGeoKey(a)) {
    if (a.geo === 'ok' && a.lat !== '' && a.lng !== '' && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng))) {
      return { state: 'ok', lat: Number(a.lat), lng: Number(a.lng) };
    }
    if (a.geo === 'none') return { state: 'none' };
  }
  return { state: loc ? 'todo' : 'none' }; // 只有短網址（沒有座標）又沒填地點，查不到
}

/** 每一天已定位的行程：[{ date, dayIdx, color, points: [{ a, n, lat, lng }] }] */
function mapDays(t, dates) {
  return dates.map((date, dayIdx) => {
    let n = 0;
    const points = (t.days[date] || []).map((a) => ({ a, g: actGeo(a) })).filter((x) => x.g.state === 'ok')
      .map((x) => ({ a: x.a, n: ++n, lat: x.g.lat, lng: x.g.lng }));
    return { date, dayIdx, color: dayColor(dayIdx), points };
  });
}

/* ---------- Google 地圖（每天一張路線圖） ---------- */
function mapsKey() {
  return (typeof Cloud !== 'undefined' && Cloud.enabled && Cloud.mapsKey) || '';
}

// 這天依行程順序（時間）有地點的站：已定位用座標（最準），否則用地點文字讓 Google 自己找
// 地點文字裡的「|」（官方版的中途站分隔）和「to:」（舊版嵌入的中途站分隔）換成空白，免得一站被拆成兩站
function gmapStops(t, d) {
  return (t.days[d] || []).map((a) => {
    const g = actGeo(a);
    if (g.state === 'ok') return { a, q: `${g.lat},${g.lng}` };
    const loc = (a.location || '').replace(/\|/g, ' ').replace(/\bto:/gi, 'to ').trim();
    return loc ? { a, q: loc } : null;
  }).filter(Boolean);
}

// 這天有地點、但沒畫進路線的行程數（只貼了短網址、也沒填地點文字）
function gmapSkipped(t, d) {
  return (t.days[d] || []).filter((a) => (a.location || a.mapUrl) && actGeo(a).state !== 'ok' && !(a.location || '').trim()).length;
}

// 大眾運輸不支援中途站，超過兩站時改用開車
function gmapModeFor(stops) {
  return gmapMode === 'transit' && stops.length > 2 ? 'driving' : gmapMode;
}

// 真正畫進路線的站：起點＋最多 20 個中途站＋終點
function gmapDrawn(stops) {
  return stops.length - 2 > GMAP_MAX_WAYPOINTS ? stops.slice(0, GMAP_MAX_WAYPOINTS + 1).concat(stops.slice(-1)) : stops;
}

/**
 * 嵌入用的網址。有金鑰：官方 Maps Embed API（免費、不限次數，但要綁付款帳戶）；
 * 沒金鑰：Google 早期的嵌入網址（output=embed，不用金鑰；不是公開保證的功能，哪天可能失效）
 */
function gmapEmbedUrl(key, stops, mode) {
  const s = gmapDrawn(stops);
  const last = s[s.length - 1];
  if (key) {
    if (s.length === 1) return `https://www.google.com/maps/embed/v1/place?${new URLSearchParams({ key, q: last.q, language: 'zh-TW' })}`;
    const p = new URLSearchParams({ key, origin: s[0].q, destination: last.q, mode, language: 'zh-TW' });
    if (s.length > 2) p.set('waypoints', s.slice(1, -1).map((x) => x.q).join('|'));
    return `https://www.google.com/maps/embed/v1/directions?${p}`;
  }
  if (s.length === 1) return `https://www.google.com/maps?${new URLSearchParams({ q: last.q, hl: 'zh-TW', output: 'embed' })}`;
  // daddr：第二站起用「 to:」串起來；dirflg：d 開車、w 步行、r 大眾運輸
  const daddr = s.slice(1).map((x) => x.q).join(' to:');
  return `https://maps.google.com/maps?${new URLSearchParams({ saddr: s[0].q, daddr, dirflg: { driving: 'd', walking: 'w', transit: 'r' }[mode] || 'd', hl: 'zh-TW', output: 'embed' })}`;
}

// 打開 Google 地圖（App）規劃這天的路線（網址最多 9 個中途站）
const GMAP_LINK_MAX_WAYPOINTS = 9;
function gmapOpenUrl(stops, mode) {
  if (!stops.length) return '';
  const p = new URLSearchParams({ api: '1', destination: stops[stops.length - 1].q, travelmode: mode });
  if (stops.length > 1) p.set('origin', stops[0].q);
  const mids = stops.slice(1, -1).slice(0, GMAP_LINK_MAX_WAYPOINTS);
  if (mids.length) p.set('waypoints', mids.map((s) => s.q).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}

function gmapDayHtml(t, d, dayIdx) {
  const key = mapsKey();
  const stops = gmapStops(t, d);
  const drawn = gmapDrawn(stops);
  const mode = gmapModeFor(stops);
  const color = dayColor(dayIdx);
  const skipped = gmapSkipped(t, d);
  const modes = Object.entries(GMAP_MODES).map(([k, label]) => {
    const off = k === 'transit' && stops.length > 2;
    return `<button type="button" class="map-day${mode === k ? ' on' : ''}" data-action="gmap-mode" data-mode="${k}" ${off ? 'disabled title="大眾運輸不支援中途站，只有兩站時能用"' : ''} aria-pressed="${mode === k}">${label}</button>`;
  }).join('');
  const offline = navigator.onLine === false;
  return `
    <div class="map-days gmap-modes no-print" role="group" aria-label="路線的交通方式">${modes}</div>
    ${offline ? '<p class="trip-map map-loading muted">📴 離線中，地圖需要網路。</p>'
      : stops.length
        ? `<iframe class="trip-map gmap" title="Day ${dayIdx + 1} 的 Google 路線圖" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" src="${esc(gmapEmbedUrl(key, stops, mode))}"></iframe>`
        : '<p class="map-loading muted">這天的行程還沒有填地點。</p>'}
    ${drawn.length ? `<ol class="gmap-stops" style="--day:${color}">${drawn.map((s) => `<li>${s.a.time ? `<span class="muted">${esc(timeLabel(s.a))}</span> ` : ''}${esc(s.a.title)}</li>`).join('')}</ol>` : ''}
    <p class="muted hint">Google 地圖依行程時間順序，從第 1 站經過中途站到最後一站畫出實際路線（地圖上的 A、B、C… 對應上面的順序）。
      ${gmapMode === 'transit' && stops.length > 2 ? '大眾運輸不支援中途站，這天超過兩站，先用開車路線顯示。' : ''}
      ${drawn.length < stops.length ? `中途站最多 ${GMAP_MAX_WAYPOINTS} 個，有 ${stops.length - drawn.length} 站沒有畫進去。` : ''}
      ${skipped ? `有 ${skipped} 個行程只貼了短網址、沒填地點，沒畫進路線（填上地點就會出現）。` : ''}
      ${key ? '' : '路線圖用的是 Google 不用金鑰的嵌入方式，哪天如果顯示不出來，請改用下面的連結。'}
      ${stops.length ? `<a href="${esc(gmapOpenUrl(stops, mode))}" target="_blank" rel="noopener">在 Google 地圖 App 開啟這天的路線</a>${stops.length - 2 > GMAP_LINK_MAX_WAYPOINTS ? `（App 連結最多帶 ${GMAP_LINK_MAX_WAYPOINTS} 個中途站）` : ''}` : ''}</p>`;
}

function mapPlaces(t) {
  return (t.places || []).filter((p) => p.geo === 'ok' && typeof p.lat === 'number' && typeof p.lng === 'number' && !(typeof placeDate === 'function' && placeDate(t, p)));
}

/* ---------- 畫面 ---------- */
function mapView(t, dates) {
  if (mapDay !== 'all' && !dates.includes(mapDay)) mapDay = 'all';
  const days = mapDays(t, dates);
  const all = allActivities(t).map((a) => ({ a, s: actGeo(a).state }));
  const located = all.filter((x) => x.s === 'ok').length;
  const missing = dates.flatMap((d, i) => (t.days[d] || []).filter((a) => actGeo(a).state === 'none').map((a) => ({ a, d, i })));
  const todo = all.filter((x) => x.s === 'todo').length;
  const skip = all.filter((x) => x.s === 'skip').length;
  const chip = (key, label, color) => `<button type="button" class="map-day${mapDay === key ? ' on' : ''}" data-action="map-day" data-day="${key}"${color ? ` style="--day:${color}"` : ''} aria-pressed="${mapDay === key}">${label}</button>`;
  // 選某一天：一律用 Google 路線圖（有金鑰用官方版，沒有就用不用金鑰的嵌入）；「全部」用 Leaflet
  const google = mapDay !== 'all';
  const dayIdx = dates.indexOf(mapDay);
  return `
    <section class="panel map-panel">
      <div class="map-days" role="group" aria-label="看哪一天">
        ${chip('all', '全部')}${days.map((d) => chip(d.date, `Day ${d.dayIdx + 1}${gmapStops(t, d.date).length ? '' : '・無'}`, d.color)).join('')}
      </div>
      ${google ? gmapDayHtml(t, mapDay, dayIdx) : `
      <div class="map-toggles no-print">
        <label class="chip-check"><input type="checkbox" data-change="map-places" ${mapShowPlaces ? 'checked' : ''}><span>⚪ 想去的地方</span></label>
        <label class="chip-check"><input type="checkbox" data-change="map-rail" ${mapRail ? 'checked' : ''}><span>🚆 鐵道</span></label>
      </div>
      <p id="map-status" class="map-status muted" ${mapGeoStatus || todo ? '' : 'hidden'}>${esc(mapGeoStatus || (todo ? `還有 ${todo} 個地點等著定位…` : ''))}</p>
      <div id="trip-map" class="trip-map" role="region" aria-label="行程地圖"><p class="map-loading muted">${navigator.onLine === false ? '📴 離線中，地圖需要網路。' : '地圖載入中…'}</p></div>
      <p class="muted hint">圖釘的數字是當天的順序，同一天依行程時間順序連線（直線）。<b>選某一天可以看 Google 地圖畫的實際路線。</b>點圖釘可以開 Google 導航。已定位 ${located} 個${skip ? `，${skip} 個行程沒填地點` : ''}。位置是用 OpenStreetMap 查的，不一定準；貼上電腦版 Google 地圖網址列的完整連結（裡面有座標）會最準。</p>`}
    </section>
    ${missing.length ? `
      <section class="panel">
        <h3>找不到位置<span class="muted shop-day-total">${missing.length} 個</span></h3>
        <p class="muted hint">點一下改「地點」的寫法（店名或地標比門牌容易查到），或在「更多」貼上 Google 地圖網址列的完整連結，存檔後會重新定位。</p>
        <ul class="shop-list">${missing.map(({ a, d, i }) => `
          <li class="map-missing">
            <span class="chip" style="background:${dayColor(i)};color:#fff">Day ${i + 1}</span>
            <button type="button" class="link-btn" data-action="open-activity" data-date="${esc(d)}" data-id="${esc(a.id)}">${esc(a.title)}${a.location ? `<small class="muted">📍 ${esc(a.location)}</small>` : ''}</button>
          </li>`).join('')}</ul>
      </section>` : ''}`;
}

function setMapStatus(text) {
  mapGeoStatus = text;
  const el = document.getElementById('map-status');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

/* ---------- Leaflet ---------- */
function ensureLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
        document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LEAFLET_CSS, integrity: LEAFLET_CSS_SRI, crossOrigin: 'anonymous' }));
      }
      const s = Object.assign(document.createElement('script'), { src: LEAFLET_JS, integrity: LEAFLET_JS_SRI, crossOrigin: 'anonymous' });
      s.onload = () => resolve(window.L);
      s.onerror = () => {
        leafletPromise = null;
        s.remove();
        reject(new Error('地圖元件載入失敗，請確認網路後再切換一次分頁'));
      };
      document.head.append(s);
    });
  }
  return leafletPromise;
}

/** renderTrip 畫好地圖分頁後呼叫：載入 Leaflet、畫圖釘，需要的話在背景定位 */
async function initTripMap(t, dates) {
  const tripId = t.id;
  // Google 路線圖畫面（沒有 #trip-map）：不用載 Leaflet；定位照樣做，座標給 Google 用比地名準
  if (!document.getElementById('trip-map')) {
    if (tripMap) { tripMap.map.remove(); tripMap = null; }
    geocodeActivities(tripId);
    return;
  }
  try {
    await ensureLeaflet();
  } catch (err) {
    const el = document.getElementById('trip-map');
    if (el) el.innerHTML = `<p class="map-loading muted">⚠️ ${esc(err.message)}</p>`;
    return;
  }
  const cur = currentTrip();
  if (!cur || cur.id !== tripId || currentTab !== 'map') return;
  drawTripMap(cur, dateRange(cur.startDate, cur.endDate));
  geocodeActivities(tripId);
}

function viewKey(tripId) {
  return `${tripId}|${mapDay}`;
}

function drawTripMap(t, dates, refit = false) {
  const el = document.getElementById('trip-map');
  if (!el || !window.L) return;
  const L = window.L;
  if (tripMap && (tripMap.el !== el || !document.body.contains(tripMap.el))) {
    tripMap.map.remove();
    tripMap = null;
  }
  if (!tripMap) {
    el.innerHTML = '';
    const map = L.map(el, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    tripMap = { map, el, tripId: t.id, layer: L.layerGroup().addTo(map), rail: null };
    map.on('moveend', () => {
      if (tripMap && tripMap.map === map) mapViews.set(viewKey(tripMap.tripId), { center: map.getCenter(), zoom: map.getZoom() });
    });
  }
  const { map, layer } = tripMap;
  tripMap.tripId = t.id;
  // 鐵道圖層
  if (mapRail && !tripMap.rail) {
    tripMap.rail = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
      subdomains: 'abc', maxZoom: 19, opacity: 0.8,
      attribution: '<a href="https://www.openrailwaymap.org/" target="_blank" rel="noopener">OpenRailwayMap</a>（CC-BY-SA）',
    }).addTo(map);
  } else if (!mapRail && tripMap.rail) {
    map.removeLayer(tripMap.rail);
    tripMap.rail = null;
  }

  layer.clearLayers();
  const bounds = [];
  const days = mapDays(t, dates).filter((d) => mapDay === 'all' || d.date === mapDay);
  for (const d of days) {
    if (d.points.length > 1) {
      L.polyline(d.points.map((p) => [p.lat, p.lng]), { color: d.color, weight: 3, opacity: 0.75 }).addTo(layer);
    }
    for (const p of d.points) {
      const icon = L.divIcon({
        className: 'map-pin-wrap',
        html: `<span class="map-pin" style="--day:${d.color}"><b>${p.n}</b></span>`,
        iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26],
      });
      const nav = navUrl(p.a) || `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
      L.marker([p.lat, p.lng], { icon, title: p.a.title })
        .bindPopup(`<div class="map-pop"><b style="color:${d.color}">Day ${d.dayIdx + 1}・${p.n}</b>${p.a.time ? ` ${esc(timeLabel(p.a))}` : ''}<br>${esc(p.a.title)}${p.a.location ? `<br><small>📍 ${esc(p.a.location)}</small>` : ''}<br><a href="${esc(nav)}" target="_blank" rel="noopener">🧭 Google 導航</a></div>`)
        .addTo(layer);
      bounds.push([p.lat, p.lng]);
    }
  }
  if (mapShowPlaces) {
    for (const p of mapPlaces(t)) {
      const icon = L.divIcon({ className: 'map-pin-wrap', html: '<span class="map-pin map-pin-place"></span>', iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8] });
      L.marker([p.lat, p.lng], { icon, title: p.name })
        .bindPopup(`<div class="map-pop"><b>想去</b><br>${esc(p.name)}<br><a href="${esc(placeMapUrl(p))}" target="_blank" rel="noopener">📍 Google 地圖</a></div>`)
        .addTo(layer);
      if (!bounds.length || mapDay === 'all') bounds.push([p.lat, p.lng]);
    }
  }
  const saved = !refit && mapViews.get(viewKey(t.id));
  if (saved) map.setView(saved.center, saved.zoom, { animate: false });
  else if (bounds.length) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15, animate: false });
  else fitDestination(t, map);
  setTimeout(() => map.invalidateSize(), 0); // 分頁剛切換時容器大小可能還沒定
}

// 沒有任何圖釘時，先看目的地（查過的中心點記在這台裝置）
function fitDestination(t, map) {
  let center = null;
  try {
    center = (JSON.parse(localStorage.getItem(GEO_CENTER_KEY)) || {})[(t.destination || '').trim()] || null;
  } catch { /* 忽略 */ }
  if (center) map.setView([center.lat, center.lng], 11, { animate: false });
  else map.setView([35.68, 139.76], 5, { animate: false });
}

/* ---------- 背景定位 ---------- */
/** 查出還沒定位的行程。查詢要花時間，期間旅程可能被雲端重新載入，所以結果最後才依 id 寫回去 */
async function geocodeActivities(tripId) {
  if (mapGeoBusy || navigator.onLine === false) return;
  if (Date.now() - (mapGeoFailed.get(tripId) || 0) < MAP_GEO_RETRY_MS) return;
  const first = getTrip(tripId);
  const todo = first ? allActivities(first).filter((a) => actGeo(a).state === 'todo').map((a) => ({ id: a.id, key: actGeoKey(a), q: a.location.trim() })) : [];
  if (!todo.length) return setMapStatus('');
  mapGeoBusy = true;
  const results = new Map();
  try {
    const center = await destinationCenter(first);
    for (let i = 0; i < todo.length; i++) {
      setMapStatus(`📍 定位中 ${i + 1}/${todo.length}：${todo[i].q}`);
      results.set(todo[i].id, await geoSearchSmart(todo[i].q, center)); // 間隔由 geoThrottle 控制
    }
  } catch (err) {
    console.warn('地圖定位失敗', err);
    mapGeoFailed.set(tripId, Date.now());
    toast(`${err.message || '定位失敗'}，已查到的會先保留`);
  } finally {
    mapGeoBusy = false;
    setMapStatus('');
  }
  const t = getTrip(tripId);
  if (!t || !results.size) return;
  let changed = 0;
  for (const a of allActivities(t)) {
    if (!results.has(a.id)) continue;
    const want = todo.find((x) => x.id === a.id);
    if (actGeoKey(a) !== want.key) continue; // 查詢期間地點被改過，這次的結果不算
    const hit = results.get(a.id);
    Object.assign(a, hit ? { lat: hit.lat, lng: hit.lng, geo: 'ok', geoKey: want.key } : { lat: '', lng: '', geo: 'none', geoKey: want.key });
    changed++;
  }
  if (!changed) return;
  commitTrip(t);
  const cur = currentTrip();
  if (cur && cur.id === tripId && currentTab === 'map' && !document.querySelector('dialog[open]')) {
    mapViews.delete(viewKey(tripId)); // 有新的圖釘，重新縮放到看得到全部
    renderTrip(cur);
  }
}

/* ---------- 操作 ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="map-day"]');
  const t = currentTrip();
  if (!el || !t) return;
  mapDay = el.dataset.day;
  mapViews.delete(viewKey(t.id)); // 換一天就重新縮放到看得到全部
  renderTrip(t); // 畫面會換（Google 路線圖或 Leaflet、這天的連結），整個重畫最單純
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="gmap-mode"]');
  const t = currentTrip();
  if (!el || !t || el.disabled) return;
  gmapMode = Object.hasOwn(GMAP_MODES, el.dataset.mode) ? el.dataset.mode : 'driving';
  try {
    localStorage.setItem(GMAP_MODE_KEY, gmapMode);
  } catch { /* 忽略 */ }
  renderTrip(t);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change="map-places"], [data-change="map-rail"]');
  const t = currentTrip();
  if (!el || !t) return;
  if (el.dataset.change === 'map-places') mapShowPlaces = el.checked;
  else mapRail = el.checked;
  drawTripMap(t, dateRange(t.startDate, t.endDate));
});
