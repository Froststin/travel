'use strict';

/* ============================================================
 * 待去清單：想去、但還沒排進行程的地方（整個旅程共用）
 *   place = { id, name, address, mapUrl, geo, lat, lng, area, geoName, activityId }
 *   address：Google 地圖用的地址（空＝用名稱搜尋）；mapUrl：Google 地圖分享連結（選填）
 *   geo：''＝還沒定位、'ok'＝已定位、'none'＝找不到；activityId：已排入行程時指向那個行程
 * 「整理」：用 OpenStreetMap 查出每個地點的位置，再把距離近的分成一組，方便排在同一天。
 * 定位不一定準（尤其是中文俗稱），所以畫面會顯示查到的是哪裡，查錯就改名稱再整理一次。
 * ============================================================ */

const MAX_PLACES = 100;
const GEO_URL = 'https://nominatim.openstreetmap.org/search';
const GEO_GAP_MS = 1100;   // OpenStreetMap 的使用規範：每秒最多查一次
const GROUP_KM = 3;        // 兩群的中心相距多遠以內算「順路」，會併成一組
const GEO_CENTER_KEY = 'travel-planner:geo-center';
let organizing = '';       // 整理中的進度文字，空字串＝沒有在整理
let editingPlaceId = null;
const placeDialog = document.getElementById('place-dialog');
const placeForm = document.getElementById('place-form');

/* ---------- Google 地圖的地址與連結 ---------- */
// 定位、地圖搜尋、排進行程時用的字串：有填地址用地址，否則用名稱
function placeQuery(p) {
  return p.address || p.name;
}

// 點開看地圖：自己貼的連結 → 自己填的地址 → 查到的座標 → 用名稱搜尋
function placeMapUrl(p) {
  if (p.mapUrl) return p.mapUrl;
  if (p.address) return mapUrl(p.address);
  if (p.geo === 'ok') return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  return mapUrl(p.name);
}

// 完整的 Google 地圖網址裡有座標（短網址 maps.app.goo.gl 沒有）
function coordsFromMapUrl(url) {
  const s = String(url || '');
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)                                            // 地點本身的座標
    || s.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i)
    || s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);                                                  // 畫面中心
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/* ---------- 距離與分組（純函式） ---------- */
function distKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function centerOf(items) {
  return { lat: items.reduce((s, p) => s + p.lat, 0) / items.length, lng: items.reduce((s, p) => s + p.lng, 0) / items.length };
}

// 走訪順序：從最西邊開始，每次去最近的下一個
function visitOrder(items) {
  const left = items.slice().sort((a, b) => a.lng - b.lng);
  const out = [left.shift()];
  while (left.length) {
    const last = out[out.length - 1];
    let best = 0;
    left.forEach((p, i) => { if (distKm(last, p) < distKm(last, left[best])) best = i; });
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

/**
 * 把已定位的地點依距離分組：一開始每個地點自己一組，反覆把中心最近的兩組合併，直到最近的也超過 GROUP_KM
 * @return {{groups: Array<{label, items, spanKm}>, pending: Array, missing: Array}}
 */
function placeGroups(places) {
  const located = places.filter((p) => p.geo === 'ok' && typeof p.lat === 'number' && typeof p.lng === 'number');
  let clusters = located.map((p) => [p]);
  for (;;) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = distKm(centerOf(clusters[i]), centerOf(clusters[j]));
        if (d <= GROUP_KM && (!best || d < best.d)) best = { i, j, d };
      }
    }
    if (!best) break;
    clusters[best.i] = clusters[best.i].concat(clusters[best.j]);
    clusters.splice(best.j, 1);
  }
  const groups = clusters.map((items) => {
    // 組名用最多地點所在的區
    const count = {};
    items.forEach((p) => { if (p.area) count[p.area] = (count[p.area] || 0) + 1; });
    const label = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || '附近';
    let spanKm = 0;
    items.forEach((a) => items.forEach((b) => { spanKm = Math.max(spanKm, distKm(a, b)); }));
    return { label, items: visitOrder(items), spanKm };
  }).sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  return {
    groups,
    pending: places.filter((p) => p.geo !== 'ok' && p.geo !== 'none'),
    missing: places.filter((p) => p.geo === 'none'),
  };
}

