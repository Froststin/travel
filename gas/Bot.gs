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
  '・新增 明天 09:00-12:00 清水寺 移動15分',
  '・新增 明天 13:00 伏見稻荷 電車15分 車資230円',
  '　（車資寫「円／日幣」是日幣、「元／台幣」是台幣，沒寫單位當日幣）',
  '　（花費寫「400円／¥400」會換算成旅程的幣別；只寫 $400 就是旅程的幣別）',
  '',
  '【修改／刪除】',
  '・改 清水寺 11:30（有結束時間會一起平移）',
  '・改 清水寺 10:00-12:30、改 清水寺 移動20分',
  '・改 清水寺 公車 25分 車資230',
  '・改 清水寺 到 後天',
  '・刪除 清水寺',
  '',
  '【Google 地圖導航】',
  '・導航 清水寺、清水寺怎麼去',
  '・今天路線、明天路線 → 串起當天所有地點',
  '・新增或修改時貼上 Google 地圖分享連結也可以',
  '',
  '【待去清單】想去但還沒排進行程的地方',
  '・想去 淺草寺、晴空塔 → 加進清單',
  '・待去清單 → 查看（到網站按「整理」會把順路的分在一起）',
  '・不去 晴空塔',
  '',
  '【購物清單】跟著每天的行程走；每個人各自一份，旅伴看不到',
  '・買 明天 抹茶粉 500円、八橋 → 記在那一天',
  '・買 面膜 @藥妝店 → 記在那個行程（行程改天會跟著走）',
  '　（金額會計入預算的「購物」；寫 円／¥ 會換算成旅程的幣別）',
  '・購物清單、明天要買什麼 → 查看（照片和備註到網站上加）',
  '・買到 抹茶粉、買到 抹茶粉 480円（順便改成實際金額）',
  '・不買 八橋',
  '',
  '【旅遊日誌】',
  '・日誌 今天的抹茶超好喝',
  '・直接傳照片 → 自動記到今天的日誌',
  '・日誌／日誌 10/29 → 查看',
  '',
  '【旅伴】',
  '・邀請 → 產生邀請訊息，轉傳給旅伴',
  '・加入 邀請碼 → 加入別人的旅程',
  '・成員、退出旅程、移除成員 名字',
  '',
  '【網站】輸入「網站」取得連結，可以編輯完整行程',
  '',
  '【匯出備份】',
  '・匯出／匯出 京都 → 產生 PDF 連結＋網站連結',
  '　網站打不開時還能看；建議把 PDF 下載到手機',
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

  // 圖文選單切換分頁（旅遊 ⇄ 投資）也會送 postback 過來，不需要回應
  if (ev.type === 'postback' && /^invest-menu:/.test((ev.postback && ev.postback.data) || '')) return;

  withLock_(() => ensureUserName_(userId));
  if (ev.type === 'follow') {
    reply_(ev.replyToken, textMsg_(`歡迎使用旅程手帖！\n\n${HELP_TEXT}`, defaultQuick_()));
    return;
  }
  const ctx = newCtx_(userId, ev.replyToken);
  // 鎖只包住讀寫試算表的部分；連外部網站、產生 PDF 這些慢的事放在鎖外面，才不會卡住其他人的存檔
  if (ev.type === 'postback') {
    warmRates_();
    withLock_(() => handlePostback_(ctx, ev.postback.data));
  } else if (ev.type === 'message' && ev.message.type === 'text') {
    warmRates_();
    withLock_(() => handleText_(ctx, ev.message.text));
  } else if (ev.type === 'message' && ev.message.type === 'image') {
    handleImage_(ctx, ev.message);
  }
  if (ctx.afterLock) ctx.afterLock();
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
  if (handleInvestText_(ctx, text)) return;
  if ((m = text.match(/^(?:匯出|備份|離線版?|下載|pdf)(?:\s*(?:行程|旅程|pdf))?\s*(.*)$/i)) && text.length <= 30) return cmdExport_(ctx, m[1]);
  if (text.length <= 15 && /網站|網頁|連結|網址|link|開啟|打開/i.test(text)) return cmdSite_(ctx);
  if ((m = text.match(/^(?:新旅程|新增旅程|建立旅程)\s*([\s\S]*)$/))) return cmdNewTrip_(ctx, m[1]);
  if (/路線/.test(text) && text.length <= 12) return cmdRoute_(ctx, text.replace(/路線|導航/g, ''));
  if ((m = text.match(/^(?:導航到|導航|帶我去|怎麼去|前往)\s*(.+)$/)) || (m = text.match(/^(.+?)\s*(?:怎麼去|怎麼走|導航)$/))) return cmdNavigate_(ctx, m[1]);
  if ((m = text.match(/^加入\s*([A-Za-z0-9]{6})$/)) && /\d/.test(m[1]) && /[a-z]/i.test(m[1])) return cmdJoin_(ctx, m[1]);
  if ((m = text.match(/^(?:邀請|邀請旅伴|分享旅程|共用旅程|共享旅程)\s*(.*)$/))) return cmdInvite_(ctx, m[1]);
  if (/^(成員|旅伴|同行者|成員名單|有誰)$/.test(text)) return cmdMembers_(ctx);
  if ((m = text.match(/^(?:退出|離開)(?:旅程)?\s*(.*)$/))) return cmdLeave_(ctx, m[1]);
  if ((m = text.match(/^(?:移除成員|踢除|踢掉)\s*(.+)$/))) return cmdRemoveMember_(ctx, m[1]);
  if (/^(?:待去清單|想去清單|待去|想去的地方|想去哪裡?|口袋名單)$/.test(text)) return cmdPlacesView_(ctx);
  if ((m = text.match(/^不去了?\s*([\s\S]+)$/))) return cmdPlacesRemove_(ctx, m[1]);
  if ((m = text.match(/^想去\s*[:：]?\s*([\s\S]+)$/)) && !/哪|嗎|什麼|\?/.test(text)) return cmdPlacesAdd_(ctx, m[1]);
  if (/購物清單|購物列表|要買什麼|買什麼|要買啥|買啥|要買的/.test(text) && text.length <= 20) return cmdShopView_(ctx, text.replace(/購物清單|購物列表|要買什麼|買什麼|要買啥|買啥|要買的(?:東西)?/g, ' '));
  if ((m = text.match(/^(?:買到了?|買了|已買|買好了?)\s*([\s\S]+)$/))) return cmdShopMark_(ctx, m[1], 'done');
  if ((m = text.match(/^(?:不買了?|不用買)\s*([\s\S]+)$/))) return cmdShopMark_(ctx, m[1], 'remove');
  if ((m = text.match(/^(?:要買|記得買|想買|買)\s*[:：]?\s*([\s\S]+)$/)) && !/幾點|哪|嗎|\?/.test(text)) return cmdShopAdd_(ctx, m[1]);
  if ((m = text.match(/^(?:新增|加入|\+)\s*([\s\S]+)$/))) return cmdAdd_(ctx, m[1]);
  if ((m = text.match(/^(?:刪除|移除|刪掉)\s*([\s\S]+)$/))) return cmdDelete_(ctx, m[1]);
  if ((m = text.match(/^(?:修改|更改|改)\s*([\s\S]+)$/))) return cmdEdit_(ctx, m[1]);
  if (/^(?:看|查看|查|確認)?(?:旅遊)?(?:日誌|日記)(?:確認)?(?:\s+(.+))?$/.test(text) && !/^(?:日誌|日記)\s*[:：]/.test(text)) {
    const arg = text.replace(/^(?:看|查看|查|確認)?(?:旅遊)?(?:日誌|日記)(?:確認)?\s*/, '');
    if (!arg || isDateOnly_(ctx, arg)) return cmdJournalView_(ctx, arg);
  }
  if ((m = text.match(/^(?:日誌|日記|記錄|紀錄|記下|筆記|寫日誌)\s*[:：]?\s*([\s\S]+)$/))) return cmdJournalAdd_(ctx, m[1].trim());
  if (/^(匯率|日幣|日圓|日幣匯率|匯率多少)$/.test(text)) return say_(ctx, textMsg_(`💱 ${rateText_('JPY')}\n\n例：¥1,000 ≈ ${ntd_(toTWD_(1000, 'JPY') || 0)}`));
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
    return say_(ctx, textMsg_('目前還沒有任何旅程。\n可以輸入「新旅程 京都 10/28-10/30」建立，或輸入「網站」到網頁上規劃。\n旅伴有邀請碼的話，傳「加入 邀請碼」就能加入。'));
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
      `🗓️ ${trip.name}・Day ${daysBetween_(trip.startDate, date) + 1}・${prettyDate_(date)}${a.time ? ` ${timeLabel_(a)}` : ''}`,
    ];
    if (a.location) lines.push(`📍 ${a.location}`);
    if (placeUrl_(a)) lines.push(`🗺️ 地圖：${placeUrl_(a)}`);
    if (navUrl_(a)) lines.push(`🧭 導航：${navUrl_(a)}`);
    if (a.cost) lines.push(`💰 ${showMoney_(a.cost, trip.currency)}`);
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

