/* ============================================================
 * LINE Messaging API 呼叫
 * ============================================================ */

function lineFetch_(url, options) {
  const res = UrlFetchApp.fetch(url, Object.assign({
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${prop_('CHANNEL_ACCESS_TOKEN')}` },
  }, options));
  const code = res.getResponseCode();
  if (code >= 300) console.error(`LINE API ${code} ${url}: ${res.getContentText()}`);
  return res;
}

function lineApi_(path, payload, method) {
  const options = { method: method || 'post' };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  return lineFetch_(`https://api.line.me/v2/bot/${path}`, options);
}

/**
 * 回覆訊息（最多 5 則）。Flex 被 LINE 拒絕時，改用純文字 fallbackText 再回一次
 */
function reply_(replyToken, messages, fallbackText) {
  const list = [].concat(messages).filter(Boolean).slice(0, 5);
  if (!replyToken || !list.length) return;
  const res = lineApi_('message/reply', { replyToken, messages: list });
  if (res.getResponseCode() === 400 && fallbackText) {
    const quickReply = list[list.length - 1].quickReply;
    lineApi_('message/reply', { replyToken, messages: [textMsg_(fallbackText, quickReply && quickReply.items)] });
  }
}

function getMessageContent_(messageId) {
  const res = lineFetch_(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { method: 'get' });
  if (res.getResponseCode() !== 200) throw new Error('無法取得圖片內容');
  return res.getBlob();
}

/* ---------- 訊息組裝 ---------- */
function textMsg_(text, quickItems) {
  const msg = { type: 'text', text: String(text).slice(0, 4900) };
  if (quickItems && quickItems.length) msg.quickReply = { items: quickItems.slice(0, 13) };
  return msg;
}

function withQuick_(msg, quickItems) {
  if (quickItems && quickItems.length) msg.quickReply = { items: quickItems.slice(0, 13) };
  return msg;
}

function qMsg_(label, text) {
  return { type: 'action', action: { type: 'message', label: label.slice(0, 20), text: text || label } };
}

function qPostback_(label, data, displayText) {
  return {
    type: 'action',
    action: { type: 'postback', label: label.slice(0, 20), data: JSON.stringify(data), displayText: displayText || label },
  };
}

function qUri_(label, uri) {
  return { type: 'action', action: { type: 'uri', label: label.slice(0, 20), uri } };
}

function defaultQuick_() {
  return [qMsg_('今天'), qMsg_('明天'), qMsg_('所有旅程'), qMsg_('日誌'), qMsg_('📤 匯出', '匯出'), qUri_('開啟網站', LIFF_URL), qMsg_('說明')];
}
