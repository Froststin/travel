'use strict';

/* ============================================================
 * 待去清單：想去、但還沒排進行程的地方（整個旅程共用）
 *   place = { id, name, geo, lat, lng, area, geoName, activityId }
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
    area: String(a.city_district || a.suburb || a.borough || a.city || a.town || a.village || a.county || a.state || '').slice(0, 40),
  };
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
  const todo = ((first && first.places) || []).filter((p) => p.geo !== 'ok' && p.geo !== 'none').map((p) => ({ id: p.id, name: p.name }));
  if (!todo.length) return toast('都整理好了。新加的地點、或改過名稱的地點才需要再整理');
  const results = new Map();
  organizing = '準備中……';
  refreshPlaces(tripId);
  try {
    const center = await destinationCenter(first);
    for (let i = 0; i < todo.length; i++) {
      organizing = `正在查位置 ${i + 1} / ${todo.length}：${todo[i].name}`;
      refreshPlaces(tripId);
      if (i) await geoPause();
      results.set(todo[i].id, await geoSearch(todo[i].name, center));
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
    if (!results.has(p.id) || todo.find((x) => x.id === p.id).name !== p.name) return p; // 查詢期間被改名的不套用
    const hit = results.get(p.id);
    if (hit) { found++; return { ...p, geo: 'ok', ...hit }; }
    none++;
    return { ...p, geo: 'none', lat: '', lng: '', area: '', geoName: '' };
  });
  if (found || none) commitTrip(t);
  refreshPlaces(tripId);
  if (found || none) toast(`整理好了：${found} 個找到位置${none ? `，${none} 個找不到` : ''}`);
}

function refreshPlaces(tripId) {
  const t = currentTrip();
  if (t && t.id === tripId && currentTab === 'places' && !document.querySelector('dialog[open]')) renderTrip(t);
}

/* ---------- 畫面 ---------- */
function placeItem(t, p, dates) {
  const d = placeDate(t, p);
  const dayNo = dates.indexOf(d) + 1;
  const map = p.geo === 'ok' ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : mapUrl(p.name);
  return `
    <li class="place-item">
      <div class="place-main">
        <span class="place-name">${esc(p.name)}</span>
        ${p.geo === 'ok' ? `<a class="place-geo muted" href="${esc(map)}" target="_blank" rel="noopener" title="查到的位置，點開確認對不對">📍 ${esc(p.geoName || p.name)}${p.area ? `・${esc(p.area)}` : ''}</a>` : ''}
      </div>
      ${d
        ? `<span class="chip place-done">已排入 ${dayNo ? `Day ${dayNo}` : esc(d)}</span>`
        : `<select class="place-pick no-print" data-change="schedule-place" data-id="${esc(p.id)}" aria-label="把 ${esc(p.name)} 排入哪一天">
            <option value="">排入…</option>${dates.map((x, i) => `<option value="${x}">Day ${i + 1}・${prettyDate(x)}</option>`).join('')}
          </select>`}
      <span class="shop-actions no-print">
        <button class="icon-btn" data-action="edit-place" data-id="${esc(p.id)}" title="改名稱（會重新定位）" aria-label="改名稱">✎</button>
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
    const route = dayRouteUrl(g.items.map((p) => ({ location: p.name })));
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
        <button class="btn btn-line no-print" data-action="organize-places" ${organizing || !pending.length ? 'disabled' : ''}>🧭 整理待去清單</button>
      </div>
      ${organizing ? `<p class="place-progress">${esc(organizing)}</p>` : ''}
      <p class="muted hint">「整理」會查出每個地點的位置，把距離近（約 ${GROUP_KM} 公里內）的分成一組，方便排在同一天；之後可以整組或單獨排進某一天。
        位置是用 OpenStreetMap 查的，不一定準：每個地點下面會寫查到的是哪裡，查錯或找不到時按 ✎ 改成更完整的名稱（例如加上英文或地名）再整理一次。</p>
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
        <p class="muted hint">按 ✎ 改成更完整的名稱再整理一次；不改也可以直接排進行程。</p>
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
  t.places.push(...names.map((name) => ({ id: uid(), name, geo: '', lat: '', lng: '', area: '', geoName: '', activityId: '' })));
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
      title: p.name, category: 'sight', location: p.name, mapUrl: '', cost: 0, notes: '',
    };
    (t.days[date] ||= []).push(a);
    p.activityId = a.id;
  }
  sortDay(t.days[date]);
  commitTrip(t);
  renderTrip(t);
  toast(`已把 ${list.length} 個地方排進 ${prettyDate(date)}，到「每日行程」可以填時間`);
}

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
