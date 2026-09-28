# 旅程手帖（靜態旅遊行程規劃網站）

純 HTML／CSS／JavaScript，不需要安裝或建置，資料存在瀏覽器的 localStorage。

## 使用

- 直接用瀏覽器開啟 `index.html`，或在此資料夾執行 `python3 -m http.server 8000` 後開 http://localhost:8000
- 第一次使用可按「載入範例行程」看範例

## 功能

- 多個旅程管理，首頁顯示倒數天數／旅行中／已結束
- 依出發～回程日期自動產生每日行程；項目含時間區間（開始～結束）、移動時間、類別、地點、花費、備註，依時間自動排序，可改日期移到別天
- 移動方式（步行／電車／公車／計程車／開車／腳踏車／飛機／船）、移動時間與車資：行程之間顯示「🚃 電車 15 分鐘・¥230」，車資可選日幣或台幣，日幣會以臺灣銀行現金賣出匯率（FinMind 每日資料，備援為國際參考匯率，快取 6 小時）即時換算台幣，並換算後計入預算的交通類，導航自動切換對應的 Google 地圖交通方式，上一站結束＋移動時間趕不上下一站時會出現 ⚠️ 警告；新增時自動帶入開始時間
- Google 地圖：地點一鍵開啟地圖、🧭 導航（從目前位置出發），每天還有「🧭 路線」串起當天所有地點；也可以貼上 Google 地圖分享連結
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
| `js/cloud.js` | 雲端同步（LINE 登入後讀寫 Google Apps Script） |
| `js/config.js` | 網站設定（LIFF ID、API 網址） |
| `gas/` | Google Apps Script 後端：LINE 官方帳號機器人＋網站 API（資料存 Google 試算表） |

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

## LINE 官方帳號＋雲端同步（`gas/`）

用 LINE 登入後，網站與 LINE 官方帳號共用同一份資料（Google 試算表；日誌照片存 Google 雲端硬碟）。

- 官方帳號可以：查詢（今天／明天吃什麼／清水寺幾點等口語問法）、新增／修改／刪除行程、建立旅程、寫旅遊日誌、傳照片記錄、查預算與行李、取得網站連結、Google 地圖導航（「導航 清水寺」「今天路線」）
- 旅伴共用：LINE 傳「邀請」或網站按「＋ 邀請旅伴」產生邀請訊息，旅伴在 LINE 傳「加入 邀請碼」即加入；成員都能查看／編輯行程、共用日誌（標註作者），只有主人能刪除旅程與移除成員
- 網站新增「📔 日誌」分頁；在 LINE 做的修改，切回網頁時自動重新載入；兩邊同時改同一個旅程時，網站會提示並重新載入，不會覆蓋

### 檔案

| 檔案 | 內容 |
| --- | --- |
| `gas/Main.gs` | 進入點：LINE Webhook 與網站 API |
| `gas/Bot.gs` | 官方帳號的訊息處理 |
| `gas/Parse.gs` | 日期、時間、花費解析與模糊比對（純函式） |
| `gas/Flex.gs` | Flex Message 行程卡片 |
| `gas/Store.gs` | Google 試算表讀寫 |
| `gas/Line.gs` | LINE API 呼叫 |
| `gas/Setup.gs` | 初始設定與圖文選單 |
| `gas/richmenu.png` | 圖文選單圖片（2500×1686） |
| `gas/test/run.cjs` | 本機測試：`node gas/test/run.cjs` |

### 安全性

- 機密（`CHANNEL_ACCESS_TOKEN`）放在 Apps Script 的指令碼屬性，不在程式碼裡
- Apps Script 讀不到 HTTP header，無法驗證 LINE 簽章，改用 Webhook 網址上的隨機金鑰（`WEBHOOK_KEY`）
- 網站 API 以 LINE Login ID token 驗證使用者，每個人只能存取自己的資料
- 想限制只有自己能用：在指令碼屬性設定 `ALLOWED_USERS`（LINE userId，逗號分隔）
