/* ============================================================
 * 文字解析：日期、時間、花費、類別、模糊比對
 * 這裡只放純函式（不呼叫任何 Google／LINE 服務），方便在本機測試
 * ============================================================ */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEK_CHARS = '日一二三四五六';
// 移動方式：label、icon、Google 地圖 travelmode、文字辨識
const TRAVEL_MODES = {
  walk: { label: '步行', icon: '🚶', gmap: 'walking', re: /步行|走路|徒步/ },
  train: { label: '電車', icon: '🚃', gmap: 'transit', re: /電車|火車|地鐵|捷運|JR|新幹線|高鐵|鐵路|輕軌/i },
  bus: { label: '公車', icon: '🚌', gmap: 'transit', re: /公車|巴士|客運|接駁車/ },
  taxi: { label: '計程車', icon: '🚕', gmap: 'driving', re: /計程車|小黃|uber|的士/i },
  car: { label: '開車', icon: '🚗', gmap: 'driving', re: /開車|自駕|租車/ },
  bike: { label: '腳踏車', icon: '🚲', gmap: 'bicycling', re: /腳踏車|單車|自行車|騎車/ },
  flight: { label: '飛機', icon: '✈️', gmap: '', re: /飛機|航班|搭機/ },
  ship: { label: '船', icon: '⛴️', gmap: '', re: /渡輪|搭船|坐船|船/ },
};
const CATEGORY_INFO = {
  sight: { label: '景點', icon: '🏞️', color: '#16a34a' },
  food: { label: '餐飲', icon: '🍜', color: '#ea580c' },
  transport: { label: '交通', icon: '🚆', color: '#2563eb' },
  stay: { label: '住宿', icon: '🏨', color: '#7c3aed' },
  shopping: { label: '購物', icon: '🛍️', color: '#db2777' },
  other: { label: '其他', icon: '📌', color: '#64748b' },
};
// 新增行程時，依標題猜類別
const CATEGORY_GUESS = [
  ['stay', /飯店|酒店|旅館|民宿|入住|退房|住宿|hotel|check-?in|check-?out/i],
  ['transport', /機場|車站|搭|新幹線|電車|火車|高鐵|捷運|地鐵|巴士|公車|計程車|租車|航班|飛機|班機|出發|返程|回程|交通|渡輪/i],
  ['food', /吃|餐|飯|麵|咖啡|甜點|燒肉|壽司|居酒屋|美食|小吃|夜市|早午餐|下午茶|酒吧/],
  ['shopping', /買|購物|逛街|商場|百貨|outlet|伴手禮|藥妝|市集|商店街/i],
  ['sight', /寺|神社|宮|廟|公園|博物館|美術館|城|塔|景點|步道|海灘|溫泉|樂園|參觀|散步|夜景|展|老街|瀑布|山|湖/],
];
// 查詢時，問句裡代表某類別的字
const CATEGORY_QUERY = [
  ['food', /吃什麼|吃啥|吃哪|吃飯|美食|餐廳|哪裡吃|吃/],
  ['stay', /住哪|住宿|飯店|旅館|民宿|住/],
  ['transport', /交通|怎麼去|搭車|坐車|航班|飛機|機場/],
  ['shopping', /購物|買什麼|逛街|買/],
  ['sight', /景點|去哪玩|玩什麼/],
];
const STOP_WORDS = /(請問|請|幫我|幫忙|查詢|查一下|查|一下|什麼時候|甚麼時候|幾點|時間|在哪裡|在哪|哪裡|地點|要去|去|的|嗎|呢|吧|啊|呀|了|是|有沒有|行程|安排|什麼|甚麼|要|我|哪|幾|？|\?|！|!|。|，|,|、)/g;

/* ---------- 基本 ---------- */
function toHalf_(s) {
  return String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function pad2_(n) {
  return String(n).padStart(2, '0');
}

function cnToInt_(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s];
  return NaN;
}

