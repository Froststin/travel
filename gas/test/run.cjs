/* 本機測試：用假的 Google／LINE 服務載入所有 .gs，模擬 LINE 訊息與網站 API
 * 執行：node gas/test/run.cjs
 */
const H = require('./harness.cjs');
const { ctx, run, props, sent, flags, writes, sheets, cache, files, lockLog } = H;

// 走和正式環境一樣的入口（doPost → ensureSchema_ → handleWebhook_）
function hook() {
  ctx.__req = { parameter: { src: 'line', key: 'k' }, postData: { contents: JSON.stringify(ctx.__ev) } };
  run('doPost(__req)');
}

function rows(name) { run('__clearCache()'); ctx.__n = name; return run('readTable_(__n)'); }

/* ---------- 工具 ---------- */
let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✔' : '✘'} ${name}${!cond && detail ? `\n    ${detail}` : ''}`);
}

function say(text, user = 'U1') {
  sent.length = 0;
  run('__clearCache()');
  ctx.__ev = { events: [{ type: 'message', replyToken: 'r', source: { userId: user }, message: { type: 'text', text } }] };
  hook();
  return lastReply();
}

function postback(data, user = 'U1') {
  sent.length = 0;
  run('__clearCache()');
  ctx.__ev = { events: [{ type: 'postback', replyToken: 'r', source: { userId: user }, postback: { data: JSON.stringify(data) } }] };
  hook();
  return lastReply();
}

function lastReply() {
  const r = sent.filter((s) => s.url.includes('message/reply')).pop();
  if (!r) return { text: '', msgs: [] };
  const msgs = r.body.messages;
  const text = msgs.map((m) => (m.type === 'text' ? m.text : `[flex] ${m.altText} ${JSON.stringify(m.contents)}`)).join('\n');
  return { text, msgs, quick: (msgs[msgs.length - 1].quickReply || { items: [] }).items };
}

function api(action, payload, token = 'good:U1') {
  run('__clearCache()');
  ctx.__req = { parameter: {}, postData: { contents: JSON.stringify({ action, idToken: token, ...payload }) } };
  return JSON.parse(run('doPost(__req)').s);
}

/* ---------- 圖文選單：版本不同時自動重建 ---------- */
const menuCreates = () => sent.filter((s) => s.url.endsWith('/v2/bot/richmenu'));
flags.menuImageMissing = true;
api('list', {});
check('圖文選單：圖片還抓不到時不建立、也不影響使用', menuCreates().length === 0 && !props.RICHMENU_VERSION && api('list', {}).ok);
flags.menuImageMissing = false;
api('list', {});
check('圖文選單：失敗後 10 分鐘內不重試', menuCreates().length === 0);
props.RICHMENU_TRIED_AT = String(Date.now() - 11 * 60 * 1000);
api('list', {});
const menu = menuCreates()[0] && menuCreates()[0].body;
check('圖文選單：自動重建成 7 格，含「匯出」', menuCreates().length === 1 && menu.areas.length === 7 && props.RICHMENU_VERSION === '2'
  && menu.areas.some((a) => a.action.text === '匯出' && a.bounds.x === 1250 && a.bounds.y === 843 && a.bounds.width === 625)
  && menu.areas.reduce((s, a) => s + a.bounds.width * a.bounds.height, 0) === 2500 * 1686, JSON.stringify(menu));
check('圖文選單：有上傳圖片並設為預設', sent.some((s) => /richmenu\/menu-\d+\/content$/.test(s.url)) && sent.some((s) => /user\/all\/richmenu\/menu-\d+$/.test(s.url)));
api('list', {});
check('圖文選單：已是最新版就不再重建', menuCreates().length === 1);
sent.length = 0;

/* ---------- 解析 ---------- */
const P = (code) => run(code);
const c0 = { today: '2026-10-29', trips: [], trip: { startDate: '2026-10-28', endDate: '2026-10-30' } };
ctx.__c0 = c0;
check('明天', P('extractDate_("明天吃什麼", __c0).date') === '2026-10-30');
check('大後天', P('extractDate_("大後天", __c0).date') === '2026-11-01');
check('第三天', P('extractDate_("第三天", __c0).date') === '2026-10-30');
check('Day 2', P('extractDate_("day 2 行程", __c0).date') === '2026-10-29');
check('10/28', P('extractDate_("10/28", __c0).date') === '2026-10-28');
check('1/5 跨年', P('extractDate_("1/5", __c0).date') === '2027-01-05');
check('11月3日', P('extractDate_("11月3日", __c0).date') === '2026-11-03');
check('星期五（旅程內）', P('extractDate_("星期五", __c0).date') === '2026-10-30');
check('下午三點半', P('extractTime_("下午三點半 喝咖啡").time') === '15:30');
check('10:05', P('extractTime_("10:05 清水寺").time') === '10:05');
check('$400', P('extractCost_("清水寺 $400").cost') === 400);
check('500元', P('extractCost_("拉麵 500元").cost') === 500);
check('花費幣別', P('extractCost_("清水寺 400円").currency') === 'JPY' && P('extractCost_("清水寺 ¥400").currency') === 'JPY'
  && P('extractCost_("拉麵 NT$300").currency') === 'TWD' && P('extractCost_("清水寺 $400").currency') === '' && P('extractCost_("拉麵 500元").currency') === '');
check('關鍵字：清水寺幾點', P('keywordOf_("清水寺幾點？")') === '清水寺');
check('類別：吃什麼', P('queryCategory_("吃什麼").category') === 'food');
check('猜類別：拉麵', P('guessCategory_("一蘭拉麵")') === 'food');
check('新旅程 10/28-10/30', P('JSON.stringify(parseTripSpec_("京都 10/28-10/30", __c0))') === JSON.stringify({ name: '京都', startDate: '2026-10-28', endDate: '2026-10-30' }));
check('新旅程 12/30-1/2 跨年', P('parseTripSpec_("東京 12/30-1/2", __c0).endDate') === '2027-01-02');
check('新旅程 12/1 5天', P('parseTripSpec_("沖繩 12/1 5天", __c0).endDate') === '2026-12-05');
check('新旅程 10/28-30', P('parseTripSpec_("大阪 10/28-30", __c0).endDate') === '2026-10-30');

/* ---------- 機器人對話 ---------- */
let r = say('今天');
check('沒有旅程時提示建立', r.text.includes('新旅程'), r.text);

r = say('新旅程 京都 10/28-10/30');
check('建立旅程', r.text.includes('已建立「京都」'), r.text);

r = say('新增 今天 10:00 清水寺 @清水寺 $400');
check('新增行程', r.text.includes('10:00 🏞️ 清水寺（清水寺）'), r.text);
say('新增 明天 12:30 一蘭拉麵 @祇園 980元');
say('新增 明天 9:00 伏見稻荷大社');
say('新增 第1天 16:00 飯店 Check-in');

r = say('今天');
check('今天 → Flex 行程卡片', r.msgs[0].type === 'flex' && r.text.includes('清水寺'), r.text.slice(0, 200));

r = say('明天吃什麼');
check('明天吃什麼 → 只列餐飲', r.text.includes('一蘭拉麵') && !r.text.includes('伏見'), r.text.slice(0, 300));

r = say('清水寺幾點');
check('清水寺幾點 → 單筆詳細', r.text.includes('Day 2') && r.text.includes('10:00'), r.text);

r = say('稻荷');
check('模糊：稻荷 → 伏見稻荷大社', r.text.includes('伏見稻荷大社'), r.text);

r = say('改 清水寺 11:30');
check('修改時間', r.text.includes('11:30 🏞️ 清水寺'), r.text);

r = say('改 伏見稻荷 到 第三天');
check('移到別天', r.text.includes('10/30'), r.text);

r = say('預算');
check('預算（台幣）', r.text.includes('預估花費：NT$1,380'), r.text);

r = say('刪除 拉麵');
check('刪除先確認', r.text.includes('確定要刪除') && r.quick[0].action.type === 'postback', r.text);
r = postback(JSON.parse(r.quick[0].action.data));
check('確認後刪除', r.text.includes('已刪除'), r.text);

r = say('日誌 抹茶超好喝');
check('寫日誌', r.text.includes('已記到 10/29（四） 的旅遊日誌'), r.text);
r = say('日誌 今天好累');
check('日誌內容含「今天」仍當作新增', r.text.includes('已記到'), r.text);

sent.length = 0;
run('__clearCache()');
ctx.__ev = { events: [
  { type: 'message', replyToken: 'r1', source: { userId: 'U1' }, message: { type: 'image', id: 'm1', imageSet: { id: 's', index: 1, total: 2 } } },
  { type: 'message', replyToken: 'r2', source: { userId: 'U1' }, message: { type: 'image', id: 'm2', imageSet: { id: 's', index: 2, total: 2 } } },
] };
hook();
const imgReplies = sent.filter((s) => s.url.includes('message/reply'));
check('多張照片只回覆一次', imgReplies.length === 1 && imgReplies[0].body.messages[0].text.includes('2 張照片'), JSON.stringify(imgReplies));

