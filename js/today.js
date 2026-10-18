'use strict';

/* ============================================================
 * 旅行中：今天模式與天氣預報
 *  - 打開旅行中的旅程自動捲到今天；標出「進行中」與「下一站」，每分鐘更新
 *  - 每天標題旁顯示天氣（Open-Meteo，免金鑰；只有 16 天內才有預報）
 *    地點用那天排進行程的「想去」地點座標，沒有就用旅程的目的地
 * ============================================================ */

/* ---------- 今天 ---------- */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function waitText(min) {
  if (min < 60) return `${min} 分鐘後`;
  return `${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}後`;
}

/** 今天這幾個行程裡，哪個進行中、哪個是下一站：Map(行程 id → { kind: 'now'｜'next', text }) */
function nowMarks(list, now = nowMinutes()) {
  const timed = list.filter((a) => a.time);
  const marks = new Map();
  let next = null;
  timed.forEach((a, i) => {
    const start = toMin(a.time);
    const following = timed.slice(i + 1).find((x) => toMin(x.time) > start);
    const end = a.endTime ? toMin(a.endTime) : following ? toMin(following.time) : start + 60;
    if (start <= now && now < end && !marks.size) marks.set(a.id, { kind: 'now', text: '進行中' });
    if (start > now && !next) next = a;
  });
  if (next) marks.set(next.id, { kind: 'next', text: `下一站・${waitText(toMin(next.time) - now)}` });
  return marks;
}

// 行程頁最上面：旅行中才出現，告訴你現在在哪、下一站去哪
function todayBanner(t, dates) {
  const today = fmtDate(new Date());
  if (!dates.includes(today)) return '';
  const list = t.days[today] || [];
  const marks = nowMarks(list);
  const find = (kind) => list.find((a) => (marks.get(a.id) || {}).kind === kind);
  const cur = find('now');
  const next = find('next');
  const nav = next && navUrl(next);
  let text;
  if (next) text = `下一站 <b>${esc(next.time)} ${esc(next.title)}</b>（${waitText(toMin(next.time) - nowMinutes())}）`;
  else if (cur) text = `正在 <b>${esc(cur.title)}</b>，今天沒有排時間的行程了`;
  else if (list.length) text = '今天排了時間的行程都走完了';
  else text = '今天還沒有安排';
  return `
    <div class="today-banner no-print">
      <span class="today-banner-day">🧭 旅行中・Day ${dates.indexOf(today) + 1}</span>
      <span class="today-banner-text">${cur && next ? `正在 ${esc(cur.title)}・` : ''}${text}</span>
      <span class="today-banner-actions">
        ${nav ? `<a class="btn btn-sm btn-primary" href="${esc(nav)}" target="_blank" rel="noopener">🧭 導航</a>` : ''}
        <a class="btn btn-sm" href="#day-${today}" data-action="jump" data-date="${today}">看今天</a>
      </span>
    </div>`;
}

// 剛打開旅行中的旅程：捲到今天
function scrollToToday(t) {
  const today = fmtDate(new Date());
  if (currentTab !== 'plan' || today < t.startDate || today > t.endDate || today === t.startDate) return;
  requestAnimationFrame(() => document.getElementById(`day-${today}`)?.scrollIntoView());
}

// 每分鐘更新「下一站還有幾分鐘」；正在操作（開著視窗、選單、輸入、拖曳）時不打斷
setInterval(() => {
  const t = typeof currentTrip === 'function' && currentTrip();
  if (!t || currentTab !== 'plan' || document.hidden) return;
  const today = fmtDate(new Date());
  if (today < t.startDate || today > t.endDate) return;
  if (document.querySelector('dialog[open], details.menu[open], .dragging') || document.activeElement?.matches('input, textarea, select')) return;
  const y = window.scrollY;
  renderTrip(t);
  window.scrollTo(0, y);
}, 60 * 1000);

/* ---------- 天氣 ---------- */
const WEATHER_KEY = 'travel-planner:weather';
const WEATHER_TTL = 3 * 3600 * 1000;
const WEATHER_DAYS = 16; // Open-Meteo 最多預報 16 天
const WMO = [
  [[0], '☀️', '晴'], [[1, 2], '🌤️', '晴時多雲'], [[3], '☁️', '陰'], [[45, 48], '🌫️', '霧'],
  [[51, 53, 55, 56, 57], '🌦️', '毛毛雨'], [[61, 63, 65, 66, 67], '🌧️', '雨'], [[71, 73, 75, 77], '🌨️', '雪'],
  [[80, 81, 82], '🌦️', '陣雨'], [[85, 86], '🌨️', '陣雪'], [[95, 96, 99], '⛈️', '雷雨'],
];