/** 匯出：PDF 連結＋網站連結，再附一份純文字行程（留在聊天室裡，什麼都連不上時也看得到） */
function cmdExport_(ctx, name) {
  const trip = pickTrip_(ctx, name);
  if (!trip) return say_(ctx, textMsg_('還沒有旅程可以匯出喔。'));
  ctx.afterLock = () => exportTrip_(ctx, trip); // 產生 PDF 要幾秒，放到鎖外面做
}

function exportTrip_(ctx, trip) {
  const site = tripLiffUrl_(trip.id);
  const overview = tripOverviewText_(trip);
  let res;
  try {
    res = exportTripPdf_(ctx.userId, trip);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return say_(ctx, [
      textMsg_(`⚠️ PDF 產生失敗（${err.message}），先給你網站連結和純文字版：\n🌐 ${site}`),
      textMsg_(overview, [qUri_('開啟網站', site), qMsg_('再試一次', `匯出 ${trip.name}`), ...defaultQuick_()]),
    ]);
  }
  return say_(ctx, [
    textMsg_([
      `📤「${trip.name}」已匯出（${res.exportedAt} 的內容）`,
      '',
      '📄 PDF（網站打不開也能看）：',
      res.url,
      '',
      '🌐 網站（最新內容）：',
      site,
      '',
      '※ PDF 是當下的備份，行程改過要再匯出一次，舊連結會失效。建議打開後下載到手機，沒網路也能看。',
      '※ 知道 PDF 連結的人都能看，請只傳給旅伴。',
    ].join('\n')),
    textMsg_(overview, [qUri_('📄 開啟 PDF', res.url), qUri_('🌐 開啟網站', site), ...defaultQuick_()]),
  ]);
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
  const cur = trip.currency;
  const b = budgetSummary_(trip); // 全部換算成台幣，含購物清單
  const spent = b.spent;
  const lines = [`💰 ${trip.name} 預算`];
  if (trip.budget) {
    const remain = twdOrRaw_(trip.budget, cur) - spent;
    lines.push(`總預算：${showMoney_(trip.budget, cur)}`, `預估花費：${ntd_(spent)}`,
      remain >= 0 ? `剩餘：${ntd_(remain)}` : `⚠️ 超出預算：${ntd_(-remain)}`);
  } else {
    lines.push(`預估花費：${ntd_(spent)}（尚未設定總預算）`);
  }
  const cats = b.cats;
  if (cats.length) {
    lines.push('', '分類：');
    cats.forEach(([k, v]) => lines.push(`${CATEGORY_INFO[k].icon} ${CATEGORY_INFO[k].label} ${ntd_(v)}`));
  }
  const { foreign, missing } = b;
  if (missing.length) lines.push('', `⚠️ 目前查不到 ${missing.join('、')} 的匯率，這些金額暫時直接當成台幣加總，數字不準，請稍後再查一次。`);
  if (foreign.length) lines.push('', `※ 金額皆換算成台幣：${foreign.map(rateText_).join('；')}`);
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
    days: {}, packing: [], shopping: [], places: [], createdAt: Date.now(),
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
  const tr = extractTravel_(rest);
  if (tr) rest = tr.rest;
  const d = extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base });
  if (d) rest = d.rest;
  const t = extractTimeRange_(rest);
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

  const cc = costInCurrency_(c ? c.cost : 0, c ? c.currency : '', trip.currency);
  const activity = {
    id: Utilities.getUuid(), time: t ? t.time : '', endTime: t ? t.endTime : '', travelMin: tr ? tr.travelMin : 0,
    travelMode: tr ? tr.travelMode : '', travelCost: tr && tr.travelCost != null ? tr.travelCost : 0,
    travelCostCurrency: tr && tr.travelCost != null ? tr.travelCostCurrency : '', title: title.slice(0, 100),
    category: guessCategory_(`${title} ${loc ? loc.location : ''}`), location: loc ? loc.location.slice(0, 200) : '',
    mapUrl: u ? cleanUrl_(u.url) : '', cost: cc.cost, notes: '',
  };
  (trip.days[date] = trip.days[date] || []).push(activity);
  sortDay_(trip.days[date]);
  saveTrip_(ctx.userId, trip);
  const list = trip.days[date];
  const issue = scheduleIssue_(list[list.indexOf(activity) - 1], activity);
  return say_(ctx, textMsg_(
    `✅ 已新增到「${trip.name}」Day ${daysBetween_(trip.startDate, date) + 1}・${prettyDate_(date)}\n${activityLine_(activity)}${transitLabel_(activity, trip.currency) ? `\n${transitLabel_(activity, trip.currency)}` : ''}${activity.cost ? `\n💰 ${showMoney_(activity.cost, trip.currency)}${cc.note}` : ''}${issue ? `\n⚠️ ${issue}` : ''}`,
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
  const tr = extractTravel_(rest);
  if (tr) {
    if (tr.hasTravel) { changes.travelMin = tr.travelMin; if (tr.travelMode) changes.travelMode = tr.travelMode; }
    if (tr.travelCost != null) { changes.travelCost = tr.travelCost; changes.travelCostCurrency = tr.travelCostCurrency; }
    rest = tr.rest;
  }
  const t = extractTimeRange_(rest);
  if (t) { changes.time = t.time; if (t.endTime) changes.endTime = t.endTime; rest = t.rest; }
  const c = extractCost_(rest);
  if (c) { changes.cost = c.cost; if (c.currency) changes.costCur = c.currency; rest = c.rest; }
  const loc = extractLocation_(rest);
  if (loc) { changes.location = loc.location; rest = loc.rest; }
  const d = base ? extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base }) : null;
  if (d) { changes.date = d.date; rest = d.rest; }
  const kw = keywordOf_(rest.replace(/改成|改到|換到|移到|到|成|為/g, ' '));

  if (!Object.keys(changes).length || !kw) {
    return say_(ctx, textMsg_('要怎麼改呢？例如：\n改 清水寺 11:30\n改 清水寺 10:00-12:30\n改 清水寺 移動20分\n改 清水寺 到 後天\n改 清水寺 $500\n改 清水寺 @京都東山\n改 清水寺 https://maps.app.goo.gl/…\n\n其他內容請到網站修改（輸入「網站」）。'));
  }
  const hits = searchActivities_(ctx.trips, kw, 0.6);
  if (!hits.length) return say_(ctx, textMsg_(`找不到跟「${kw}」有關的行程。`));
  if (hits.length === 1) return applyEdit_(ctx, hits[0].activity.id, changes);
  const ref = editRef_(changes);
  return say_(ctx, textMsg_(`找到 ${hits.length} 筆，要改哪一個？`, hits.slice(0, 12).map((h) =>
    qPostback_(`${h.date.slice(5).replace('-', '/')} ${h.activity.title}`, Object.assign({ a: 'edit', id: h.activity.id }, ref), `修改 ${h.activity.title}`))));
}

