/* ============================================================
 * LINE 官方帳號：訊息處理
 * ============================================================ */

const HELP_TEXT = [
  '🧭 旅程手帖 使用說明',
  '',
  '【查詢】直接問就好，例如：',
  '・今天／明天／後天／10/29／第二天',
  '・明天吃什麼、清水寺幾點',
  '・預算、行李、所有旅程',
  '',
  '【新增】',
  '・新旅程 京都 10/28-10/30',
  '・新增 明天 10:00 清水寺 @清水寺 $400',
  '',
  '【修改／刪除】',
  '・改 清水寺 11:30',
  '・改 清水寺 到 後天',
  '・刪除 清水寺',
  '',
  '【Google 地圖導航】',
  '・導航 清水寺、清水寺怎麼去',
  '・今天路線、明天路線 → 串起當天所有地點',
  '・新增或修改時貼上 Google 地圖分享連結也可以',
  '',
  '【旅遊日誌】',
  '・日誌 今天的抹茶超好喝',
  '・直接傳照片 → 自動記到今天的日誌',
  '・日誌／日誌 10/29 → 查看',
  '',
  '【網站】輸入「網站」取得連結，可以編輯完整行程',
].join('\n');

function handleWebhook_(body) {
  for (const ev of body.events || []) {
    try {
      handleEvent_(ev);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      if (ev.replyToken) reply_(ev.replyToken, textMsg_(`抱歉，處理時發生錯誤：${err.message}`));
    }
  }
}

function handleEvent_(ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId || !ev.replyToken) return;
  try {
    checkAllowed_(userId);
  } catch (err) {
    reply_(ev.replyToken, textMsg_('這是私人使用的旅遊助理，目前沒有開放使用喔。'));
    return;
  }

  if (ev.type === 'follow') {
    reply_(ev.replyToken, textMsg_(`歡迎使用旅程手帖！\n\n${HELP_TEXT}`, defaultQuick_()));
    return;
  }
  const ctx = newCtx_(userId, ev.replyToken);
  if (ev.type === 'postback') return withLock_(() => handlePostback_(ctx, ev.postback.data));
  if (ev.type !== 'message') return;
  if (ev.message.type === 'text') return withLock_(() => handleText_(ctx, ev.message.text));
  if (ev.message.type === 'image') return withLock_(() => handleImage_(ctx, ev.message));
}

function newCtx_(userId, replyToken) {
  const ctx = { userId, replyToken, today: todayStr_() };
  Object.defineProperty(ctx, 'trips', { get() { return this._trips || (this._trips = loadTrips_(userId)); } });
  return ctx;
}

function say_(ctx, messages, fallbackText) {
  const list = [].concat(messages);
  const last = list[list.length - 1];
  if (!last.quickReply) withQuick_(last, defaultQuick_());
  reply_(ctx.replyToken, list, fallbackText);
}