// 這個地點排進了哪一天（沒排或行程已刪掉就回傳空字串）
function placeDate(t, p) {
  if (!p.activityId) return '';
  return Object.keys(t.days).find((d) => (t.days[d] || []).some((a) => a.id === p.activityId)) || '';
}

// 存檔前整理：行程被刪掉的，解除「已排入」
function syncPlaces(t) {
  const ids = new Set(Object.values(t.days || {}).flat().map((a) => a.id));
  t.places = (t.places || []).map((p) => (p.activityId && !ids.has(p.activityId) ? { ...p, activityId: '' } : p));
}

/* ---------- 定位（OpenStreetMap） ---------- */
async function geoSearch(q, center) {
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1', 'accept-language': 'zh-TW', q });
  // 限定在目的地附近（約 150 公里內），避免同名的地方跑到別的國家
  if (center) {
    params.set('viewbox', [center.lng - 1.6, center.lat + 1.3, center.lng + 1.6, center.lat - 1.3].join(','));
    params.set('bounded', '1');
  }
  const res = await fetch(`${GEO_URL}?${params}`);
  if (!res.ok) throw new Error(`定位服務沒有回應（${res.status}）`);
  const hit = (await res.json())[0];
  if (!hit) return null;
  const a = hit.address || {};
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    geoName: String(hit.name || q).slice(0, 80),
    area: areaName(a),
  };
}

// 所在的區，當作分組的名稱。定位服務有時回「丰岛区 / 豐島區」這種兩種寫法並列的，取最後一個
function areaName(a) {
  const raw = String(a.city_district || a.suburb || a.borough || a.city || a.town || a.village || a.county || a.state || '');
  return raw.split(/\s*\/\s*/).pop().slice(0, 40);
}

/**
 * 定位服務要每個字都對得上才找得到，「六歌仙 新宿西口总店」這種帶分店名的常常查不到。
 * 所以整串查不到時，從後面一段一段拿掉再查（最多查 3 次）：「六歌仙 新宿西口总店」→「六歌仙」
 */
function geoCandidates(query) {
  const parts = query.trim().split(/[\s　]+/).filter(Boolean);
  const out = [parts.join(' ')];
  for (let n = parts.length - 1; n >= 1 && out.length < 3; n--) out.push(parts.slice(0, n).join(' '));
  // 沒有空格可以拆時，只拿掉結尾的「總店／本店」這類字樣：「六歌仙总店」→「六歌仙」
  // （不去猜哪一段是分店名，免得「一蘭拉麵新宿店」被當成別家分店）
  if (parts.length === 1) {
    const base = parts[0].replace(/(?:總本店|总本店|總店|总店|本店)$/, '');
    if (base.length >= 2 && base !== parts[0]) out.push(base);
  }
  return [...new Set(out)];
}

async function geoSearchSmart(query, center) {
  const tries = geoCandidates(query);
  for (let i = 0; i < tries.length; i++) {
    if (i) await geoPause();
    const hit = await geoSearch(tries[i], center);
    // 用簡化過的名稱查到的可能是別家分店，寫在查到的名稱後面，提醒點開地圖確認
    if (hit) return i ? { ...hit, geoName: `${hit.geoName}（用「${tries[i]}」查的，請確認）`.slice(0, 80) } : hit;
  }
  return null;
}

// 由座標查所在的區（用來當分組的名稱），查不到就算了
async function geoArea(lat, lng) {
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: '14', 'accept-language': 'zh-TW' });
    const res = await fetch(`${GEO_URL.replace('/search', '/reverse')}?${params}`);
    const a = (await res.json()).address || {};
    return areaName(a);
  } catch (err) {
    return '';
  }
}

const geoPause = () => new Promise((r) => setTimeout(r, GEO_GAP_MS));

// 目的地的中心點（記在這台裝置，下次不用再查）
async function destinationCenter(t) {
  const key = (t.destination || '').trim();
  if (!key) return null;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(GEO_CENTER_KEY)) || {};
  } catch { /* 忽略 */ }
  if (saved[key]) return saved[key];
  const hit = await geoSearch(key, null);
  await geoPause();
  if (!hit) return null;
  saved[key] = { lat: hit.lat, lng: hit.lng };
  try {
    localStorage.setItem(GEO_CENTER_KEY, JSON.stringify(saved));
  } catch { /* 忽略 */ }
  return saved[key];
}

