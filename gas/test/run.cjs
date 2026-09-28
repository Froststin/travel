/* 本機測試：用假的 Google／LINE 服務載入所有 .gs，模擬 LINE 訊息與網站 API
 * 執行：node gas/test/run.cjs
 */
const H = require('./harness.cjs');
const { ctx, run, props, sent, flags } = H;

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
check('預算', r.text.includes('預估花費：1,380 TWD'), r.text);

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
check('新增含移動方式與車資', r.text.includes('🚃 電車 15 分鐘・230 TWD') && r.text.includes('💰 3000 TWD'), r.text);
check('試算表存了移動方式與車資', rows('Activities').some((a) => a.title === '先斗町晚餐' && a.travelMode === 'train' && a.travelCost === '230' && a.cost === '3000'));
r = say('改 先斗町晚餐 搭計程車');
check('只改移動方式保留分鐘數', r.text.includes('🚕 計程車 15 分鐘・230 TWD'), r.text);
r = say('改 先斗町晚餐 車資500');
check('只改車資', r.text.includes('🚕 計程車 15 分鐘・500 TWD'), r.text);
r = say('明天');
check('行程卡片顯示移動方式與車資', r.text.includes('🚕 計程車 15 分鐘・500 TWD'), r.text.slice(0, 300));
r = say('導航 先斗町晚餐');
check('導航使用計程車（開車）路線', r.text.includes('先斗町晚餐') && r.quick[0].action.uri.endsWith('&travelmode=driving'), JSON.stringify(r.quick[0]));
r = say('預算');
check('車資算進預算的交通類', r.text.includes('🚆 交通') && /預估花費：[\d,]+ TWD/.test(r.text), r.text);

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
check('資料表已自動升級', ['Members', 'Users'].every((n) => H.sheets[n]) && H.sheets.Trips.data[0].includes('inviteCode') && props.SCHEMA_VERSION === '4');
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
say(`加入 ${code}`, 'U2');
check('API：旅伴刪除旅程＝退出', api('deleteTrip', { id: shared.id }, 'good:U2').result === 'left' && api('list', {}).trips.length === 1);
say(`加入 ${code}`, 'U2');
check('API：主人用成員代號移除', api('removeMember', { tripId: shared.id, member: u2key }).ok && api('list', {}, 'good:U2').trips.length === 0);
r = say('退出旅程');
check('主人不能退出自己的旅程', r.text.includes('你是「京都」的主人'), r.text);

check('API deleteTrip', api('deleteTrip', { id: trip.id }).ok && api('list', {}).trips.length === 0);

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
