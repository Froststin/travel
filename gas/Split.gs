/* ============================================================
 * 分帳與住宿／交通資訊（網站 js/split.js、js/bookings.js 有同樣的算法）
 * ============================================================ */

/**
 * 分帳結算：每筆有填「誰付的」的花費（行程花費＋車資，換算成台幣），由 splitWith 的人平分（沒選＝所有成員）。
 * 購物清單（自己的與旅伴的）有填「誰付的」的也算進來（單價 × 數量），照勾的分攤的人平分；
 * 沒填誰付的：只有自己分攤就是自己買的，不算；有分給別人卻沒填誰付的，列為「沒填誰付的」。
 * 已勾「已買」的購物視為已經付款、自己結清了，不列入分帳（使用者 2026-11-15 指定）。
 * 記帳（trip.expenses）：待分帳的照分攤的人算，結清的不列入。
 * 回傳每個人付了多少、應分攤多少，以及最少筆數的轉帳建議。
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
  let settled = 0; // 已勾「已買」、有填誰付的購物（視為已結清，沒算進來）
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
  const meKey = (members.find((m) => m.me) || members.find((m) => m.sharer) || {}).key || '';
  const shopLists = [{ owner: meKey, items: trip.shopping || [] }].concat((trip.othersShopping || []).map((g) => ({ owner: g.key, items: g.items || [] })));
  for (const g of shopLists) for (const s of g.items) {
    if (s.done) { // 已勾「已買」＝已經付款、帳自己對好了，不列入分帳（每人花費照算）
      if (s.paidBy && shopTwd_(s, cur) > 0) settled++;
      continue;
    }
    const amount = shopTwd_(s, cur);
    if (!(amount > 0)) continue;
    const who = shopSharers_(s, g.owner, everyone);
    // 沒填誰付的：只有自己分攤就是自己買的，不算；有分給別人卻沒填誰付的，提醒一下
    if (!s.paidBy) {
      if (who.some((k) => k !== g.owner)) unassigned++;
      continue;
    }
    if (!who.length) continue;
    total += amount;
    person(s.paidBy).paid += amount;
    who.forEach((k) => { person(k).share += amount / who.length; });
  }
  // 記帳：待分帳的照分攤的人算；結清的不列入（跟購物「已買」一樣）
  for (const x of trip.expenses || []) {
    const amount = twdOrRaw_(x.amount, x.currency || cur);
    if (!(amount > 0)) continue;
    if (x.settled) { if (x.paidBy) settled++; continue; }
    if (!x.paidBy) { unassigned++; continue; }
    const who = x.splitWith && x.splitWith.length ? x.splitWith : everyone;
    if (!who.length) continue;
    total += amount;
    person(x.paidBy).paid += amount;
    who.forEach((k) => { person(k).share += amount / who.length; });
  }
  const rows = [...people.values()].map((p) => Object.assign(p, { net: p.paid - p.share }));
  return { rows, transfers: settleTransfers_(rows), unassigned, total, settled };
}

/**
 * 每人花費（LINE「預算」用）：每筆照「分攤的人」平分；行程沒勾＝全部成員，購物照 shopSharers_（勾了誰就是誰）。
 * 有沒有填誰付的都一樣分。和網站 js/split.js 的 memberShares 同算法（這裡只算整趟總計）。
 * @return {null | { rows: [{ key, name, me, total }], total, pcts: number[] }} pcts 和 rows 同順序、加起來 100；不是共用旅程時回傳 null
 */
function memberShares_(trip) {
  const cur = trip.currency;
  const members = (trip.members || []).filter((m) => m.key);
  if (members.length < 2) return null;
  const everyone = members.map((m) => m.key);
  const ownerOfMine = (members.find((m) => m.me) || {}).key || '';
  const people = new Map(members.map((m) => [m.key, { key: m.key, name: m.name, me: !!m.me, total: 0 }]));
  let total = 0;
  // 已退出的旅伴不管幾個人都併成一列
  const add = (keys, amount) => {
    if (!(amount > 0) || !keys.length) return;
    total += amount;
    keys.forEach((k) => {
      const key = everyone.includes(k) ? k : '__gone';
      if (!people.has(key)) people.set(key, { key, name: '已退出的旅伴', me: false, total: 0 });
      people.get(key).total += amount / keys.length;
    });
  };
  const split = (x) => (x.splitWith && x.splitWith.length ? x.splitWith : everyone);
  const valid = new Set(dateRange_(trip.startDate, trip.endDate));
  for (const [d, list] of Object.entries(trip.days || {})) {
    if (!valid.has(d)) continue;
    for (const a of list) add(split(a), twdOrRaw_(a.cost, a.costCurrency || cur) + twdOrRaw_(a.travelCost, fareCurrency_(a, cur)));
  }
  const lists = [{ owner: ownerOfMine, items: trip.shopping || [] }].concat((trip.othersShopping || []).map((g) => ({ owner: g.key, items: g.items || [] })));
  for (const g of lists) {
    for (const s of g.items) add(shopSharers_(s, g.owner, everyone), shopTwd_(s, cur));
  }
  // 記帳：照分攤的人（沒選＝全部成員），結清的也算（是花掉的錢）
  for (const x of trip.expenses || []) add(split(x), twdOrRaw_(x.amount, x.currency || cur));
  const rows = [...people.values()].filter((p) => everyone.includes(p.key) || p.total > 0.005);
  return { rows, total, pcts: sharePcts_(rows.map((p) => p.total), total) };
}

/**
 * 購物由誰分攤：勾了誰就由誰平分（不管有沒有填誰付的）；
 * 沒勾（舊資料）時，有填誰付的＝大家平分，沒填＝清單主人自己買的。和網站 shopSharers 一樣
 */
function shopSharers_(s, owner, everyone) {
  if (s.splitWith && s.splitWith.length) return s.splitWith;
  if (s.paidBy) return everyone;
  return owner ? [owner] : everyone;
}

/** 佔比（整數 %）：最大餘數法，加起來一定是 100（和網站 sharePcts 一樣） */
function sharePcts_(values, total) {
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  // 餘數先取到固定精度：金額數學上相等時照列的順序，不受浮點誤差影響（前後端結果才會一樣）
  raw.map((v, i) => ({ i, r: Math.round((v - Math.floor(v)) * 1e6) })).sort((a, b) => b.r - a.r || a.i - b.i)
    .forEach(({ i }) => { if (left > 0) { out[i]++; left--; } });
  return out;
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
    if (s.settled) lines.push('', `已買的購物、已結清的記帳共 ${s.settled} 筆視為已經結清，目前沒有要轉帳的。`);
    else lines.push('', '還沒有填「誰付的」的花費。', '到網站的行程或購物清單裡，可以選誰付的、哪些人分攤。');
  } else {
    lines.push(`已填付款人的花費共 ${ntd_(s.total)}`, '');
    s.rows.forEach((p) => lines.push(`・${name(p)}：付了 ${ntd_(p.paid)}，應分攤 ${ntd_(p.share)}`));
    lines.push('', '結算：');
    if (s.transfers.length) s.transfers.forEach((x) => lines.push(`💸 ${name(x.from)} → ${name(x.to)} ${ntd_(x.amount)}`));
    else lines.push('大家都打平了 🎉');
  }
  if (s.unassigned) lines.push('', `※ 還有 ${s.unassigned} 筆花費沒填誰付的，沒有算進來。`);
  const hasShop = (trip.shopping || []).length || (trip.othersShopping || []).some((g) => (g.items || []).length);
  if (hasShop) lines.push('', '※ 購物清單已勾「已買」的視為已經結清，不列入分帳。');
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
