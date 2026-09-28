# 旅程手帖（靜態旅遊行程規劃網站）

純 HTML／CSS／JavaScript，不需要安裝或建置，資料存在瀏覽器的 localStorage。

## 使用

- 直接用瀏覽器開啟 `index.html`，或在此資料夾執行 `python3 -m http.server 8000` 後開 http://localhost:8000
- 第一次使用可按「載入範例行程」看範例

## 功能

- 多個旅程管理，首頁顯示倒數天數／旅行中／已結束
- 依出發～回程日期自動產生每日行程；項目含時間、類別、地點、花費、備註，依時間自動排序，可改日期移到別天
- 地點一鍵開啟 Google 地圖
- 預算頁：總預算、預估花費、剩餘／超支、分類花費、每日花費
- 行李清單：勾選進度、一鍵加入常用物品
- 匯出／匯入 JSON（單一旅程或全部備份）、列印每日行程
- 支援手機版與深色模式
- 分享到 LINE：整趟旅程或單日行程（見下方「LINE 整合」）

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `index.html` | 頁面骨架與表單對話框 |
| `css/style.css` | 樣式（含深色模式、列印樣式） |
| `js/app.js` | 主要邏輯：資料存取、路由、畫面渲染、匯入匯出 |
| `js/line.js` | LINE 分享與 LIFF 整合 |
| `js/config.js` | 網站設定（LIFF ID） |

## 注意

- 資料只存在目前這個瀏覽器，清除網站資料或換裝置前請先「匯出全部」
- 旅程最長 60 天；縮短日期時，範圍外的行程項目會在確認後刪除

## LINE 整合

- **分享連結（不需設定）**：旅程頁的「分享到 LINE」分享整趟旅程，每天的「LINE」按鈕只分享那一天；內容是純文字，透過 `https://line.me/R/share` 送出
- **LIFF（需設定）**：在 `js/config.js` 填入 `liffId` 後，從 LINE 內開啟網站時，分享會改用 shareTargetPicker 傳送 Flex Message 行程卡片（每天一張，最多 12 天）；不支援或失敗時自動退回純文字分享

### LIFF 設定步驟

1. 把網站部署到 https 網址（例如 GitHub Pages）
2. LINE Developers Console → 選 Provider → 建立 **LINE Login** channel
3. channel 的「LIFF」分頁 → Add：Size 選 `Full`、Endpoint URL 填步驟 1 的網址、Scopes 勾 `profile`、打開 **shareTargetPicker**
4. 把拿到的 LIFF ID 填進 `js/config.js`，重新部署
5. 用 `https://liff.line.me/<LIFF ID>` 開啟；channel 在 Developing 狀態時只有管理員／測試者能用，要給其他人用需改成 Published
