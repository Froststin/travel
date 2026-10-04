// 網站設定
// liffId：LINE Developers Console → LINE Login channel → LIFF 分頁。留空時不啟用 LIFF，分享改用純文字連結
// apiUrl：Google Apps Script 網頁應用程式網址（gas/ 資料夾）。留空時資料只存在瀏覽器，不做雲端同步
// version：每次更新網站都要加 1，並且和 version.json 一致。瀏覽器會把舊檔案留 10 分鐘左右，
//          網站靠這個數字發現有新版，自動抓新檔案並重新載入（見 app.js 的 checkForUpdate）
window.TRAVEL_CONFIG = {
  version: '21',
  liffId: '2011768794-Lhly8AIw',
  apiUrl: 'https://script.google.com/macros/s/AKfycbxjPX_V7LYnM6oRp3C4uu5dVMNKoCMWKTpymuqgl_SCj04MS8_RU78dPHnpBphLUWd3/exec',
};
