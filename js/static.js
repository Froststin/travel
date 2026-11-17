'use strict';

/* ============================================================
 * 匯出靜態網頁：把一個旅程做成單一 HTML 檔
 * 樣式內嵌、不依賴這個網站或雲端，可以離線開啟、列印或轉傳。
 * 只有一小段 JavaScript：購物、行李清單可以打勾，記在打開檔案的那台裝置（擋 JavaScript 時照樣能看，只是不能勾）。
 * 內容是匯出當下的快照（金額用當時的匯率換算好），之後的修改要重新匯出。
 * ============================================================ */

const STATIC_MAX_PHOTOS = 40; // 備忘照片最多內嵌幾張，避免檔案太大
const STATIC_MAX_CHARS = 15 * 1024 * 1024; // 匯出檔超過約 15 MB 時把地鐵圖再縮小

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
label.tick { display:inline-flex; align-items:baseline; gap:6px; cursor:pointer; }
label.tick input { width:18px; height:18px; margin:0; flex:none; position:relative; top:3px; accent-color:var(--pri); }
label.tick input:checked + span { text-decoration:line-through; color:var(--muted); }
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
.booking { margin:-4px 0 8px; padding:2px 10px; border-left:3px solid #7c3aed; }
.shopimg { display:block; width:120px; max-width:40%; border-radius:8px; margin:4px 0; }
figure.metro { margin:0 0 16px; }
figure.metro img { display:block; width:100%; height:auto; border-radius:10px; border:1px solid var(--line); }
footer { margin-top:24px; text-align:center; font-size:.85rem; color:var(--muted); }
@media print { body { background:#fff; } section { break-inside:avoid; border-color:#ccc; } #metro { break-inside:auto; } figure.metro { break-inside:avoid; } nav { display:none; } a { color:inherit; text-decoration:none; } }
`;

// 購物項目的照片（匯出前已經用 ShopPhotos.fetch 準備好的才放得進來）
function staticShopImg(s) {
  const src = typeof ShopPhotos !== 'undefined' ? ShopPhotos.src(s) : (s.image || '');
  return src ? `<img class="shopimg" src="${esc(src)}" alt="">` : '';
}

// 可以打勾的項目：離線匯出的檔案裡點一下就能勾（同一樣東西出現在好幾個地方會一起變）；線上檢視頁只能看
let staticOnline = false;
function staticTick(key, done, text) {
  return `<label class="tick"><input type="checkbox" data-k="${esc(key)}" ${done ? 'checked' : ''}${staticOnline ? ' disabled' : ''}><span>${esc(text)}</span></label>`;
}

function staticShopItems(items, currency) {
  return items.map((s) => `<li>${staticShopImg(s)}${staticTick(`s:${s.id}`, s.done, s.text)}${Number(s.price) || cleanQty(s.quantity) > 1 ? ` <span class="muted small">${shopMoneyHtml(s, currency)}</span>` : ''}${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ''}</li>`).join('');
}

/**
 * 產生整份靜態網頁的 HTML
 * @param {Object} t 旅程
 * @param {Map<string,string>} photos 日誌照片（fileId → data URL），沒有的照片會顯示文字說明
 */
function buildStaticHtml(t, photos = new Map(), online = false, metro = new Map()) {
  staticOnline = online;
  const dates = dateRange(t.startDate, t.endDate);
  const shop = shoppingIndex(t, dates);
  const b = budgetData(t, dates);
  const now = new Date();
  const exportedAt = `${fmtDate(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const siteUrl = `${location.origin}${location.pathname}${cloudOn() || online ? `?trip=${encodeURIComponent(t.id)}` : ''}`;
  const journal = tripMemos(t);

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
            ${staticShopImg(a)}
            <div class="title">${c.icon} ${esc(a.title)}<span class="chip">${c.label}</span></div>
            ${place || nav ? `<div class="small">${place ? `<a href="${esc(place)}">📍 ${esc(a.location || '地圖')}</a>` : ''}${nav ? ` ・ <a href="${esc(nav)}">🧭 導航</a>` : ''}</div>` : ''}
            ${a.notes ? `<div class="small muted">${esc(a.notes)}</div>` : ''}
            ${buy.length ? `<ul class="buy">${staticShopItems(buy, t.currency)}</ul>` : ''}
          </div>
          ${Number(a.cost) ? `<div class="cost">${showMoney(a.cost, costCurrency(a, t.currency))}</div>` : ''}
        </li>`;
    }).join('');
    return `
      <section id="day-${i + 1}">
        <div class="day-head">
          <div><div class="day-no">DAY ${i + 1}</div><h2>${prettyDate(d)}</h2></div>
          <div class="small muted">${total ? `${ntd(total)}　` : ''}${route ? `<a href="${esc(route)}">🧭 當天路線</a>` : ''}</div>
        </div>
        ${typeof bookingsOn === 'function' ? bookingsOn(t, d).map((bk) => `<div class="small booking">${esc(bookingText(bk, d))}${bk.code && d === bk.date ? `　<span class="muted">確認碼 ${esc(bk.code)}</span>` : ''}</div>`).join('') : ''}
        ${list.length ? `<ol>${acts}</ol>` : '<p class="muted">（尚未安排）</p>'}
        ${dayShop.length ? `<div class="small muted" style="margin-top:8px">🛒 這天要買</div><ul class="buy">${staticShopItems(dayShop, t.currency)}</ul>` : ''}
      </section>`;
  }).join('');

  const budget = `
    <section id="budget">
      <h2>💰 預算</h2>
      <div class="stats">
        <div class="stat"><span class="small muted">總預算（合計）</span><b>${b.budget ? ntd(b.budget) : '未設定'}</b></div>
        <div class="stat"><span class="small muted">預估花費</span><b>${ntd(b.spent)}</b></div>
        <div class="stat"><span class="small muted">${b.over ? '超出預算' : '剩餘'}</span><b${b.over ? ' class="warn"' : ''}>${b.budget ? ntd(Math.abs(b.remain)) : '—'}</b></div>
      </div>
      ${(() => {
        // 帳戶以人為單位：每個人的台幣、日幣帳戶（有設預算或有花費的才列）
        const lines = b.people.flatMap((p) => Object.keys(ACCOUNTS).map((k) => ({ p, x: accountLine(p, k) }))).filter(({ x }) => x.budget || x.spent > 0.005);
        if (!lines.length) return '';
        const many = b.people.length > 1;
        return `<table><thead><tr>${many ? '<th>誰</th>' : ''}<th>帳戶</th><th class="num">預算</th><th class="num">已用</th><th class="num">剩餘</th></tr></thead><tbody>
          ${lines.map(({ p, x }) => `<tr>${many ? `<td>${esc(p.name)}</td>` : ''}<td>${x.icon} ${x.label}</td><td class="num">${x.budget ? acctMoney(x.budget, x.key) : '—'}</td><td class="num">${acctMoney(x.spent, x.key)}</td><td class="num${x.over ? ' warn' : ''}">${x.budget ? `${x.over ? '超出 ' : ''}${acctMoney(Math.abs(x.remain), x.key)}` : '—'}</td></tr>`).join('')}</tbody></table>`;
      })()}
      ${b.byCat.length ? `<table style="margin-top:12px"><thead><tr><th>分類</th><th class="num">花費</th></tr></thead><tbody>
        ${b.byCat.map((x) => `<tr><td>${x.icon} ${x.label}</td><td class="num">${ntd(x.sum)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">行程項目還沒有填寫花費。</p>'}
      <table style="margin-top:12px"><thead><tr><th>日期</th><th class="num">花費</th></tr></thead><tbody>
        ${dates.map((d, i) => `<tr><td>Day ${i + 1}・${prettyDate(d)}</td><td class="num">${ntd(b.dayTotal(d))}</td></tr>`).join('')}
        ${b.looseTotal > 0.005 ? `<tr><td>不指定日期（購物、記帳）</td><td class="num">${ntd(b.looseTotal)}</td></tr>` : ''}
      </tbody></table>
      ${b.shares ? `<table style="margin-top:12px"><thead><tr><th>每人花費</th><th class="num">總計</th></tr></thead><tbody>
        ${b.shares.rows.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${ntd(p.total)}</td></tr>`).join('')}
        <tr><td><b>全部總計</b></td><td class="num"><b>${ntd(b.shares.total)}</b></td></tr></tbody></table>` : ''}
      ${b.shopTotal ? `<p class="small muted">※ 含購物清單 ${ntd(b.shopTotal)}（歸在「購物」）</p>` : ''}
      ${b.foreign.length ? `<p class="small muted">※ 金額皆以匯出當時的匯率換算成台幣：${b.foreign.map((c) => esc(rateNote(c))).join('；')}</p>` : ''}
      ${b.missing.length ? `<p class="small warn">⚠️ 匯出時還沒取得 ${esc(b.missing.join('、'))} 的匯率，這些金額直接當成台幣加總，數字不準。</p>` : ''}
    </section>`;

  const books = typeof sortedBookings === 'function' ? sortedBookings(t) : [];
  const bookingsHtml = books.length ? `
    <section id="bookings">
      <h2>🧾 住宿與交通</h2>
      <table><tbody>${books.map((bk) => `<tr>
        <td class="small muted">${bk.date ? prettyDate(bk.date) : '未定'}${bk.type === 'stay' && bk.endDate ? ` – ${prettyDate(bk.endDate)}` : ''}</td>
        <td>${esc(bookingText(bk, ''))}${bk.place ? `<div class="small muted">📍 ${esc(bk.place)}</div>` : ''}${bk.notes ? `<div class="small muted">${esc(bk.notes)}</div>` : ''}</td>
        <td class="num">${bk.code ? esc(bk.code) : ''}</td></tr>`).join('')}</tbody></table>
    </section>` : '';

  const st = typeof splitMembers === 'function' && splitMembers(t).length ? settlement(t) : null;
  const settleHtml = st && !st.total && st.settled ? `
    <section id="settle">
      <h2>🤝 分帳</h2>
      <p>已結清的記帳 ${st.settled} 筆，目前沒有要轉帳的。</p>
    </section>` : st && st.total ? `
    <section id="settle">
      <h2>🤝 分帳</h2>
      <table><thead><tr><th>旅伴</th><th class="num">付了</th><th class="num">應分攤</th></tr></thead><tbody>
        ${st.rows.map((p) => `<tr><td>${esc(personName(p))}</td><td class="num">${ntd(p.paid)}</td><td class="num">${ntd(p.share)}</td></tr>`).join('')}
      </tbody></table>
      <p>${st.transfers.length ? st.transfers.map((x) => `💸 ${esc(personName(x.from))} 付給 ${esc(personName(x.to))} <b>${ntd(x.amount)}</b>`).join('<br>') : '大家都打平了 🎉'}</p>
      ${st.unassigned ? `<p class="small muted">※ 還有 ${st.unassigned} 筆花費沒填誰付的，沒有算進來。</p>` : ''}
    </section>` : '';

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

  // 行李：共用的＋自己的（雲端共用旅程才有「我的」）
  const packLists = [['', t.packing || []], ['我的', t.myPacking || []]].filter(([, l]) => l.length);
  const packing = packLists.length ? `
    <section id="packing">
      <h2>🧳 行李清單</h2>
      ${packLists.map(([label, list]) => `
      ${label || packLists.length > 1 ? `<h3 class="small muted">${label || '共用'}</h3>` : ''}
      <p class="small muted">已準備 ${list.filter((p) => p.done).length} / ${list.length}</p>
      <ul class="check cols">${list.map((p) => `<li>${staticTick(`p:${p.id}`, p.done, p.text)}</li>`).join('')}</ul>`).join('')}
    </section>` : '';

  const journalHtml = journal.length ? `
    <section id="journal">
      <h2>📝 備忘</h2>
      ${['', ...dates].filter((d) => journal.some((j) => j.date === d)).map((d) => `
        <h3 class="small muted">${d ? `Day ${dates.indexOf(d) + 1}・${prettyDate(d)}` : '📌 整趟通用'}</h3>
        <ul class="journal">${journal.filter((j) => j.date === d).map((j) => `
          <li><span class="time">${esc(j.date ? j.time : '')}</span><div class="body">
            ${j.mine === false && j.author ? `<div class="small muted">${esc(j.author)}</div>` : ''}
            ${j.type === 'image'
              ? (photos.get(j.fileId) ? `<img src="${esc(photos.get(j.fileId))}" alt="旅遊照片">` : '<span class="muted">（照片沒有包含在這份匯出裡）</span>')
              : esc(j.text).replace(/\n/g, '<br>')}
          </div></li>`).join('')}</ul>`).join('')}
    </section>` : '';

  // 待去清單裡還沒排進行程的地方（整理過的依順路分組）
  const openPlaces = typeof placeGroups === 'function' ? (t.places || []).filter((p) => !placeDate(t, p)) : [];
  const pg = openPlaces.length ? placeGroups(openPlaces) : null;
  const placesHtml = pg ? `
    <section id="places">
      <h2>📍 想去（還沒排進行程）</h2>
      <ul class="check">
        ${pg.groups.map((g) => `<li><b>${esc(g.label)}一帶</b>：${g.items.map((p) => `<a href="${esc(placeMapUrl(p))}">${esc(p.name)}</a>`).join('、')}</li>`).join('')}
        ${[...pg.pending, ...pg.missing].length ? `<li>${pg.groups.length ? '<b>其他</b>：' : ''}${[...pg.pending, ...pg.missing].map((p) => `<a href="${esc(placeMapUrl(p))}">${esc(p.name)}</a>`).join('、')}</li>` : ''}
      </ul>
    </section>` : '';

  // 地鐵圖（離線匯出才有；metro：id → 縮小過的圖）
  const metroList = (t.metroMaps || []).filter((m) => metro.get(m.id));
  const metroHtml = metroList.length ? `
    <section id="metro">
      <h2>🚇 地鐵圖</h2>
      ${metroList.map((m) => `<figure class="metro"><img src="${esc(metro.get(m.id))}" alt="${esc(m.name || '地鐵圖')}"><figcaption class="small muted">${esc(m.name || '地鐵圖')}（可以用兩指放大）</figcaption></figure>`).join('')}
    </section>` : '';

  const nav = [
    bookingsHtml ? '<a href="#bookings">🧾 住宿交通</a>' : '',
    ...dates.map((d, i) => `<a href="#day-${i + 1}">Day ${i + 1}</a>`),
    placesHtml ? '<a href="#places">📍 想去</a>' : '',
    '<a href="#budget">💰 預算</a>',
    settleHtml ? '<a href="#settle">🤝 分帳</a>' : '',
    shopping ? '<a href="#shopping">🛒 購物</a>' : '',
    packing ? '<a href="#packing">🧳 行李</a>' : '',
    journalHtml ? '<a href="#journal">📝 備忘</a>' : '',
    metroHtml ? '<a href="#metro">🚇 地鐵圖</a>' : '',
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
  ${online
    ? `<p class="notice">唯讀的線上檢視頁，${exportedAt} 的內容；重新整理就會更新。<br>要編輯請到旅程手帖：<a href="${esc(siteUrl)}">${esc(siteUrl)}</a></p>`
    : `<p class="notice">這是 ${exportedAt} 匯出的離線版本，不需要網路就能看（地圖連結除外），之後的修改不會出現在這裡。購物、行李清單可以直接打勾（記在這台裝置，不會同步回網站）。<br>最新內容：<a href="${esc(siteUrl)}">${esc(siteUrl)}</a></p>`}
  <nav>${nav}</nav>
  ${bookingsHtml}${days}${placesHtml}${budget}${settleHtml}${shopping}${packing}${journalHtml}${metroHtml}
  <footer>旅程手帖・${exportedAt} ${online ? '的內容' : '匯出'}</footer>
</main>
${online ? '' : `<script>
// 購物、行李可以打勾：記在這台裝置（localStorage），重開還在；同一樣東西在好幾個地方會一起變
(function () {
  var key = 'travel-static:${esc(t.id)}';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
  var boxes = document.querySelectorAll('input[data-k]');
  Array.prototype.forEach.call(boxes, function (c) {
    if (Object.prototype.hasOwnProperty.call(saved, c.getAttribute('data-k'))) c.checked = saved[c.getAttribute('data-k')];
    c.addEventListener('change', function () {
      var k = c.getAttribute('data-k');
      saved[k] = c.checked;
      Array.prototype.forEach.call(boxes, function (o) { if (o.getAttribute('data-k') === k) o.checked = c.checked; });
      try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) {}
    });
  });
})();
</script>`}
</body>
</html>`;
}

function staticShopRow(t, s, dayLabel) {
  const a = s.activityId && Object.values(t.days).flat().find((x) => x.id === s.activityId);
  return `<tr><td class="small muted" style="white-space:nowrap">${dayLabel}</td>
    <td>${staticShopImg(s)}${staticTick(`s:${s.id}`, s.done, s.text)}${a ? ` <span class="small muted">📍 ${esc(a.title)}</span>` : ''}${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ''}</td>
    <td class="num">${shopMoneyHtml(s, t.currency)}</td></tr>`;
}

// 日誌照片存在雲端，匯出前先抓下來內嵌（抓不到的就略過）
async function staticPhotos(t) {
  const photos = new Map();
  if (!cloudOn()) return photos;
  // 和備忘分頁看到的一樣（含整趟通用）
  const all = tripMemos(t).filter((j) => j.type === 'image' && j.fileId).map((j) => j.fileId);
  photos.skipped = Math.max(0, all.length - STATIC_MAX_PHOTOS);
  const ids = all.slice(0, STATIC_MAX_PHOTOS);
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

// 日誌照片是 LINE 傳來的原圖，一張可能好幾 MB；縮小後再內嵌，匯出的檔案才不會大到存不了、傳不出去
async function shrinkDataUrl(dataUrl, maxSide, quality) {
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', quality);
    return out.length < dataUrl.length ? out : dataUrl;
  } catch (err) {
    return dataUrl; // 縮不了就用原圖
  }
}

/* ---------- 匯出結果：下載、開新分頁、分享，三種方式任選 ----------
 * 不同瀏覽器擋的東西不一樣（內嵌瀏覽器常不能下載、LINE 內建瀏覽器常不能分享檔案），
 * 所以產生好之後讓使用者自己挑，一種不行可以換另一種。 */
let staticResult = null; // { name, html, url }

function staticSizeText(chars) {
  const kb = chars / 1024; // 內容大多是 ASCII（圖片的 base64），用字數估就夠了
  return kb < 1024 ? `約 ${Math.max(1, Math.round(kb))} KB` : `約 ${(kb / 1024).toFixed(1)} MB`;
}

function staticFile() {
  return typeof File === 'function' ? new File([staticResult.html], staticResult.name, { type: 'text/html' }) : null;
}

async function exportStaticSite(t) {
  toast('正在產生靜態網站……');
  // 上傳過的圖都附上：購物、行程照片、地鐵圖（地鐵圖是大圖，一次抓一張）、備忘照片
  if (typeof ShopPhotos !== 'undefined') {
    await ShopPhotos.fetch([...(t.shopping || []), ...Object.values(t.days).flat()].map((s) => s.fileId));
    await ShopPhotos.fetch((t.metroMaps || []).map((m) => m.fileId), 1);
  }
  const metroSrc = new Map();
  for (const m of t.metroMaps || []) {
    const src = typeof ShopPhotos !== 'undefined' ? ShopPhotos.src(m) : (m.image || '');
    if (src) metroSrc.set(m.id, src);
  }
  const shrinkMetro = async (side, q) => {
    const out = new Map();
    for (const [id, src] of metroSrc) out.set(id, await shrinkDataUrl(src, side, q));
    return out;
  };
  let metro = await shrinkMetro(2000, 0.8); // 路線圖要放大看得清楚，比照片大一點
  const photos = await staticPhotos(t);
  const skipped = photos.skipped || 0;
  for (const [id, dataUrl] of photos) photos.set(id, await shrinkDataUrl(dataUrl, 1200, 0.78));
  let html = buildStaticHtml(t, photos, false, metro);
  // 檔案太大（約 15 MB 以上）時手機可能存不了、傳不出去：地鐵圖再縮小一次
  let metroShrunk = false;
  if (html.length > STATIC_MAX_CHARS && metro.size) {
    metro = await shrinkMetro(1400, 0.72);
    html = buildStaticHtml(t, photos, false, metro);
    metroShrunk = true;
  }
  const missingMetro = (t.metroMaps || []).length - metro.size;
  const name = `${t.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '旅程'}.html`;
  if (staticResult && staticResult.url) URL.revokeObjectURL(staticResult.url);
  staticResult = { name, html, tripId: t.id, tripName: t.name, url: URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })) };

  const dialog = document.getElementById('static-dialog');
  if (!dialog) { // 瀏覽器還留著舊版頁面：照舊直接下載
    downloadBlob(name, new Blob([html], { type: 'text/html;charset=utf-8' }));
    return toast('已匯出靜態網站，用瀏覽器打開就能看');
  }
  const file = staticFile();
  let canShare = false;
  try {
    canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  } catch (err) { /* 不支援分享 */ }
  document.getElementById('static-info').textContent = `「${name}」已經產生好了（${staticSizeText(html.length)}）。`
    + (metro.size ? `含 ${metro.size} 張地鐵圖。` : '')
    + (missingMetro > 0 ? `有 ${missingMetro} 張地鐵圖讀不到，沒有放進去。` : '')
    + (skipped ? `備忘照片超過 ${STATIC_MAX_PHOTOS} 張，有 ${skipped} 張沒有放進去（避免檔案太大）。` : '')
    + (metroShrunk ? '檔案太大，地鐵圖已經縮小一些。' : '')
    + (html.length > STATIC_MAX_CHARS ? '檔案還是很大，手機上存檔或傳送可能會失敗，可以改用線上檢視連結。' : '')
    + (missingMetro > 0 ? '（讀不到的地鐵圖可以重新整理後再匯出一次）' : '');
  document.getElementById('static-share').hidden = !canShare;
  document.getElementById('static-open').href = staticResult.url;
  // 線上檢視連結要登入雲端才有（頁面是後端產生的）
  const linkBox = document.getElementById('static-link-box');
  if (linkBox) {
    linkBox.hidden = !cloudOn();
    document.getElementById('static-link-result').hidden = true;
  }
  dialog.showModal();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-static]');
  if (!el || !staticResult) return;
  if (el.dataset.static === 'download') {
    downloadBlob(staticResult.name, new Blob([staticResult.html], { type: 'text/html;charset=utf-8' }));
    toast('已開始下載；沒有反應的話改用「在新分頁開啟」');
  }
  if (el.dataset.static === 'share') {
    try {
      await navigator.share({ files: [staticFile()], title: staticResult.name });
    } catch (err) {
      if (err.name !== 'AbortError') toast('這個瀏覽器不能分享檔案，請改用「下載」或「在新分頁開啟」');
    }
  }
  // 「在新分頁開啟」是一般的連結（href 指向產生好的內容），不用另外處理

  /* ----- 線上檢視連結 ----- */
  const urlBox = document.getElementById('static-link-url');
  if (el.dataset.static === 'link' || el.dataset.static === 'link-reset') {
    const reset = el.dataset.static === 'link-reset';
    if (reset && !confirm('換新連結後，舊的連結會立刻失效，已經傳出去的都打不開。確定要換嗎？')) return;
    try {
      el.disabled = true;
      const { url } = await Cloud.call('viewLink', { tripId: staticResult.tripId, reset });
      urlBox.value = url;
      document.getElementById('static-link-result').hidden = false;
      toast(reset ? '已換成新連結，舊的失效了' : '連結好了，可以開啟、複製或傳到 LINE');
    } catch (err) {
      toast(`取得連結失敗：${err.message}`);
    } finally {
      el.disabled = false;
    }
  }
  if (el.dataset.static === 'link-open' && urlBox.value) {
    // 在 LINE 裡用外部瀏覽器開，才不會被內建瀏覽器擋
    if (typeof liffReady !== 'undefined' && liffReady && liff.isInClient()) liff.openWindow({ url: urlBox.value, external: true });
    else window.open(urlBox.value, '_blank', 'noopener');
  }
  if (el.dataset.static === 'link-copy' && urlBox.value) {
    try {
      await navigator.clipboard.writeText(urlBox.value);
      toast('已複製連結');
    } catch (err) {
      urlBox.focus();
      urlBox.select();
      toast('請長按或按 Ctrl/⌘+C 複製選取的連結');
    }
  }
  if (el.dataset.static === 'link-line' && urlBox.value) {
    openLineShareUrl(`🧳 ${staticResult.tripName} 的行程（免登入、只能看）\n${urlBox.value}`);
  }
});

/* ---------- 匯出 PDF：後端產生、存在 Google 雲端硬碟，回傳一個連結 ----------
 * 不靠瀏覽器下載檔案，所以在會擋下載的瀏覽器（例如 LINE 裡）也能用。 */
async function exportPdf(t) {
  if (!cloudOn()) return toast('匯出 PDF 要先用 LINE 登入同步；沒登入的話請用「匯出靜態網站」');
  const dialog = document.getElementById('pdf-dialog');
  if (!dialog) return toast('網頁有更新，請重新整理後再試一次');
  const info = document.getElementById('pdf-info');
  const result = document.getElementById('pdf-result');
  const urlBox = document.getElementById('pdf-url');
  info.textContent = `正在產生「${t.name}」的 PDF，大約需要 10 秒……`;
  info.classList.remove('rate-warn');
  result.hidden = true;
  dialog.dataset.name = t.name;
  dialog.showModal();
  try {
    await Cloud.queue; // 等還沒存完的修改先存上去，PDF 才是最新的
    const r = await Cloud.call('exportPdf', { tripId: t.id });
    urlBox.value = r.url;
    document.getElementById('pdf-open').href = r.url;
    info.textContent = `PDF 好了（${r.exportedAt} 的內容），存在你的 Google 雲端硬碟。行程改過要再匯出一次，舊連結會失效。知道連結的人都能看。`;
    result.hidden = false;
  } catch (err) {
    console.warn('匯出 PDF 失敗', err);
    info.classList.add('rate-warn');
    info.textContent = `匯出失敗：${err.message}。可以再按一次「匯出 PDF」，或改用「匯出靜態網站」裡的線上檢視連結。`;
  }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-pdf]');
  const urlBox = document.getElementById('pdf-url');
  if (!el || !urlBox || !urlBox.value) return;
  if (el.dataset.pdf === 'copy') {
    try {
      await navigator.clipboard.writeText(urlBox.value);
      toast('已複製連結');
    } catch (err) {
      urlBox.focus();
      urlBox.select();
      toast('請長按或按 Ctrl/⌘+C 複製選取的連結');
    }
  }
  if (el.dataset.pdf === 'line') {
    openLineShareUrl(`📄 ${document.getElementById('pdf-dialog').dataset.name} 的行程 PDF\n${urlBox.value}`);
  }
  // 在 LINE 裡用外部瀏覽器開，內建瀏覽器常開不了雲端硬碟的檔案
  if (el.dataset.pdf === 'open' && typeof liffReady !== 'undefined' && liffReady && liff.isInClient()) {
    e.preventDefault();
    liff.openWindow({ url: urlBox.value, external: true });
  }
});

/* ---------- 線上檢視頁：網址帶 ?view=<代碼> 時，不登入、不進入編輯畫面，直接把行程畫成唯讀頁面 ----------
 * 資料用代碼跟後端要（免登入），再用和「匯出靜態網站」同一套版面畫出來，整頁換成靜態內容。 */
const VIEW_TOKEN = new URLSearchParams(location.search).get('view') || '';

async function bootView() {
  document.querySelectorAll('.site-header, .site-footer').forEach((el) => { el.hidden = true; });
  app.innerHTML = '<p class="loading">正在載入行程……</p>';
  try {
    let data = null;
    for (let attempt = 1; !data; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'view', token: VIEW_TOKEN }),
        });
        data = await res.json();
      } catch (err) {
        if (attempt >= 3) throw new Error('連不上雲端，請稍後再重新整理');
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    if (!data.ok) throw new Error(data.error || '這個連結打不開');
    try {
      await loadRate(); // 外幣換算成台幣要用
    } catch (err) { /* 沒有匯率就顯示原幣 */ }
    state = { trips: [data.trip], journal: data.journal || [] };
    const html = buildStaticHtml(data.trip, new Map(), true);
    document.open();
    document.write(html);
    document.close();
  } catch (err) {
    document.title = '旅程手帖';
    app.innerHTML = `
      <section class="empty">
        <div class="empty-icon" aria-hidden="true">🔗</div>
        <h1>這個連結打不開</h1>
        <p class="muted">${esc(err.message || '')}</p>
        <p class="muted">請向分享的人要新的連結。</p>
      </section>`;
  }
}

if (VIEW_TOKEN) bootView();