r = say('旅遊日誌確認');
check('查看日誌', r.text.includes('抹茶超好喝') && r.text.includes('📷 照片'), r.text);

r = say('網站');
check('網站連結', r.text.includes('https://liff.line.me/2011768794-Lhly8AIw'), r.text);

r = say('所有旅程');
check('旅程列表', r.msgs[0].type === 'flex', r.text.slice(0, 200));

r = say('京都');
check('旅程名稱 → 整趟行程', r.msgs[0].type === 'flex' && r.text.includes('carousel'), r.text.slice(0, 200));

r = say('asdfgh');
check('找不到時友善提示', r.text.includes('找不到'), r.text);

r = say('今天', 'U2');
check('其他使用者看不到 U1 的資料', r.text.includes('還沒有任何旅程'), r.text);

flags.failFlex = true;
r = say('今天');
check('Flex 失敗時改回純文字', r.msgs[0].type === 'text' && r.text.includes('清水寺'), r.text);
flags.failFlex = false;

/* ---------- Google 地圖 ---------- */
r = say('新增 今天 13:00 八坂神社 @八坂神社 https://maps.app.goo.gl/abc123');
check('新增時貼地圖連結', rows('Activities').some((a) => a.title === '八坂神社' && a.mapUrl === 'https://maps.app.goo.gl/abc123'), r.text);
r = say('八坂神社');
check('查詢顯示地圖與導航連結', r.text.includes('🗺️ 地圖：https://maps.app.goo.gl/abc123') && r.text.includes('🧭 導航：https://www.google.com/maps/dir/?api=1&destination=%E5%85%AB%E5%9D%82%E7%A5%9E%E7%A4%BE'), r.text);
check('查詢的快速回覆有「開始導航」', r.quick[0].action.type === 'uri' && r.quick[0].action.uri.includes('/maps/dir/'), JSON.stringify(r.quick[0]));
r = say('導航 清水寺');
check('導航 清水寺', r.text.includes('destination=%E6%B8%85%E6%B0%B4%E5%AF%BA'), r.text);
r = say('清水寺怎麼去');
check('清水寺怎麼去', r.text.includes('/maps/dir/'), r.text);
r = say('導航 金閣寺');
check('行程外的地點也能導航', r.text.includes('金閣寺') && r.text.includes('destination=%E9%87%91%E9%96%A3%E5%AF%BA'), r.text);
r = say('今天路線');
check('今天路線串起多個地點', r.text.includes('waypoints=') && r.text.includes('1. 11:30 清水寺'), r.text);
r = say('今天');
check('Flex 有導航與當天路線按鈕', r.text.includes('🧭 導航') && r.text.includes('當天路線'), r.text.slice(0, 200));
r = say('改 八坂神社 https://maps.app.goo.gl/xyz');
check('修改地圖連結', rows('Activities').some((a) => a.title === '八坂神社' && a.mapUrl === 'https://maps.app.goo.gl/xyz'), r.text);
check('拒絕非 https 連結', P('cleanUrl_("javascript:alert(1)")') === '' && P('cleanUrl_("http://x.com")') === '');

/* ---------- 時間區間與移動時間 ---------- */
check('區間 09:00-12:00', P('JSON.stringify(extractTimeRange_("09:00-12:00 清水寺"))') === JSON.stringify({ time: '09:00', endTime: '12:00', rest: '清水寺' }));
check('區間 9點到12點半', P('extractTimeRange_("9點到12點半").endTime') === '12:30');
check('區間 下午2點~5點', P('JSON.stringify([extractTimeRange_("下午2點~5點").time, extractTimeRange_("下午2點~5點").endTime])') === '["14:00","17:00"]');
check('單一時間仍可用', P('JSON.stringify(extractTimeRange_("10:00 午餐"))') === JSON.stringify({ time: '10:00', endTime: '', rest: '午餐' }));
check('日期區間不會被當成時間', P('extractTimeRange_("10/28-10/30")') === null);
check('移動15分', P('extractTravel_("清水寺 移動15分").travelMin') === 15);
check('車程 1 小時 20 分', P('extractTravel_("車程 1 小時 20 分").travelMin') === 80);
check('步行約 20 分鐘', P('extractTravel_("步行約 20 分鐘").travelMin') === 20);
check('時間衝突判斷', P('scheduleIssue_({time:"09:00",endTime:"12:00"},{time:"12:00",travelMin:15})') === '預計 12:15 才會到，晚了 15 分鐘'
  && P('scheduleIssue_({time:"09:00",endTime:"12:00"},{time:"12:15",travelMin:15})') === '');

r = say('新增 明天 13:00-15:00 嵐山散步 @嵐山');
check('新增時間區間', r.text.includes('13:00–15:00 🏞️ 嵐山散步'), r.text);
r = say('新增 明天 15:00-16:00 嵐山午茶 移動15分');
check('新增移動時間並警告趕不上', r.text.includes('移動 15 分鐘') && r.text.includes('⚠️ 預計 15:15 才會到'), r.text);
r = say('改 嵐山午茶 15:15');
check('只改開始時間，結束時間跟著平移', r.text.includes('15:15–16:15') && !r.text.includes('⚠️'), r.text);
r = say('改 嵐山午茶 移動30分');
check('修改移動時間後再次警告', r.text.includes('移動 30 分鐘') && r.text.includes('晚了 15 分鐘'), r.text);
r = say('明天');
check('行程卡片顯示區間、移動與警告', r.text.includes('~15:00') && r.text.includes('移動 30 分鐘') && r.text.includes('⚠️'), r.text.slice(0, 400));
check('試算表存了結束與移動時間', rows('Activities').some((a) => a.title === '嵐山午茶' && a.endTime === '16:15' && a.travelMin === '30'));

/* ---------- 移動方式與車資 ---------- */
const T = (code) => JSON.parse(P(`JSON.stringify(${code})`));
let tv = T('extractTravel_("伏見稻荷 電車15分 車資230")');
check('電車15分 車資230', tv.travelMode === 'train' && tv.travelMin === 15 && tv.travelCost === 230 && tv.rest === '伏見稻荷', JSON.stringify(tv));
tv = T('extractTravel_("搭公車 20 分鐘")');
check('搭公車 20 分鐘', tv.travelMode === 'bus' && tv.travelMin === 20, JSON.stringify(tv));
tv = T('extractTravel_("移動 計程車 1小時 交通費 $3000")');
check('移動 計程車 1小時 交通費 $3000', tv.travelMode === 'taxi' && tv.travelMin === 60 && tv.travelCost === 3000, JSON.stringify(tv));
tv = T('extractTravel_("移動15分")');
check('移動15分（未指定方式）', tv.travelMode === '' && tv.travelMin === 15 && tv.travelCost === null, JSON.stringify(tv));
tv = T('extractTravel_("午餐 $500")');
check('行程花費不會被當成車資', tv === null, JSON.stringify(tv));
tv = T('extractTravel_("船岡山公園")');
check('地名含「船」不會被誤判', tv === null, JSON.stringify(tv));
check('導航帶入交通方式', P('navUrl_({location:"清水寺",travelMode:"train"})').endsWith('&travelmode=transit'));

