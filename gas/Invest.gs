/* ============================================================
 * 投資日報：跟「投資分析」專案（github.com/Froststin/invest-analysis）共用這個官方帳號
 *
 *  - 推播：投資分析的每日排程 POST <網頁應用程式網址>?src=invest&key=<INVEST_PUSH_KEY>，
 *          body {"text": "..."}，只推給綁定過的人（INVEST_USERS），旅伴不會收到
 *  - 查詢：綁定過的人傳「選股」「模擬交易」「虛擬貨幣」，直接讀投資分析的試算表回覆
 *  - 綁定：傳「綁定投資 <一次性代碼>」，代碼用過即失效
 *
 * 指令碼屬性：
 *   INVEST_SHEET_ID   投資分析的試算表
 *   INVEST_PUSH_KEY   推播用的金鑰
 *   INVEST_BIND_CODE  一次性綁定代碼（用過會清空）
 *   INVEST_USERS      綁定的 LINE userId（逗號分隔）
 * ============================================================ */

// 欄位順序要跟投資分析 stock_reco/store.py 的 TABLES 一致
const INVEST_RECO_COLS = ['trade_date', 'rank_no', 'code', 'name', 'score', 'level', 'close'];
const INVEST_TABLES = {
  daily_recommendations: INVEST_RECO_COLS,
  daily_crypto_recommendations: INVEST_RECO_COLS,
  market_trend_snapshot: ['trade_date', 'total_candidates', 'bullish_count', 'avg_score', 'trend_label'],
  sim_orders: ['id', 'created_at', 'asset_type', 'code', 'name', 'side', 'status', 'signal_date', 'signal_score'],
  sim_positions: ['id', 'asset_type', 'code', 'name', 'signal_date', 'signal_score', 'entry_date', 'entry_price',
    'qty', 'cost', 'stop_price', 'target_price', 'status', 'exit_date', 'exit_price', 'exit_reason', 'proceeds', 'pnl', 'pnl_pct'],
  sim_equity: ['date', 'cash', 'market_value', 'equity', 'daily_return_pct', 'total_return_pct', 'open_positions',
    'realized_pnl', 'unrealized_pnl'],
};
const INVEST_HELP = '📈 投資日報\n・選股 → 最近一次的台股推薦\n・虛擬貨幣 → 最近一次的幣種推薦\n・模擬交易 → 目前權益、報酬率與持有部位\n\n每天排程跑完會自動傳日報給你。純模擬，沒有實際下單。';

function investUsers_() {
  return prop_('INVEST_USERS').split(',').map((s) => s.trim()).filter(Boolean);
}

function investRows_(name) {
  const sh = SpreadsheetApp.openById(prop_('INVEST_SHEET_ID')).getSheetByName(name);
  const cols = INVEST_TABLES[name];
  const n = sh ? sh.getLastRow() - 1 : 0;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, cols.length).getDisplayValues()
    .filter((r) => r[0])
    .map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

function investNum_(text, digits) {
  const n = Number(text);
  if (text === '' || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits == null ? 0 : digits });
}

function investSigned_(text, digits) {
  const n = Number(text);
  if (text === '' || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits);
}

/** 投資相關的訊息；有處理回 true，不是投資指令（或這個人沒綁定）回 false，交回旅程手帖處理 */
function handleInvestText_(ctx, text) {
  let m;
  if (/^我的\s*id$/i.test(text)) {
    say_(ctx, textMsg_(`你的 LINE user ID：\n${ctx.userId}`));
    return true;
  }
  if ((m = text.match(/^綁定投資\s*([A-Za-z0-9]{8,})$/))) {
    const code = prop_('INVEST_BIND_CODE');
    if (!code || m[1] !== code) {
      say_(ctx, textMsg_('綁定代碼不正確或已經用過了。'));
      return true;
    }
    const props = PropertiesService.getScriptProperties();
    props.setProperty('INVEST_USERS', investUsers_().concat(ctx.userId).filter((u, i, a) => a.indexOf(u) === i).join(','));
    props.setProperty('INVEST_BIND_CODE', '');
    say_(ctx, textMsg_(`✅ 已綁定投資日報。\n\n${INVEST_HELP}`));
    return true;
  }
  if (!investUsers_().includes(ctx.userId) || !prop_('INVEST_SHEET_ID')) return false;

  if (/^(投資|投資說明|投資日報)$/.test(text)) say_(ctx, textMsg_(INVEST_HELP));
  else if (/^(選股|今日選股|股票|股票推薦|台股)$/.test(text)) say_(ctx, textMsg_(investStockText_()));
  else if (/^(虛擬貨幣|加密貨幣|幣|幣圈)$/.test(text)) say_(ctx, textMsg_(investRecoText_('daily_crypto_recommendations', '🪙 虛擬貨幣推薦')));
  else if (/^(模擬交易|模擬|報酬率|投資報酬率?|績效)$/.test(text)) say_(ctx, textMsg_(investSimText_()));
  else return false;
  return true;
}

