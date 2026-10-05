/* ============================================================
 * 匯出：把旅程做成 PDF 放在 Google 雲端硬碟（知道連結的人可檢視）
 * 用途是備份——網站打不開時還能看行程，也可以下載到手機離線看。
 * 內容是匯出當下的快照，之後改了行程要再匯出一次；購物清單只含匯出者自己的。
 * ============================================================ */

function escHtml_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 預算摘要（全部換算成台幣）；購物清單的金額歸在「購物」 */
function budgetSummary_(trip) {
  const cur = trip.currency;
  const all = Object.values(trip.days).flat();
  const shopSum = (trip.shopping || []).reduce((s, x) => s + twdOrRaw_(x.price, cur), 0);
  const byCat = { shopping: shopSum };
  all.forEach((a) => {
    byCat[catKey_(a.category)] = (byCat[catKey_(a.category)] || 0) + twdOrRaw_(a.cost, cur);
    byCat.transport = (byCat.transport || 0) + twdOrRaw_(a.travelCost, fareCurrency_(a, cur)); // 車資算交通
  });
  const foreign = [...new Set([cur, ...all.filter((a) => Number(a.travelCost)).map((a) => fareCurrency_(a, cur))])].filter((c) => c && c !== 'TWD');
  return {
    spent: Object.values(byCat).reduce((s, v) => s + v, 0),
    budget: trip.budget ? twdOrRaw_(trip.budget, cur) : 0,
    cats: Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]),
    foreign,
    missing: foreign.filter((c) => !rateFor_(c)),
  };
}

/** 整趟旅程的靜態網頁（不含 emoji，轉 PDF 時比較不會缺字） */
function exportHtml_(trip, exportedAt) {
  const e = escHtml_;
  const dates = dateRange_(trip.startDate, trip.endDate);
  const days = dates.map((d, i) => {
    const list = trip.days[d] || [];
    const rows = list.map((a, idx) => {
      const transit = transitLabel_(a, trip.currency).replace(/^[^\u4e00-\u9fffA-Za-z0-9]+/, ''); // 去掉開頭的圖示
      const issue = scheduleIssue_(list[idx - 1], a);
      const buy = (trip.shopping || []).filter((s) => s.activityId === a.id);
      return `
        ${transit || issue ? `<tr class="transit"><td></td><td colspan="3">↓ ${e(transit)}${issue ? ` <b>注意：${e(issue)}</b>` : ''}</td></tr>` : ''}
        <tr>
          <td class="time">${e(timeLabel_(a) || '—')}</td>
          <td><b>${e(a.title)}</b> <span class="cat">${e(CATEGORY_INFO[catKey_(a.category)].label)}</span>
            ${a.location ? `<div class="sub">地點：${e(a.location)}</div>` : ''}
            ${a.notes ? `<div class="sub">${e(a.notes)}</div>` : ''}
            ${buy.length ? `<div class="sub buy">要買：${buy.map((s) => shopText_(trip, s)).join('、')}</div>` : ''}
          </td>
          <td class="money">${a.cost ? e(showMoney_(a.cost, trip.currency)) : ''}</td>
        </tr>`;
    }).join('');
    const dayBuy = shoppingOn_(trip, d).filter((s) => !list.some((a) => a.id === s.activityId));
    return `
      <h2>Day ${i + 1}・${e(prettyDate_(d))}</h2>
      ${list.length ? `<table>${rows}</table>` : '<p class="sub">（尚未安排）</p>'}
      ${dayBuy.length ? `<p class="buy">這天要買：${dayBuy.map((s) => shopText_(trip, s)).join('、')}</p>` : ''}`;
  }).join('');

  const b = budgetSummary_(trip);
  const budget = `
    <h2>預算</h2>
    <table>
      ${trip.budget ? `<tr><td>總預算</td><td class="money">${e(showMoney_(trip.budget, trip.currency))}</td></tr>` : ''}
      <tr><td>預估花費</td><td class="money">${e(ntd_(b.spent))}</td></tr>
      ${trip.budget ? `<tr><td>${b.budget - b.spent >= 0 ? '剩餘' : '超出預算'}</td><td class="money">${e(ntd_(Math.abs(b.budget - b.spent)))}</td></tr>` : ''}
      ${b.cats.map(([k, v]) => `<tr class="transit"><td>　${e(CATEGORY_INFO[k].label)}</td><td class="money">${e(ntd_(v))}</td></tr>`).join('')}
    </table>
    ${b.foreign.length ? `<p class="sub">金額皆換算成台幣：${e(b.foreign.map(rateText_).join('；'))}</p>` : ''}
    ${b.missing.length ? `<p class="sub"><b>查不到 ${e(b.missing.join('、'))} 的匯率，這些金額暫時直接當成台幣加總，數字不準。</b></p>` : ''}`;

  const loose = shoppingOn_(trip, '');
  const shopping = (trip.shopping || []).length ? `
    <h2>我的購物清單</h2>
    <table>
      ${dates.map((d, i) => shoppingOn_(trip, d).map((s) => shopRowHtml_(trip, s, `Day ${i + 1}`)).join('')).join('')}
      ${loose.map((s) => shopRowHtml_(trip, s, '不指定')).join('')}
    </table>` : '';

  const packing = (trip.packing || []).length ? `
    <h2>行李清單</h2>
    <p>${trip.packing.map((p) => `${p.done ? '[v]' : '[　]'} ${e(p.text)}`).join('　')}</p>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${e(trip.name)}</title><style>
    body { font-family: "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif; font-size: 11pt; color: #1f2a2e; line-height: 1.5; }
    h1 { font-size: 20pt; margin: 0 0 4px; color: #0f766e; }
    h2 { font-size: 13pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 2px solid #0f766e; color: #0f766e; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
    .time { width: 92px; white-space: nowrap; color: #555; }
    .money { width: 150px; text-align: right; white-space: nowrap; }
    .cat { font-size: 8.5pt; color: #666; border: 1px solid #bbb; padding: 0 4px; }
    .sub { font-size: 9.5pt; color: #555; }
    .buy { color: #b0195a; }
    .transit td { font-size: 9.5pt; color: #555; border-bottom: none; padding-top: 2px; padding-bottom: 2px; }
    .meta { color: #555; margin: 0; }
  </style></head><body>
    <h1>${e(trip.name)}</h1>
    <p class="meta">${e(trip.destination || '未設定目的地')}・${e(prettyDate_(trip.startDate))} – ${e(prettyDate_(trip.endDate))}・${e(durationText_(dates.length))}</p>
    ${(trip.members || []).length > 1 ? `<p class="meta">成員：${e(trip.members.map((m) => m.name).join('、'))}</p>` : ''}
    ${trip.notes ? `<p>${e(trip.notes)}</p>` : ''}
    <p class="sub">這是 ${e(exportedAt)} 匯出的備份，之後的修改不會出現在這裡。最新內容：${e(tripLiffUrl_(trip.id))}</p>
    ${days}${budget}${shopping}${packing}
  </body></html>`;
}