function addDays_(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween_(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function dateRange_(start, end) {
  const out = [];
  for (let d = start; d <= end && out.length <= 60; d = addDays_(d, 1)) out.push(d);
  return out;
}

function isValidDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function prettyDate_(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}（${WEEK_CHARS[weekday_(s)]}）`;
}

function durationText_(n) {
  return n > 1 ? `${n} 天 ${n - 1} 夜` : '一日遊';
}

function catKey_(c) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_INFO, c) ? c : 'other';
}

function sortDay_(list) {
  return list.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

/* ---------- 旅程挑選 ---------- */
// 優先順序：包含指定日期 → 包含今天 → 最近一個即將出發 → 最近結束的
function activeTrip_(trips, today, date) {
  const within = (d) => trips.find((t) => t.startDate <= d && d <= t.endDate);
  if (date && within(date)) return within(date);
  if (within(today)) return within(today);
  const upcoming = trips.filter((t) => t.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (upcoming.length) return upcoming[0];
  const past = trips.slice().sort((a, b) => b.endDate.localeCompare(a.endDate));
  return past[0] || null;
}

/* ---------- 日期 ---------- */
function monthDayToDate_(month, day, ctx) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const md = `${pad2_(month)}-${pad2_(day)}`;
  // 若某個旅程包含這天，用那個旅程的年份
  for (const t of ctx.trips || []) {
    for (const y of new Set([t.startDate.slice(0, 4), t.endDate.slice(0, 4)])) {
      const d = `${y}-${md}`;
      if (t.startDate <= d && d <= t.endDate) return d;
    }
  }
  // 否則取最接近的未來（容許 60 天內的過去）
  const y = Number(ctx.today.slice(0, 4));
  const d = `${y}-${md}`;
  if (!isValidDate_(d)) return null;
  return daysBetween_(ctx.today, d) < -60 ? `${y + 1}-${md}` : d;
}

/**
 * 從文字中找出日期
 * @param {string} text
 * @param {{today: string, trips: Array, trip?: Object}} ctx trip 用於「第 N 天」「星期幾」
 * @return {{date: string, rest: string} | null}
 */
function extractDate_(text, ctx) {
  const rules = [
    [/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/, (m) => `${m[1]}-${pad2_(m[2])}-${pad2_(m[3])}`],
    [/(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*(?:日|號|号)?/, (m) => monthDayToDate_(Number(m[1]), Number(m[2]), ctx)],
    [/大後天/, () => addDays_(ctx.today, 3)],
    [/後天/, () => addDays_(ctx.today, 2)],
    [/明天|明日|明早|明晚/, () => addDays_(ctx.today, 1)],
    [/今天|今日|今早|今晚|今夜/, () => ctx.today],
    [/前天/, () => addDays_(ctx.today, -2)],
    [/昨天|昨日|昨晚/, () => addDays_(ctx.today, -1)],
    [/第\s*([0-9一二兩三四五六七八九十]+)\s*天|day\s*(\d+)/i, (m) => {
      if (!ctx.trip) return null;
      const n = cnToInt_(m[1] || m[2]);
      const d = n >= 1 ? addDays_(ctx.trip.startDate, n - 1) : null;
      return d && d <= ctx.trip.endDate ? d : null;
    }],
    [/(?:週|周|星期|禮拜)\s*([一二三四五六日天])/, (m) => {
      const wd = m[1] === '天' ? 0 : WEEK_CHARS.indexOf(m[1]);
      if (ctx.trip) {
        const days = dateRange_(ctx.trip.startDate, ctx.trip.endDate).filter((d) => weekday_(d) === wd);
        const next = days.find((d) => d >= ctx.today) || days[0];
        if (next) return next;
      }
      return addDays_(ctx.today, (wd - weekday_(ctx.today) + 7) % 7);
    }],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (!m) continue;
    const date = fn(m);
    if (date && isValidDate_(date)) return { date, rest: text.replace(m[0], ' ').trim() };
  }
  return null;
}

/* ---------- 時間 ---------- */
function extractTime_(text) {
  let m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
    return { time: `${pad2_(m[1])}:${m[2]}`, rest: text.replace(m[0], ' ').trim() };
  }
  m = text.match(/(上午|早上|中午|下午|晚上|傍晚|凌晨)?\s*(\d{1,2}|[一二兩三四五六七八九十]{1,3})\s*[點点時](?:\s*(半)|\s*(\d{1,2})\s*分?)?/);
  if (m) {
    let h = cnToInt_(m[2]);
    const min = m[3] ? 30 : m[4] ? Number(m[4]) : 0;
    if (/下午|晚上|傍晚/.test(m[1] || '') && h < 12) h += 12;
    if (h >= 0 && h < 24 && min < 60) {
      return { time: `${pad2_(h)}:${pad2_(min)}`, rest: text.replace(m[0], ' ').trim() };
    }
  }
  return null;
}

/* ---------- 花費、地點 ---------- */
// 幣別：NT$／台幣＝TWD、¥／円／日圓／日幣＝JPY、韓元＝KRW；只寫 $、元、塊時 currency 為空＝旅程的幣別
function extractCost_(text) {
  const m = text.match(/(NT\$|\$|¥|￥)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(元|塊|円|日圓|日幣|台幣|臺幣|韓元)/i);
  if (!m) return null;
  const unit = (m[1] || m[4]).toUpperCase();
  let currency = '';
  if (/NT\$|台幣|臺幣/.test(unit)) currency = 'TWD';
  else if (/¥|￥|円|日圓|日幣/.test(unit)) currency = 'JPY';
  else if (unit === '韓元') currency = 'KRW';
  return { cost: Number(m[2] || m[3]), currency, rest: text.replace(m[0], ' ').trim() };
}

function extractLocation_(text) {
  const m = text.match(/@\s*([^\s@]+(?:\s+[^\s@$]+)*)/);
  if (!m) return null;
  return { location: m[1].trim(), rest: text.replace(m[0], ' ').trim() };
}

function guessCategory_(text) {
  const hit = CATEGORY_GUESS.find(([, re]) => re.test(text));
  return hit ? hit[0] : 'other';
}

function queryCategory_(text) {
  const hit = CATEGORY_QUERY.find(([, re]) => re.test(text));
  return hit ? { category: hit[0], rest: text.replace(hit[1], ' ').trim() } : null;
}

/* ---------- 模糊比對 ---------- */
function keywordOf_(text) {
  return toHalf_(text).replace(STOP_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams_(s) {
  if (s.length < 2) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// 0～1：完全包含為 1，否則看雙字詞重疊比例
function similarity_(query, target) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  const t = String(target || '').toLowerCase().replace(/\s+/g, '');
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;
  if (q.includes(t) && t.length >= 2) return 0.8;
  const qs = bigrams_(q);
  const ts = new Set(bigrams_(t));
  const hit = qs.filter((x) => ts.has(x)).length;
  return qs.length ? hit / qs.length : 0;
}

/**
 * 在所有旅程的行程項目中模糊搜尋
 * @return {Array<{trip, date, activity, score}>} 依分數與日期排序
 */
function searchActivities_(trips, query, minScore) {
  const threshold = minScore == null ? 0.5 : minScore;
  const out = [];
  for (const trip of trips) {
    for (const [date, list] of Object.entries(trip.days || {})) {
      for (const a of list) {
        const score = Math.max(
          similarity_(query, a.title),
          similarity_(query, a.location) * 0.9,
          similarity_(query, a.notes) * 0.6,
        );
        if (score >= threshold) out.push({ trip, date, activity: a, score });
      }
    }
  }
  out.sort((x, y) => y.score - x.score || (x.date + x.activity.time).localeCompare(y.date + y.activity.time));
  // 標題完全包含關鍵字的，優先於只是地點相近的
  return out.length && out[0].score >= 1 ? out.filter((h) => h.score >= 1) : out;
}

function searchTrips_(trips, query) {
  return trips
    .map((trip) => ({ trip, score: Math.max(similarity_(query, trip.name), similarity_(query, trip.destination)) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
}

/* ---------- 購物清單（跟著每日行程走） ---------- */
// 這樣東西預計在哪一站買（行程被刪掉就回傳 null）
function shopActivity_(trip, item) {
  if (!item.activityId) return null;
  for (const list of Object.values(trip.days || {})) {
    const a = list.find((x) => x.id === item.activityId);
    if (a) return a;
  }
  return null;
}

// 這樣東西歸在哪一天：有指定行程就跟著行程走（行程改到別天也跟著），否則用自己的日期；空字串＝不指定
function shopDate_(trip, item) {
  if (item.activityId) {
    for (const [d, list] of Object.entries(trip.days || {})) {
      if (list.some((a) => a.id === item.activityId)) return d;
    }
  }
  return item.date && trip.startDate <= item.date && item.date <= trip.endDate ? item.date : '';
}

// 存檔前整理：有指定行程的，把日期更新成行程目前那一天；行程被刪掉的就留在最後那一天
function syncShopping_(trip) {
  const where = {};
  for (const [d, list] of Object.entries(trip.days || {})) list.forEach((a) => { where[a.id] = d; });
  return (trip.shopping || []).map((s) => {
    const d = s.activityId && where[s.activityId];
    return {
      id: s.id, text: s.text, date: d || s.date || '', activityId: d ? s.activityId : '', price: Math.max(0, Number(s.price) || 0), done: !!s.done,
      note: s.note || '', fileId: s.fileId || '',
    };
  });
}

function shoppingOn_(trip, date) {
  return (trip.shopping || []).filter((s) => shopDate_(trip, s) === date);
}

/**
 * 「抹茶粉 500円」「八橋 $300」「面膜 250」→ 名稱與金額；金額沒寫幣別就是旅程的幣別
 * @return {{text: string, cost: number|null, currency: string}}
 */
function parseShopItem_(segment) {
  const s = segment.replace(/\s+/g, ' ').trim();
  const c = extractCost_(s);
  if (c) return { text: c.rest.replace(/\s+/g, ' ').trim(), cost: c.cost, currency: c.currency };
  const m = s.match(/^(.*\S)\s+(\d+(?:\.\d+)?)$/); // 最後空一格接數字
  if (m) return { text: m[1].trim(), cost: Number(m[2]), currency: '' };
  return { text: s, cost: null, currency: '' };
}

// 用「、，,」或換行分開多樣東西；先把 1,000 這種千分位逗號拿掉
function splitShopItems_(text) {
  return text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').split(/[、，,\n]+/).map(parseShopItem_).filter((x) => x.text);
}

function shopLine_(trip, item) {
  const a = shopActivity_(trip, item);
  return `${item.done ? '☑' : '☐'} ${item.text}${item.fileId ? ' 📷' : ''}${Number(item.price) ? ` ${showMoney_(item.price, trip.currency)}` : ''}${a ? `（${a.title}）` : ''}${item.note ? `\n　　📝 ${item.note}` : ''}`;
}

/* ---------- 新旅程：名稱＋日期範圍 ---------- */
function parseTripSpec_(text, ctx) {
  const DATE = '(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}\\s*(?:/|月)\\s*\\d{1,2}\\s*(?:日|號)?)';
  let m = text.match(new RegExp(`${DATE}\\s*(?:-|~|～|到|至)\\s*${DATE}`));
  let start;
  let end;
  let rest;
  if (m) {
    start = extractDate_(m[1], ctx);
    end = extractDate_(m[2], ctx);
    rest = text.replace(m[0], ' ');
  } else if ((m = text.match(new RegExp(`${DATE}\\s*(?:-|~|～|到|至)\\s*(\\d{1,2})\\s*(?:日|號)?(?!\\s*天)`)))) {
    // 10/28-30
    start = extractDate_(m[1], ctx);
    if (start) end = { date: `${start.date.slice(0, 8)}${pad2_(m[2])}` };
    rest = text.replace(m[0], ' ');
  } else if ((m = text.match(new RegExp(`${DATE}\\s*(?:出發)?\\s*(\\d{1,2}|[一二兩三四五六七八九十]+)\\s*天`)))) {
    // 10/28 3天
    start = extractDate_(m[1], ctx);
    const n = cnToInt_(m[2]);
    if (start && n >= 1) end = { date: addDays_(start.date, n - 1) };
    rest = text.replace(m[0], ' ');
  }
  if (!start || !end || !isValidDate_(end.date)) return null;
  let endDate = end.date;
  if (endDate < start.date) {
    // 跨年：12/30-1/2
    const next = `${Number(endDate.slice(0, 4)) + 1}${endDate.slice(4)}`;
    if (isValidDate_(next) && daysBetween_(start.date, next) <= 60) endDate = next;
  }
  const name = rest.replace(/\s+/g, ' ').trim();
  return { name, startDate: start.date, endDate };
}

/* ---------- Google 地圖 ---------- */
function extractUrl_(text) {
  const m = text.match(/https:\/\/[^\s"'<>]+/i);
  return m ? { url: m[0].slice(0, 500), rest: text.replace(m[0], ' ').trim() } : null;
}

// 只接受 https 連結，避免奇怪的網址被放進按鈕或網頁
function cleanUrl_(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 500) : '';
}

function placeUrl_(a) {
  if (a.mapUrl) return a.mapUrl;
  return a.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.location)}` : '';
}

// 導航：以目前位置為起點，直接開啟 Google 地圖路線
function navUrl_(a) {
  if (!a.location) return a.mapUrl || '';
  const mode = TRAVEL_MODES[travelModeKey_(a.travelMode)];
  return navToUrl_(a.location) + (mode && mode.gmap ? `&travelmode=${mode.gmap}` : '');
}

function navToUrl_(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`;
}

// 當天路線：依時間順序串起有地點的行程（Google 地圖最多 9 個中途點）
function dayRouteUrl_(list) {
  const stops = list.map((a) => a.location).filter(Boolean);
  if (!stops.length) return '';
  const waypoints = stops.slice(0, -1).slice(-9);
  return navToUrl_(stops[stops.length - 1]) + (waypoints.length ? `&waypoints=${encodeURIComponent(waypoints.join('|'))}` : '');
}

/* ---------- 時間區間與移動時間 ---------- */
function toMin_(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function fromMin_(n) {
  const v = Math.min(Math.max(Math.round(n), 0), 23 * 60 + 59);
  return `${pad2_(Math.floor(v / 60))}:${pad2_(v % 60)}`;
}

function timeLabel_(a) {
  if (!a.time) return '';
  return a.endTime ? `${a.time}–${a.endTime}` : a.time;
}

function travelText_(min) {
  if (min < 60) return `${min} 分鐘`;
  return `${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}`;
}

// 上一站結束＋移動時間，是否趕得上這一站
function scheduleIssue_(prev, a) {
  const prevEnd = prev && (prev.endTime || prev.time);
  if (!a.time || !prevEnd) return '';
  const arrive = toMin_(prevEnd) + (Number(a.travelMin) || 0);
  const late = arrive - toMin_(a.time);
  return late > 0 ? `預計 ${fromMin_(arrive)} 才會到，晚了 ${late} 分鐘` : '';
}

/** 09:00-12:00、9點到12點、下午2點~5點半；沒有區間時退回單一時間 */
function extractTimeRange_(text) {
  const T = '(?:上午|早上|中午|下午|晚上|傍晚|凌晨)?\\s*(?:\\d{1,2}\\s*[:：]\\s*\\d{2}|(?:\\d{1,2}|[一二兩三四五六七八九十]{1,3})\\s*[點点時](?:\\s*半|\\s*\\d{1,2}\\s*分?)?)';
  const m = text.match(new RegExp(`(${T})\\s*(?:-|~|～|–|到|至)\\s*(${T})`));
  if (m) {
    const a = extractTime_(m[1]);
    let b = extractTime_(m[2]);
    if (a && b) {
      // 「下午2點到5點」：結束沒寫上下午時，沿用開始的
      if (b.time < a.time && toMin_(b.time) + 12 * 60 < 24 * 60) b = { time: fromMin_(toMin_(b.time) + 12 * 60) };
      if (b.time >= a.time) return { time: a.time, endTime: b.time, rest: text.replace(m[0], ' ').trim() };
    }
  }
  const single = extractTime_(text);
  return single ? { time: single.time, endTime: '', rest: single.rest } : null;
}

function travelModeKey_(v) {
  return Object.prototype.hasOwnProperty.call(TRAVEL_MODES, v) ? v : '';
}

function detectTravelMode_(text) {
  const hit = Object.entries(TRAVEL_MODES).find(([, m]) => m.re.test(text));
  return hit ? hit[0] : '';
}

/**
 * 移動段落：移動15分、電車15分、搭公車 20 分鐘、車程 1 小時 20 分、計程車10分 車資300
 * 車資一定要寫「車資／交通費／票價」，避免和行程本身的花費混在一起
 * @return {{travelMin: number, travelMode: string, travelCost: number|null, hasTravel: boolean, rest: string} | null}
 */
function extractTravel_(text) {
  const MODE = Object.values(TRAVEL_MODES).map((m) => m.re.source).join('|');
  const LEG = `(?:(?:移動|交通|車程|路程)\\s*(?:時間)?\\s*)?(?:(?:搭|坐|騎|開)?\\s*(${MODE})\\s*)?(?:約|大概|大約)?\\s*(?:(\\d{1,2})\\s*(?:小時|hr|h)\\s*)?(?:(\\d{1,3})\\s*(?:分鐘|分|min))?`;
  let rest = text;
  let found = null;
  for (const chunk of text.match(new RegExp(LEG, 'gi')) || []) {
    if (!chunk) continue;
    const parts = chunk.match(new RegExp(`^${LEG}`, 'i'));
    const hasKeyword = /^(?:移動|交通|車程|路程)/.test(chunk) || parts[1];
    if (!hasKeyword || (!parts[2] && !parts[3])) continue;
    found = {
      travelMin: Math.min(1440, (Number(parts[2]) || 0) * 60 + (Number(parts[3]) || 0)),
      travelMode: parts[1] ? detectTravelMode_(parts[1]) : '',
    };
    rest = rest.replace(chunk, ' ');
    break;
  }
  // 車資單位：円／日圓／日幣／¥ ＝日幣；元／塊／台幣／NT$ ＝台幣；沒寫單位當作日幣
  const fare = rest.match(/(?:車資|交通費|票價|車票)\s*(NT\$|\$|¥|￥)?\s*(\d+(?:\.\d+)?)\s*(元|塊|台幣|臺幣|円|日圓|日幣|yen)?/i);
  if (fare) rest = rest.replace(fare[0], ' ');
  const fareCurrency = fare && (/NT\$|\$|元|塊|台幣|臺幣/i.test(`${fare[1] || ''}${fare[3] || ''}`) ? 'TWD' : 'JPY');
  // 只寫「搭電車」沒寫時間
  if (!found) {
    const onlyMode = rest.match(new RegExp(`(?:搭|坐|騎|開)\\s*(${MODE})`, 'i'));
    if (onlyMode) {
      found = { travelMin: 0, travelMode: detectTravelMode_(onlyMode[1]) };
      rest = rest.replace(onlyMode[0], ' ');
    }
  }
  if (!found && !fare) return null;
  return {
    travelMin: found ? found.travelMin : 0,
    travelMode: found ? found.travelMode : '',
    travelCost: fare ? Number(fare[2]) : null,
    travelCostCurrency: fareCurrency || '',
    hasTravel: !!found,
    rest: rest.replace(/\s+/g, ' ').trim(),
  };
}

function transitLabel_(a, currency) {
  const mode = TRAVEL_MODES[travelModeKey_(a.travelMode)];
  const travel = Number(a.travelMin) || 0;
  const fare = fareText_(a, currency);
  if (!mode && !travel && !fare) return '';
  const parts = [mode ? `${mode.icon} ${mode.label}` : '⏱️ 移動'];
  if (travel) parts.push(travelText_(travel));
  return parts.join(' ') + (fare ? `・${fare}` : '');
}
