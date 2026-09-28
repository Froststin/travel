/* ============================================================
 * 初始設定：在 Apps Script 編輯器裡手動執行
 *  1. setup()         建立試算表、照片資料夾、Webhook 金鑰；有 token 時順便建立圖文選單
 *  2. setupRichMenu() 單獨重建圖文選單（改過圖片或按鈕時）
 * ============================================================ */

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
  if (!prop_('PHOTO_FOLDER_ID')) {
    props.setProperty('PHOTO_FOLDER_ID', DriveApp.createFolder('旅程手帖日誌照片').getId());
  }
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

function setupRichMenu() {
  const cell = (col, row) => ({ x: [0, 833, 1667][col], y: row * 843, width: col === 1 ? 834 : 833, height: 843 });
  const menu = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: '旅程手帖選單',
    chatBarText: '旅程選單',
    areas: [
      { bounds: cell(0, 0), action: { type: 'message', text: '今天' } },
      { bounds: cell(1, 0), action: { type: 'message', text: '明天' } },
      { bounds: cell(2, 0), action: { type: 'message', text: '所有旅程' } },
      { bounds: cell(0, 1), action: { type: 'message', text: '日誌' } },
      { bounds: cell(1, 1), action: { type: 'uri', uri: LIFF_URL } },
      { bounds: cell(2, 1), action: { type: 'message', text: '說明' } },
    ],
  };
  const res = lineApi_('richmenu', menu);
  if (res.getResponseCode() !== 200) throw new Error(`建立圖文選單失敗：${res.getContentText()}`);
  const id = JSON.parse(res.getContentText()).richMenuId;

  const image = UrlFetchApp.fetch(RICHMENU_IMAGE_URL).getBlob();
  const up = lineFetch_(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, {
    method: 'post', contentType: 'image/png', payload: image.getBytes(),
  });
  if (up.getResponseCode() !== 200) throw new Error(`上傳圖文選單圖片失敗：${up.getContentText()}`);
  lineApi_(`user/all/richmenu/${id}`, null, 'post');

  // 刪除舊的選單
  const list = JSON.parse(lineApi_('richmenu/list', null, 'get').getContentText()).richmenus || [];
  list.filter((m) => m.richMenuId !== id).forEach((m) => lineApi_(`richmenu/${m.richMenuId}`, null, 'delete'));
  console.log(`圖文選單已建立：${id}`);
}