// LINE 的 postback 資料上限 300 字：修改內容太長（例如帶了地圖網址）時先放進快取，按鈕只帶代號
function editRef_(changes) {
  if (JSON.stringify(changes).length <= 180) return { p: changes };
  const k = Utilities.getUuid().slice(0, 8);
  CacheService.getScriptCache().put(`pb_${k}`, JSON.stringify(changes), 21600);
  return { k };
}

function applyEdit_(ctx, id, changes) {
  const found = findActivity_(ctx, id);
  if (!found) return say_(ctx, textMsg_('這個行程已經不存在了。'));
  const { trip, activity } = found;
  let date = found.date;
  if (changes.time && /^\d{2}:\d{2}$/.test(changes.time)) {
    if (changes.endTime && /^\d{2}:\d{2}$/.test(changes.endTime) && changes.endTime >= changes.time) {
      activity.endTime = changes.endTime;
    } else if (activity.time && activity.endTime) {
      // 只改開始時間：結束時間跟著平移，保留原本的停留長度
      activity.endTime = fromMin_(toMin_(changes.time) + toMin_(activity.endTime) - toMin_(activity.time));
    }
    activity.time = changes.time;
  }
  // 「改 X 搭電車」只改方式時保留原本的分鐘數
  if (changes.travelMin != null && (changes.travelMin > 0 || !changes.travelMode)) activity.travelMin = Math.min(1440, Math.max(0, Math.round(Number(changes.travelMin) || 0)));
  if (changes.travelMode) activity.travelMode = travelModeKey_(changes.travelMode);
  if (changes.travelCost != null) {
    activity.travelCost = Math.max(0, Number(changes.travelCost) || 0);
    activity.travelCostCurrency = CURRENCY_CODES.includes(changes.travelCostCurrency) ? changes.travelCostCurrency : '';
  }
  let costNote = '';
  if (changes.cost != null) {
    const cc = costInCurrency_(changes.cost, CURRENCY_CODES.includes(changes.costCur) ? changes.costCur : '', trip.currency);
    activity.cost = cc.cost;
    costNote = cc.note;
  }
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
  const issue = scheduleIssue_(trip.days[date][trip.days[date].indexOf(activity) - 1], activity);
  return say_(ctx, textMsg_(`✏️ 已更新：${prettyDate_(date)} ${activityLine_(activity)}${transitLabel_(activity, trip.currency) ? `\n${transitLabel_(activity, trip.currency)}` : ''}${activity.cost ? `\n💰 ${showMoney_(activity.cost, trip.currency)}${costNote}` : ''}${issue ? `\n⚠️ ${issue}` : ''}`));
}