/* ---------- 文字訊息 ---------- */
function handleText_(ctx, rawText) {
  const text = toHalf_(rawText).trim();
  let m;

  if (/^(說明|幫助|help|指令|怎麼用|使用說明|功能|\?)$/i.test(text)) return say_(ctx, textMsg_(HELP_TEXT));
  if (/^(取消|算了|不用了|不要)$/.test(text)) return say_(ctx, textMsg_('好的，已取消。'));
  if (text.length <= 15 && /網站|網頁|連結|網址|link|開啟|打開/i.test(text)) return cmdSite_(ctx);
  if ((m = text.match(/^(?:新旅程|新增旅程|建立旅程)\s*([\s\S]*)$/))) return cmdNewTrip_(ctx, m[1]);
  if (/路線/.test(text) && text.length <= 12) return cmdRoute_(ctx, text.replace(/路線|導航/g, ''));
  if ((m = text.match(/^(?:導航到|導航|帶我去|怎麼去|前往)\s*(.+)$/)) || (m = text.match(/^(.+?)\s*(?:怎麼去|怎麼走|導航)$/))) return cmdNavigate_(ctx, m[1]);
  if ((m = text.match(/^(?:新增|加入|\+)\s*([\s\S]+)$/))) return cmdAdd_(ctx, m[1]);
  if ((m = text.match(/^(?:刪除|移除|刪掉)\s*([\s\S]+)$/))) return cmdDelete_(ctx, m[1]);
  if ((m = text.match(/^(?:修改|更改|改)\s*([\s\S]+)$/))) return cmdEdit_(ctx, m[1]);
  if (/^(?:看|查看|查|確認)?(?:旅遊)?(?:日誌|日記)(?:確認)?(?:\s+(.+))?$/.test(text) && !/^(?:日誌|日記)\s*[:：]/.test(text)) {
    const arg = text.replace(/^(?:看|查看|查|確認)?(?:旅遊)?(?:日誌|日記)(?:確認)?\s*/, '');
    if (!arg || isDateOnly_(ctx, arg)) return cmdJournalView_(ctx, arg);
  }
  if ((m = text.match(/^(?:日誌|日記|記錄|紀錄|記下|筆記|寫日誌)\s*[:：]?\s*([\s\S]+)$/))) return cmdJournalAdd_(ctx, m[1].trim());
  if (/預算|花費|花多少|多少錢|開銷|支出/.test(text)) return cmdBudget_(ctx);
  if (/行李|打包/.test(text)) return cmdPacking_(ctx);
  if (/^(行程|旅程|我的旅程|所有旅程|旅程列表|列表|全部行程|全部旅程)$/.test(text)) return cmdTrips_(ctx);

  return cmdQuery_(ctx, text);
}

function isDateOnly_(ctx, s) {
  const d = extractDate_(s, { today: ctx.today, trips: ctx.trips, trip: activeTrip_(ctx.trips, ctx.today) });
  return !!d && !keywordOf_(d.rest);
}

/* ---------- 查詢（模糊） ---------- */
function cmdQuery_(ctx, text) {
  const trips = ctx.trips;
  if (!trips.length) {
    return say_(ctx, textMsg_('目前還沒有任何旅程。\n可以輸入「新旅程 京都 10/28-10/30」建立，或輸入「網站」到網頁上規劃。'));
  }
  const base = activeTrip_(trips, ctx.today);
  const found = extractDate_(text, { today: ctx.today, trips, trip: base });
  let rest = found ? found.rest : text;
  const cat = queryCategory_(rest);
  if (cat) rest = cat.rest;
  const kw = keywordOf_(rest);

  // 1. 有關鍵字：先找行程項目，再找旅程名稱
  if (kw) {
    let hits = searchActivities_(trips, kw);
    if (found) hits = hits.filter((h) => h.date === found.date);
    if (hits.length) return replySearchHits_(ctx, kw, hits);
    const tripHits = searchTrips_(trips, kw);
    if (!found && tripHits.length) return say_(ctx, tripFlex_(tripHits[0].trip), tripOverviewText_(tripHits[0].trip));
  }

  // 2. 有日期：顯示那天
  if (found) {
    const trip = activeTrip_(trips, ctx.today, found.date);
    if (!trip || found.date < trip.startDate || found.date > trip.endDate) {
      return say_(ctx, textMsg_(`${prettyDate_(found.date)} 沒有旅程安排喔。${kw ? `\n（也找不到跟「${kw}」有關的行程）` : ''}`));
    }
    const filter = cat ? cat.category : '';
    return say_(ctx, dayFlex_(trip, found.date, filter), dayText_(trip, found.date, filter));
  }

  // 3. 只有類別：旅行中看今天，否則列出整趟旅程的該類別
  if (cat) {
    const trip = base;
    if (trip.startDate <= ctx.today && ctx.today <= trip.endDate) {
      return say_(ctx, dayFlex_(trip, ctx.today, cat.category), dayText_(trip, ctx.today, cat.category));
    }
    const lines = [`${CATEGORY_INFO[cat.category].icon} ${trip.name} 的${CATEGORY_INFO[cat.category].label}安排`];
    for (const d of dateRange_(trip.startDate, trip.endDate)) {
      (trip.days[d] || []).filter((a) => catKey_(a.category) === cat.category)
        .forEach((a) => lines.push(`${prettyDate_(d)} ${activityLine_(a)}`));
    }
    if (lines.length === 1) lines.push('（沒有這類的行程）');
    return say_(ctx, textMsg_(lines.join('\n')));
  }

  // 4. 泛問「去哪／有什麼安排」
  if (!kw || /去哪|安排|計畫|計劃|幹嘛|做什麼/.test(text)) {
    if (base.startDate <= ctx.today && ctx.today <= base.endDate) {
      return say_(ctx, dayFlex_(base, ctx.today), dayText_(base, ctx.today));
    }
    return say_(ctx, tripFlex_(base), tripOverviewText_(base));
  }

  return say_(ctx, textMsg_(`找不到跟「${kw}」有關的行程 🤔\n可以試試「今天」「明天吃什麼」「清水寺幾點」，或輸入「說明」看所有用法。`));
}

