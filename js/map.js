'use strict';

/* ============================================================
 * 地圖分頁：把行程的地點釘在地圖上（Leaflet＋OpenStreetMap，免費、不用金鑰）
 *  - 每一天一個顏色，圖釘標當天的順序（1、2、3…），同一天依行程順序用直線連起來
 *  - 「想去」清單裡已定位、還沒排進行程的地點用灰色圖釘
 *  - 「鐵道」開關疊上 OpenRailwayMap 的鐵路／地鐵路線
 * 座標：Google 地圖連結裡有座標就直接用；否則用 OpenStreetMap 查「地點」（和想去清單同一套，見 js/places.js），
 *       查到的存在行程上（lat、lng、geo、geoKey），旅伴不用再查；geoKey 是查的時候的「地點|連結」，改了就重查
 * 選某一天時，每段直線旁標出點到點的直線距離，地圖下方列出每段距離與當天合計
 * Leaflet 只在打開地圖分頁時才載入，不拖慢其他畫面
 * ============================================================ */

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
// 子資源完整性（cdnjs 公布的 SRI），CDN 上的檔案被改過瀏覽器就不會執行
const LEAFLET_CSS_SRI = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';
const LEAFLET_JS_SRI = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
const DAY_COLORS = ['#0f766e', '#db2777', '#2563eb', '#ea580c', '#7c3aed', '#16a34a', '#ca8a04', '#0891b2', '#be123c', '#4f46e5'];
const MAP_GEO_RETRY_MS = 60 * 1000; // 定位失敗（連線問題）後，多久內不自動重試

let leafletPromise = null;
let tripMap = null;         // { map, el, tripId, layer, rail }
let mapDay = 'all';         // 'all' 或日期
let mapShowPlaces = true;
let mapRail = false;
let mapGeoStatus = '';      // 定位中的進度文字
let mapGeoBusy = false;
const mapGeoFailed = new Map(); // tripId → 上次定位失敗的時間
const mapGoogleTried = new Set(); // 這次開啟期間已經用 Google 再查過的「地點|連結」，不要一直重查
const mapViews = new Map();     // `${tripId}|${day}` → { center, zoom }：重新畫面時維持原本看的位置

function dayColor(i) {
  return DAY_COLORS[i % DAY_COLORS.length];
}

// 沒填「地點」時用標題查（例如「清水寺」）；交通類或「返程、自由活動」這種不是地點的不查
const GEO_TITLE_SKIP = /返程|回程|出發|集合|自由活動|休息|移動|搭車|轉車|退房|check.?out/i;
function actGeoQuery(a) {
  const loc = (a.location || '').trim();
  if (loc) return loc;
  const title = (a.title || '').trim();
  return title && catKey(a) !== 'transport' && !GEO_TITLE_SKIP.test(title) ? title : '';
}

// 定位用的「地點|連結」：兩者都沒變，之前查到的座標才算數（用標題查的前面加 #，改了標題也會重查）
function actGeoKey(a) {
  const loc = (a.location || '').trim();
  return `${loc || (actGeoQuery(a) ? `#${actGeoQuery(a)}` : '')}|${(a.mapUrl || '').trim()}`;
}

/**
 * 一個行程在地圖上的狀態：
 *   ok＝有座標（{ lat, lng }）、none＝找不到、todo＝還沒定位、skip＝沒有地點也沒有連結（不放在地圖上）
 */
// 有 Google 地圖連結時一律以連結為準：完整網址直接取座標；短網址（maps.app.goo.gl）請後端展開，
// 展開得到的座標存成 geoKey＝「url:連結」；展開失敗（連結失效、沒登入）才用名稱查
const mapUrlTried = new Set(); // 這次開啟期間已經請後端展開過的連結
function urlGeoKey(a) {
  return `url:${(a.mapUrl || '').trim()}`;
}
function fromLink(a) {
  return !!((typeof coordsFromMapUrl === 'function' && coordsFromMapUrl(a.mapUrl)) || ((a.mapUrl || '').trim() && a.geoKey === urlGeoKey(a) && a.geo === 'ok'));
}