/* ---------- 待去清單 ---------- */
function placeScheduled_(trip, place) {
  if (!place.activityId) return '';
  for (const [d, list] of Object.entries(trip.days || {})) {
    if (list.some((a) => a.id === place.activityId)) return d;
  }
  return '';
}

function cmdPlacesView_(ctx) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const trip = activeTrip_(ctx.trips, ctx.today);
  const places = trip.places || [];
  const more = [qUri_('到網站整理', tripLiffUrl_(trip.id)), ...defaultQuick_()];
  if (!places.length) return say_(ctx, textMsg_(`「${trip.name}」的待去清單還是空的。\n例如：想去 淺草寺、晴空塔`, more));
  const line = (p) => {
    const d = placeScheduled_(trip, p);
    return `${d ? '✅' : '・'} ${p.name}${d ? `（已排入 Day ${daysBetween_(trip.startDate, d) + 1}）` : ''}`;
  };
  const lines = [`📍 ${trip.name} 待去清單：${places.length} 個，已排入行程 ${places.filter((p) => placeScheduled_(trip, p)).length} 個`];
  // 已經在網站整理過的，依所在的區分組
  const areas = [...new Set(places.filter((p) => p.geo === 'ok' && p.area).map((p) => p.area))];
  areas.forEach((area) => {
    lines.push('', `【${area}】`);
    places.filter((p) => p.geo === 'ok' && p.area === area).forEach((p) => lines.push(line(p)));
  });
  const rest = places.filter((p) => !(p.geo === 'ok' && p.area));
  if (rest.length) {
    lines.push('', areas.length ? '【還沒整理】' : '');
    rest.forEach((p) => lines.push(line(p)));
  }
  lines.push('', '到網站的「想去」分頁按「整理」，會依距離把順路的地點分在一起，還能直接排進某一天。');
  return say_(ctx, textMsg_(lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n'), more));
}

function cmdPlacesAdd_(ctx, body) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('要先建立旅程喔，例如：新旅程 京都 10/28-10/30'));
  const trip = activeTrip_(ctx.trips, ctx.today);
  trip.places = trip.places || [];
  const have = new Set(trip.places.map((p) => p.name));
  const names = [...new Set(body.split(/[、，,\n]+/).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))];
  const fresh = names.filter((n) => !have.has(n));
  if (!names.length) return say_(ctx, textMsg_('想去哪裡呢？例如：想去 淺草寺、晴空塔'));
  if (trip.places.length + fresh.length > MAX_PLACES) return say_(ctx, textMsg_(`待去清單最多 ${MAX_PLACES} 個地方。`));
  fresh.forEach((name) => trip.places.push({ id: Utilities.getUuid(), name, address: '', mapUrl: '', geo: '', lat: '', lng: '', area: '', geoName: '', activityId: '' }));
  if (fresh.length) saveTrip_(ctx.userId, trip);
  const lines = [fresh.length ? `📍 已加入「${trip.name}」的待去清單：${fresh.join('、')}` : '這些地方都已經在待去清單裡了。'];
  if (names.length > fresh.length && fresh.length) lines.push(`（已經有的：${names.filter((n) => have.has(n)).join('、')}）`);
  lines.push(`目前共 ${trip.places.length} 個。到網站按「整理」可以把順路的分在一起。`);
  return say_(ctx, textMsg_(lines.join('\n'), [qMsg_('待去清單'), qUri_('到網站整理', tripLiffUrl_(trip.id)), ...defaultQuick_()]));
}