function replySearchHits_(ctx, kw, hits) {
  if (hits.length === 1) {
    const { trip, date, activity: a } = hits[0];
    const info = CATEGORY_INFO[catKey_(a.category)];
    const lines = [
      `${info.icon} ${a.title}`,
      `🗓️ ${trip.name}・Day ${daysBetween_(trip.startDate, date) + 1}・${prettyDate_(date)}${a.time ? ` ${a.time}` : ''}`,
    ];
    if (a.location) lines.push(`📍 ${a.location}`);
    if (placeUrl_(a)) lines.push(`🗺️ 地圖：${placeUrl_(a)}`);
    if (navUrl_(a)) lines.push(`🧭 導航：${navUrl_(a)}`);
    if (a.cost) lines.push(`💰 ${a.cost} ${trip.currency}`);
    if (a.notes) lines.push(`📝 ${a.notes}`);
    const quick = [qMsg_(`看 ${prettyDate_(date)}`, date.slice(5).replace('-', '/'))];
    if (navUrl_(a)) quick.unshift(qUri_('🧭 開始導航', navUrl_(a)));
    return say_(ctx, textMsg_(lines.join('\n'), [...quick, ...defaultQuick_()]));
  }
  const lines = [`🔎 找到 ${hits.length} 筆跟「${kw}」有關的行程：`];
  hits.slice(0, 15).forEach((h) => lines.push(`${prettyDate_(h.date)} ${activityLine_(h.activity)}`));
  if (hits.length > 15) lines.push(`……還有 ${hits.length - 15} 筆`);
  return say_(ctx, textMsg_(lines.join('\n')));
}

function tripOverviewText_(trip) {
  const lines = [`🧳 ${trip.name}（${trip.destination || '未設定目的地'}）`];
  for (const d of dateRange_(trip.startDate, trip.endDate)) {
    lines.push('', `【Day ${daysBetween_(trip.startDate, d) + 1}・${prettyDate_(d)}】`);
    const list = trip.days[d] || [];
    if (!list.length) lines.push('（尚未安排）');
    list.forEach((a) => lines.push(activityLine_(a)));
  }
  return lines.join('\n');
}

/* ---------- 其他查詢 ---------- */
function cmdSite_(ctx) {
  const trip = ctx.trips.length ? activeTrip_(ctx.trips, ctx.today) : null;
  const lines = ['🌐 旅程手帖網站（在 LINE 裡開啟會自動登入同步）', LIFF_URL];
  if (trip) lines.push('', `📌 直接開啟「${trip.name}」：`, tripLiffUrl_(trip.id));
  return say_(ctx, textMsg_(lines.join('\n')));
}

function cmdTrips_(ctx) {
  const trips = ctx.trips;
  if (!trips.length) return say_(ctx, textMsg_('還沒有旅程喔。輸入「新旅程 京都 10/28-10/30」就能建立。'));
  const text = trips.map((t) => `・${t.name}｜${prettyDate_(t.startDate)}–${prettyDate_(t.endDate)}`).join('\n');
  return say_(ctx, tripListFlex_(trips, ctx.today), `我的旅程：\n${text}`);
}