r = say('新增 明天 19:30 先斗町晚餐 電車15分 車資230 $3000');
check('新增含移動方式與車資（沒寫單位當日幣，台幣為主）', r.text.includes('🚃 電車 15 分鐘・NT$47（¥230）') && r.text.includes('💰 NT$3,000') && !r.text.includes('TWD'), r.text);
check('試算表存了移動方式與車資', rows('Activities').some((a) => a.title === '先斗町晚餐' && a.travelMode === 'train' && a.travelCost === '230' && a.cost === '3000'));
r = say('改 先斗町晚餐 搭計程車');
check('只改移動方式保留分鐘數', r.text.includes('🚕 計程車 15 分鐘・NT$47（¥230）'), r.text);
r = say('改 先斗町晚餐 車資500元');
check('只改車資（台幣只顯示台幣）', r.text.includes('🚕 計程車 15 分鐘・NT$500') && !r.text.includes('¥'), r.text);
r = say('明天');
check('行程卡片顯示移動方式與車資', r.text.includes('🚕 計程車 15 分鐘・NT$500'), r.text.slice(0, 300));
r = say('導航 先斗町晚餐');
check('導航使用計程車（開車）路線', r.text.includes('先斗町晚餐') && r.quick[0].action.uri.endsWith('&travelmode=driving'), JSON.stringify(r.quick[0]));
tv = T('extractTravel_("車資230円")');
check('車資230円＝日幣', tv.travelCost === 230 && tv.travelCostCurrency === 'JPY', JSON.stringify(tv));
tv = T('extractTravel_("車資 NT$50")');
check('車資 NT$50＝台幣', tv.travelCost === 50 && tv.travelCostCurrency === 'TWD', JSON.stringify(tv));
tv = T('extractTravel_("車資¥1200")');
check('車資¥1200＝日幣', tv.travelCost === 1200 && tv.travelCostCurrency === 'JPY', JSON.stringify(tv));
check('日幣換算台幣', P('convertAmount_(1000, "JPY", "TWD", {rate: 0.2044})') === 204.4 && P('convertAmount_(100, "USD", "TWD", {rate: 0.2})') === null);
r = say('匯率');
check('LINE 查匯率', r.text.includes('臺灣銀行現金賣出') && r.text.includes('0.2044') && r.text.includes('≈ NT$204'), r.text);
say('改 先斗町晚餐 車資1000円');
r = say('預算');
check('預算把日幣車資換算成台幣並註明匯率', r.text.includes('金額皆換算成台幣：臺灣銀行現金賣出'), r.text);
check('API 匯率不需登入', api('rate', {}, '').rate.rate === 0.2044);
flags.finmindBanned = true;
run('jpyRate_.memo = undefined; fetchReferenceRate_.memo = undefined');
let fx = api('rate', {}, '').rate;
check('FinMind 被封鎖時改用國際參考匯率並記下原因', fx.source === '國際參考匯率' && fx.rate === 0.2019 && fx.note.includes('ip banned'), JSON.stringify(fx));
let calls = flags.finmindCalls;
run('jpyRate_.memo = undefined; fetchReferenceRate_.memo = undefined');
api('rate', {}, '');
check('FinMind 失敗後 6 小時內不再問', flags.finmindCalls === calls && Number(props.FINMIND_FAILED_AT) > 0);
check('網站回報離譜的匯率會被拒絕', api('reportRate', { rate: { rate: 0.5, date: '2026-10-28' } }).accepted === false);
check('網站回報合理的臺銀匯率', api('reportRate', { rate: { rate: 0.2044, date: '2026-10-28' } }).accepted === true);
fx = api('rate', {}, '').rate;
check('之後改用網站回報的臺銀匯率', fx.source === '臺灣銀行現金賣出' && fx.rate === 0.2044, JSON.stringify(fx));
delete props.FINMIND_FAILED_AT;
calls = flags.finmindCalls;
run('jpyRate_.memo = undefined');
check('有網站回報的匯率時不問 FinMind', api('rate', {}, '').rate.rate === 0.2044 && flags.finmindCalls === calls);
check('回報匯率需要登入', api('reportRate', { rate: { rate: 0.2044, date: '2026-10-28' } }, '').status === 401);
flags.finmindBanned = false;
run('jpyRate_.memo = undefined');
r = say('預算');
check('車資算進預算的交通類', r.text.includes('🚆 交通') && /預估花費：NT\$[\d,]+/.test(r.text), r.text);

check('台幣只顯示台幣', P('showMoney_(500, "TWD")') === 'NT$500');
check('外幣顯示台幣為主', P('showMoney_(1000, "JPY")') === 'NT$204（¥1,000）');
check('其他幣別用國際參考匯率換算', P('showMoney_(10, "USD")').startsWith('NT$3'), P('showMoney_(10, "USD")'));

/* ---------- 網站 API ---------- */
let res = api('list', {});
check('API list', res.ok && res.trips.length === 1 && res.journal.length === 4, JSON.stringify(res).slice(0, 300));
const trip = res.trips[0];
check('API 無 token → 401', api('list', {}, '').status === 401);
check('API 錯誤 token → 401', api('list', {}, 'bad').status === 401);

trip.notes = '從網站修改';
res = api('saveTrip', { trip, baseUpdatedAt: trip.updatedAt });
check('API saveTrip', res.ok && res.updatedAt, JSON.stringify(res));
const stale = api('saveTrip', { trip, baseUpdatedAt: trip.updatedAt });
check('API 舊版本 → 409', stale.status === 409, JSON.stringify(stale));
check('API 別人的旅程 → 403', api('saveTrip', { trip, baseUpdatedAt: res.updatedAt }, 'good:U2').status === 403);

res = api('addJournal', { entry: { date: '2026-10-29', text: '網站寫的日誌' } });
check('API addJournal', res.ok && res.entry.id && res.entry.tripId);
check('API deleteJournal', api('deleteJournal', { id: res.entry.id }).ok);
const photo = api('list', {}).journal.find((j) => j.type === 'image');
check('API photo', api('photo', { fileId: photo.fileId }).dataUrl.startsWith('data:image/jpeg;base64,'));
check('API 別人的照片 → 404', api('photo', { fileId: photo.fileId }, 'good:U2').status === 404);

ctx.__req = { parameter: { src: 'line', key: 'wrong' }, postData: { contents: '{"events":[]}' } };
check('Webhook 金鑰錯誤 → forbidden', run('doPost(__req)').s === 'forbidden');

props.ALLOWED_USERS = 'U9';
r = say('今天');
check('ALLOWED_USERS 限制', r.text.includes('私人使用'), r.text);
props.ALLOWED_USERS = '';


/* ---------- 旅伴（共用旅程） ---------- */
check('資料表已自動升級', ['Members', 'Users'].every((n) => H.sheets[n]) && H.sheets.Trips.data[0].includes('inviteCode') && H.sheets.Trips.data[0].includes('shopping') && H.sheets.Trips.data[0].includes('places') && H.sheets.Shopping && props.SCHEMA_VERSION === '9');
check('第一次互動就記下 LINE 名稱', rows('Users').some((u) => u.userId === 'U1' && u.name === 'Name-U1'));
r = say('邀請');
const code = (r.text.match(/加入 ([A-Z0-9]{6})/) || [])[1];
check('邀請產生邀請碼與連結', code && r.text.includes('https://line.me/R/oaMessage/%40839jhulx/?') && r.text.includes('https://line.me/R/ti/p/%40839jhulx'), r.text);
check('邀請有「分享給旅伴」按鈕', r.quick[0].action.uri.startsWith('https://line.me/R/share?text='));
check('再邀請一次邀請碼不變', say('邀請').text.includes(`加入 ${code}`));
r = say(`加入 ${code.toLowerCase()}`, 'U2');
check('旅伴用邀請碼加入（大小寫皆可）', r.text.includes('已加入「京都」') && r.text.includes('Name-U1、Name-U2'), r.text);
check('重複加入不會重複成員', say(`加入 ${code}`, 'U2').text.includes('已經在') && rows('Members').length === 1);
check('錯誤邀請碼', say('加入 ZZZ999', 'U2').text.includes('找不到邀請碼'));
r = say('今天', 'U2');
check('旅伴看得到行程', r.msgs[0].type === 'flex' && r.text.includes('清水寺'), r.text.slice(0, 200));
r = say('新增 今天 15:00 金閣寺 @金閣寺', 'U2');
check('旅伴可以新增行程', r.text.includes('金閣寺'), r.text);
check('主人看得到旅伴新增的行程', say('今天').text.includes('金閣寺'));
check('旅伴新增後主人仍是擁有者', rows('Trips')[0].userId === 'U1');
say('日誌 金閣寺好美', 'U2');
r = say('日誌');
check('共用日誌標註作者', r.text.includes('Name-U2：金閣寺好美') && r.text.includes('抹茶超好喝') && !r.text.includes('Name-U1：'), r.text);
r = say('成員', 'U2');
check('成員名單', r.text.includes('👑 Name-U1') && r.text.includes('Name-U2（你）') && r.quick.some((q) => q.action.label === '退出旅程'), r.text);
r = say('成員');
check('主人的成員名單有移除按鈕', r.quick.some((q) => q.action.label === '移除 Name-U2'));
check('非主人不能移除成員', say('移除成員 Name-U1', 'U2').text.includes('只有旅程主人'));
check('「加入 Costco」仍是新增行程', say('加入 今天 Costco').text.includes('已新增'));