function cmdPlacesRemove_(ctx, body) {
  const names = body.split(/[、，,\n]+/).map((s) => s.trim()).filter(Boolean);
  const trip = ctx.trips.length ? activeTrip_(ctx.trips, ctx.today) : null;
  const removed = [];
  const missing = [];
  for (const name of names) {
    const hit = ((trip && trip.places) || [])
      .map((p) => ({ p, score: similarity_(name, p.name) }))
      .filter((x) => x.score >= 0.6 && !removed.includes(x.p))
      .sort((a, b) => b.score - a.score)[0];
    if (hit) removed.push(hit.p); else missing.push(name);
  }
  if (!removed.length) return say_(ctx, textMsg_(`待去清單裡找不到「${missing.join('、')}」。輸入「待去清單」可以看全部。`, [qMsg_('待去清單'), ...defaultQuick_()]));
  trip.places = trip.places.filter((p) => !removed.includes(p));
  saveTrip_(ctx.userId, trip);
  const lines = [`🗑️ 已從待去清單拿掉：${removed.map((p) => p.name).join('、')}`];
  if (removed.some((p) => placeScheduled_(trip, p))) lines.push('（已經排進行程的那一站不會被刪掉）');
  if (missing.length) lines.push(`找不到：${missing.join('、')}`);
  return say_(ctx, textMsg_(lines.join('\n'), [qMsg_('待去清單'), ...defaultQuick_()]));
}

/* ---------- 購物清單 ---------- */
function shopWhere_(trip, item) {
  const d = shopDate_(trip, item);
  const a = shopActivity_(trip, item);
  if (!d) return '不指定日期';
  return `Day ${daysBetween_(trip.startDate, d) + 1}・${prettyDate_(d)}${a ? `・${a.title}` : ''}`;
}

function cmdShopView_(ctx, rest) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const base = activeTrip_(ctx.trips, ctx.today);
  const found = extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base });
  const trip = activeTrip_(ctx.trips, ctx.today, found && found.date);
  const all = trip.shopping || [];
  const more = [qUri_('在網站編輯', tripLiffUrl_(trip.id)), ...defaultQuick_()];
  if (!all.length) {
    return say_(ctx, textMsg_(`「${trip.name}」的購物清單還是空的。\n例如：\n買 明天 抹茶粉、八橋\n買 面膜 @藥妝店`, more));
  }
  const lines = [`🛒 ${trip.name} 購物清單：已買 ${all.filter((s) => s.done).length} / ${all.length}`];
  const total = all.reduce((s, x) => s + twdOrRaw_(x.price, trip.currency), 0);
  if (total) lines.push(`預估 ${ntd_(total)}（已計入預算），其中已買 ${ntd_(all.filter((s) => s.done).reduce((s, x) => s + twdOrRaw_(x.price, trip.currency), 0))}`);
  if (found && trip.startDate <= found.date && found.date <= trip.endDate) {
    const list = shoppingOn_(trip, found.date);
    lines.push('', `【Day ${daysBetween_(trip.startDate, found.date) + 1}・${prettyDate_(found.date)}】`);
    if (!list.length) lines.push('（這天沒有要買的東西）');
    list.forEach((s) => lines.push(shopLine_(trip, s)));
  } else {
    for (const d of dateRange_(trip.startDate, trip.endDate)) {
      const list = shoppingOn_(trip, d);
      if (!list.length) continue;
      lines.push('', `【Day ${daysBetween_(trip.startDate, d) + 1}・${prettyDate_(d)}】`);
      list.forEach((s) => lines.push(shopLine_(trip, s)));
    }
    const loose = shoppingOn_(trip, '');
    if (loose.length) {
      lines.push('', '【不指定日期】');
      loose.forEach((s) => lines.push(shopLine_(trip, s)));
    }
  }
  return say_(ctx, textMsg_(lines.join('\n'), more));
}

