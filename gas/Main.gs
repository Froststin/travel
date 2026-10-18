/* ============================================================
 * 進入點
 *  - LINE Webhook：POST  <網頁應用程式網址>?src=line&key=<WEBHOOK_KEY>
 *  - 投資日報推播：POST  <網頁應用程式網址>?src=invest&key=<INVEST_PUSH_KEY>（見 Invest.gs）
 *  - 網站 API：   POST  <網頁應用程式網址>（text/plain 的 JSON，附 LIFF ID token）
 * Apps Script 無法讀取 HTTP header，因此 LINE 簽章改用網址上的 WEBHOOK_KEY 驗證；
 * 網站 API 則用 LINE Login 的 ID token 驗證使用者；驗證過後發一張 30 天有效的登入憑證（session），
 * 之後網站改用它，不必每小時重新登入 LINE（ID token 只有 1 小時）。
 * ============================================================ */

function doGet(e) {
  const token = e && e.parameter && e.parameter.view;
  if (token) return viewPage_(token); // 免登入的線上檢視頁（見 Export.gs）
  return ContentService.createTextOutput(`旅程手帖 API 運作中（圖文選單 v${prop_('RICHMENU_VERSION') || '1'}，程式 v${RICHMENU_VERSION}）`);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, status: 400, error: '格式錯誤' });
  }

  if (e.parameter.src === 'invest') {
    const key = prop_('INVEST_PUSH_KEY');
    if (!key || e.parameter.key !== key) return ContentService.createTextOutput('forbidden');
    ensureInvestMenu_();
    return json_(Object.assign(investPush_(body), { menu: prop_('INVEST_MENU_VERSION'), menuScope: prop_('INVEST_MENU_SCOPE') }));
  }

  if (e.parameter.src === 'line') {
    const key = prop_('WEBHOOK_KEY');
    if (!key || e.parameter.key !== key) return ContentService.createTextOutput('forbidden');
    ensureSchema_();
    ensureRichMenu_();
    ensureInvestMenu_();
    handleWebhook_(body);
    return ContentService.createTextOutput('ok');
  }

  try {
    ensureSchema_();
    ensureRichMenu_();
    return json_(Object.assign({ ok: true }, handleApi_(body)));
  } catch (err) {
    if (!err.status) console.error(err);
    return json_({ ok: false, status: err.status || 500, error: err.status ? err.message : `伺服器錯誤：${err.message}` });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 網站 API ---------- */
function handleApi_(body) {
  if (body.action === 'rate') return { rate: jpyRate_() }; // 匯率不需登入
  if (body.action === 'view') return withLock_(() => viewData_(body.token)); // 線上檢視連結：憑代碼，不需登入
  const auth = authenticate_(body);
  const userId = auth.userId;
  checkAllowed_(userId);
  if (body.action === 'logout') {
    withLock_(() => revokeSessions_(userId));
    return {};
  }
  const result = apiAction_(userId, body);
  // 用 LINE 的 ID token 登入的、或憑證用超過 7 天的，順便發一張新的
  if (auth.renew) result.session = issueSession_(userId);
  return result;
}

function apiAction_(userId, body) {
  switch (body.action) {
    case 'reportRate':
      fetchReferenceRate_(); // 連外部網站，先查好再拿鎖
      return { accepted: withLock_(() => reportRate_(body.rate)) };

    case 'list':
      // 讀取也要排隊：避免讀到別人存檔寫到一半的資料，再被網站存回去
      return withLock_(() => {
        if (body.name) setUserName_(userId, body.name);
        return { trips: loadTrips_(userId), journal: loadJournal_(userId) };
      });

    case 'saveTrip':
      return withLock_(() => {
        const trip = sanitizeTrip_(body.trip);
        if (!trip) throw apiError_(400, '旅程資料格式錯誤');
        const current = findTripRow_(trip.id);
        if (current) {
          if (!roleIn_(userId, current)) throw apiError_(403, '沒有權限修改這個旅程');
          if (body.baseUpdatedAt !== current.updatedAt) throw apiError_(409, '這個旅程已在其他地方更新');
        }
        return { updatedAt: saveTrip_(userId, trip) };
      });

    case 'deleteTrip':
      return withLock_(() => ({ result: deleteTrip_(userId, String(body.id || '')) }));

    case 'invite':
      return withLock_(() => {
        const tripId = String(body.tripId || '');
        const code = inviteCodeFor_(userId, tripId);
        return { code, text: inviteText_(findTripRow_(tripId), code, userName_(userId)) };
      });

    case 'removeMember':
      return withLock_(() => {
        if (!removeMember_(userId, String(body.tripId || ''), String(body.member || ''))) throw apiError_(404, '找不到這位成員');
        return {};
      });

    case 'addJournal':
      return withLock_(() => {
        const text = str_(body.entry && body.entry.text, 2000).trim();
        if (!text) throw apiError_(400, '日誌內容是空的');
        const row = addJournal_(userId, Object.assign({}, body.entry, { type: 'text', text, fileId: '' }));
        return { entry: { id: row.id, tripId: row.tripId } };
      });

    case 'deleteJournal':
      return withLock_(() => {
        deleteJournal_(userId, String(body.id || ''));
        return {};
      });

    case 'exportPdf': {
      // 網站上的「匯出 PDF」：和 LINE 的匯出是同一套，讀資料時才拿鎖，產生 PDF 放在鎖外面
      warmRates_();
      const trip = withLock_(() => loadTrips_(userId).find((t) => t.id === String(body.tripId || '')));
      if (!trip) throw apiError_(404, '找不到這個旅程');
      try {
        return exportTripPdf_(userId, trip);
      } catch (err) {
        throw apiError_(500, `PDF 產生失敗（${err.message}）`);
      }
    }

    case 'viewLink':
      return withLock_(() => ({ url: viewUrl_(viewTokenFor_(userId, String(body.tripId || ''), !!body.reset)) }));

    case 'uploadShopImage':
      return { fileId: uploadShopImage_(userId, body.dataUrl, body.kind === 'activity' ? 'activity' : 'shop') };

    case 'shopPhotos':
      return { photos: shopPhotos_(userId, body.fileIds) };

    case 'photo': {
      const row = readTable_('Journal').find((j) => j.fileId && j.fileId === body.fileId);
      if (!row || !canSeeJournal_(userId, row)) throw apiError_(404, '找不到照片');
      const blob = DriveApp.getFileById(row.fileId).getBlob();
      return { dataUrl: `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}` };
    }

    default:
      throw apiError_(400, '未知的動作');
  }
}

/* ---------- 登入 ---------- */
const SESSION_DAYS = 30;
const SESSION_RENEW_DAYS = 7;

function authenticate_(body) {
  if (body.session) {
    const p = verifySession_(body.session);
    return { userId: p.u, renew: Date.now() - p.iat > SESSION_RENEW_DAYS * 86400000 };
  }
  return { userId: verifyIdToken_(body.idToken), renew: true };
}

function sessionSecret_() {
  let s = prop_('SESSION_SECRET');
  if (!s) {
    s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty('SESSION_SECRET', s);
  }
  return s;
}

function sessionSig_(body) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, sessionSecret_())).replace(/=+$/, '');
}