res = api('list', {}, 'good:U2');
const shared = res.trips[0];
check('API：旅伴拿到共用旅程與角色', shared.role === 'editor' && shared.members.length === 2 && shared.members.find((m) => m.me).name === 'Name-U2', JSON.stringify(shared.members));
check('API：不外流其他人的 LINE userId', !JSON.stringify(res).includes('"U1"'));
check('API：旅伴看得到共用日誌與照片', res.journal.some((j) => j.author === 'Name-U1' && !j.mine) && api('photo', { fileId: res.journal.find((j) => j.type === 'image').fileId }, 'good:U2').ok);
res = api('saveTrip', { trip: shared, baseUpdatedAt: shared.updatedAt }, 'good:U2');
check('API：旅伴可以存檔', res.ok, JSON.stringify(res));
check('API：外人不能存檔', api('saveTrip', { trip: shared, baseUpdatedAt: res.updatedAt }, 'good:U3').status === 403);
const ownerView = api('list', {}).trips[0];
const u2key = ownerView.members.find((m) => m.name === 'Name-U2').id;
check('API：旅伴不能刪別人的日誌', api('deleteJournal', { id: api('list', {}, 'good:U2').journal.find((j) => !j.mine).id }, 'good:U2').status === 403);
res = api('invite', { tripId: shared.id }, 'good:U2');
check('API：旅伴也能產生邀請', res.ok && res.code === code && res.text.includes('Name-U2 邀請你'), JSON.stringify(res));

r = say('移除成員 Name-U2');
check('移除成員先確認', r.text.includes('確定要把 Name-U2 移出'), r.text);
r = postback(JSON.parse(r.quick[0].action.data));
check('主人移除成員', r.text.includes('已將 Name-U2 移出') && say('今天', 'U2').text.includes('還沒有任何旅程'), r.text);
check('被移除後舊邀請碼失效', say(`加入 ${code}`, 'U2').text.includes('找不到邀請碼'));
const code2 = api('invite', { tripId: shared.id }).code;
check('重新邀請會換新的邀請碼', /^[A-Z0-9]{6}$/.test(code2) && code2 !== code, code2);
say(`加入 ${code2}`, 'U2');
check('API：旅伴刪除旅程＝退出', api('deleteTrip', { id: shared.id }, 'good:U2').result === 'left' && api('list', {}).trips.length === 1);
check('自己退出不會換邀請碼', say(`加入 ${code2}`, 'U2').text.includes('已加入'));
check('API：主人用成員代號移除', api('removeMember', { tripId: shared.id, member: u2key }).ok && api('list', {}, 'good:U2').trips.length === 0);
r = say('退出旅程');
check('主人不能退出自己的旅程', r.text.includes('你是「京都」的主人'), r.text);

const evilId = '"><img src=x onerror=alert(1)>';
const mine = api('list', {}).trips[0];
check('API：旅程 id 含特殊字元會被拒絕', api('saveTrip', { trip: { ...mine, id: evilId } }).status === 400);
mine.days[mine.startDate] = [{ id: evilId, title: '測試' }];
mine.packing = [{ id: evilId, text: '測試', done: false }];
res = api('saveTrip', { trip: mine, baseUpdatedAt: mine.updatedAt });
check('API：行程與行李的 id 含特殊字元會換成新的', res.ok && !JSON.stringify(api('list', {}).trips[0]).includes('onerror'), JSON.stringify(res));
res = api('addJournal', { entry: { id: evilId, date: mine.startDate, text: '測試' } });
check('API：日誌 id 含特殊字元會換成新的', res.ok && /^[\w-]+$/.test(res.entry.id), JSON.stringify(res));

/* ---------- 購物清單 ---------- */
const shopTrip = () => api('list', {}).trips[0];
r = say('購物清單');
check('購物清單是空的時有教學', r.text.includes('還是空的') && r.text.includes('買 明天'), r.text);
say('新增 明天 14:00 錦市場');
r = say('買 明天 抹茶粉、八橋');
check('買：記在指定的那一天', r.text.includes('已加入') && r.text.includes('10/30') && shopTrip().shopping.length === 2 && shopTrip().shopping.every((s) => s.date === '2026-10-30' && !s.done), r.text);
r = say('買 面膜 @錦市場');
const nishiki = shopTrip().days['2026-10-30'].find((a) => a.title === '錦市場');
check('買 @行程：記在那個行程', r.text.includes('錦市場') && shopTrip().shopping.find((s) => s.text === '面膜').activityId === nishiki.id, r.text);
r = say('買 牙刷');
check('沒寫日期就不指定', r.text.includes('不指定') && shopTrip().shopping.find((s) => s.text === '牙刷').date === '', r.text);
r = say('明天');
check('看某一天的行程會列出要買的東西', r.text.includes('🛒 要買：抹茶粉、八橋、面膜') && !r.text.includes('牙刷'), r.text);
flags.failFlex = true;
check('純文字版也會列出要買的東西', say('明天').text.includes('🛒 要買：抹茶粉、八橋、面膜'));
flags.failFlex = false;
r = say('買到 抹茶粉');
check('買到：打勾並回報剩下幾樣', r.text.includes('買到了：抹茶粉') && r.text.includes('還有 3 樣') && shopTrip().shopping.find((s) => s.text === '抹茶粉').done, r.text);
check('買到的不再出現在當天行程', !say('明天').text.includes('抹茶粉'));
r = say('不買 八橋');
check('不買：從清單拿掉', r.text.includes('拿掉：八橋') && !shopTrip().shopping.some((s) => s.text === '八橋'), r.text);
r = say('改 錦市場 到 今天');
r = say('明天要買什麼');
check('行程改到別天，東西跟著走', !r.text.includes('面膜') && say('今天要買什麼').text.includes('☐ 面膜（錦市場）'), r.text);
r = say('購物清單');
check('購物清單依天分組', r.text.includes('已買 1 / 3') && r.text.includes('【Day 2・10/29') && r.text.includes('【不指定日期】') && r.text.includes('☑ 抹茶粉'), r.text);
check('買到找不到的東西', say('買到 火箭').text.includes('找不到'));
check('「買伴手禮幾點」仍是查詢', !say('買伴手禮幾點').text.includes('已加入'));
let st = shopTrip();
st.shopping.push({ id: evilIdShop(), text: '壞東西', date: '2099-01-01', activityId: 'nope', done: 1 }, { id: 'ok-1', text: '  ', date: '', activityId: '' });
res = api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });
st = shopTrip();
const bad = st.shopping.find((s) => s.text === '壞東西');
check('API：購物清單會清理不合法的資料', res.ok && st.shopping.length === 4 && bad.date === '' && bad.activityId === '' && bad.done === true && /^[\w-]+$/.test(bad.id), JSON.stringify(st.shopping));
function evilIdShop() { return '"><img src=x onerror=alert(1)>'; }
say('刪除 錦市場'); postback({ a: 'del', id: nishiki.id });
check('行程被刪掉後，東西留在原本那一天', shopDateOf('面膜') === '2026-10-29', shopDateOf('面膜'));
function shopDateOf(text) { ctx.__t = shopTrip(); ctx.__s = ctx.__t.shopping.find((s) => s.text === text); return run('shopDate_(__t, __s)'); }

/* ---------- 購物清單金額，計入預算 ---------- */
check('購物項目解析金額', T('splitShopItems_("抹茶粉 1,000円、八橋 $300，面膜 250、牙刷")').map((x) => `${x.text}:${x.cost}:${x.currency}`).join('|') === '抹茶粉:1000:JPY|八橋:300:|面膜:250:|牙刷:null:');
const budgetOf = () => Number((say('預算').text.match(/預估花費：NT\$([\d,]+)/) || [])[1].replace(/,/g, ''));
const shopCat = () => Number(((say('預算').text.match(/購物 NT\$([\d,]+)/) || [])[1] || '0').replace(/,/g, ''));
const near = (a, b) => Math.abs(a - b) <= 1; // 畫面上的金額四捨五入到整數
const before = budgetOf();
const shopBefore = shopCat();
r = say('買 今天 茶碗 1,000円、和菓子 300');
check('買：金額寫日幣會換算、沒寫幣別用旅程幣別', r.text.includes('☐ 茶碗 NT$204（由 ¥1,000 換算）') && r.text.includes('☐ 和菓子 NT$300') && r.text.includes('已計入預算')
  && shopTrip().shopping.find((s) => s.text === '茶碗').price === 204.4 && shopTrip().shopping.find((s) => s.text === '和菓子').price === 300, r.text);
check('購物金額計入預算與購物分類', near(budgetOf() - before, 504.4) && near(shopCat() - shopBefore, 504.4), `${before} → ${budgetOf()}，購物 ${shopBefore} → ${shopCat()}`);
r = say('購物清單');
check('購物清單顯示金額與合計', r.text.includes('☐ 茶碗 NT$204') && r.text.includes('預估 NT$504（已計入預算），其中已買 NT$0'), r.text);
r = say('買到 茶碗 900円');
check('買到時可以順便改成實際金額', r.text.includes('買到了：茶碗 NT$184（由 ¥900 換算）') && shopTrip().shopping.find((s) => s.text === '茶碗').price === 183.96 && near(budgetOf() - before, 483.96), r.text);
check('不買之後預算扣回來', say('不買 和菓子').text.includes('拿掉：和菓子') && near(budgetOf() - before, 183.96));
st = shopTrip();
st.shopping.find((s) => s.text === '茶碗').price = -5;
api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });
check('API：購物金額不合法會歸零', shopTrip().shopping.find((s) => s.text === '茶碗').price === 0);