function cmdBudget_(ctx) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const trip = activeTrip_(ctx.trips, ctx.today);
  const all = Object.values(trip.days).flat();
  const spent = all.reduce((s, a) => s + (Number(a.cost) || 0), 0);
  const cur = trip.currency;
  const lines = [`💰 ${trip.name} 預算`];
  if (trip.budget) {
    const remain = trip.budget - spent;
    lines.push(`總預算：${trip.budget.toLocaleString()} ${cur}`, `預估花費：${spent.toLocaleString()} ${cur}`,
      remain >= 0 ? `剩餘：${remain.toLocaleString()} ${cur}` : `⚠️ 超出預算：${(-remain).toLocaleString()} ${cur}`);
  } else {
    lines.push(`預估花費：${spent.toLocaleString()} ${cur}（尚未設定總預算）`);
  }
  const byCat = {};
  all.forEach((a) => { byCat[catKey_(a.category)] = (byCat[catKey_(a.category)] || 0) + (Number(a.cost) || 0); });
  const cats = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    lines.push('', '分類：');
    cats.forEach(([k, v]) => lines.push(`${CATEGORY_INFO[k].icon} ${CATEGORY_INFO[k].label} ${v.toLocaleString()} ${cur}`));
  }
  return say_(ctx, textMsg_(lines.join('\n')));
}

function cmdPacking_(ctx) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const trip = activeTrip_(ctx.trips, ctx.today);
  const items = trip.packing || [];
  if (!items.length) return say_(ctx, textMsg_(`「${trip.name}」的行李清單還是空的，可以到網站上新增。`));
  const todo = items.filter((i) => !i.done);
  const lines = [`🧳 ${trip.name} 行李：已準備 ${items.length - todo.length} / ${items.length}`];
  if (todo.length) {
    lines.push('', '還沒準備：');
    todo.slice(0, 30).forEach((i) => lines.push(`☐ ${i.text}`));
  } else {
    lines.push('全部準備好了 🎉');
  }
  return say_(ctx, textMsg_(lines.join('\n')));
}

/* ---------- 新增 ---------- */
function cmdNewTrip_(ctx, body) {
  const spec = parseTripSpec_(body, { today: ctx.today, trips: ctx.trips });
  if (!spec || !spec.name) {
    return say_(ctx, textMsg_('請告訴我名稱和日期，例如：\n新旅程 京都 10/28-10/30\n新旅程 沖繩 12/1 5天'));
  }
  if (daysBetween_(spec.startDate, spec.endDate) + 1 > 60) return say_(ctx, textMsg_('單一旅程最長 60 天喔。'));
  const trip = {
    id: Utilities.getUuid(), name: spec.name.slice(0, 60), destination: spec.name.slice(0, 60),
    startDate: spec.startDate, endDate: spec.endDate, budget: 0, currency: 'TWD', notes: '',
    days: {}, packing: [], createdAt: Date.now(),
  };
  saveTrip_(ctx.userId, trip);
  const n = dateRange_(trip.startDate, trip.endDate).length;
  return say_(ctx, textMsg_(
    `✅ 已建立「${trip.name}」\n🗓️ ${prettyDate_(trip.startDate)} – ${prettyDate_(trip.endDate)}・${durationText_(n)}\n\n接著可以輸入：\n新增 ${trip.startDate.slice(5).replace('-', '/')} 10:00 景點名稱\n或到網站編輯：${tripLiffUrl_(trip.id)}`,
  ));
}