/** 把還沒定位的地點查出位置。查詢要花時間，期間旅程可能被雲端重新載入，所以結果最後才依 id 寫回去 */
async function organizePlaces(tripId) {
  if (organizing) return;
  const first = getTrip(tripId);
  // 之前找不到的也再查一次（可能只是當時連線失敗）
  const todo = ((first && first.places) || []).filter((p) => p.geo !== 'ok').map((p) => ({ id: p.id, name: placeQuery(p) }));
  if (!todo.length) return toast('都整理好了。新加的地點、或改過地址的地點才需要再整理');
  const results = new Map();
  organizing = '準備中……';
  refreshPlaces(tripId);
  try {
    const center = await destinationCenter(first);
    for (let i = 0; i < todo.length; i++) {
      organizing = `正在查位置 ${i + 1} / ${todo.length}：${todo[i].name}`;
      refreshPlaces(tripId);
      if (i) await geoPause();
      results.set(todo[i].id, await geoSearchSmart(todo[i].name, center));
    }
  } catch (err) {
    console.warn('定位失敗', err);
    toast(`${err.message || '定位失敗'}，已查到的會先保留，請稍後再按一次「整理」`);
  }
  organizing = '';
  const t = getTrip(tripId);
  if (!t) return;
  let found = 0;
  let none = 0;
  t.places = (t.places || []).map((p) => {
    if (!results.has(p.id) || p.geo === 'ok' || todo.find((x) => x.id === p.id).name !== placeQuery(p)) return p; // 查詢期間被改過的不套用
    const hit = results.get(p.id);
    if (hit) { found++; return { ...p, geo: 'ok', ...hit }; }
    none++;
    return { ...p, geo: 'none', lat: '', lng: '', area: '', geoName: '' };
  });
  if (found || none) commitTrip(t);
  refreshPlaces(tripId);
  const unsure = t.places.filter((p) => results.has(p.id) && /請確認）$/.test(p.geoName || '')).length;
  if (found || none) toast(`整理好了：${found} 個找到位置${none ? `，${none} 個找不到` : ''}${unsure ? `；其中 ${unsure} 個是用簡化的名稱查的，請點開地圖確認` : ''}`);
}

function refreshPlaces(tripId) {
  const t = currentTrip();
  if (t && t.id === tripId && currentTab === 'places' && !document.querySelector('dialog[open]')) renderTrip(t);
}

/* ---------- 畫面 ---------- */
function placeItem(t, p, dates) {
  const d = placeDate(t, p);
  const dayNo = dates.indexOf(d) + 1;
  // 下面那行小字：自己填的地址／連結優先，否則顯示查到的位置
  const where = p.address || (p.mapUrl ? 'Google 地圖連結' : (p.geo === 'ok' ? (p.geoName || p.name) : ''));
  return `
    <li class="place-item">
      <div class="place-main">
        <span class="place-name">${esc(p.name)}</span>
        ${where ? `<a class="place-geo muted" href="${esc(placeMapUrl(p))}" target="_blank" rel="noopener" title="點開 Google 地圖確認位置；不對的話按 ✎ 改地址">📍 ${esc(where)}${p.geo === 'ok' && p.area ? `・${esc(p.area)}` : ''}</a>` : ''}
      </div>
      ${d
        ? `<span class="chip place-done">已排入 ${dayNo ? `Day ${dayNo}` : esc(d)}</span>`
        : `<select class="place-pick no-print" data-change="schedule-place" data-id="${esc(p.id)}" aria-label="把 ${esc(p.name)} 排入哪一天">
            <option value="">排入…</option>${dates.map((x, i) => `<option value="${x}">Day ${i + 1}・${prettyDate(x)}</option>`).join('')}
          </select>`}
      <span class="shop-actions no-print">
        <button class="icon-btn" data-action="edit-place" data-id="${esc(p.id)}" title="改名稱、Google 地圖的地址或連結" aria-label="編輯">✎</button>
        <button class="icon-btn" data-action="delete-place" data-id="${esc(p.id)}" title="刪除" aria-label="刪除">✕</button>
      </span>
    </li>`;
}