/* ---------- 購物清單依 LINE 帳號分開 ---------- */
const kyoto = shopTrip();
const mineBefore = JSON.stringify(kyoto.shopping);
say(`加入 ${api('invite', { tripId: kyoto.id }).code}`, 'U2');
const tripOf = (user) => api('list', {}, `good:${user}`).trips.find((t) => t.id === kyoto.id);
check('旅伴看不到別人的購物清單', kyoto.shopping.length > 0 && tripOf('U2').shopping.length === 0 && say('購物清單', 'U2').text.includes('還是空的'));
r = say('買 今天 U2的東西 100', 'U2');
check('旅伴加的東西只在自己那份', r.text.includes('已加入') && tripOf('U2').shopping.map((s) => s.text).join() === 'U2的東西' && JSON.stringify(tripOf('U1').shopping) === mineBefore, r.text);
check('查當天行程只列出自己要買的', say('今天', 'U2').text.includes('🛒 要買：U2的東西') && !say('今天').text.includes('U2的東西'));
const u2budget = Number(say('預算', 'U2').text.match(/購物 NT\$([\d,]+)/)[1].replace(/,/g, ''));
check('預算的購物金額只算自己的', u2budget === 100 && shopCat() === 0, `U2 ${u2budget}／U1 ${shopCat()}`);
let u2trip = tripOf('U2');
u2trip.shopping.push({ id: 'u2-web', text: '網站加的', date: '', activityId: '', price: 50 });
res = api('saveTrip', { trip: u2trip, baseUpdatedAt: u2trip.updatedAt }, 'good:U2');
check('旅伴在網站存檔不會動到別人的購物清單', res.ok && tripOf('U2').shopping.length === 2 && JSON.stringify(tripOf('U1').shopping) === mineBefore);
check('買到別人的東西會找不到', say('買到 U2的東西').text.includes('找不到') && !tripOf('U2').shopping[0].done);
check('試算表每一列都記了是誰的', rows('Shopping').filter((s) => s.tripId === kyoto.id).every((s) => ['U1', 'U2'].includes(s.userId)) && rows('Shopping').filter((s) => s.userId === 'U2').length === 2);
// 舊版資料（存在 Trips.shopping）升級後歸給旅程主人
const col = H.sheets.Trips.data[0].indexOf('shopping');
const tripRowNo = H.sheets.Trips.data.findIndex((row) => row[0] === kyoto.id);
H.sheets.Trips.data[tripRowNo][col] = JSON.stringify([{ id: 'old-1', text: '舊版的東西', date: '2026-10-29', activityId: '', price: 70, done: true }]);
props.SCHEMA_VERSION = '6';
check('舊版購物清單升級後歸給旅程主人', tripOf('U1').shopping.some((s) => s.id === 'old-1' && s.text === '舊版的東西' && s.price === 70 && s.done) && !tripOf('U2').shopping.some((s) => s.id === 'old-1')
  && H.sheets.Trips.data[tripRowNo][col] === '' && props.SCHEMA_VERSION === '9');
props.SCHEMA_VERSION = '6';
H.sheets.Trips.data[tripRowNo][col] = JSON.stringify([{ id: 'old-1', text: '舊版的東西' }]);
check('重複升級不會產生重複的項目', tripOf('U1').shopping.filter((s) => s.id === 'old-1').length === 1);
say('不買 舊版的東西');
api('deleteTrip', { id: kyoto.id }, 'good:U2');
check('退出旅程後主人的購物清單不受影響', JSON.stringify(tripOf('U1').shopping) === mineBefore);

/* ---------- 購物清單的照片與備註 ---------- */
const png = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
check('上傳照片需要登入', api('uploadShopImage', { dataUrl: png }, '').status === 401);
check('不是圖片或太大的不能上傳', api('uploadShopImage', { dataUrl: 'data:text/html;base64,PGI+' }).status === 400 && api('uploadShopImage', { dataUrl: `data:image/jpeg;base64,${'A'.repeat(2900000)}` }).status === 400);
res = api('uploadShopImage', { dataUrl: png });
const shopFile = res.fileId;
check('上傳照片：存進購物照片資料夾並回傳檔案 id', res.ok && files.some((f) => f.id === shopFile && f.folderId === 'folder-旅程手帖購物清單照片' && f.sharing === null), JSON.stringify(res));
say('買 今天 眉筆 1200');
st = shopTrip();
Object.assign(st.shopping.find((s) => s.text === '眉筆'), { note: '  深咖 ×2，記得比價  ', fileId: shopFile });
res = api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });
let brow = shopTrip().shopping.find((s) => s.text === '眉筆');
check('存檔：備註與照片跟著購物項目', res.ok && brow.note === '深咖 ×2，記得比價' && brow.fileId === shopFile, JSON.stringify(brow));
check('讀照片：只拿得到自己的', api('shopPhotos', { fileIds: [shopFile, 'not-mine-000000'] }).photos[shopFile].startsWith('data:image/jpeg;base64,') && Object.keys(api('shopPhotos', { fileIds: [shopFile] }, 'good:U3').photos).length === 0);
r = say('購物清單');
check('LINE 的購物清單顯示備註與照片記號', r.text.includes('眉筆 📷 NT$1,200') && r.text.includes('📝 深咖 ×2，記得比價'), r.text);
r = say('買到 眉筆');
check('LINE 操作後備註與照片還在', shopTrip().shopping.find((s) => s.text === '眉筆').fileId === shopFile && shopTrip().shopping.find((s) => s.text === '眉筆').note === '深咖 ×2，記得比價');
// 別人拿我的檔案 id 來用：存不進去，也讀不到
const u3trip = mkTripForPhoto();
function mkTripForPhoto() { return { id: 'u3-photo', name: 'U3 的', startDate: '2026-12-01', endDate: '2026-12-02', days: {}, packing: [], shopping: [{ id: 'x1', text: '偷照片', fileId: shopFile, note: 'n' }] }; }
api('saveTrip', { trip: u3trip }, 'good:U3');
const u3item = api('list', {}, 'good:U3').trips.find((t) => t.id === 'u3-photo').shopping[0];
check('不能把別人的照片掛到自己的清單', u3item.fileId === '' && u3item.note === 'n' && Object.keys(api('shopPhotos', { fileIds: [shopFile] }, 'good:U3').photos).length === 0, JSON.stringify(u3item));
api('deleteTrip', { id: 'u3-photo' }, 'good:U3');
check('別人刪旅程不會動到我的照片', files.find((f) => f.id === shopFile).trashed === false);
// 換照片、刪項目：舊照片丟到垃圾桶
const shopFile2 = api('uploadShopImage', { dataUrl: png }).fileId;
st = shopTrip();
st.shopping.find((s) => s.text === '眉筆').fileId = shopFile2;
api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });
check('換照片：舊的丟到垃圾桶', files.find((f) => f.id === shopFile).trashed === true && files.find((f) => f.id === shopFile2).trashed === false && shopTrip().shopping.find((s) => s.text === '眉筆').fileId === shopFile2);
say('不買 眉筆');
check('刪掉項目：照片也丟到垃圾桶', files.find((f) => f.id === shopFile2).trashed === true);

/* ---------- 雲端硬碟的資料夾被搬動、丟掉或刪除 ---------- */
const lastFolder = () => files[files.length - 1].folderId;
api('uploadShopImage', { dataUrl: png });
check('資料夾還在（改名或搬位置不影響 id）：繼續存到同一個', lastFolder() === 'folder-旅程手帖購物清單照片' && props.SHOP_FOLDER_ID === 'folder-旅程手帖購物清單照片');
flags.trashedFolders = ['folder-旅程手帖購物清單照片'];
res = api('uploadShopImage', { dataUrl: png });
check('資料夾被丟到垃圾桶：自動建新的，上傳照常成功', res.ok && lastFolder() === 'folder-旅程手帖購物清單照片-2' && props.SHOP_FOLDER_ID === 'folder-旅程手帖購物清單照片-2', `${JSON.stringify(res)} ${lastFolder()}`);
flags.missingFolders = ['folder-旅程手帖購物清單照片-2', 'folder1', 'old-export-folder'];
props.EXPORT_FOLDER_ID = 'old-export-folder';
res = api('uploadShopImage', { dataUrl: png });
check('資料夾被永久刪除：自動建新的，上傳照常成功', res.ok && lastFolder() === 'folder-旅程手帖購物清單照片-3', `${JSON.stringify(res)} ${lastFolder()}`);
sent.length = 0;
ctx.__ev = { events: [{ type: 'message', replyToken: 'r', source: { userId: 'U1' }, message: { type: 'image', id: 'm-folder' } }] };
run('__clearCache()'); hook();
check('日誌照片的資料夾被刪除：自動建新的，照片照常記錄', lastReply().text.includes('已把 1 張照片') && lastFolder() === 'folder-旅程手帖日誌照片' && props.PHOTO_FOLDER_ID === 'folder-旅程手帖日誌照片', `${lastReply().text} ${lastFolder()}`);
r = say('匯出');
check('匯出的資料夾被刪除：自動建新的，照常匯出', r.text.includes('已匯出') && lastFolder() === 'folder-旅程手帖匯出' && props.EXPORT_FOLDER_ID === 'folder-旅程手帖匯出', `${r.text.slice(0, 60)} ${lastFolder()}`);
flags.trashedFolders = []; flags.missingFolders = [];
api('deleteJournal', { id: api('list', {}).journal.filter((j) => j.type === 'image').pop().id });

