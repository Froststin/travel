'use strict';

/* ============================================================
 * LINE 整合
 *  A. 分享到 LINE：把行程整理成文字，用 line.me/R/share 分享（不需任何設定）
 *  B. LIFF：在 config.js 填入 liffId 後，於 LINE 內開啟時改用 shareTargetPicker
 *     傳送 Flex Message 行程卡片；失敗或不支援時自動退回 A
 * ============================================================ */

const LIFF_SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
const LIFF_ID = (window.TRAVEL_CONFIG && window.TRAVEL_CONFIG.liffId) || '';
const SHARE_TEXT_LIMIT = 2000;
const FLEX_MAX_BUBBLES = 12;       // carousel 上限
const FLEX_MAX_ITEMS = 12;         // 每天最多列出幾項
const CAT_COLORS = {
  sight: '#16a34a', food: '#ea580c', transport: '#2563eb',
  stay: '#7c3aed', shopping: '#db2777', other: '#64748b',
};

let liffReady = false;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`無法載入 ${src}`));
    document.head.appendChild(s);
  });
}

async function initLiff() {
  if (!LIFF_ID) return settleLocal();
  try {
    await loadScript(LIFF_SDK_URL);
    await liff.init({ liffId: LIFF_ID });
    liffReady = true;
    document.body.classList.toggle('in-line', liff.isInClient());
  } catch (err) {
    console.warn('LIFF 初始化失敗，改用一般分享連結', err);
    settleLocal();
    return;
  }
  if (!API_URL) {
    openTripFromQuery();
    return;
  }
  if (liff.isLoggedIn()) {
    Cloud.start();
  } else {
    document.getElementById('login-btn').hidden = false;
    settleLocal();
  }
}

// 不走雲端時，用本機資料重新判斷目前頁面
function settleLocal() {
  if (!cloudPending) return;
  cloudPending = false;
  route();
}

function lineLogin() {
  if (liffReady) liff.login({ redirectUri: location.href });
  else toast('LINE 登入目前無法使用，請稍後再試');
}

function canUsePicker() {
  return liffReady && liff.isLoggedIn() && liff.isApiAvailable('shareTargetPicker');
}

/* ---------- 文字版（方案 A） ---------- */
function tripShareText(t, dates) {
  const all = dateRange(t.startDate, t.endDate);
  const lines = [
    `🧳 ${t.name}`,
    `📍 ${t.destination || '未設定目的地'}`,
    `🗓️ ${prettyDate(t.startDate)} – ${prettyDate(t.endDate)}・${durationText(all.length)}`,
  ];
  for (const d of dates) {
    const list = t.days[d] || [];
    lines.push('', `【Day ${all.indexOf(d) + 1}・${prettyDate(d)}】`);
    if (!list.length) lines.push('（尚未安排）');
    for (const a of list) {
      const c = CATEGORIES[catKey(a)];
      lines.push(`${a.time || '--:--'} ${c.icon} ${a.title}${a.location ? `（${a.location}）` : ''}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > SHARE_TEXT_LIMIT) text = `${text.slice(0, SHARE_TEXT_LIMIT)}\n……（行程太長，只顯示前段）`;
  return text;
}

function openLineShareUrl(text) {
  const url = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
  if (liffReady && liff.isInClient()) liff.openWindow({ url, external: false });
  else window.open(url, '_blank', 'noopener');
}

/* ---------- Flex Message 版（方案 B） ---------- */
function flexText(text, extra = {}) {
  return { type: 'text', text: String(text || ' ').slice(0, 200), wrap: true, ...extra };
}

function dayBubble(t, d, dayNo) {
  const list = t.days[d] || [];
  const rows = list.slice(0, FLEX_MAX_ITEMS).map((a) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      flexText(a.time || '--:--', { size: 'sm', color: '#66727a', flex: 0 }),
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: CAT_COLORS[catKey(a)], contents: [] },
      {
        type: 'box',
        layout: 'vertical',
        contents: [
          flexText(a.title, { size: 'sm', weight: 'bold', color: '#1f2a2e' }),
          ...(a.location ? [flexText(`📍 ${a.location}`, { size: 'xs', color: '#0f766e' })] : []),
        ],
      },
    ],
  }));
  if (list.length > FLEX_MAX_ITEMS) {
    rows.push(flexText(`……還有 ${list.length - FLEX_MAX_ITEMS} 項`, { size: 'xs', color: '#66727a' }));
  }
  if (!rows.length) rows.push(flexText('尚未安排', { size: 'sm', color: '#66727a' }));

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0f766e',
      paddingAll: '16px',
      contents: [
        flexText(t.name, { size: 'xs', color: '#d9f0ec' }),
        flexText(`Day ${dayNo}・${prettyDate(d)}`, { size: 'lg', weight: 'bold', color: '#ffffff' }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'lg', contents: rows },
  };
}

function tripFlexMessage(t, dates) {
  const all = dateRange(t.startDate, t.endDate);
  const bubbles = dates.slice(0, FLEX_MAX_BUBBLES).map((d) => dayBubble(t, d, all.indexOf(d) + 1));
  const alt = `${t.name}｜${prettyDate(dates[0])}${dates.length > 1 ? ` – ${prettyDate(dates[dates.length - 1])}` : ''} 的行程`;
  return {
    type: 'flex',
    altText: alt.slice(0, 400),
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
  };
}

/* ---------- 對外：分享 ---------- */
async function shareToLine(t, dates) {
  if (!t || !dates.length) return;
  if (canUsePicker()) {
    try {
      const res = await liff.shareTargetPicker([tripFlexMessage(t, dates)]);
      if (res) toast('已分享到 LINE');
      return;
    } catch (err) {
      console.warn('shareTargetPicker 失敗，改用文字分享', err);
    }
  }
  openLineShareUrl(tripShareText(t, dates));
}

initLiff();
