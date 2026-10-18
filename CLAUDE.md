# 旅程手帖

旅遊行程規劃網站（GitHub Pages）＋ LINE 官方帳號。功能與檔案說明見 `README.md`。

## 結構

- 前端：純 HTML／CSS／JS，不用建置工具；`index.html`、`css/`、`js/`（`config.js` 放後端網址）、`sw.js`（離線快取）、`version.json`
- 後端：`gas/` 為 Google Apps Script（`Main.gs` 進入點、`Store.gs` 試算表存取、`Bot.gs`／`Line.gs` LINE、`Invest.gs` 投資分析的 LINE 轉送）
- 資料存在 Google 試算表與 Drive，不另開資料庫

## 開發規矩

- 每次更新網站，`version.json` 與 `js/config.js` 的 `version` 一起加 1（兩者要一致），已開著的網頁才會自動抓新檔案
- 試算表欄位變更要走 `Store.gs` 的 `ensureSchema_` 並提高 `SCHEMA_VERSION`，不可手動改舊資料
- 這是公開 repo：金鑰只放 Apps Script 指令碼屬性或 `~/Coding/KEY/`，不可寫進程式或 commit；`.clasp.json` 不進 git

## 驗證（完成標準）

- 後端：`node gas/test/run.cjs` 全部通過
- 前端：本機開 `index.html` 實際操作改到的畫面（手機寬度也要看）

## 部署（測試通過後直接做，不用再問）

- 前端：commit、push 後 GitHub Pages 約 1 分鐘更新
- 後端：`clasp push -f && clasp deploy -i <部署 ID> -d "說明"`，一定要帶 `-i` 更新同一個部署（部署 ID 見 `js/config.js` 的 apiUrl）
- 詳細設定（LINE、指令碼屬性、匯率）見 `~/Coding/claude/Output/MD/旅程手帖/travel-project.md`
