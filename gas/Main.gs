/* ============================================================
 * 進入點
 *  - LINE Webhook：POST  <網頁應用程式網址>?src=line&key=<WEBHOOK_KEY>
 *  - 網站 API：   POST  <網頁應用程式網址>（text/plain 的 JSON，附 LIFF ID token）
 * Apps Script 無法讀取 HTTP header，因此 LINE 簽章改用網址上的 WEBHOOK_KEY 驗證；
 * 網站 API 則用 LINE Login 的 ID token 驗證使用者。
 * ============================================================ */

function doGet() {
  return ContentService.createTextOutput('旅程手帖 API 運作中');
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, status: 400, error: '格式錯誤' });
  }

  if (e.parameter.src === 'line') {
    const key = prop_('WEBHOOK_KEY');
    if (!key || e.parameter.key !== key) return ContentService.createTextOutput('forbidden');
    ensureSchema_();
    handleWebhook_(body);
    return ContentService.createTextOutput('ok');
  }

  try {
    ensureSchema_();
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
  const userId = verifyIdToken_(body.idToken);
  checkAllowed_(userId);

  switch (body.action) {
    case 'reportRate':
      return { accepted: withLock_(() => reportRate_(body.rate)) };

    case 'list':
      if (body.name) withLock_(() => setUserName_(userId, body.name));
      return { trips: loadTrips_(userId), journal: loadJournal_(userId) };

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