function actGeo(a) {
  const loc = actGeoQuery(a);
  const url = (a.mapUrl || '').trim();
  if (!loc && !url) return { state: 'skip' };
  const fromUrl = typeof coordsFromMapUrl === 'function' ? coordsFromMapUrl(url) : null;
  if (fromUrl) return { state: 'ok', ...fromUrl };
  const okCoords = a.geo === 'ok' && a.lat !== '' && a.lng !== '' && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng));
  if (url && a.geoKey === urlGeoKey(a) && okCoords) return { state: 'ok', lat: Number(a.lat), lng: Number(a.lng) };
  if (url && typeof cloudOn === 'function' && cloudOn() && !mapUrlTried.has(url)) return { state: 'todo', viaUrl: true }; // 先展開連結
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

/* ---------- 位置範圍：避免查到別的國家的同名地點（例如「羽田機場」跑到台灣） ---------- */
const GEO_NEAR_KM = 300;      // 新查到的位置離這趟的中心超過這麼遠就不採用
const GEO_OUTLIER_KM = 1000;  // 已經存的位置離其他地點超過這麼遠，列成「位置可能有誤」
const GEO_OK_KEY = 'travel-planner:geo-confirmed'; // 使用者按過「沒錯」的（行程 id|geoKey），記在這台裝置

/**
 * 台灣的地名、機場（出發、回程常見）：在台灣的範圍裡查，不套用旅程目的地的範圍
 * 例如「松山機場」在日本愛媛也有一個，旅程在日本時會被對到那裡
 */
const HOME_HINT_RE = /台北|臺北|桃園|松山機場|松山机场|小港|高雄|台中|臺中|清泉崗|台南|臺南|花蓮|台東|臺東|台灣|臺灣|taipei|taoyuan|kaohsiung|taichung|taiwan|\b(?:TPE|TSA|KHH|RMQ)\b/i;
const HOME_CENTER = { lat: 23.7, lng: 120.95, spanLat: 1.9, spanLng: 1.6 }; // 台灣本島
function homeHint(a) {
  return HOME_HINT_RE.test(`${actGeoQuery(a)} ${a.title || ''}`);
}
function inHome(p) {
  return p.lat >= 21.8 && p.lat <= 25.6 && p.lng >= 119.3 && p.lng <= 122.6;
}

/** 這趟其他已定位地點的中間位置（取中位數，少數幾個查錯的不會影響）；exceptId：不算這一個 */
function pointsCenter(t, exceptId = '') {
  const pts = allActivities(t).filter((a) => a.id !== exceptId).map((a) => actGeo(a)).filter((g) => g.state === 'ok');
  if (!pts.length) return null;
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return { lat: med(pts.map((p) => p.lat)), lng: med(pts.map((p) => p.lng)) };
}

/** 查詢時限定的範圍：目的地的位置，查不到就用其他地點的中間位置 */
async function tripCenter(t, exceptId = '') {
  let c = null;
  try { c = await destinationCenter(t); } catch { c = null; }
  return c || pointsCenter(t, exceptId);
}

function geoConfirmed() {
  try { return new Set(JSON.parse(localStorage.getItem(GEO_OK_KEY)) || []); } catch { return new Set(); }
}

/** 位置可能有誤：離這趟其他地點（中位數）超過 GEO_OUTLIER_KM，而且使用者沒按過「沒錯」 */
function geoOutliers(t, dates) {
  const ok = geoConfirmed();
  return dates.flatMap((d, i) => (t.days[d] || []).map((a) => ({ a, d, i, g: actGeo(a) }))
    .filter(({ a, g }) => {
      if (g.state !== 'ok' || fromLink(a) || ok.has(`${a.id}|${actGeoKey(a)}`)) return false; // 連結的位置以連結為準
      if (homeHint(a)) return !inHome(g); // 台灣的地名：不在台灣才算有誤
      const c = pointsCenter(t, a.id);
      return c && distKm(c, g) > GEO_OUTLIER_KM;
    }));
}