function cmdAdd_(ctx, body) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('要先建立旅程喔，例如：新旅程 京都 10/28-10/30'));
  const base = activeTrip_(ctx.trips, ctx.today);
  let rest = body;
  const u = extractUrl_(rest);
  if (u) rest = u.rest;
  const d = extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base });
  if (d) rest = d.rest;
  const t = extractTime_(rest);
  if (t) rest = t.rest;
  const c = extractCost_(rest);
  if (c) rest = c.rest;
  const loc = extractLocation_(rest);
  if (loc) rest = loc.rest;
  const title = rest.replace(/\s+/g, ' ').trim();
  if (!title) return say_(ctx, textMsg_('要新增什麼呢？例如：新增 明天 10:00 清水寺 @清水寺 $400'));

  let date = d && d.date;
  if (!date) {
    if (base.startDate <= ctx.today && ctx.today <= base.endDate) date = ctx.today;
    else return say_(ctx, textMsg_(`要加在哪一天呢？例如：\n新增 ${base.startDate.slice(5).replace('-', '/')} ${body}\n新增 第2天 ${body}`));
  }
  const trip = ctx.trips.find((x) => x.startDate <= date && date <= x.endDate);
  if (!trip) return say_(ctx, textMsg_(`${prettyDate_(date)} 沒有旅程喔，要先建立：新旅程 名稱 ${date.slice(5).replace('-', '/')}-…`));

  const activity = {
    id: Utilities.getUuid(), time: t ? t.time : '', title: title.slice(0, 100),
    category: guessCategory_(`${title} ${loc ? loc.location : ''}`), location: loc ? loc.location.slice(0, 200) : '',
    mapUrl: u ? cleanUrl_(u.url) : '', cost: c ? c.cost : 0, notes: '',
  };
  (trip.days[date] = trip.days[date] || []).push(activity);
  sortDay_(trip.days[date]);
  saveTrip_(ctx.userId, trip);
  return say_(ctx, textMsg_(
    `✅ 已新增到「${trip.name}」Day ${daysBetween_(trip.startDate, date) + 1}・${prettyDate_(date)}\n${activityLine_(activity)}${activity.cost ? `\n💰 ${activity.cost} ${trip.currency}` : ''}`,
    [qMsg_(`看 ${prettyDate_(date)}`, date.slice(5).replace('-', '/')), qPostback_('復原', { a: 'del', id: activity.id }, '復原剛才的新增'), ...defaultQuick_()],
  ));
}

/* ---------- 刪除／修改 ---------- */
function findActivity_(ctx, id) {
  for (const trip of ctx.trips) {
    for (const [date, list] of Object.entries(trip.days)) {
      const a = list.find((x) => x.id === id);
      if (a) return { trip, date, activity: a };
    }
  }
  return null;
}

function cmdDelete_(ctx, body) {
  const kw = keywordOf_(body);
  const hits = kw ? searchActivities_(ctx.trips, kw, 0.6) : [];
  if (!hits.length) return say_(ctx, textMsg_(`找不到跟「${kw || body}」有關的行程。`));
  if (hits.length === 1) {
    const h = hits[0];
    return say_(ctx, textMsg_(`確定要刪除這個行程嗎？\n${prettyDate_(h.date)} ${activityLine_(h.activity)}`, [
      qPostback_('確定刪除', { a: 'del', id: h.activity.id }), qMsg_('取消', '取消'),
    ]));
  }
  return say_(ctx, textMsg_(`找到 ${hits.length} 筆，要刪除哪一個？`, hits.slice(0, 12).map((h) =>
    qPostback_(`${h.date.slice(5).replace('-', '/')} ${h.activity.title}`, { a: 'del', id: h.activity.id }, `刪除 ${h.activity.title}`))));
}

function deleteActivity_(ctx, id) {
  const found = findActivity_(ctx, id);
  if (!found) return say_(ctx, textMsg_('這個行程已經不存在了。'));
  const { trip, date, activity } = found;
  trip.days[date] = trip.days[date].filter((x) => x.id !== id);
  saveTrip_(ctx.userId, trip);
  return say_(ctx, textMsg_(`🗑️ 已刪除：${prettyDate_(date)} ${activityLine_(activity)}`));
}

function cmdEdit_(ctx, body) {
  let rest = body;
  const changes = {};
  const base = activeTrip_(ctx.trips, ctx.today);
  const u = extractUrl_(rest);
  if (u) { changes.mapUrl = u.url; rest = u.rest; }
  const t = extractTime_(rest);
  if (t) { changes.time = t.time; rest = t.rest; }
  const c = extractCost_(rest);
  if (c) { changes.cost = c.cost; rest = c.rest; }
  const loc = extractLocation_(rest);
  if (loc) { changes.location = loc.location; rest = loc.rest; }
  const d = base ? extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base }) : null;
  if (d) { changes.date = d.date; rest = d.rest; }
  const kw = keywordOf_(rest.replace(/改成|改到|換到|移到|到|成|為/g, ' '));

  if (!Object.keys(changes).length || !kw) {
    return say_(ctx, textMsg_('要怎麼改呢？例如：\n改 清水寺 11:30\n改 清水寺 到 後天\n改 清水寺 $500\n改 清水寺 @京都東山\n改 清水寺 https://maps.app.goo.gl/…\n\n其他內容請到網站修改（輸入「網站」）。'));
  }
  const hits = searchActivities_(ctx.trips, kw, 0.6);
  if (!hits.length) return say_(ctx, textMsg_(`找不到跟「${kw}」有關的行程。`));
  if (hits.length === 1) return applyEdit_(ctx, hits[0].activity.id, changes);
  return say_(ctx, textMsg_(`找到 ${hits.length} 筆，要改哪一個？`, hits.slice(0, 12).map((h) =>
    qPostback_(`${h.date.slice(5).replace('-', '/')} ${h.activity.title}`, { a: 'edit', id: h.activity.id, p: changes }, `修改 ${h.activity.title}`))));
}

