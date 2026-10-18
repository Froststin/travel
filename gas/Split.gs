/* ============================================================
 * 分帳與住宿／交通資訊（網站 js/split.js、js/bookings.js 有同樣的算法）
 * ============================================================ */

/**
 * 分帳結算：每筆有填「誰付的」的花費（行程花費＋車資，換算成台幣），由 splitWith 的人平分（沒選＝所有成員）。
 * 回傳每個人付了多少、應分攤多少，以及最少筆數的轉帳建議。購物清單是每個人自己的，不算在內。
 */
function settlement_(trip) {
  const cur = trip.currency;
  const members = (trip.members || []).filter((m) => m.key);
  const everyone = members.map((m) => m.key);
  const people = new Map(members.map((m) => [m.key, { key: m.key, name: m.name, me: !!m.me, paid: 0, share: 0 }]));
  const person = (k) => {
    if (!people.has(k)) people.set(k, { key: k, name: '已退出的旅伴', me: false, paid: 0, share: 0 });
    return people.get(k);
  };
  let unassigned = 0;
  let total = 0;
  for (const a of Object.values(trip.days || {}).flat()) {
    const amount = twdOrRaw_(a.cost, a.costCurrency || cur) + twdOrRaw_(a.travelCost, fareCurrency_(a, cur));
    if (!(amount > 0)) continue;
    if (!a.paidBy) {
      unassigned++;
      continue;
    }
    const who = a.splitWith && a.splitWith.length ? a.splitWith : everyone;
    if (!who.length) continue;
    total += amount;
    person(a.paidBy).paid += amount;
    who.forEach((k) => { person(k).share += amount / who.length; });
  }
  const rows = [...people.values()].map((p) => Object.assign(p, { net: p.paid - p.share }));
  return { rows, transfers: settleTransfers_(rows), unassigned, total };
}

/** 欠錢的人依序付給被欠最多的人，筆數最少；不到 1 元的零頭略過 */
function settleTransfers_(rows) {
  const debtors = rows.filter((p) => p.net < -0.5).map((p) => ({ p, left: -p.net })).sort((a, b) => b.left - a.left);
  const creditors = rows.filter((p) => p.net > 0.5).map((p) => ({ p, left: p.net })).sort((a, b) => b.left - a.left);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    if (amount >= 0.5) out.push({ from: debtors[i].p, to: creditors[j].p, amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left < 0.5) i++;
    if (creditors[j].left < 0.5) j++;
  }
  return out;
}

function settleText_(trip) {
  const s = settlement_(trip);
  const name = (p) => `${p.name}${p.me ? '（你）' : ''}`;
  const lines = [`🤝 ${trip.name} 分帳`];
  if (!s.total) {
    lines.push('', '還沒有填「誰付的」的花費。', '到網站的行程裡，花費下面可以選誰付的、哪些人分攤。');
  } else {
    lines.push(`已填付款人的花費共 ${ntd_(s.total)}`, '');
    s.rows.forEach((p) => lines.push(`・${name(p)}：付了 ${ntd_(p.paid)}，應分攤 ${ntd_(p.share)}`));
    lines.push('', '結算：');
    if (s.transfers.length) s.transfers.forEach((x) => lines.push(`💸 ${name(x.from)} → ${name(x.to)} ${ntd_(x.amount)}`));
    else lines.push('大家都打平了 🎉');
  }
  if (s.unassigned) lines.push('', `※ 還有 ${s.unassigned} 筆花費沒填誰付的，沒有算進來。`);
  return lines.join('\n');
}

/* ---------- 住宿與交通資訊 ---------- */
const BOOKING_INFO = {
  flight: { icon: '✈️', label: '航班' },
  stay: { icon: '🏨', label: '住宿' },
  train: { icon: '🚄', label: '火車' },
  bus: { icon: '🚌', label: '巴士' },
  car: { icon: '🚗', label: '租車' },
  ticket: { icon: '🎫', label: '票券' },
  other: { icon: '📌', label: '其他' },
};

function bookingInfo_(b) {
  return BOOKING_INFO[b.type] || BOOKING_INFO.other;
}

/** 這一天要知道的住宿與交通：住宿從入住日到退房日每天都列，其他只列當天 */
function bookingsOn_(trip, date) {
  return (trip.bookings || [])
    .filter((b) => (b.type === 'stay' && b.date && b.endDate ? b.date <= date && date <= b.endDate : b.date === date))
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

/** 例如「✈️ 08:30→12:40 CI154（確認碼 ABC123）」「🏨 入住 京都站前飯店 15:00」 */
function bookingLine_(b, date) {
  const info = bookingInfo_(b);
  const code = b.code ? `（確認碼 ${b.code}）` : '';
  if (b.type === 'stay') {
    if (date && date === b.endDate && date !== b.date) return `${info.icon} 退房 ${b.title}${b.endTime ? ` ${b.endTime}` : ''}`;
    if (date && date !== b.date) return `${info.icon} 住 ${b.title}`;
    return `${info.icon} 入住 ${b.title}${b.time ? ` ${b.time}` : ''}${code}`;
  }
  const time = b.time ? `${b.time}${b.endTime ? `→${b.endTime}` : ''} ` : '';
  return `${info.icon} ${time}${b.title}${code}`;
}

function bookingsText_(trip) {
  const list = (trip.bookings || []).slice().sort((a, b) => `${a.date || '9'}${a.time}`.localeCompare(`${b.date || '9'}${b.time}`));
  const lines = [`🧾 ${trip.name} 的住宿與交通`];
  if (!list.length) lines.push('', '還沒有資料。到網站的「每日行程」最上面按「＋ 住宿／交通」新增航班、飯店、確認碼。');
  list.forEach((b) => {
    lines.push('', `${b.date ? prettyDate_(b.date) : '未定日期'}${b.type === 'stay' && b.endDate ? ` – ${prettyDate_(b.endDate)}` : ''}`, bookingLine_(b, ''));
    if (b.place) lines.push(`📍 ${b.place}`);
    if (b.notes) lines.push(`📝 ${b.notes}`);
  });
  return lines.join('\n');
}