/* ---------- 待去清單 ---------- */
r = say('待去清單');
check('待去清單是空的時有教學', r.text.includes('還是空的') && r.text.includes('想去 '), r.text);
r = say('想去 淺草寺、晴空塔，上野動物園');
check('想去：一次加好幾個', r.text.includes('已加入') && shopTrip().places.map((p) => p.name).join() === '淺草寺,晴空塔,上野動物園' && shopTrip().places.every((p) => p.geo === '' && p.lat === ''), r.text);
r = say('想去 淺草寺、築地市場');
check('想去：重複的不會再加', r.text.includes('已經有的：淺草寺') && shopTrip().places.length === 4, r.text);
check('「想去哪」仍是查詢', !say('明天想去哪').text.includes('已加入'));
check('旅伴看得到同一份待去清單', tripOf('U1').places.length === 4 && say('待去清單').text.includes('・ 築地市場'));
// 網站整理後存回定位結果，並把其中一個排進行程
st = shopTrip();
const day2 = st.days['2026-10-29'];
Object.assign(st.places[0], { geo: 'ok', lat: 35.7134031, lng: 139.7955261, area: '臺東區', geoName: '淺草寺', activityId: day2[0].id });
Object.assign(st.places[2], { geo: 'ok', lat: 35.7163, lng: 139.7714, area: '臺東區', geoName: '上野動物園' });
Object.assign(st.places[1], { geo: 'none', address: '  東京都墨田區押上1-1-2  ', mapUrl: 'javascript:alert(1)' });
Object.assign(st.places[2], { mapUrl: 'https://maps.app.goo.gl/abc123' });
Object.assign(st.places[3], { geo: 'ok', lat: 999, lng: 139, area: '壞資料', activityId: 'nope' });
res = api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });
st = shopTrip();
check('API：待去清單存回定位結果並清理不合法的資料', res.ok && st.places[0].geo === 'ok' && st.places[0].lat === 35.713403 && st.places[0].activityId === day2[0].id
  && st.places[1].geo === 'none' && st.places[1].address === '東京都墨田區押上1-1-2' && st.places[1].mapUrl === '' && st.places[2].mapUrl === 'https://maps.app.goo.gl/abc123' && st.places[3].geo === '' && st.places[3].lat === '' && st.places[3].area === '' && st.places[3].activityId === '', JSON.stringify(st.places));
r = say('待去清單');
check('待去清單：依區域分組並標示已排入', r.text.includes('【臺東區】') && r.text.includes('✅ 淺草寺（已排入 Day 2）') && r.text.includes('・ 上野動物園') && r.text.includes('【還沒整理】') && r.text.includes('4 個，已排入行程 1 個'), r.text);
r = say('不去 晴空塔、火星');
check('不去：拿掉並回報找不到的', r.text.includes('拿掉：晴空塔') && r.text.includes('找不到：火星') && shopTrip().places.length === 3, r.text);
st = shopTrip();
st.places = [];
api('saveTrip', { trip: st, baseUpdatedAt: st.updatedAt });

/* ---------- 匯出 PDF ---------- */
say('買 今天 匯出測試用 120');
say('新增 今天 20:00 <b>壞標題</b> @居酒屋 $800');
const pdfs = () => files.filter((f) => f.blob && f.blob.type === 'application/pdf');
r = say('匯出');
let pdf = pdfs().pop();
check('匯出：回覆 PDF 連結、網站連結與純文字行程', r.msgs.length === 2 && r.msgs[0].text.includes(pdf.getUrl()) && r.msgs[0].text.includes('https://liff.line.me/') && r.msgs[1].text.includes('【Day 1')
  && r.quick.some((q) => q.action.type === 'uri' && q.action.uri === pdf.getUrl()), r.text.slice(0, 300));
check('匯出：PDF 設成知道連結的人可檢視，放在匯出資料夾', pdf.sharing === 'ANYONE_WITH_LINK/VIEW' && pdf.folderId === 'folder-旅程手帖匯出' && /^京都_.*\.pdf$/.test(pdf.blob.name), `${pdf.sharing} ${pdf.folderId} ${pdf.blob.name}`);
const html = pdf.blob.content;
check('匯出：內容有每日行程、預算、購物清單、行李', ['<h1>京都</h1>', 'Day 1・', 'Day 2・', '預估花費', '我的購物清單', '匯出測試用', 'NT$120'].every((x) => html.includes(x)), html.slice(0, 400));
check('匯出：內容會跳脫 HTML', html.includes('&lt;b&gt;壞標題&lt;/b&gt;') && !html.includes('<b>壞標題</b>'));
say('買 今天 U2私人的東西', 'U2joiner');
r = say('匯出 京都');
const pdf2 = pdfs().pop();
check('再匯出一次：舊檔丟到垃圾桶、給新連結', pdf2 !== pdf && pdf.trashed === true && pdf2.trashed === false && r.msgs[0].text.includes(pdf2.getUrl()));
check('預設快速按鈕有「匯出」', say('今天').quick.some((q) => q.action.text === '匯出'));
r = say('所有旅程');
const exportBtn = JSON.stringify(r.msgs).match(/\{\\"a\\":\\"export\\",\\"id\\":\\"([\w-]+)\\"\}/);
check('旅程卡片有「匯出 PDF」按鈕，按了會匯出', exportBtn && postback({ a: 'export', id: exportBtn[1] }).text.includes('已匯出'), JSON.stringify(r.msgs).slice(0, 300));
// 產生 PDF 這種慢的事要在放掉鎖之後才做，不能卡住其他人的存檔
lockLog.length = 0;
say('匯出');
check('匯出：PDF 在鎖外面產生', lockLog.includes('pdf') && lockLog.lastIndexOf('unlock') < lockLog.indexOf('pdf'), lockLog.join(','));
flags.lockBusy = true;
res = api('list', {});
r = say('今天');
flags.lockBusy = false;
check('拿不到鎖時回 503，機器人也會回覆請稍後再試', res.status === 503 && res.error.includes('稍後再試') && r.text.includes('稍後再試'), `${JSON.stringify(res)} ${r.text}`);
flags.failPdf = true;
r = say('匯出');
flags.failPdf = false;
check('PDF 產生失敗時仍給網站連結與純文字行程', r.msgs[0].text.includes('PDF 產生失敗') && r.msgs[0].text.includes('https://liff.line.me/') && r.msgs[1].text.includes('【Day 1'), r.text.slice(0, 200));
check('別人的旅程不能匯出', postback({ a: 'export', id: exportBtn[1] }, 'U9').text.includes('已經不存在'));
say('刪除 壞標題'); postback({ a: 'del', id: shopTrip().days['2026-10-29'].find((a) => a.title.includes('壞標題')).id });
say('不買 匯出測試用');

/* ---------- 花費幣別、過長的修改內容 ---------- */
r = say('新增 今天 15:00 龍安寺 400円');
check('台幣旅程輸入日幣花費會換算', r.text.includes('NT$82') && r.text.includes('由 ¥400 換算') && api('list', {}).trips[0].days['2026-10-29'].find((a) => a.title === '龍安寺').cost === 81.76, r.text);
r = say('新增 今天 16:00 銀閣寺 $500');
check('只寫 $ 維持旅程幣別', r.text.includes('NT$500') && !r.text.includes('換算'), r.text);
r = say('改 龍安寺 1000日幣');
check('修改花費也會換算', r.text.includes('NT$204') && r.text.includes('由 ¥1,000 換算'), r.text);
say('新增 今天 17:00 抹茶店A');
say('新增 今天 18:00 抹茶店B');
const longUrl = `https://www.google.com/maps/place/${'x'.repeat(300)}`;
r = say(`改 抹茶店 ${longUrl}`);
check('多筆結果＋長網址：按鈕資料不超過 300 字', r.quick.length >= 2 && r.quick.filter((q) => q.action.type === 'postback').every((q) => q.action.data.length <= 300 && JSON.parse(q.action.data).k), JSON.stringify(r.quick));
r = postback(JSON.parse(r.quick[0].action.data));
check('按下按鈕後套用長網址', r.text.includes('已更新') && api('list', {}).trips[0].days['2026-10-29'].some((a) => a.mapUrl === longUrl), r.text);
cache.clear();
r = postback({ a: 'edit', id: 'whatever', k: 'gone' });
check('暫存過期時會提示重新輸入', r.text.includes('已經過期'), r.text);