function shopText_(trip, s) {
  return escHtml_(`${s.done ? '(已買) ' : ''}${s.text}${s.note ? `（${s.note}）` : ''}${Number(s.price) ? ` ${showMoney_(s.price, trip.currency)}` : ''}`);
}

function shopRowHtml_(trip, s, dayLabel) {
  const a = shopActivity_(trip, s);
  return `<tr><td class="time">${escHtml_(dayLabel)}</td><td>${s.done ? '[v]' : '[　]'} ${escHtml_(s.text)}${a ? ` <span class="sub">（${escHtml_(a.title)}）</span>` : ''}${s.note ? `<div class="sub">${escHtml_(s.note)}</div>` : ''}</td>
    <td class="money">${Number(s.price) ? escHtml_(showMoney_(s.price, trip.currency)) : ''}</td></tr>`;
}

function exportFolder_() {
  return driveFolder_('EXPORT_FOLDER_ID', '旅程手帖匯出');
}

/**
 * 產生 PDF 並回傳分享連結。同一個人同一個旅程只留最新的一份，舊的丟到垃圾桶（舊連結會失效）
 * @return {{url: string, exportedAt: string}}
 */
function exportTripPdf_(userId, trip) {
  const exportedAt = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const pdf = Utilities.newBlob(exportHtml_(trip, exportedAt), 'text/html', `${trip.name}.html`)
    .getAs('application/pdf')
    .setName(`${trip.name}_${exportedAt.replace(/[: ]/g, '')}.pdf`);
  const file = exportFolder_().createFile(pdf);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const props = PropertiesService.getScriptProperties();
  const key = `EXPORT_${memberKey_(trip.id, userId)}`;
  const old = prop_(key);
  if (old) {
    try {
      DriveApp.getFileById(old).setTrashed(true);
    } catch (err) {
      console.warn('刪除舊的匯出檔失敗', err);
    }
  }
  props.setProperty(key, file.getId());
  return { url: file.getUrl(), exportedAt };
}
