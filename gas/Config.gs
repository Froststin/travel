/* ============================================================
 * 設定
 * 機密資料（CHANNEL_ACCESS_TOKEN）一律放在「專案設定 → 指令碼屬性」，不寫在程式碼裡
 * 指令碼屬性：
 *   CHANNEL_ACCESS_TOKEN  官方帳號 Messaging API 的 channel access token（手動填）
 *   ALLOWED_USERS         選填，限制可使用的 LINE userId（逗號分隔），留空＝加好友的人都能用
 *   SHEET_ID / PHOTO_FOLDER_ID / WEBHOOK_KEY   由 setup() 自動建立
 * ============================================================ */

const LIFF_ID = '2011768794-Lhly8AIw';
const LOGIN_CHANNEL_ID = LIFF_ID.split('-')[0];
const SITE_URL = 'https://froststin.github.io/travel/';
const LIFF_URL = `https://liff.line.me/${LIFF_ID}`;
const BOT_BASIC_ID = '@839jhulx'; // 官方帳號 ID，用於邀請連結
const RICHMENU_IMAGE_URL = `${SITE_URL}gas/richmenu.png`;
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
