/* ============================================================
 * 設定
 * 機密資料（CHANNEL_ACCESS_TOKEN）一律放在「專案設定 → 指令碼屬性」，不寫在程式碼裡
 * 指令碼屬性：
 *   CHANNEL_ACCESS_TOKEN  官方帳號 Messaging API 的 channel access token（手動填）
 *   ALLOWED_USERS         選填，限制可使用的 LINE userId（逗號分隔），留空＝加好友的人都能用
 *   SHEET_ID / PHOTO_FOLDER_ID / WEBHOOK_KEY   由 setup() 自動建立
 *   RICHMENU_VERSION / RICHMENU_TRIED_AT       圖文選單目前的版本與上次嘗試重建的時間（自動維護）
 * ============================================================ */

const LIFF_ID = '2011768794-Lhly8AIw';
const LOGIN_CHANNEL_ID = LIFF_ID.split('-')[0];
const SITE_URL = 'https://froststin.github.io/travel/';
// 這支後端的網址（要和 js/config.js 的 apiUrl 一樣）；舊版的線上檢視連結是直接指到這裡
const API_URL = 'https://script.google.com/macros/s/AKfycbxjPX_V7LYnM6oRp3C4uu5dVMNKoCMWKTpymuqgl_SCj04MS8_RU78dPHnpBphLUWd3/exec';
const LIFF_URL = `https://liff.line.me/${LIFF_ID}`;
const BOT_BASIC_ID = '@839jhulx'; // 官方帳號 ID，用於邀請連結
// 圖文選單：改了按鈕或圖片就把 RICHMENU_VERSION 加 1（圖片換新檔名），部署後第一次有人使用時會自動重建
const RICHMENU_VERSION = '2';
const RICHMENU_IMAGE_URL = `${SITE_URL}gas/richmenu-v${RICHMENU_VERSION}.png`;
const TZ = 'Asia/Taipei';

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function todayStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function nowTime_() {
  return Utilities.formatDate(new Date(), TZ, 'HH:mm');
}

function tripLiffUrl_(tripId) {
  return tripId ? `${LIFF_URL}?trip=${encodeURIComponent(tripId)}` : LIFF_URL;
}
