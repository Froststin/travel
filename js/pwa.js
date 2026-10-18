'use strict';

/* ============================================================
 * 安裝到手機主畫面（PWA）：註冊 sw.js 讓網站沒網路也打得開，
 * 選單裡的「安裝到主畫面」在支援的瀏覽器直接跳出安裝，其他的（iPhone、LINE 裡）說明怎麼加
 * ============================================================ */

let installPrompt = null;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('離線功能啟用失敗', err));
  });
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

(() => {
  const btn = document.getElementById('install-btn');
  if (btn) btn.hidden = isStandalone();
})();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  const btn = document.getElementById('install-btn');
  if (btn) btn.hidden = true;
  toast('已安裝到主畫面');
});

document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-action="install-app"]')) return;
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    return;
  }
  const ua = navigator.userAgent;
  if (/Line\//i.test(ua)) {
    alert('LINE 裡面不能安裝。請點右上角「⋯」→「在預設瀏覽器開啟」，再從瀏覽器加到主畫面。');
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    alert('iPhone／iPad：請用 Safari 開啟這個網站，按下方的「分享」按鈕 →「加入主畫面」。');
  } else {
    alert('請在瀏覽器的選單裡找「安裝應用程式」或「加到主畫面」。');
  }
});