check('API deleteTrip', api('deleteTrip', { id: trip.id }).ok && api('list', {}).trips.length === 0);

/* ---------- 只寫入有變動的列 ---------- */
const mkTrip = (id, name, start, n) => ({
  id, name, startDate: start, endDate: start,
  days: { [start]: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, time: `${String(8 + (i % 12)).padStart(2, '0')}:00`, title: `${name}${i}` })) },
  packing: [],
});
const titles = (t) => Object.values(t.days).flat().map((a) => a.title).sort().join(',');
const fresh = (user = 'U1') => api('list', {}, `good:${user}`).trips;
const save = (t, user = 'U1') => api('saveTrip', { trip: t, baseUpdatedAt: t.updatedAt || '' }, `good:${user}`);
const actWrites = () => writes.filter((w) => w.sheet === 'Activities');

check('超過工作表列數也能存（大旅程 150 筆）', save(mkTrip('big', '大', '2026-11-01', 150)).ok && save(mkTrip('small', '小', '2026-11-10', 5)).ok);
save(mkTrip('other', '別人', '2026-11-20', 4), 'U3');
let [big, small] = fresh();
const otherBefore = JSON.stringify(sheets.Activities.data.filter((r) => r[1] === 'other'));
check('重新讀取內容正確', titles(big) === titles(mkTrip('big', '大', '2026-11-01', 150)) && small.days['2026-11-10'].length === 5);

writes.length = 0;
small.days['2026-11-10'][2].title = '改過了';
res = save(small);
check('改一筆行程只寫入一列', res.ok && actWrites().length === 1 && actWrites()[0].count === 1 && writes.filter((w) => w.sheet === 'Trips').every((w) => w.count === 1), JSON.stringify(writes));
small = fresh()[1];
check('改過的內容有存進去', small.days['2026-11-10'].some((a) => a.title === '改過了'));

writes.length = 0;
small.packing = [{ id: 'p1', text: '護照', done: true }];
res = save(small);
check('只改行李清單不會動到行程表', res.ok && actWrites().length === 0, JSON.stringify(writes));

writes.length = 0;
small = fresh()[1];
small.days['2026-11-10'].pop();
small.days['2026-11-10'].push({ id: 'small-new', time: '23:00', title: '新增的' });
small.days['2026-11-10'].push({ id: 'small-new2', time: '23:30', title: '再一個' });
res = save(small);
check('新增行程接在最後，不重寫整張表', res.ok && actWrites().reduce((s, w) => s + w.count, 0) <= 2, JSON.stringify(writes));
small = fresh()[1];
check('新增後內容正確', small.days['2026-11-10'].length === 6 && titles(small).includes('新增的') && titles(small).includes('再一個'));

small.days['2026-11-10'] = small.days['2026-11-10'].slice(0, 2);
res = save(small);
[big, small] = fresh();
check('刪除行程後內容正確，其他旅程不受影響', res.ok && small.days['2026-11-10'].length === 2 && big.days['2026-11-01'].length === 150);

// 存檔寫到一半失敗：其他旅程的資料都還在，重新存檔可以補回來
small.days['2026-11-10'] = mkTrip('small', '重來', '2026-11-10', 8).days['2026-11-10'];
flags.failWriteIn = 2;
res = save(small);
flags.failWriteIn = 0;
check('模擬寫入失敗會回報錯誤', res.status === 500, JSON.stringify(res));
check('失敗後其他旅程完整無缺', fresh()[0].days['2026-11-01'].length === 150 && JSON.stringify(sheets.Activities.data.filter((r) => r[1] === 'other')) === otherBefore);
check('失敗後版本號沒變，重新存檔成功', save(small).ok && titles(fresh()[1]) === titles(mkTrip('small', '重來', '2026-11-10', 8)));

// 整表重寫（整理空列）中途失敗也不會變成空表
ctx.__keep = run('__clearCache(), readTable_("Activities")').slice(0, 100);
flags.failWriteIn = 2;
let threw = false;
try { run('writeTable_("Activities", __keep)'); } catch (err) { threw = true; }
flags.failWriteIn = 0;
check('整表重寫失敗時資料還在', threw && rows('Activities').length >= 100);
save(mkTrip('big', '大', '2026-11-01', 150));
save(fresh()[1]);

// 刪掉大旅程後留下的空列會被整理掉
const beforeRows = sheets.Activities.data.length;
check('刪除旅程', api('deleteTrip', { id: 'big' }).ok && fresh().length === 1);
check('空列太多時自動整理', sheets.Activities.data.length < beforeRows - 100 && sheets.Activities.data.slice(1).every((r) => r[0]), `${beforeRows} → ${sheets.Activities.data.length}`);
check('整理後內容正確', titles(fresh()[0]) === titles(mkTrip('small', '重來', '2026-11-10', 8)) && JSON.stringify(sheets.Activities.data.filter((r) => r[1] === 'other')) === otherBefore);
check('別人的旅程仍然讀得到', fresh('U3')[0].days['2026-11-20'].length === 4);

/* ---------- 投資日報（跟投資分析專案共用官方帳號） ---------- */
const pushes = () => sent.filter((s) => s.url.includes('message/push'));
function investPost(key, body) {
  sent.length = 0;
  ctx.__req = { parameter: { src: 'invest', key }, postData: { contents: JSON.stringify(body) } };
  return run('doPost(__req)').s;
}
function investSheet(name, rowsData) {
  ctx.__n = name;
  const sh = run('SpreadsheetApp.openById("x").getSheetByName(__n) || SpreadsheetApp.openById("x").insertSheet(__n)');
  sh.getRange(1, 1, 1, 1).setValues([['header']]);
  if (rowsData.length) sh.getRange(2, 1, rowsData.length, rowsData[0].length).setValues(rowsData);
}

check('投資：沒設定金鑰時推播一律拒絕', investPost('', { text: 'x' }) === 'forbidden' && investPost('anything', { text: 'x' }) === 'forbidden');
Object.assign(props, { INVEST_PUSH_KEY: 'pk', INVEST_BIND_CODE: 'Code1234', INVEST_SHEET_ID: 'inv', INVEST_USERS: '' });
check('投資：金鑰錯誤拒絕', investPost('wrong', { text: 'x' }) === 'forbidden' && pushes().length === 0);
check('投資：還沒人綁定時不推', JSON.parse(investPost('pk', { text: '日報' })).ok === false && pushes().length === 0);
check('投資：沒綁定的人傳「選股」照舊走旅程手帖', !say('選股').text.includes('📊'));
check('投資：我的ID 回覆自己的 userId', say('我的ID', 'U9').text.includes('U9'));
check('投資：代碼錯誤不能綁定', say('綁定投資 Wrong999').text.includes('不正確') && props.INVEST_USERS === '');
check('投資：代碼正確綁定成功', say('綁定投資 Code1234').text.includes('已綁定') && props.INVEST_USERS === 'U1' && props.INVEST_BIND_CODE === '');
check('投資：代碼用過就失效', say('綁定投資 Code1234', 'U2').text.includes('已經用過') && props.INVEST_USERS === 'U1');

const pushed = JSON.parse(investPost('pk', { text: '🧪 模擬交易 日報' }));
check('投資：推播只送給綁定的人', pushed.ok && pushed.sent === 1 && pushes().length === 1 && pushes()[0].body.to === 'U1' && pushes()[0].body.messages[0].text === '🧪 模擬交易 日報');
check('投資：空內容不推', JSON.parse(investPost('pk', { text: '  ' })).ok === false && pushes().length === 0);

