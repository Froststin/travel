'use strict';

/* ============================================================
 * 匯出靜態網頁：把一個旅程做成單一 HTML 檔
 * 樣式內嵌、沒有 JavaScript、不依賴這個網站或雲端，可以離線開啟、列印或轉傳。
 * 內容是匯出當下的快照（金額用當時的匯率換算好），之後的修改要重新匯出。
 * ============================================================ */

const STATIC_MAX_PHOTOS = 40; // 日誌照片最多內嵌幾張，避免檔案太大

const STATIC_CSS = `
:root { --bg:#f6f4ef; --card:#fff; --text:#1f2a2e; --muted:#66727a; --line:#e2ddd3; --pri:#0f766e; --warn:#b42318; --buy:#be185d; }
@media (prefers-color-scheme: dark) { :root { --bg:#151b1e; --card:#1c2428; --text:#e6ebed; --muted:#9aa7ae; --line:#2e393e; --pri:#5eead4; --warn:#f97066; --buy:#f472b6; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif; }
main { max-width:860px; margin:0 auto; padding:20px 16px 48px; }
h1 { margin:0 0 4px; font-size:1.7rem; }
h2 { margin:0 0 10px; font-size:1.15rem; color:var(--pri); }
a { color:var(--pri); }
.muted { color:var(--muted); }
.small { font-size:.88rem; }
.notice { margin:14px 0; padding:10px 14px; border:1px dashed var(--line); border-radius:10px; font-size:.9rem; color:var(--muted); overflow-wrap:anywhere; }
nav { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0; }
nav a { padding:4px 12px; border:1px solid var(--line); border-radius:999px; background:var(--card); text-decoration:none; font-size:.9rem; }
section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin:14px 0; }
.day-head { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:8px; }
.day-no { font-size:.75rem; font-weight:700; letter-spacing:.08em; color:var(--pri); }
ol,ul { list-style:none; margin:0; padding:0; }
.act { display:flex; gap:12px; padding:10px 0; border-top:1px dashed var(--line); }
.act:first-child { border-top:0; }
.time { flex:none; width:64px; font-weight:600; color:var(--muted); font-variant-numeric:tabular-nums; }
.body { flex:1; min-width:0; overflow-wrap:anywhere; }
.title { font-weight:600; }
.chip { display:inline-block; white-space:nowrap; margin-left:6px; padding:1px 8px; border-radius:999px; background:var(--bg); font-size:.75rem; font-weight:400; color:var(--muted); }
.cost { flex:none; font-weight:600; white-space:nowrap; text-align:right; }
.transit { padding:2px 0 2px 76px; font-size:.86rem; color:var(--muted); }
.warn { color:var(--warn); font-weight:600; }
.buy { margin-top:4px; padding:4px 10px; border-left:3px solid var(--buy); font-size:.92rem; }
.buy li, .check li { padding:2px 0; }
.done { text-decoration:line-through; color:var(--muted); }
table { width:100%; border-collapse:collapse; }
th,td { padding:7px 6px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
td.num, th.num { text-align:right; white-space:nowrap; }
.stats { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; }
.stat { flex:1; min-width:150px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; }
.stat b { display:block; font-size:1.15rem; }
.cols { columns:2 220px; }
.journal li { display:flex; gap:12px; padding:8px 0; border-top:1px dashed var(--line); }
.journal li:first-child { border-top:0; }
.journal img { max-width:100%; border-radius:10px; }
footer { margin-top:24px; text-align:center; font-size:.85rem; color:var(--muted); }
@media print { body { background:#fff; } section { break-inside:avoid; border-color:#ccc; } nav { display:none; } a { color:inherit; text-decoration:none; } }
`;

function staticShopItems(items, currency) {
  return items.map((s) => `<li>${s.done ? '☑' : '☐'} <span${s.done ? ' class="done"' : ''}>${esc(s.text)}</span>${Number(s.price) ? ` <span class="muted small">${showMoney(s.price, currency)}</span>` : ''}</li>`).join('');
}

/**
 * 產生整份靜態網頁的 HTML
 * @param {Object} t 旅程
 * @param {Map<string,string>} photos 日誌照片（fileId → data URL），沒有的照片會顯示文字說明
 */