function placesView(t, dates) {
  const places = t.places || [];
  const { groups, pending, missing } = placeGroups(places);
  const scheduled = places.filter((p) => placeDate(t, p)).length;
  const dayOptions = dates.map((x, i) => `<option value="${x}">Day ${i + 1}・${prettyDate(x)}</option>`).join('');

  const groupHtml = groups.map((g, gi) => {
    const open = g.items.filter((p) => !placeDate(t, p));
    const route = dayRouteUrl(g.items.map((p) => ({ location: placeQuery(p) })));
    return `
      <section class="panel">
        <div class="shop-day-head">
          <h3>${esc(g.label)}一帶<span class="muted shop-day-total">${g.items.length} 個${g.items.length > 1 ? `・相距最遠約 ${g.spanKm < 1 ? `${Math.round(g.spanKm * 1000)} 公尺` : `${g.spanKm.toFixed(1)} 公里`}` : ''}</span></h3>
          <div class="place-group-actions no-print">
            ${g.items.length > 1 && route ? `<a class="btn btn-sm" href="${esc(route)}" target="_blank" rel="noopener">🧭 路線</a>` : ''}
            ${open.length > 1 ? `<select class="place-pick" data-change="schedule-group" data-group="${gi}" aria-label="把這一組還沒排的都排入哪一天">
              <option value="">整組排入…</option>${dayOptions}</select>` : ''}
          </div>
        </div>
        <ul class="shop-list">${g.items.map((p) => placeItem(t, p, dates)).join('')}</ul>
      </section>`;
  }).join('');

  return `
    <section class="panel">
      <form id="places-form" class="packing-form no-print">
        <input name="name" placeholder="想去的地方，例如：淺草寺、晴空塔" maxlength="300" required aria-label="想去的地方">
        <button type="submit" class="btn btn-primary">加入</button>
      </form>
      <div class="shop-day-head">
        <div class="packing-summary">共 ${places.length} 個${places.length ? `，已排入行程 ${scheduled} 個` : ''}</div>
        <button class="btn btn-line no-print" data-action="organize-places" ${organizing || !(pending.length + missing.length) ? 'disabled' : ''}>🧭 整理待去清單</button>
      </div>
      ${organizing ? `<p class="place-progress">${esc(organizing)}</p>` : ''}
      <p class="muted hint">「整理」會查出每個地點的位置，把距離近（約 ${GROUP_KM} 公里內）的分成一組，方便排在同一天；之後可以整組或單獨排進某一天。
        位置是用 OpenStreetMap 查的，不一定準：每個地點下面會寫查到的是哪裡，查錯或找不到時按 ✎ 改 Google 地圖的地址（或貼上地圖連結）再整理一次。</p>
      ${places.length ? '' : '<p class="muted shop-empty">還沒有想去的地方。先把想去的都丟進來，再按「整理」分組。</p>'}
    </section>
    ${groupHtml}
    ${pending.length ? `
      <section class="panel">
        <h3>還沒整理<span class="muted shop-day-total">${pending.length} 個</span></h3>
        <ul class="shop-list">${pending.map((p) => placeItem(t, p, dates)).join('')}</ul>
      </section>` : ''}
    ${missing.length ? `
      <section class="panel">
        <h3>找不到位置<span class="muted shop-day-total">${missing.length} 個</span></h3>
        <p class="muted hint">按 ✎ 在「Google 地圖的地址」填店名或地標（比門牌號碼容易查到），或貼上電腦版 Google 地圖網址列的完整連結，再整理一次；不改也可以直接排進行程。</p>
        <ul class="shop-list">${missing.map((p) => placeItem(t, p, dates)).join('')}</ul>
      </section>` : ''}`;
}

/* ---------- 操作 ---------- */
function addPlaces(t, raw) {
  t.places ||= [];
  const have = new Set(t.places.map((p) => p.name));
  const names = [...new Set(raw.split(/[、，,\n]+/).map((s) => s.trim().slice(0, 80)).filter(Boolean))].filter((n) => !have.has(n));
  if (!names.length) return toast('這些地方已經在清單裡了');
  if (t.places.length + names.length > MAX_PLACES) return toast(`待去清單最多 ${MAX_PLACES} 個地方`);
  t.places.push(...names.map((name) => ({ id: uid(), name, address: '', mapUrl: '', geo: '', lat: '', lng: '', area: '', geoName: '', activityId: '' })));
  commitTrip(t);
  renderTrip(t);
  toast(`已加入 ${names.length} 個地方，按「整理」可以分組`);
}