/** 網站的登入憑證：「內容.簽章」，內容是 { u: userId, iat: 發出時間, exp: 到期時間 } */
function issueSession_(userId) {
  const iat = Date.now();
  const exp = iat + SESSION_DAYS * 86400000;
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({ u: userId, iat, exp }));
  return { token: `${body}.${sessionSig_(body)}`, exp, userId };
}

function verifySession_(token) {
  const [body, sig] = String(token).split('.');
  let p = null;
  if (body && sig && sig === sessionSig_(body)) {
    try {
      p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
    } catch (err) {
      p = null;
    }
  }
  if (!p || typeof p.u !== 'string' || !(p.exp > Date.now()) || p.iat < sessionsFrom_(p.u)) {
    throw apiError_(401, '登入已過期，請重新登入');
  }
  return p;
}

function verifyIdToken_(token) {
  if (!token) throw apiError_(401, '請先登入 LINE');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  const cacheKey = `idt_${Utilities.base64EncodeWebSafe(digest).slice(0, 43)}`;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: token, client_id: LOGIN_CHANNEL_ID },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw apiError_(401, '登入已過期，請重新登入');
  const data = JSON.parse(res.getContentText());
  const ttl = Math.min(600, data.exp - Math.floor(Date.now() / 1000));
  if (ttl > 5) cache.put(cacheKey, data.sub, ttl);
  return data.sub;
}

function checkAllowed_(userId) {
  const allowed = prop_('ALLOWED_USERS').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(userId)) throw apiError_(403, '這個帳號沒有使用權限');
}