/* ---------- 直線距離 ---------- */
function fmtDist(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** 一天裡相鄰兩站的直線距離：[{ from, to, km }]，加總是當天合計 */
function daySegments(points) {
  return points.slice(1).map((p, i) => ({ from: points[i], to: p, km: distKm(points[i], p) }));
}

/** 地圖下方的距離清單：選某一天時列每段，「全部」時列每天合計 */
function distanceList(t, days) {
  if (mapDay === 'all') {
    const rows = days.filter((d) => d.points.length > 1);
    if (!rows.length) return '';
    return `<ul class="map-dist-list">${rows.map((d) => {
      const total = daySegments(d.points).reduce((s, x) => s + x.km, 0);
      return `<li><span class="chip" style="background:${d.color};color:#fff">Day ${d.dayIdx + 1}</span> ${d.points.length} 站・直線合計 ${fmtDist(total)}</li>`;
    }).join('')}</ul>`;
  }
  const d = days.find((x) => x.date === mapDay);
  if (!d || !d.points.length) return '';
  const segs = daySegments(d.points);
  const total = segs.reduce((s, x) => s + x.km, 0);
  const open = `https://www.google.com/maps/dir/${d.points.map((p) => `${p.lat},${p.lng}`).join('/')}`;
  return `
    <ol class="map-dist-steps" style="--day:${d.color}">
      ${d.points.map((p, i) => `<li><span class="map-dist-no">${p.n}</span>${p.a.time ? `<span class="muted">${esc(timeLabel(p.a))}</span> ` : ''}${esc(p.a.title)}${fromLink(p.a) ? ' <small class="muted" title="位置來自 Google 地圖連結">🔗</small>' : ''}${actGeoQuery(p.a) && !fromLink(p.a) ? ` <button type="button" class="link-btn map-regeo-sm no-print" data-action="map-regeo" data-force="1" data-date="${esc(d.date)}" data-id="${esc(p.a.id)}" title="位置不對？在這趟旅程的範圍內重新查">🔄 重新查</button>` : ''}${segs[i] ? `<span class="map-dist-seg">↓ ${fmtDist(segs[i].km)}</span>` : ''}</li>`).join('')}
    </ol>
    <p class="map-dist-total">${segs.length ? `直線距離合計 <b>${fmtDist(total)}</b>（${segs.length} 段）` : '這天只有 1 個地點'}
      ・<a href="${esc(open)}" target="_blank" rel="noopener">在 Google 地圖開啟這些地點</a></p>`;
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
  const outliers = geoOutliers(t, dates);
  const todo = all.filter((x) => x.s === 'todo').length;
  const skip = all.filter((x) => x.s === 'skip').length;
  const chip = (key, label, color) => `<button type="button" class="map-day${mapDay === key ? ' on' : ''}" data-action="map-day" data-day="${key}"${color ? ` style="--day:${color}"` : ''} aria-pressed="${mapDay === key}">${label}</button>`;
  return `
    <section class="panel map-panel">
      <div class="map-days" role="group" aria-label="看哪一天">
        ${chip('all', '全部')}${days.map((d) => chip(d.date, `Day ${d.dayIdx + 1}${d.points.length ? '' : '・無'}`, d.color)).join('')}
      </div>
      <div class="map-toggles no-print">
        <label class="chip-check"><input type="checkbox" data-change="map-places" ${mapShowPlaces ? 'checked' : ''}><span>⚪ 想去的地方</span></label>
        <label class="chip-check"><input type="checkbox" data-change="map-rail" ${mapRail ? 'checked' : ''}><span>🚆 鐵道</span></label>
      </div>
      <p id="map-status" class="map-status muted" ${mapGeoStatus || todo ? '' : 'hidden'}>${esc(mapGeoStatus || (todo ? `還有 ${todo} 個地點等著定位…` : ''))}</p>
      <div id="trip-map" class="trip-map" role="region" aria-label="行程地圖"><p class="map-loading muted">${navigator.onLine === false ? '📴 離線中，地圖需要網路。' : '地圖載入中…'}</p></div>
      ${distanceList(t, days)}
      <p class="muted hint">圖釘的數字是當天的順序，同一天依行程時間順序用直線連起來${mapDay === 'all' ? '；選某一天可以看每段的直線距離' : '，線上標的是兩點之間的直線距離（不是實際走的路程）'}。點圖釘可以開 Google 導航。已定位 ${located} 個${skip ? `，${skip} 個行程沒填地點` : ''}。<br>位置怎麼抓：①有「Google 地圖連結」就一律用連結的位置（標 🔗，最準；手機分享的短網址也可以，要登入）→ ②沒有連結才用「地點」（沒填就用標題）查 OpenStreetMap → ③查不到再用 Google 查。查錯時貼上 Google 地圖連結最快。</p>
    </section>
    ${outliers.length ? `
      <section class="panel">
        <h3>⚠️ 位置可能有誤<span class="muted shop-day-total">${outliers.length} 個</span></h3>
        <p class="muted hint">這些地點離這趟其他地點超過 ${GEO_OUTLIER_KM.toLocaleString()} 公里，或寫的是台灣的地名卻不在台灣，可能查到別處的同名地點。按「重新查」會在正確的範圍內重查（台灣的地名在台灣找）；本來就在那裡的按「沒錯」。地點寫清楚一點（例如「台北松山機場」）會更準。</p>
        <ul class="shop-list">${outliers.map(({ a, d, i, g }) => `
          <li class="map-missing">
            <span class="chip" style="background:${dayColor(i)};color:#fff">Day ${i + 1}</span>
            <button type="button" class="link-btn" data-action="open-activity" data-date="${esc(d)}" data-id="${esc(a.id)}">${esc(a.title)}<small class="muted">${homeHint(a) ? '台灣的地名，但目前不在台灣' : `距離其他地點約 ${fmtDist(distKm(pointsCenter(t, a.id), g))}`}</small></button>
            <button type="button" class="btn btn-sm no-print" data-action="map-regeo" data-force="1" data-date="${esc(d)}" data-id="${esc(a.id)}">🔄 重新查</button>
            <button type="button" class="btn btn-sm no-print" data-action="map-geo-ok" data-id="${esc(a.id)}" data-key="${esc(actGeoKey(a))}">✅ 沒錯</button>
          </li>`).join('')}</ul>
      </section>` : ''}
    ${missing.length ? `
      <section class="panel">
        <h3>找不到位置<span class="muted shop-day-total">${missing.length} 個</span></h3>
        <p class="muted hint">${cloudOn() ? 'OpenStreetMap 和 Google 都查不到的地點。' : '用 LINE 登入後，OpenStreetMap 查不到的會自動改用 Google 查。'}點名稱可以改「地點」的寫法（店名或地標比門牌容易查到）；或按「🔍 Google 地圖」用名稱搜尋，找到後按「分享」複製連結，貼到行程的「Google 地圖連結」，存檔後就會用那個位置。</p>
        <ul class="shop-list">${missing.map(({ a, d, i }) => `
          <li class="map-missing">
            <span class="chip" style="background:${dayColor(i)};color:#fff">Day ${i + 1}</span>
            <button type="button" class="link-btn" data-action="open-activity" data-date="${esc(d)}" data-id="${esc(a.id)}">${esc(a.title)}${a.location ? `<small class="muted">📍 ${esc(a.location)}</small>` : ''}</button>
            ${cloudOn() && actGeoQuery(a) ? `<button type="button" class="btn btn-sm no-print" data-action="map-regeo" data-date="${esc(d)}" data-id="${esc(a.id)}">🔄 用 Google 再查</button>` : ''}
            <a class="btn btn-sm no-print" href="${esc(mapUrl(actGeoQuery(a) || a.title))}" target="_blank" rel="noopener" title="用名稱在 Google 地圖找；找到後按「分享」複製連結，貼到這個行程的「Google 地圖連結」">🔍 Google 地圖</a>
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
      // 只看一天時，每段中間標出直線距離（全部的天數一起看太擠，不標）
      if (mapDay !== 'all') {
        for (const s of daySegments(d.points)) {
          const label = L.divIcon({ className: 'map-dist-wrap', html: `<span class="map-dist" style="--day:${d.color}">${fmtDist(s.km)}</span>`, iconSize: null });
          L.marker([(s.from.lat + s.to.lat) / 2, (s.from.lng + s.to.lng) / 2], { icon: label, interactive: false, keyboard: false }).addTo(layer);
        }
      }
    }
    for (const p of d.points) {
      const icon = L.divIcon({
        className: 'map-pin-wrap',
        html: `<span class="map-pin" style="--day:${d.color}"><b>${p.n}</b></span>`,
        iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26],
      });
      const nav = navUrl(p.a) || `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
      L.marker([p.lat, p.lng], { icon, title: p.a.title })
        .bindPopup(`<div class="map-pop"><b style="color:${d.color}">Day ${d.dayIdx + 1}・${p.n}</b>${p.a.time ? ` ${esc(timeLabel(p.a))}` : ''}<br>${esc(p.a.title)}${p.a.location ? `<br><small>📍 ${esc(p.a.location)}</small>` : ''}${p.n > 1 ? `<br><small>距離上一站（直線）${fmtDist(distKm(d.points[p.n - 2], p))}</small>` : ''}<br><a href="${esc(nav)}" target="_blank" rel="noopener">🧭 Google 導航</a></div>`)
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
  setTimeout(() => { if (tripMap && tripMap.map === map && document.body.contains(tripMap.el)) map.invalidateSize(); }, 0); // 已經重畫掉的舊地圖不要碰 // 分頁剛切換時容器大小可能還沒定
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
  // 還沒定位的照常查（OpenStreetMap → Google）；之前標成找不到的，登入時用 Google 再查一次
  const todo = first ? allActivities(first)
    .filter((a) => actGeo(a).state === 'todo' || (cloudOn() && actGeo(a).state === 'none' && actGeoQuery(a) && !mapGoogleTried.has(actGeoKey(a))))
    .map((a) => ({ id: a.id, key: actGeoKey(a), q: actGeoQuery(a), googleOnly: actGeo(a).state === 'none', home: homeHint(a), url: actGeo(a).viaUrl ? a.mapUrl.trim() : '' })) : [];
  if (!todo.length) return setMapStatus('');
  mapGeoBusy = true;
  const results = new Map();
  try {
    const tripC = await tripCenter(first); // 目的地查不到時用其他地點的中間位置，免得查到別的國家
    for (let i = 0; i < todo.length; i++) {
      setMapStatus(`📍 定位中 ${i + 1}/${todo.length}：${todo[i].q || '地圖連結'}`);
      // 有連結：先請後端展開，拿到座標就用（以連結為準，不檢查距離）
      if (todo[i].url) {
        mapUrlTried.add(todo[i].url);
        let linked = null;
        try { linked = (await Cloud.call('resolveMapUrl', { url: todo[i].url })).hit; } catch (err) { console.warn('展開地圖連結失敗', err); }
        if (linked) { results.set(todo[i].id, { ...linked, viaUrl: true }); continue; }
        if (!todo[i].q) { results.set(todo[i].id, null); continue; }
      }
      mapGoogleTried.add(todo[i].key); // 這次開啟期間 Google 查過了（geoLookup 查不到時也會問 Google），不要再重查
      const center = todo[i].home ? HOME_CENTER : tripC; // 台灣的地名在台灣找
      const dest = todo[i].home ? '台灣' : (first.destination || '');
      let hit = todo[i].googleOnly ? await googleGeocode(todo[i].q, center, dest) : await geoLookup(todo[i].q, center, dest); // 間隔由 geoThrottle 控制
      if (hit && center && distKm(center, hit) > GEO_NEAR_KM) hit = null; // 離這趟太遠：多半是同名的別處
      results.set(todo[i].id, hit);
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
    if (!hit && want.googleOnly) continue; // Google 也查不到：維持找不到，不用存檔
    Object.assign(a, hit ? { lat: hit.lat, lng: hit.lng, geo: 'ok', geoKey: hit.viaUrl ? urlGeoKey(a) : want.key } : { lat: '', lng: '', geo: 'none', geoKey: want.key });
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

/* ---------- 手動用 Google 再查一次（找不到位置清單的按鈕） ---------- */
const GOOGLE_REASON_TEXT = {
  none: 'Google 也查不到這個名稱，可以改「地點」的寫法（店名加分店、地標），或按「🔍 Google 地圖」找到後貼連結',
  limit: '你今天的 Google 查詢次數用完了（每人每天 200 次），明天再試',
  quota: 'Google 查詢額度今天用完了，明天再試',
  error: '連不上雲端，請確認網路後再試',
  login: '要用 LINE 登入才能用 Google 查',
};

/**
 * 在這趟旅程的範圍內重新查一個地點（OpenStreetMap → Google）。
 * force：原本有位置但不對（「位置可能有誤」或距離清單的「重新查」），查不到時把錯的位置拿掉
 */
async function regeoActivity(tripId, date, id, force = false) {
  const t0 = getTrip(tripId);
  const a0 = t0 && (t0.days[date] || []).find((x) => x.id === id);
  if (!a0) return;
  const q = actGeoQuery(a0);
  const key = actGeoKey(a0);
  if (coordsFromMapUrl(a0.mapUrl)) return toast('這個行程的位置來自 Google 地圖連結，要改請換連結');
  // 有連結：以連結為準，先展開連結
  if ((a0.mapUrl || '').trim() && cloudOn()) {
    toast('正在讀 Google 地圖連結的位置…');
    let linked = null;
    try { linked = (await Cloud.call('resolveMapUrl', { url: a0.mapUrl.trim() })).hit; } catch (err) { console.warn(err); }
    const t1 = getTrip(tripId);
    const a1 = t1 && (t1.days[date] || []).find((x) => x.id === id);
    if (linked && a1 && a1.mapUrl === a0.mapUrl) {
      Object.assign(a1, { lat: linked.lat, lng: linked.lng, geo: 'ok', geoKey: urlGeoKey(a1) });
      commitTrip(t1);
      toast('已改用 Google 地圖連結的位置');
      if (currentTrip() && currentTrip().id === tripId && currentTab === 'map') { mapViews.delete(viewKey(tripId)); renderTrip(t1); }
      return;
    }
  }
  if (!q) return toast('這個行程沒有地點可以查，請填「地點」或貼 Google 地圖連結');
  toast(`正在這趟旅程的範圍內查「${q}」…`);
  const home = homeHint(a0);
  const center = home ? HOME_CENTER : await tripCenter(t0, id); // 台灣的地名在台灣找
  const dest = home ? '台灣' : (t0.destination || '');
  let hit = force ? await geoLookup(q, center, dest) : await googleGeocode(q, center, dest);
  if (hit && center && distKm(center, hit) > GEO_NEAR_KM) { hit = null; googleGeoReason = 'none'; }
  const t = getTrip(tripId);
  const a = t && (t.days[date] || []).find((x) => x.id === id);
  if (!a || actGeoKey(a) !== key) return;
  if (!hit) {
    if (force) { // 原本的位置是錯的：拿掉，移到「找不到位置」
      Object.assign(a, { lat: '', lng: '', geo: 'none', geoKey: key });
      commitTrip(t);
      if (currentTrip() && currentTrip().id === tripId && currentTab === 'map') renderTrip(t);
    }
    return toast(`${force ? '在這趟旅程附近找不到，已先拿掉原本的位置。' : ''}${GOOGLE_REASON_TEXT[googleGeoReason] || GOOGLE_REASON_TEXT.none}`, { duration: 7000 });
  }
  Object.assign(a, { lat: hit.lat, lng: hit.lng, geo: 'ok', geoKey: key });
  commitTrip(t);
  toast(`找到了：${hit.geoName}`);
  if (currentTrip() && currentTrip().id === tripId && currentTab === 'map') { mapViews.delete(viewKey(tripId)); renderTrip(t); }
}

/* ---------- 操作 ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="map-regeo"]');
  if (el && currentTrip()) regeoActivity(currentTrip().id, el.dataset.date, el.dataset.id, el.dataset.force === '1');
  const ok = e.target.closest('[data-action="map-geo-ok"]');
  if (ok && currentTrip()) {
    const set = geoConfirmed();
    set.add(`${ok.dataset.id}|${ok.dataset.key}`);
    try { localStorage.setItem(GEO_OK_KEY, JSON.stringify([...set].slice(-500))); } catch { /* 忽略 */ }
    renderTrip(currentTrip());
  }
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="map-day"]');
  const t = currentTrip();
  if (!el || !t) return;
  mapDay = el.dataset.day;
  mapViews.delete(viewKey(t.id)); // 換一天就重新縮放到看得到全部
  renderTrip(t); // 下方的距離清單也要跟著換
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change="map-places"], [data-change="map-rail"]');
  const t = currentTrip();
  if (!el || !t) return;
  if (el.dataset.change === 'map-places') mapShowPlaces = el.checked;
  else mapRail = el.checked;
  drawTripMap(t, dateRange(t.startDate, t.endDate));
});