check('投資：還沒有資料時的回覆', say('報酬率').text.includes('還沒有資料') && say('持股').text.includes('還沒有資料') && say('交易紀錄').text.includes('還沒有任何委託') && say('準確率').text.includes('還沒有資料') && say('選股').text.includes('還沒有資料') && say('投資').msgs[0].type === 'flex');
investSheet('daily_recommendations', [
  ['2026-10-01', '1', '2330', '台積電', '70', '強烈進場訊號', '2400'],
  ['2026-10-02', '2', '0050', '元大台灣50', '55.5', '可觀察', '180.5'],
  ['2026-10-02', '1', '2308', '台達電', '80', '強烈進場訊號', '1885'],
]);
investSheet('market_trend_snapshot', [['2026-10-02', '15', '5', '56.92', '中性']]);
const stockText = say('選股').text;
check('投資：選股只列最新一天並依名次排序', stockText.includes('📊 選股 2026-10-02') && stockText.indexOf('2308 台達電') < stockText.indexOf('0050 元大台灣50') && !stockText.includes('台積電'), stockText);
check('投資：選股帶氛圍', stockText.includes('中性（5/15'));
investSheet('daily_crypto_recommendations', [['2026-10-04', '1', 'TRX', '波場幣', '53.4', '可觀察', '10.8599']]);
check('投資：虛擬貨幣', say('虛擬貨幣').text.includes('TRX 波場幣') && say('幣').text.includes('10.8599'));
investSheet('sim_equity', [
  ['2026-10-04', '1000000', '0', '1000000', '0', '0', '0', '0', '0'],
  ['2026-10-05', '204518.05', '808070', '1012588.05', '1.259', '1.259', '2', '-17074', '12588.05'],
]);
investSheet('sim_positions', [
  ['1', '股票', '2330', '台積電', '2026-10-02', '79.4', '2026-10-05', '2550', '78', '199183.43', '2346', '2805', 'open', '', '', '', '', '', ''],
  ['2', '股票', '2317', '鴻海', '2026-09-01', '70', '2026-09-02', '250', '800', '200285', '230', '275', 'closed', '2026-09-10', '230', '停損', '183211', '-17074', '-8.52'],
  ['3', '虛擬貨幣', 'BTC', '比特幣', '2026-10-04', '70', '2026-10-05', '3000000', '0.06656', '199979.52', '2760000', '3300000', 'open', '', '', '', '', '', ''],
]);
investSheet('sim_orders', [
  ['1', 't', '股票', '2317', '鴻海', 'buy', 'filled', '2026-09-01', '70', '2026-09-02', '250', '800', '200000', '285', 'BUY 訊號', '2'],
  ['2', 't', '股票', '2317', '鴻海', 'sell', 'filled', '2026-09-01', '70', '2026-09-10', '230', '800', '184000', '789', '停損', '2'],
  ['3', 't', '股票', '2330', '台積電', 'buy', 'filled', '2026-10-02', '79.4', '2026-10-05', '2550', '78', '198900', '283.43', 'BUY 訊號', '1'],
  ['4', 't', '股票', '2454', '聯發科', 'buy', 'pending', '2026-10-05', '66.2', '', '', '', '', '', 'BUY 訊號', ''],
  ['5', 't', '股票', '2603', '長榮', 'buy', 'cancelled', '2026-10-02', '60', '2026-10-05', '200', '', '', '', '現金不足，取消', ''],
]);
investSheet('sim_holdings', [
  ['latest', '2026-10-05', '虛擬貨幣', 'BTC', '比特幣', '2026-10-05', '3000000', '0.06656', '199979.52', '2950000', '196352', '-3922.05', '-1.96', '2760000', '3300000', '1'],
  ['latest', '2026-10-05', '股票', '2330', '台積電', '2026-10-05', '2550', '78', '199183.43', '2600', '202800', '2714.17', '1.36', '2346', '2805', '1'],
]);
investSheet('sim_accuracy', [
  ['latest', '2026-10-05', '訊號數', '', '58', '', ''],
  ['latest', '2026-10-05', 'BUY', 't5', '12', '66.7', '1.85'],
  ['latest', '2026-10-05', 'BUY', 't20', '0', '', ''],
  ['latest', '2026-10-05', 'SKIP', 't5', '20', '40', '-0.5'],
  ['latest', '2026-10-05', '方向', 't5', '32', '62.5', ''],
]);

const investMenu = say('投資');
const inv_menuButtons = JSON.stringify(investMenu.msgs[0].contents);
check('投資：選單是 Flex 卡片，六個按鈕都在', investMenu.msgs[0].type === 'flex' && ['持股', '交易紀錄', '報酬率', '準確率', '選股', '虛擬貨幣'].every((t) => inv_menuButtons.includes(`"text":"${t}"`)), inv_menuButtons);
check('投資：選單帶目前權益與報酬率', investMenu.text.includes('總權益 1,012,588') && investMenu.text.includes('累計 +1.26%'));
check('投資：每則回覆下方都有投資按鈕', ['持股', '交易紀錄', '報酬率', '準確率', '選股', '虛擬貨幣', '投資'].every((t) => { const q = say(t).quick.map((i) => i.action.text); return q.includes('持股') && q.includes('報酬率') && q.includes('投資'); }));

const inv_hold = say('持股').text;
check('投資：持股清單依市值排序、帶每檔收益率', inv_hold.includes('📂 模擬持股 2026-10-05（2 檔）') && inv_hold.indexOf('2330 台積電') < inv_hold.indexOf('BTC 比特幣') && inv_hold.includes('收益率 +1.36%（+2,714）') && inv_hold.includes('收益率 -1.96%（-3,922）'), inv_hold);
check('投資：持股清單有股數、進場價、現價、停損停利', inv_hold.includes('78 股｜進 2,550 → 現 2,600') && inv_hold.includes('0.06656｜進 3,000,000 → 現 2,950,000') && inv_hold.includes('10/5 進場，持有 1 天') && inv_hold.includes('停損 2,346／停利 2,805'), inv_hold);
check('投資：持股清單有合計未實現、待成交與現金', inv_hold.includes('持股市值 808,070') && inv_hold.includes('未實現 -1,208（-0.30%）') && inv_hold.includes('2454 聯發科｜66.2 分') && inv_hold.includes('現金 204,518'), inv_hold);
check('投資：「現股清單」「庫存」是同一個功能', say('現股清單').text === inv_hold && say('庫存').text === inv_hold);

const inv_trades = say('交易紀錄').text;
check('投資：交易紀錄由新到舊', inv_trades.includes('成交 3 筆') && inv_trades.indexOf('10/5 🟢 買進 2330 台積電') < inv_trades.indexOf('9/10 📤 賣出 2317 鴻海') && inv_trades.indexOf('9/10 📤 賣出') < inv_trades.indexOf('9/2 🟢 買進 2317'), inv_trades);
check('投資：賣出帶出場原因與損益', inv_trades.includes('800 股 @ 230｜金額 184,000') && inv_trades.includes('停損｜損益 -17,074（-8.52%）'), inv_trades);
check('投資：交易紀錄列出取消與待成交', inv_trades.includes('取消 1 筆（現金不足）：2603 長榮') && inv_trades.includes('2454 聯發科｜66.2 分'), inv_trades);
check('投資：「模擬交易」顯示交易紀錄', say('模擬交易').text === inv_trades);

const inv_ret = say('報酬率').text;
check('投資：報酬率', inv_ret.includes('📈 投資報酬率 2026-10-05') && inv_ret.includes('總權益 1,012,588（起始 1,000,000）') && inv_ret.includes('累計報酬率 +1.26%') && inv_ret.includes('當日報酬率 +1.26%') && inv_ret.includes('未實現損益 +12,588'), inv_ret);
check('投資：報酬率帶已出場統計與近幾日', inv_ret.includes('已出場 1 筆｜勝率 0%｜平均 -8.52%') && inv_ret.indexOf('10/5　1,012,588') < inv_ret.indexOf('10/4　1,000,000'), inv_ret);
check('投資：「收益率」「投資報酬率」同一個功能', say('收益率').text === inv_ret && say('投資報酬率').text === inv_ret);

const inv_accText = say('準確率').text;
check('投資：準確率', inv_accText.includes('累計記錄 58 筆訊號') && inv_accText.includes('5 日：66.7%（12 筆，平均 +1.85%）') && inv_accText.includes('20 日：—') && inv_accText.includes('5 日 62.5%（32 筆）'), inv_accText);
check('投資：準確率樣本不足時提醒', inv_accText.includes('只有 12 筆走完 5 個交易日'));

const inv_dailyPush = JSON.parse(investPost('pk', { text: '🧪 模擬交易 2026-10-05' }));
check('投資：每日推播下方帶投資按鈕', inv_dailyPush.ok && pushes()[0].body.messages[0].quickReply.items.some((i) => i.action.text === '持股'));
check('投資：沒綁定的旅伴查不到投資資料', ['持股', '交易紀錄', '報酬率', '準確率', '選股', '投資'].every((t) => { const r = say(t, 'U2'); return !/總權益|台積電|投資選單|模擬持股/.test(r.text); }));
check('投資：旅遊指令不受影響', say('說明').text.includes('旅程手帖') && say('今天').quick.some((i) => i.action.text === '所有旅程'));

/* ---------- 網站版本號 ---------- */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const cfgVersion = (fs.readFileSync(path.join(root, 'js/config.js'), 'utf8').match(/version: '(\d+)'/) || [])[1];
check('網站版本號：js/config.js 與 version.json 一致', !!cfgVersion && cfgVersion === JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version, cfgVersion);

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