function applyEdit_(ctx, id, changes) {
  const found = findActivity_(ctx, id);
  if (!found) return say_(ctx, textMsg_('這個行程已經不存在了。'));
  const { trip, activity } = found;
  let date = found.date;
  if (changes.time && /^\d{2}:\d{2}$/.test(changes.time)) activity.time = changes.time;
  if (changes.cost != null) activity.cost = Math.max(0, Number(changes.cost) || 0);
  if (changes.location) activity.location = String(changes.location).slice(0, 200);
  if (changes.mapUrl && cleanUrl_(changes.mapUrl)) activity.mapUrl = cleanUrl_(changes.mapUrl);
  if (changes.date && changes.date !== date) {
    if (changes.date < trip.startDate || changes.date > trip.endDate) {
      return say_(ctx, textMsg_(`${prettyDate_(changes.date)} 不在「${trip.name}」的日期範圍內喔。`));
    }
    trip.days[date] = trip.days[date].filter((x) => x.id !== id);
    date = changes.date;
    (trip.days[date] = trip.days[date] || []).push(activity);
  }
  sortDay_(trip.days[date]);
  saveTrip_(ctx.userId, trip);
  return say_(ctx, textMsg_(`✏️ 已更新：${prettyDate_(date)} ${activityLine_(activity)}${activity.cost ? `\n💰 ${activity.cost} ${trip.currency}` : ''}`));
}

/* ---------- 旅遊日誌 ---------- */
function cmdJournalAdd_(ctx, body) {
  let text = body;
  let date = ctx.today;
  const m = text.match(/^(\d{1,2}\/\d{1,2}|昨天|前天)\s+([\s\S]+)$/);
  if (m) {
    const d = extractDate_(m[1], { today: ctx.today, trips: ctx.trips });
    if (d) { date = d.date; text = m[2]; }
  }
  const entry = addJournal_(ctx.userId, { date, type: 'text', text });
  return say_(ctx, textMsg_(`📝 已記到 ${prettyDate_(date)} 的旅遊日誌`, [
    qMsg_('看這天日誌', `日誌 ${date.slice(5).replace('-', '/')}`), qPostback_('刪除這則', { a: 'delj', id: entry.id }, '刪除剛才的日誌'), ...defaultQuick_(),
  ]));
}

function cmdJournalView_(ctx, arg) {
  const all = loadJournal_(ctx.userId);
  if (!all.length) return say_(ctx, textMsg_('旅遊日誌還是空的。\n輸入「日誌 想記的內容」，或直接傳照片給我，就會記到今天的日誌。'));
  let date = ctx.today;
  if (arg) {
    const d = extractDate_(arg, { today: ctx.today, trips: ctx.trips, trip: activeTrip_(ctx.trips, ctx.today) });
    if (d) date = d.date;
  } else if (!all.some((j) => j.date === ctx.today)) {
    date = all[all.length - 1].date; // 今天沒有就顯示最近一天
  }
  const entries = all.filter((j) => j.date === date);
  const lines = [`📔 ${prettyDate_(date)} 旅遊日誌`];
  if (!entries.length) lines.push('（這天沒有紀錄）');
  entries.forEach((j) => lines.push(`${j.time} ${j.type === 'image' ? '📷 照片' : j.text}`));
  const photos = entries.filter((j) => j.type === 'image').length;
  const trip = ctx.trips.find((t) => t.startDate <= date && date <= t.endDate);
  if (photos) lines.push('', `照片 ${photos} 張，可以在網站的「日誌」分頁查看：`, tripLiffUrl_(trip && trip.id));
  const days = [...new Set(all.map((j) => j.date))].filter((d) => d !== date).slice(-4).reverse();
  return say_(ctx, textMsg_(lines.join('\n'), [...days.map((d) => qMsg_(`日誌 ${d.slice(5).replace('-', '/')}`)), ...defaultQuick_()]));
}