function cmdShopAdd_(ctx, body) {
  if (!ctx.trips.length) return say_(ctx, textMsg_('要先建立旅程喔，例如：新旅程 京都 10/28-10/30'));
  const base = activeTrip_(ctx.trips, ctx.today);
  let rest = body;
  let trip = base;
  let date = '';
  let activityId = '';
  let missed = '';
  const loc = extractLocation_(rest);
  if (loc) {
    rest = loc.rest;
    const hit = searchActivities_(ctx.trips, loc.location, 0.6)[0];
    if (hit) { trip = hit.trip; date = hit.date; activityId = hit.activity.id; } else missed = loc.location;
  }
  const d = extractDate_(rest, { today: ctx.today, trips: ctx.trips, trip: base });
  if (d) {
    rest = d.rest;
    if (!activityId) {
      const t = ctx.trips.find((x) => x.startDate <= d.date && d.date <= x.endDate);
      if (!t) return say_(ctx, textMsg_(`${prettyDate_(d.date)} 沒有旅程喔。`));
      trip = t;
      date = d.date;
    }
  }
  const parsed = splitShopItems_(rest);
  if (!parsed.length) return say_(ctx, textMsg_('要買什麼呢？例如：\n買 明天 抹茶粉 500円、八橋\n買 面膜 @藥妝店'));
  trip.shopping = trip.shopping || [];
  if (trip.shopping.length + parsed.length > MAX_SHOPPING) return say_(ctx, textMsg_(`購物清單最多 ${MAX_SHOPPING} 樣，先把買好的刪掉吧。`));
  const lines = [];
  const items = parsed.map((p) => {
    const cc = costInCurrency_(p.cost || 0, p.currency, trip.currency);
    const item = { id: Utilities.getUuid(), text: p.text.slice(0, 80), date, activityId, price: cc.cost, done: false, note: '', fileId: '' };
    lines.push(`☐ ${item.text}${item.price ? ` ${showMoney_(item.price, trip.currency)}${cc.note}` : ''}`);
    return item;
  });
  trip.shopping.push(...items);
  saveTrip_(ctx.userId, trip);
  lines.unshift(`🛒 已加入「${trip.name}」的購物清單（${shopWhere_(trip, items[0])}）`);
  if (items.some((s) => s.price)) lines.push('', '金額已計入預算的「購物」。');
  if (missed) lines.push('', `※ 找不到跟「${missed}」有關的行程，先${date ? '記在這一天' : '不指定日期'}。`);
  else if (!date) lines.push('', '※ 沒寫日期，先不指定。可以這樣寫：買 明天 抹茶粉、買 面膜 @藥妝店');
  return say_(ctx, textMsg_(lines.join('\n'), [qMsg_('購物清單'), ...(date ? [qMsg_(`看 ${prettyDate_(date)}`, date.slice(5).replace('-', '/'))] : []), ...defaultQuick_()]));
}

/** mode：'done' 標記買到、'remove' 從清單拿掉 */
function cmdShopMark_(ctx, body, mode) {
  const wanted = splitShopItems_(body);
  const active = ctx.trips.length ? activeTrip_(ctx.trips, ctx.today) : null;
  const changed = new Map(); // trip → 這次處理到的項目
  const missing = [];
  const notes = new Map(); // 項目 → 金額換算說明
  for (const want of wanted) {
    const name = want.text;
    const hit = ctx.trips
      .flatMap((trip) => (trip.shopping || []).map((item) => ({ trip, item, score: similarity_(name, item.text) })))
      .filter((x) => x.score >= 0.6 && !(changed.get(x.trip) || []).includes(x.item))
      // 分數高的優先；同分時先挑還沒買的、目前這趟旅程的
      .sort((a, b) => b.score - a.score || Number(a.item.done) - Number(b.item.done) || Number(b.trip === active) - Number(a.trip === active))[0];
    if (!hit) { missing.push(name); continue; }
    if (mode === 'done') {
      hit.item.done = true;
      // 「買到 抹茶粉 480円」：順便改成實際金額
      if (want.cost != null) {
        const cc = costInCurrency_(want.cost, want.currency, hit.trip.currency);
        hit.item.price = cc.cost;
        notes.set(hit.item, cc.note);
      }
    }
    changed.set(hit.trip, (changed.get(hit.trip) || []).concat([hit.item]));
  }
  if (!changed.size) return say_(ctx, textMsg_(`購物清單裡找不到「${missing.join('、')}」。輸入「購物清單」可以看全部。`, [qMsg_('購物清單'), ...defaultQuick_()]));
  const lines = [];
  for (const [trip, items] of changed) {
    if (mode === 'remove') trip.shopping = trip.shopping.filter((s) => !items.includes(s));
    saveTrip_(ctx.userId, trip);
    items.forEach((s) => lines.push(mode === 'remove'
      ? `🗑️ 已從購物清單拿掉：${s.text}`
      : `✅ 買到了：${s.text}${Number(s.price) ? ` ${showMoney_(s.price, trip.currency)}${notes.get(s) || ''}` : ''}`));
    const left = trip.shopping.filter((s) => !s.done).length;
    lines.push(left ? `「${trip.name}」還有 ${left} 樣沒買` : `「${trip.name}」的東西都買齊了 🎉`);
  }
  if (missing.length) lines.push('', `找不到：${missing.join('、')}`);
  return say_(ctx, textMsg_(lines.join('\n'), [qMsg_('購物清單'), ...defaultQuick_()]));
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
  entries.forEach((j) => lines.push(`${j.time} ${j.mine ? '' : `${j.author}：`}${j.type === 'image' ? '📷 照片' : j.text}`));
  const photos = entries.filter((j) => j.type === 'image').length;
  const trip = ctx.trips.find((t) => t.startDate <= date && date <= t.endDate);
  if (photos) lines.push('', `照片 ${photos} 張，可以在網站的「日誌」分頁查看：`, tripLiffUrl_(trip && trip.id));
  const days = [...new Set(all.map((j) => j.date))].filter((d) => d !== date).slice(-4).reverse();
  return say_(ctx, textMsg_(lines.join('\n'), [...days.map((d) => qMsg_(`日誌 ${d.slice(5).replace('-', '/')}`)), ...defaultQuick_()]));
}