function investRecoText_(table, title) {
  const rows = investRows_(table);
  if (!rows.length) return `${title}\n還沒有資料。`;
  const date = rows.map((r) => r.trade_date).sort().pop();
  const picks = rows.filter((r) => r.trade_date === date).sort((a, b) => Number(a.rank_no) - Number(b.rank_no));
  return [`${title} ${date}`, '']
    .concat(picks.map((r) => `${r.rank_no}. ${r.code} ${r.name}\n　${r.level}｜${investNum_(r.score, 1)} 分｜${investNum_(r.close, 8)}`))
    .concat(['', '⚠️ 程式依規則產生，僅供參考，非投資建議'])
    .join('\n');
}

function investStockText_() {
  const text = investRecoText_('daily_recommendations', '📊 選股');
  const trend = investRows_('market_trend_snapshot').sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1)).pop();
  if (!trend) return text;
  const lines = text.split('\n');
  lines.splice(1, 0, `觀察池氛圍：${trend.trend_label}（${trend.bullish_count}/${trend.total_candidates} 檔技術分達標）`);
  return lines.join('\n');
}

function investSimText_() {
  const eq = investRows_('sim_equity').sort((a, b) => (a.date < b.date ? -1 : 1)).pop();
  if (!eq) return '🧪 模擬交易\n還沒有資料，排程跑過一次之後才會有。';
  const lines = [
    `🧪 模擬交易 ${eq.date}`,
    `總權益 ${investNum_(eq.equity)}`,
    `累計 ${investSigned_(eq.total_return_pct)}%｜當日 ${investSigned_(eq.daily_return_pct)}%`,
    `現金 ${investNum_(eq.cash)}｜持有 ${eq.open_positions} 檔`,
    `已實現 ${investSigned_(eq.realized_pnl, 0)}｜未實現 ${investSigned_(eq.unrealized_pnl, 0)}`,
  ];
  const positions = investRows_('sim_positions');
  const open = positions.filter((p) => p.status === 'open');
  if (open.length) {
    lines.push('', '📂 持有中');
    open.forEach((p) => lines.push(`${p.code} ${p.name}｜${p.entry_date} 進 ${investNum_(p.entry_price, 8)}\n　停損 ${investNum_(p.stop_price, 6)}／停利 ${investNum_(p.target_price, 6)}`));
  }
  const pending = investRows_('sim_orders').filter((o) => o.side === 'buy' && o.status === 'pending');
  if (pending.length) {
    lines.push('', '⏳ 待成交（下一個交易日開盤買進）');
    pending.forEach((o) => lines.push(`${o.code} ${o.name}｜${investNum_(o.signal_score, 1)} 分`));
  }
  const closed = positions.filter((p) => p.status === 'closed').sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1)).slice(0, 3);
  if (closed.length) {
    lines.push('', '📤 最近出場');
    closed.forEach((p) => lines.push(`${p.code} ${p.name}｜${p.exit_date} ${p.exit_reason}｜${investSigned_(p.pnl_pct)}%`));
  }
  lines.push('', '⚠️ 純模擬，沒有實際下單');
  return lines.join('\n');
}

/** 投資分析的排程呼叫：把文字推給綁定的人 */
function investPush_(body) {
  const text = String((body && body.text) || '').trim();
  const users = investUsers_();
  if (!text) return { ok: false, error: '沒有內容' };
  if (!users.length) return { ok: false, error: '還沒有人綁定投資日報（在 LINE 傳「綁定投資 <代碼>」）' };
  const failed = users.filter((to) => lineApi_('message/push', { to, messages: [textMsg_(text)] }).getResponseCode() !== 200);
  return failed.length ? { ok: false, error: `LINE 推播失敗 ${failed.length}/${users.length}` } : { ok: true, sent: users.length };
}
