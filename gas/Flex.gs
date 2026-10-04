/* ============================================================
 * Flex Message 版面
 * ============================================================ */

const FLEX_MAX_ITEMS = 12;

function fText_(text, extra) {
  return Object.assign({ type: 'text', text: String(text || ' ').slice(0, 200) || ' ', wrap: true }, extra || {});
}

function transitRows_(prev, a, currency) {
  const label = transitLabel_(a, currency);
  const issue = scheduleIssue_(prev, a);
  if (!label && !issue) return [];
  const text = [label, issue ? `⚠️ ${issue}` : ''].filter(Boolean).join('　');
  return [fText_(text, { size: 'xxs', color: issue ? '#b42318' : '#66727a' })];
}

function activityRow_(a) {
  const info = CATEGORY_INFO[catKey_(a.category)];
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      fText_(`${a.time || '--:--'}${a.time && a.endTime ? `\n~${a.endTime}` : ''}`, { size: 'sm', color: '#66727a', flex: 0 }),
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: info.color, contents: [] },
      {
        type: 'box',
        layout: 'vertical',
        contents: [
          fText_(`${info.icon} ${a.title}`, { size: 'sm', weight: 'bold', color: '#1f2a2e' }),
          ...mapLinks_(a),
          ...(a.notes ? [fText_(a.notes, { size: 'xs', color: '#66727a' })] : []),
        ],
      },
    ],
  };
}

// 地點（點了開地圖）＋導航按鈕
function mapLinks_(a) {
  const place = placeUrl_(a);
  const nav = navUrl_(a);
  if (!place && !nav) return [];
  const contents = [];
  if (place) contents.push(fText_(`📍 ${a.location || '地圖'}`, { size: 'xs', color: '#0f766e', flex: 1, action: { type: 'uri', label: '地圖', uri: place } }));
  if (nav) contents.push(fText_('🧭 導航', { size: 'xs', color: '#0f766e', weight: 'bold', flex: 0, action: { type: 'uri', label: '導航', uri: nav } }));
  return [{ type: 'box', layout: 'horizontal', spacing: 'md', contents }];
}

/** 單日行程卡片；filter 可限定類別 */
function dayBubble_(trip, date, filter) {
  const dayNo = daysBetween_(trip.startDate, date) + 1;
  let list = trip.days[date] || [];
  if (filter) list = list.filter((a) => catKey_(a.category) === filter);
  const rows = list.slice(0, FLEX_MAX_ITEMS).flatMap((a, i) => [...(filter ? [] : transitRows_(list[i - 1], a, trip.currency)), activityRow_(a)]);
  if (list.length > FLEX_MAX_ITEMS) rows.push(fText_(`……還有 ${list.length - FLEX_MAX_ITEMS} 項`, { size: 'xs', color: '#66727a' }));
  if (!rows.length) rows.push(fText_(filter ? `這天沒有${CATEGORY_INFO[filter].label}類的行程` : '這天還沒有安排', { size: 'sm', color: '#66727a' }));
  const toBuy = filter ? [] : shoppingOn_(trip, date).filter((s) => !s.done);
  if (toBuy.length) rows.push(fText_(`🛒 要買：${toBuy.map((s) => s.text).join('、')}`, { size: 'xs', color: '#db2777' }));
  const route = filter ? '' : dayRouteUrl_(trip.days[date] || []);

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0f766e',
      paddingAll: '16px',
      contents: [
        fText_(trip.name, { size: 'xs', color: '#d9f0ec' }),
        fText_(`Day ${dayNo}・${prettyDate_(date)}`, { size: 'lg', weight: 'bold', color: '#ffffff' }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'lg', contents: rows },
    footer: {
      type: 'box',
      layout: 'horizontal',
      contents: [
        ...(route && route.length <= 1000 ? [{
          type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '🧭 當天路線', uri: route },
        }] : []),
        { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '在網站開啟', uri: tripLiffUrl_(trip.id) } },
      ],
    },
  };
}

function flexMsg_(altText, contents) {
  return { type: 'flex', altText: String(altText).slice(0, 400), contents };
}

function dayFlex_(trip, date, filter) {
  return flexMsg_(`${trip.name}｜${prettyDate_(date)} 的行程`, dayBubble_(trip, date, filter));
}

/** 整趟旅程（每天一張，最多 12 張） */
function tripFlex_(trip) {
  const dates = dateRange_(trip.startDate, trip.endDate).slice(0, 12);
  const bubbles = dates.map((d) => dayBubble_(trip, d));
  return flexMsg_(`${trip.name} 的行程`, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

/** 旅程列表 */
function tripListFlex_(trips, today) {
  const bubbles = trips.slice(0, 12).map((t) => {
    const n = dateRange_(t.startDate, t.endDate).length;
    const count = Object.values(t.days).reduce((s, l) => s + l.length, 0);
    let status = '已結束';
    if (today < t.startDate) status = `${daysBetween_(today, t.startDate)} 天後出發`;
    else if (today <= t.endDate) status = '旅行中';
    return {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          fText_(status, { size: 'xxs', color: '#0f766e', weight: 'bold' }),
          fText_(t.name, { size: 'md', weight: 'bold' }),
          fText_(`📍 ${t.destination || '未設定'}`, { size: 'xs', color: '#66727a' }),
          fText_(`${prettyDate_(t.startDate)} 起・${durationText_(n)}`, { size: 'xs', color: '#66727a' }),
          fText_(`${count} 個行程項目${t.members && t.members.length > 1 ? `・👥 ${t.members.length} 人` : ''}`, { size: 'xs', color: '#66727a' }),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#0f766e', height: 'sm', action: { type: 'postback', label: '看行程', data: JSON.stringify({ a: 'trip', id: t.id }), displayText: `${t.name} 的行程` } },
          { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '開啟網站', uri: tripLiffUrl_(t.id) } },
          { type: 'button', style: 'link', height: 'sm', action: { type: 'postback', label: '匯出 PDF', data: JSON.stringify({ a: 'export', id: t.id }), displayText: `匯出 ${t.name}` } },
        ],
      },
    };
  });
  return flexMsg_('我的旅程', bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

/* ---------- 純文字版（Flex 失敗時的備案，也用於搜尋結果） ---------- */
function dayText_(trip, date, filter) {
  const dayNo = daysBetween_(trip.startDate, date) + 1;
  let list = trip.days[date] || [];
  if (filter) list = list.filter((a) => catKey_(a.category) === filter);
  const lines = [`🗓️ ${trip.name}｜Day ${dayNo}・${prettyDate_(date)}`];
  if (!list.length) lines.push('（沒有安排）');
  list.forEach((a, i) => {
    const transit = filter ? '' : transitLabel_(a, trip.currency);
    if (transit) lines.push(`　↓ ${transit}`);
    const issue = filter ? '' : scheduleIssue_(list[i - 1], a);
    if (issue) lines.push(`　⚠️ ${issue}`);
    lines.push(activityLine_(a));
  });
  const toBuy = filter ? [] : shoppingOn_(trip, date).filter((s) => !s.done);
  if (toBuy.length) lines.push('', `🛒 要買：${toBuy.map((s) => s.text).join('、')}`);
  return lines.join('\n');
}

function activityLine_(a) {
  const info = CATEGORY_INFO[catKey_(a.category)];
  return `${timeLabel_(a) || '--:--'} ${info.icon} ${a.title}${a.location ? `（${a.location}）` : ''}`;
}
