/* ============================================================
 * Flex Message 版面
 * ============================================================ */

const FLEX_MAX_ITEMS = 12;

function fText_(text, extra) {
  return Object.assign({ type: 'text', text: String(text || ' ').slice(0, 200) || ' ', wrap: true }, extra || {});
}

function activityRow_(a) {
  const info = CATEGORY_INFO[catKey_(a.category)];
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      fText_(a.time || '--:--', { size: 'sm', color: '#66727a', flex: 0 }),
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: info.color, contents: [] },
      {
        type: 'box',
        layout: 'vertical',
        contents: [
          fText_(`${info.icon} ${a.title}`, { size: 'sm', weight: 'bold', color: '#1f2a2e' }),
          ...(a.location ? [fText_(`📍 ${a.location}`, { size: 'xs', color: '#0f766e' })] : []),
          ...(a.notes ? [fText_(a.notes, { size: 'xs', color: '#66727a' })] : []),
        ],
      },
    ],
  };
}

/** 單日行程卡片；filter 可限定類別 */
function dayBubble_(trip, date, filter) {
  const dayNo = daysBetween_(trip.startDate, date) + 1;
  let list = trip.days[date] || [];
  if (filter) list = list.filter((a) => catKey_(a.category) === filter);
  const rows = list.slice(0, FLEX_MAX_ITEMS).map(activityRow_);
  if (list.length > FLEX_MAX_ITEMS) rows.push(fText_(`……還有 ${list.length - FLEX_MAX_ITEMS} 項`, { size: 'xs', color: '#66727a' }));
  if (!rows.length) rows.push(fText_(filter ? `這天沒有${CATEGORY_INFO[filter].label}類的行程` : '這天還沒有安排', { size: 'sm', color: '#66727a' }));

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
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'link',
        height: 'sm',
        action: { type: 'uri', label: '在網站開啟', uri: tripLiffUrl_(trip.id) },
      }],
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
          fText_(`${count} 個行程項目`, { size: 'xs', color: '#66727a' }),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#0f766e', height: 'sm', action: { type: 'postback', label: '看行程', data: JSON.stringify({ a: 'trip', id: t.id }), displayText: `${t.name} 的行程` } },
          { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '開啟網站', uri: tripLiffUrl_(t.id) } },
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
  list.forEach((a) => lines.push(activityLine_(a)));
  return lines.join('\n');
}

function activityLine_(a) {
  const info = CATEGORY_INFO[catKey_(a.category)];
  return `${a.time || '--:--'} ${info.icon} ${a.title}${a.location ? `（${a.location}）` : ''}`;
}