function handleImage_(ctx, message) {
  const set = message.imageSet;
  const folder = DriveApp.getFolderById(prop_('PHOTO_FOLDER_ID'));
  const blob = getMessageContent_(message.id);
  const date = ctx.today;
  const ext = (blob.getContentType() || 'image/jpeg').split('/')[1] || 'jpg';
  const file = folder.createFile(blob.setName(`${date}_${nowTime_().replace(':', '')}_${message.id}.${ext}`));
  addJournal_(ctx.userId, { date, type: 'image', text: '', fileId: file.getId() });
  if (set && set.index !== set.total) return; // 一次傳多張時，只在最後一張回覆
  const count = set ? set.total : 1;
  return say_(ctx, textMsg_(`📷 已把 ${count} 張照片記到 ${prettyDate_(date)} 的旅遊日誌`, [qMsg_('看今天日誌', '日誌'), ...defaultQuick_()]));
}

/* ---------- Postback ---------- */
function handlePostback_(ctx, data) {
  let p;
  try {
    p = JSON.parse(data);
  } catch (err) {
    return;
  }
  if (p.a === 'del') return deleteActivity_(ctx, p.id);
  if (p.a === 'edit') return applyEdit_(ctx, p.id, p.p || {});
  if (p.a === 'trip') {
    const trip = ctx.trips.find((t) => t.id === p.id);
    if (!trip) return say_(ctx, textMsg_('這個旅程已經不存在了。'));
    return say_(ctx, tripFlex_(trip), tripOverviewText_(trip));
  }
  if (p.a === 'delj') {
    const row = deleteJournal_(ctx.userId, p.id);
    return say_(ctx, textMsg_(row ? '🗑️ 已刪除這則日誌' : '這則日誌已經不存在了。'));
  }
}

/* ---------- Google 地圖導航 ---------- */
function cmdNavigate_(ctx, query) {
  const q = query.trim();
  const kw = keywordOf_(q);
  const hit = kw ? searchActivities_(ctx.trips, kw, 0.6)[0] : null;
  if (hit && navUrl_(hit.activity)) {
    const a = hit.activity;
    const url = navUrl_(a);
    return say_(ctx, textMsg_(`🧭 導航到「${a.title}」${a.location ? `（${a.location}）` : ''}\n${url}`, [qUri_('🧭 開始導航', url), ...defaultQuick_()]));
  }
  if (!q) return say_(ctx, textMsg_('要導航到哪裡呢？例如：導航 清水寺'));
  // 行程裡找不到（或沒有地點），直接用輸入的文字導航
  const place = hit ? hit.activity.title : q;
  const url = navToUrl_(place);
  return say_(ctx, textMsg_(`🧭 導航到「${place}」\n${url}`, [qUri_('🧭 開始導航', url), ...defaultQuick_()]));
}

function cmdRoute_(ctx, text) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const base = activeTrip_(ctx.trips, ctx.today);
  const found = extractDate_(text, { today: ctx.today, trips: ctx.trips, trip: base });
  let date = found ? found.date : ctx.today;
  const trip = activeTrip_(ctx.trips, ctx.today, date);
  if (date < trip.startDate || date > trip.endDate) date = trip.startDate;
  const list = trip.days[date] || [];
  const url = dayRouteUrl_(list);
  if (!url) return say_(ctx, textMsg_(`${prettyDate_(date)} 的行程還沒有填地點，沒辦法規劃路線喔。`));
  const stops = list.filter((a) => a.location);
  const lines = [`🧭 ${prettyDate_(date)} 路線（從目前位置出發）`];
  stops.forEach((a, i) => lines.push(`${i + 1}. ${a.time || '--:--'} ${a.title}（${a.location}）`));
  if (stops.length > 10) lines.push('※ Google 地圖一次最多 10 個地點，只帶入最後 10 個');
  lines.push('', url);
  return say_(ctx, textMsg_(lines.join('\n'), [qUri_('🧭 開始導航', url), ...defaultQuick_()]));
}
