/* ============================================================
 * 初始設定：在 Apps Script 編輯器裡手動執行
 *  1. setup()         建立試算表、照片資料夾、Webhook 金鑰；有 token 時順便建立圖文選單
 *  2. setupRichMenu() 單獨重建圖文選單（平常不用手動執行：RICHMENU_VERSION 變了會自動重建）
 * ============================================================ */

/** 圖文選單版本不同時自動重建一次；失敗不影響正常使用，10 分鐘後再試 */
function ensureRichMenu_() {
  if (prop_('RICHMENU_VERSION') === RICHMENU_VERSION || !prop_('CHANNEL_ACCESS_TOKEN')) return;
  if (Date.now() - Number(prop_('RICHMENU_TRIED_AT') || 0) < 10 * 60 * 1000) return;
  withLock_(() => {
    if (prop_('RICHMENU_VERSION') === RICHMENU_VERSION) return;
    PropertiesService.getScriptProperties().setProperty('RICHMENU_TRIED_AT', String(Date.now()));
    try {
      setupRichMenu();
    } catch (err) {
      console.error(`圖文選單重建失敗：${err && err.message}`);
    }
  });
}

function setup() {
  const props = PropertiesService.getScriptProperties();

  if (!prop_('SHEET_ID')) {
    const ss = SpreadsheetApp.create('旅程手帖資料');
    Object.entries(TABLES).forEach(([name, cols], i) => {
      const sh = i === 0 ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
      sh.getRange('A:Z').setNumberFormat('@');
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
    });
    props.setProperty('SHEET_ID', ss.getId());
  }
  driveFolder_('PHOTO_FOLDER_ID', '旅程手帖日誌照片');
  if (!prop_('WEBHOOK_KEY')) {
    props.setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));
  }

  console.log(`試算表：${SpreadsheetApp.openById(prop_('SHEET_ID')).getUrl()}`);
  console.log(`照片資料夾：${DriveApp.getFolderById(prop_('PHOTO_FOLDER_ID')).getUrl()}`);
  const url = ScriptApp.getService().getUrl();
  console.log(url
    ? `LINE Webhook URL（貼到 LINE Developers）：\n${url}?src=line&key=${prop_('WEBHOOK_KEY')}`
    : `尚未部署網頁應用程式。部署後 Webhook URL 為：<網頁應用程式網址>?src=line&key=${prop_('WEBHOOK_KEY')}`);

  if (prop_('CHANNEL_ACCESS_TOKEN')) setupRichMenu();
  else console.warn('尚未設定 CHANNEL_ACCESS_TOKEN（專案設定 → 指令碼屬性），圖文選單稍後再建立');
}

/** 旅遊選單的七個按鈕（上排 3、下排 4）；投資分頁選單的「旅遊」分頁也用同一份 */
function travelMenuActions_() {
  return [
    { type: 'message', text: '今天' },
    { type: 'message', text: '明天' },
    { type: 'message', text: '所有旅程' },
    { type: 'message', text: '日誌' },
    { type: 'uri', uri: LIFF_URL },
    { type: 'message', text: '匯出' },
    { type: 'message', text: '說明' },
  ];
}

function setupRichMenu() {
  // 上排 3 格、下排 4 格
  const top = (col) => ({ x: [0, 833, 1667][col], y: 0, width: col === 1 ? 834 : 833, height: 843 });
  const bottom = (col) => ({ x: col * 625, y: 843, width: 625, height: 843 });
  // 先確認圖片抓得到，再建立選單，避免留下沒有圖片的空選單
  const img = UrlFetchApp.fetch(RICHMENU_IMAGE_URL, { muteHttpExceptions: true });
  if (img.getResponseCode() !== 200) throw new Error(`抓不到圖文選單圖片（${img.getResponseCode()}）：${RICHMENU_IMAGE_URL}`);
  const menu = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: '旅程手帖選單',
    chatBarText: '旅程選單',
    areas: [top(0), top(1), top(2), bottom(0), bottom(1), bottom(2), bottom(3)].map((bounds, i) => ({ bounds, action: travelMenuActions_()[i] })),
  };
  const res = lineApi_('richmenu', menu);
  if (res.getResponseCode() !== 200) throw new Error(`建立圖文選單失敗：${res.getContentText()}`);
  const id = JSON.parse(res.getContentText()).richMenuId;

  const up = lineFetch_(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, {
    method: 'post', contentType: 'image/png', payload: img.getBlob().getBytes(),
  });
  if (up.getResponseCode() !== 200) {
    lineApi_(`richmenu/${id}`, null, 'delete'); // 不留半成品
    throw new Error(`上傳圖文選單圖片失敗：${up.getContentText()}`);
  }
  const set = lineApi_(`user/all/richmenu/${id}`, null, 'post');
  if (set.getResponseCode() !== 200) {
    lineApi_(`richmenu/${id}`, null, 'delete');
    throw new Error(`套用圖文選單失敗：${set.getContentText()}`);
  }
  PropertiesService.getScriptProperties().setProperty('RICHMENU_VERSION', RICHMENU_VERSION);
  PropertiesService.getScriptProperties().setProperty('INVEST_MENU_SCOPE', ''); // 預設選單剛被換掉：讓投資分頁選單下次再套用一次

  // 刪除舊的選單
  const list = JSON.parse(lineApi_('richmenu/list', null, 'get').getContentText()).richmenus || [];
  const keep = investMenuIds_().concat(id); // 投資分頁選單由 Invest.gs 管理，不要刪
  list.filter((m) => !keep.includes(m.richMenuId)).forEach((m) => lineApi_(`richmenu/${m.richMenuId}`, null, 'delete'));
  console.log(`圖文選單已建立：${id}`);
}