function handleImage_(ctx, message) {
  const set = message.imageSet;
  const folder = driveFolder_('PHOTO_FOLDER_ID', '旅程手帖日誌照片');
  const blob = getMessageContent_(message.id);
  const date = ctx.today;
  const ext = (blob.getContentType() || 'image/jpeg').split('/')[1] || 'jpg';
  const file = folder.createFile(blob.setName(`${date}_${nowTime_().replace(':', '')}_${message.id}.${ext}`));
  // 下載與存檔在鎖外面做，只有寫進試算表這一步要鎖
  withLock_(() => addJournal_(ctx.userId, { date, type: 'image', text: '', fileId: file.getId() }));
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
    return say_(ctx, textMsg_('這個按鈕已經失效了，請重新輸入一次。'));
  }
  if (p.a === 'del') return deleteActivity_(ctx, p.id);
  if (p.a === 'edit') {
    if (!p.k) return applyEdit_(ctx, p.id, p.p || {});
    const saved = CacheService.getScriptCache().get(`pb_${p.k}`);
    if (!saved) return say_(ctx, textMsg_('這個選項已經過期了，請重新輸入一次要修改的內容。'));
    return applyEdit_(ctx, p.id, JSON.parse(saved));
  }
  if (p.a === 'export') {
    const trip = ctx.trips.find((t) => t.id === p.id);
    if (!trip) return say_(ctx, textMsg_('這個旅程已經不存在了。'));
    ctx.afterLock = () => exportTrip_(ctx, trip);
    return;
  }
  if (p.a === 'trip') {
    const trip = ctx.trips.find((t) => t.id === p.id);
    if (!trip) return say_(ctx, textMsg_('這個旅程已經不存在了。'));
    return say_(ctx, tripFlex_(trip), tripOverviewText_(trip));
  }
  if (p.a === 'leave') {
    const trip = ctx.trips.find((t) => t.id === p.id);
    if (!trip) return say_(ctx, textMsg_('你已經不在這個旅程裡了。'));
    leaveTrip_(ctx.userId, p.id);
    return say_(ctx, textMsg_(`👋 已退出「${trip.name}」`));
  }
  if (p.a === 'rmm') {
    const removed = removeMember_(ctx.userId, p.t, p.u);
    return say_(ctx, textMsg_(removed ? `已將 ${userName_(removed)} 移出旅程` : '這位成員已經不在旅程裡了。'));
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
  const url = hit ? navUrl_(Object.assign({}, hit.activity, { location: place })) : navToUrl_(place);
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
  stops.forEach((a, i) => lines.push(`${i + 1}. ${timeLabel_(a) || '--:--'} ${a.title}（${a.location}）${transitLabel_(a, trip.currency) ? `｜${transitLabel_(a, trip.currency)}` : ''}`));
  if (stops.length > 10) lines.push('※ Google 地圖一次最多 10 個地點，只帶入最後 10 個');
  lines.push('', url);
  return say_(ctx, textMsg_(lines.join('\n'), [qUri_('🧭 開始導航', url), ...defaultQuick_()]));
}

/* ---------- 旅伴（共用旅程） ---------- */
function ensureUserName_(userId) {
  if (hasUserName_(userId)) return;
  const res = lineApi_(`profile/${userId}`, null, 'get');
  if (res.getResponseCode() === 200) setUserName_(userId, JSON.parse(res.getContentText()).displayName);
}