function buildStaticHtml(t, photos = new Map()) {
  const dates = dateRange(t.startDate, t.endDate);
  const shop = shoppingIndex(t, dates);
  const b = budgetData(t, dates);
  const now = new Date();
  const exportedAt = `${fmtDate(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const siteUrl = `${location.origin}${location.pathname}${cloudOn() ? `?trip=${encodeURIComponent(t.id)}` : ''}`;
  const journal = (state.journal || []).filter((j) => (j.tripId ? j.tripId === t.id : true) && j.date >= t.startDate && j.date <= t.endDate);

  const days = dates.map((d, i) => {
    const list = t.days[d] || [];
    const total = sumCost(list, t.currency) + shopCost(shoppingOn(t, shop, d), t.currency);
    const route = dayRouteUrl(list);
    const dayShop = shop.byDay.get(d) || [];
    const acts = list.map((a, idx) => {
      const c = CATEGORIES[catKey(a)];
      const transit = transitLabel(a, t.currency);
      const issue = scheduleIssue(list[idx - 1], a);
      const place = placeUrl(a);
      const nav = navUrl(a);
      const buy = shop.byAct.get(a.id) || [];
      return `
        ${transit || issue ? `<li class="transit">${transit ? `↓ ${transit}` : ''}${issue ? ` <span class="warn">⚠️ ${esc(issue)}</span>` : ''}</li>` : ''}
        <li class="act">
          <div class="time">${a.time ? esc(a.time) : '—'}${a.time && a.endTime ? `<br><span class="small">~ ${esc(a.endTime)}</span>` : ''}</div>
          <div class="body">
            <div class="title">${c.icon} ${esc(a.title)}<span class="chip">${c.label}</span></div>
            ${place || nav ? `<div class="small">${place ? `<a href="${esc(place)}">📍 ${esc(a.location || '地圖')}</a>` : ''}${nav ? ` ・ <a href="${esc(nav)}">🧭 導航</a>` : ''}</div>` : ''}
            ${a.notes ? `<div class="small muted">${esc(a.notes)}</div>` : ''}
            ${buy.length ? `<ul class="buy">${staticShopItems(buy, t.currency)}</ul>` : ''}
          </div>
          ${Number(a.cost) ? `<div class="cost">${showMoney(a.cost, t.currency)}</div>` : ''}
        </li>`;
    }).join('');
    return `
      <section id="day-${i + 1}">
        <div class="day-head">
          <div><div class="day-no">DAY ${i + 1}</div><h2>${prettyDate(d)}</h2></div>
          <div class="small muted">${total ? `${ntd(total)}　` : ''}${route ? `<a href="${esc(route)}">🧭 當天路線</a>` : ''}</div>
        </div>
        ${list.length ? `<ol>${acts}</ol>` : '<p class="muted">（尚未安排）</p>'}
        ${dayShop.length ? `<div class="small muted" style="margin-top:8px">🛒 這天要買</div><ul class="buy">${staticShopItems(dayShop, t.currency)}</ul>` : ''}
      </section>`;
  }).join('');

  const budget = `
    <section id="budget">
      <h2>💰 預算</h2>
      <div class="stats">
        <div class="stat"><span class="small muted">總預算</span><b>${b.budget ? showMoney(t.budget, t.currency) : '未設定'}</b></div>
        <div class="stat"><span class="small muted">預估花費</span><b>${ntd(b.spent)}</b></div>
        <div class="stat"><span class="small muted">${b.over ? '超出預算' : '剩餘'}</span><b${b.over ? ' class="warn"' : ''}>${b.budget ? ntd(Math.abs(b.remain)) : '—'}</b></div>
      </div>
      ${b.byCat.length ? `<table><thead><tr><th>分類</th><th class="num">花費</th></tr></thead><tbody>
        ${b.byCat.map((x) => `<tr><td>${x.icon} ${x.label}</td><td class="num">${ntd(x.sum)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">行程項目還沒有填寫花費。</p>'}
      <table style="margin-top:12px"><thead><tr><th>日期</th><th class="num">花費</th></tr></thead><tbody>
        ${dates.map((d, i) => `<tr><td>Day ${i + 1}・${prettyDate(d)}</td><td class="num">${ntd(sumCost(t.days[d] || [], t.currency) + shopCost(shoppingOn(t, shop, d), t.currency))}</td></tr>`).join('')}
        ${b.looseShop > 0.005 ? `<tr><td>🛒 購物清單（不指定日期）</td><td class="num">${ntd(b.looseShop)}</td></tr>` : ''}
      </tbody></table>
      ${b.shopTotal ? `<p class="small muted">※ 含購物清單 ${ntd(b.shopTotal)}（歸在「購物」）</p>` : ''}
      ${b.foreign.length ? `<p class="small muted">※ 金額皆以匯出當時的匯率換算成台幣：${b.foreign.map((c) => esc(rateNote(c))).join('；')}</p>` : ''}
      ${b.missing.length ? `<p class="small warn">⚠️ 匯出時還沒取得 ${esc(b.missing.join('、'))} 的匯率，這些金額直接當成台幣加總，數字不準。</p>` : ''}
    </section>`;

  const items = t.shopping || [];
  const shopping = items.length ? `
    <section id="shopping">
      <h2>🛒 購物清單</h2>
      <p class="small muted">已買 ${items.filter((s) => s.done).length} / ${items.length}${b.shopTotal ? `・預估 ${ntd(b.shopTotal)}` : ''}</p>
      <table><tbody>
        ${dates.map((d, i) => shoppingOn(t, shop, d).map((s) => staticShopRow(t, s, `Day ${i + 1}`)).join('')).join('')}
        ${shop.loose.map((s) => staticShopRow(t, s, '不指定')).join('')}
      </tbody></table>
    </section>` : '';

  const packing = (t.packing || []).length ? `
    <section id="packing">
      <h2>🧳 行李清單</h2>
      <p class="small muted">已準備 ${t.packing.filter((p) => p.done).length} / ${t.packing.length}</p>
      <ul class="check cols">${t.packing.map((p) => `<li>${p.done ? '☑' : '☐'} <span${p.done ? ' class="done"' : ''}>${esc(p.text)}</span></li>`).join('')}</ul>
    </section>` : '';

  const journalHtml = journal.length ? `
    <section id="journal">
      <h2>📔 日誌</h2>
      ${dates.filter((d) => journal.some((j) => j.date === d)).map((d) => `
        <h3 class="small muted">Day ${dates.indexOf(d) + 1}・${prettyDate(d)}</h3>
        <ul class="journal">${journal.filter((j) => j.date === d).map((j) => `
          <li><span class="time">${esc(j.time)}</span><div class="body">
            ${j.mine === false && j.author ? `<div class="small muted">${esc(j.author)}</div>` : ''}
            ${j.type === 'image'
              ? (photos.get(j.fileId) ? `<img src="${esc(photos.get(j.fileId))}" alt="旅遊照片">` : '<span class="muted">（照片沒有包含在這份匯出裡）</span>')
              : esc(j.text).replace(/\n/g, '<br>')}
          </div></li>`).join('')}</ul>`).join('')}
    </section>` : '';

  const nav = [
    ...dates.map((d, i) => `<a href="#day-${i + 1}">Day ${i + 1}</a>`),
    '<a href="#budget">💰 預算</a>',
    shopping ? '<a href="#shopping">🛒 購物</a>' : '',
    packing ? '<a href="#packing">🧳 行李</a>' : '',
    journalHtml ? '<a href="#journal">📔 日誌</a>' : '',
  ].join('');

  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(t.name)}｜旅程手帖</title>
<style>${STATIC_CSS}</style>
</head>
<body>
<main>
  <h1>${esc(t.name)}</h1>
  <p class="muted">📍 ${esc(t.destination || '未設定目的地')}・${prettyDate(t.startDate)} – ${prettyDate(t.endDate)}・${durationText(dates.length)}</p>
  ${Array.isArray(t.members) && t.members.length > 1 ? `<p class="muted small">👥 ${t.members.map((m) => esc(m.name)).join('、')}</p>` : ''}
  ${t.notes ? `<p>${esc(t.notes).replace(/\n/g, '<br>')}</p>` : ''}
  <p class="notice">這是 ${exportedAt} 匯出的離線版本，不需要網路就能看（地圖連結除外），之後的修改不會出現在這裡。<br>最新內容：<a href="${esc(siteUrl)}">${esc(siteUrl)}</a></p>
  <nav>${nav}</nav>
  ${days}${budget}${shopping}${packing}${journalHtml}
  <footer>旅程手帖・${exportedAt} 匯出</footer>
</main>
</body>
</html>`;
}

function staticShopRow(t, s, dayLabel) {
  const a = s.activityId && Object.values(t.days).flat().find((x) => x.id === s.activityId);
  return `<tr><td class="small muted" style="white-space:nowrap">${dayLabel}</td>
    <td>${s.done ? '☑' : '☐'} <span${s.done ? ' class="done"' : ''}>${esc(s.text)}</span>${a ? ` <span class="small muted">📍 ${esc(a.title)}</span>` : ''}</td>
    <td class="num">${Number(s.price) ? showMoney(s.price, t.currency) : ''}</td></tr>`;
}

// 日誌照片存在雲端，匯出前先抓下來內嵌（抓不到的就略過）
async function staticPhotos(t) {
  const photos = new Map();
  if (!cloudOn()) return photos;
  const ids = (state.journal || [])
    .filter((j) => j.type === 'image' && j.fileId && (j.tripId ? j.tripId === t.id : true) && j.date >= t.startDate && j.date <= t.endDate)
    .map((j) => j.fileId)
    .slice(0, STATIC_MAX_PHOTOS);
  for (const id of ids) {
    try {
      if (!Cloud.photoCache.has(id)) Cloud.photoCache.set(id, (await Cloud.call('photo', { fileId: id })).dataUrl);
      photos.set(id, Cloud.photoCache.get(id));
    } catch (err) {
      console.warn('照片載入失敗，匯出時略過', err);
    }
  }
  return photos;
}

async function exportStaticSite(t) {
  toast('正在產生離線網頁……');
  const html = buildStaticHtml(t, await staticPhotos(t));
  const name = `${t.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '旅程'}.html`;
  const inLine = typeof liffReady !== 'undefined' && liffReady && liff.isInClient();
  const mobile = inLine || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // 手機（尤其是 LINE 內建瀏覽器）通常不能直接下載檔案，改用系統的分享選單：可以存到檔案、傳給自己或旅伴
  if (mobile && typeof File === 'function' && navigator.canShare) {
    const file = new File([html], name, { type: 'text/html' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: t.name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // 使用者自己取消
        console.warn('分享失敗，改用下載', err);
      }
    }
  }
  downloadBlob(name, new Blob([html], { type: 'text/html;charset=utf-8' }));
  toast(inLine ? '如果沒有開始下載，請點右上角選單「以預設瀏覽器開啟」後再匯出一次' : '已匯出離線網頁，用瀏覽器打開就能看');
}