// 把地點排進某一天：新增一個沒有時間的行程，並記下對應關係
function schedulePlaces(t, ids, date) {
  const list = (t.places || []).filter((p) => ids.includes(p.id) && !placeDate(t, p));
  if (!list.length || !dateRange(t.startDate, t.endDate).includes(date)) return;
  for (const p of list) {
    const a = {
      id: uid(), time: '', endTime: '', travelMin: 0, travelMode: '', travelCost: 0, travelCostCurrency: '',
      title: p.name, category: 'sight', location: placeQuery(p), mapUrl: p.mapUrl || '', cost: 0, notes: '',
    };
    (t.days[date] ||= []).push(a);
    p.activityId = a.id;
  }
  sortDay(t.days[date]);
  commitTrip(t);
  renderTrip(t);
  toast(`已把 ${list.length} 個地方排進 ${prettyDate(date)}，到「每日行程」可以填時間`);
}

/* ---------- 編輯：名稱、Google 地圖的地址與連結 ---------- */
function openPlaceDialog(p) {
  if (!placeForm) return toast('網頁有更新，請重新整理後再試一次');
  editingPlaceId = p.id;
  placeForm.reset();
  placeForm.elements.name.value = p.name;
  placeForm.elements.address.value = p.address || '';
  placeForm.elements.mapUrl.value = p.mapUrl || '';
  placeDialog.showModal();
  placeForm.elements.address.focus();
}

placeForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tripId = currentTripId;
  const id = editingPlaceId;
  const f = new FormData(placeForm);
  const next = { name: f.get('name').trim().slice(0, 80), address: f.get('address').trim().slice(0, 200), mapUrl: cleanUrl(f.get('mapUrl')) };
  if (!next.name) return toast('請填寫名稱');
  if (f.get('mapUrl').trim() && !next.mapUrl) return toast('地圖連結要是 https:// 開頭的網址');
  placeDialog.close();
  // 連結裡有座標就直接用（順便查一下在哪一區，當作分組的名稱）
  const at = coordsFromMapUrl(next.mapUrl);
  const area = at ? await geoArea(at.lat, at.lng) : '';
  const t = getTrip(tripId);
  const p = t && (t.places || []).find((x) => x.id === id);
  if (!p) return;
  const before = { query: placeQuery(p), mapUrl: p.mapUrl || '', name: p.name };
  Object.assign(p, next);
  if (at) {
    Object.assign(p, { geo: 'ok', lat: at.lat, lng: at.lng, area, geoName: placeQuery(p) });
  } else if (placeQuery(p) !== before.query || (coordsFromMapUrl(before.mapUrl) && !coordsFromMapUrl(next.mapUrl))) {
    Object.assign(p, { geo: '', lat: '', lng: '', area: '', geoName: '' }); // 地址變了，原本查到的位置不算數
  }
  // 已經排進行程的那一站也一起更新
  const a = p.activityId && Object.values(t.days).flat().find((x) => x.id === p.activityId);
  if (a) {
    if (a.title === before.name) a.title = p.name;
    a.location = placeQuery(p);
    a.mapUrl = p.mapUrl || '';
  }
  commitTrip(t);
  if (currentTripId === tripId) renderTrip(t);
  toast(at ? '已更新，位置直接用連結裡的座標' : (p.geo === '' ? '已更新，按「整理」重新定位' : '已更新'));
});

placeDialog?.addEventListener('click', (e) => { if (e.target === placeDialog) placeDialog.close(); });

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  const t = currentTrip();
  if (!el || !t || !el.value) return;
  if (el.dataset.change === 'schedule-place') schedulePlaces(t, [el.dataset.id], el.value);
  if (el.dataset.change === 'schedule-group') {
    const g = placeGroups(t.places || []).groups[Number(el.dataset.group)];
    if (g) schedulePlaces(t, g.items.map((p) => p.id), el.value);
  }
});