function pickTrip_(ctx, name) {
  const q = keywordOf_(name || '');
  if (q) {
    const hit = searchTrips_(ctx.trips, q)[0];
    if (hit) return hit.trip;
  }
  return ctx.trips.length ? activeTrip_(ctx.trips, ctx.today) : null;
}

function inviteText_(tripRow, code, inviter) {
  const id = encodeURIComponent(BOT_BASIC_ID);
  return [
    `🧳 ${inviter} 邀請你加入旅程「${tripRow.name}」`,
    `🗓️ ${prettyDate_(tripRow.startDate)} – ${prettyDate_(tripRow.endDate)}`,
    '',
    '1️⃣ 先加「旅程手帖」官方帳號好友：',
    `https://line.me/R/ti/p/${id}`,
    '2️⃣ 點這裡加入旅程：',
    `https://line.me/R/oaMessage/${id}/?${encodeURIComponent(`加入 ${code}`)}`,
    '',
    `（或直接傳「加入 ${code}」給官方帳號）`,
  ].join('\n');
}

function cmdInvite_(ctx, name) {
  const trip = pickTrip_(ctx, name);
  if (!trip) return say_(ctx, textMsg_('要先建立旅程才能邀請旅伴喔，例如：新旅程 京都 10/28-10/30'));
  const code = inviteCodeFor_(ctx.userId, trip.id);
  const text = inviteText_(findTripRow_(trip.id), code, userName_(ctx.userId));
  return say_(ctx, [
    textMsg_(`👇 把下面這則邀請轉傳給「${trip.name}」的旅伴（長按訊息 → 分享），或按下方的「分享給旅伴」。`),
    textMsg_(text, [qUri_('📤 分享給旅伴', `https://line.me/R/share?text=${encodeURIComponent(text)}`), qMsg_('成員'), ...defaultQuick_()]),
  ]);
}

function cmdJoin_(ctx, code) {
  const res = joinTrip_(ctx.userId, code);
  if (!res) return say_(ctx, textMsg_(`找不到邀請碼「${code.toUpperCase()}」，請確認有沒有打錯。`));
  const names = membersOf_(res.row).map((m) => m.name).join('、');
  if (res.already) return say_(ctx, textMsg_(`你已經在「${res.row.name}」裡了 😊\n成員：${names}`));
  return say_(ctx, textMsg_(
    `🎉 已加入「${res.row.name}」！\n🗓️ ${prettyDate_(res.row.startDate)} – ${prettyDate_(res.row.endDate)}\n👥 成員：${names}\n\n可以試試「所有旅程」「今天」「明天吃什麼」，或輸入「說明」看所有用法。`,
  ));
}

function cmdMembers_(ctx) {
  const trip = pickTrip_(ctx, '');
  if (!trip) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const row = findTripRow_(trip.id);
  const members = membersOf_(row);
  const lines = [`👥「${trip.name}」的成員（${members.length} 人）`];
  members.forEach((m) => lines.push(`${m.role === 'owner' ? '👑' : '・'} ${m.name}${m.userId === ctx.userId ? '（你）' : ''}`));
  const quick = [qMsg_('📨 邀請旅伴', '邀請')];
  if (row.userId === ctx.userId) {
    members.filter((m) => m.role !== 'owner').slice(0, 10).forEach((m) =>
      quick.push(qPostback_(`移除 ${m.name}`, { a: 'rmm', t: row.id, u: m.userId }, `移除成員 ${m.name}`)));
  } else {
    quick.push(qMsg_('退出旅程'));
  }
  return say_(ctx, textMsg_(lines.join('\n'), [...quick, ...defaultQuick_()]));
}

function cmdLeave_(ctx, name) {
  const trip = pickTrip_(ctx, name);
  if (!trip) return say_(ctx, textMsg_('你目前沒有加入任何旅程。'));
  if (trip.role === 'owner') {
    return say_(ctx, textMsg_(`你是「${trip.name}」的主人，沒辦法退出喔。\n要刪除整個旅程請到網站操作（輸入「網站」）。`));
  }
  return say_(ctx, textMsg_(`確定要退出「${trip.name}」嗎？退出後就看不到這個旅程了。`, [
    qPostback_('確定退出', { a: 'leave', id: trip.id }), qMsg_('取消'),
  ]));
}

function cmdRemoveMember_(ctx, name) {
  const trip = pickTrip_(ctx, '');
  if (!trip) return say_(ctx, textMsg_('還沒有旅程喔。'));
  const row = findTripRow_(trip.id);
  if (row.userId !== ctx.userId) return say_(ctx, textMsg_('只有旅程主人可以移除成員喔。'));
  const hit = membersOf_(row)
    .filter((m) => m.role !== 'owner')
    .map((m) => ({ m, score: similarity_(name, m.name) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)[0];
  if (!hit) return say_(ctx, textMsg_(`「${trip.name}」裡找不到叫「${name}」的成員。輸入「成員」可以看名單。`));
  return say_(ctx, textMsg_(`確定要把 ${hit.m.name} 移出「${trip.name}」嗎？`, [
    qPostback_('確定移除', { a: 'rmm', t: row.id, u: hit.m.userId }, `移除成員 ${hit.m.name}`), qMsg_('取消'),
  ]));
}