let weatherCache = (() => {
  try {
    return JSON.parse(localStorage.getItem(WEATHER_KEY)) || {};
  } catch {
    return {};
  }
})();
const weatherLoading = new Set();

function wmo(code) {
  const hit = WMO.find(([codes]) => codes.includes(Number(code)));
  return hit ? { icon: hit[1], label: hit[2] } : { icon: '🌡️', label: '天氣' };
}

// 那天用哪個座標查天氣：排進那天的「想去」地點，沒有就用目的地（目的地的座標由 places.js 查好存著）
function weatherSpot(t, d) {
  const ids = new Set((t.days[d] || []).map((a) => a.id));
  const p = (t.places || []).find((x) => x.geo === 'ok' && ids.has(x.activityId));
  if (p) return { lat: Number(p.lat), lng: Number(p.lng) };
  try {
    const saved = JSON.parse(localStorage.getItem(GEO_CENTER_KEY)) || {};
    return saved[(t.destination || '').trim()] || null;
  } catch {
    return null;
  }
}

const spotKey = (s) => `${s.lat.toFixed(1)},${s.lng.toFixed(1)}`;

function inForecastRange(d) {
  const today = fmtDate(new Date());
  return d >= today && daysBetween(today, d) < WEATHER_DAYS;
}

function weatherChip(t, d) {
  if (!inForecastRange(d) || !t.destination) return '';
  const spot = weatherSpot(t, d);
  const hit = spot && weatherCache[spotKey(spot)];
  if (!spot || !hit || Date.now() - hit.fetchedAt > WEATHER_TTL) queueWeather(t);
  const w = hit && hit.days && hit.days[d];
  if (!w) return '';
  const { icon, label } = wmo(w.code);
  const rain = Number(w.rain) || 0;
  return `<span class="weather" title="${esc(`${label}・最高 ${w.max}°／最低 ${w.min}°・降雨機率 ${rain}%（Open-Meteo 預報）`)}">${icon} ${Math.round(w.min)}–${Math.round(w.max)}°${rain >= 30 ? `<small>💧${rain}%</small>` : ''}</span>`;
}

// 畫面畫完再去查，查好重畫一次（同一個旅程同時只查一輪）
function queueWeather(t) {
  if (weatherLoading.has(t.id) || typeof destinationCenter !== 'function') return;
  weatherLoading.add(t.id);
  setTimeout(() => loadWeather(t.id).finally(() => setTimeout(() => weatherLoading.delete(t.id), 60 * 1000)), 300);
}

async function loadWeather(tripId) {
  let t = getTrip(tripId);
  if (!t) return;
  try {
    if (!weatherSpot(t, t.startDate)) await destinationCenter(t);
  } catch (err) {
    console.warn('查不到目的地的位置，不顯示天氣', err);
    return;
  }
  t = getTrip(tripId);
  if (!t) return;
  const spots = new Map();
  for (const d of dateRange(t.startDate, t.endDate).filter(inForecastRange)) {
    const s = weatherSpot(t, d);
    if (s) spots.set(spotKey(s), s);
  }
  let changed = false;
  for (const [key, s] of spots) {
    const hit = weatherCache[key];
    if (hit && Date.now() - hit.fetchedAt < WEATHER_TTL) continue;
    try {
      const params = new URLSearchParams({
        latitude: s.lat, longitude: s.lng, timezone: 'auto', forecast_days: String(WEATHER_DAYS),
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!res.ok) throw new Error(`天氣預報沒有回應（${res.status}）`);
      const daily = (await res.json()).daily || {};
      const days = {};
      (daily.time || []).forEach((d, i) => {
        days[d] = { code: daily.weather_code[i], max: daily.temperature_2m_max[i], min: daily.temperature_2m_min[i], rain: daily.precipitation_probability_max[i] };
      });
      weatherCache[key] = { fetchedAt: Date.now(), days };
      changed = true;
    } catch (err) {
      console.warn('天氣預報讀取失敗', err);
    }
  }
  if (!changed) return;
  // 太舊的清掉，免得越存越多
  for (const [k, v] of Object.entries(weatherCache)) if (Date.now() - v.fetchedAt > 2 * 86400000) delete weatherCache[k];
  try {
    localStorage.setItem(WEATHER_KEY, JSON.stringify(weatherCache));
  } catch { /* 忽略 */ }
  const cur = currentTrip();
  if (cur && cur.id === tripId && currentTab === 'plan' && !document.querySelector('dialog[open], details.menu[open], .dragging')) {
    const y = window.scrollY;
    renderTrip(cur);
    window.scrollTo(0, y);
  }
}
