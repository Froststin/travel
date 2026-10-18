'use strict';

/* 最後載入：其他檔案的函式都準備好了才開始畫畫面 */
fillSelects();
window.addEventListener('hashchange', route);
route();
checkForUpdate();
