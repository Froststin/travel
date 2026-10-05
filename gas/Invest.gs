/* ============================================================
 * 投資日報：跟「投資分析」專案（github.com/Froststin/invest-analysis）共用這個官方帳號
 *
 *  - 推播：投資分析的每日排程 POST <網頁應用程式網址>?src=invest&key=<INVEST_PUSH_KEY>，
 *          body {"text": "..."}，只推給綁定過的人（INVEST_USERS），旅伴不會收到
 *  - 查詢：綁定過的人傳「投資」叫出選單，點按鈕（或直接傳「持股」「交易紀錄」「報酬率」「準確率」
 *          「選股」「虛擬貨幣」）就讀投資分析的試算表回覆；每則回覆下方都帶同一排按鈕
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
  sim_orders: ['id', 'created_at', 'asset_type', 'code', 'name', 'side', 'status', 'signal_date', 'signal_score',
    'fill_date', 'price', 'qty', 'amount', 'fee', 'reason', 'position_id'],
  sim_positions: ['id', 'asset_type', 'code', 'name', 'signal_date', 'signal_score', 'entry_date', 'entry_price',
    'qty', 'cost', 'stop_price', 'target_price', 'status', 'exit_date', 'exit_price', 'exit_reason', 'proceeds', 'pnl', 'pnl_pct'],
  sim_equity: ['date', 'cash', 'market_value', 'equity', 'daily_return_pct', 'total_return_pct', 'open_positions',
    'realized_pnl', 'unrealized_pnl'],
  sim_holdings: ['snapshot', 'date', 'asset_type', 'code', 'name', 'entry_date', 'entry_price', 'qty', 'cost',
    'last_price', 'market_value', 'pnl', 'pnl_pct', 'stop_price', 'target_price', 'bars_held'],
  sim_accuracy: ['snapshot', 'date', 'kind', 'horizon', 'n', 'win', 'avg'],
};

// 選單：[按鈕文字, 送出的訊息]
const INVEST_MENU = [
  ['📂 持股清單', '持股'], ['📝 交易紀錄', '交易紀錄'], ['📈 報酬率', '報酬率'],
  ['🎯 模型準確率', '準確率'], ['📊 今日選股', '選股'], ['🪙 虛擬貨幣', '虛擬貨幣'],
];
const INVEST_HELP = '📈 投資日報\n點下面的按鈕，或直接傳：\n・持股 → 目前模擬持股與每檔收益率\n・交易紀錄 → 模擬買賣與出場損益\n・報酬率 → 總權益、累計與當日報酬率\n・準確率 → 模型訊號的實際勝率\n・選股／虛擬貨幣 → 最近一次的推薦\n\n每天排程跑完會自動傳日報。純模擬，沒有實際下單。';

function investQuick_() {
  return INVEST_MENU.map(([label, text]) => qMsg_(label, text)).concat([qMsg_('🧭 投資選單', '投資')]);
}

/** 選單卡片：留在聊天室裡，隨時可以回來點 */
function investMenuFlex_() {
  const button = ([label, text]) => ({ type: 'button', style: 'secondary', height: 'sm', margin: 'sm', action: { type: 'message', label, text } });
  const eq = investRows_('sim_equity').sort((x, y) => (x.date < y.date ? -1 : 1)).pop();
  const summary = eq
    ? `總權益 ${investNum_(eq.equity)}｜累計 ${investSigned_(eq.total_return_pct)}%`
    : '排程跑過一次之後才會有資料';
  return flexMsg_(`投資選單｜${summary}`, {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: '📈 投資選單', weight: 'bold', size: 'lg' },
        { type: 'text', text: eq ? `${eq.date}｜${summary}` : summary, size: 'sm', color: '#666666', wrap: true, margin: 'sm' },
        { type: 'text', text: '純模擬，沒有實際下單', size: 'xs', color: '#999999', margin: 'sm' },
        { type: 'separator', margin: 'md' },
      ].concat(INVEST_MENU.map(button)),
    },
  });
}

function investSay_(ctx, text) {
  say_(ctx, textMsg_(text, investQuick_()));
}

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
  const d = digits == null ? 2 : digits;
  return (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
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

  if (/^(投資|投資選單|投資日報|投資功能)$/.test(text)) {
    say_(ctx, withQuick_(investMenuFlex_(), investQuick_()), INVEST_HELP);
  } else if (/^(投資說明|投資指令)$/.test(text)) investSay_(ctx, INVEST_HELP);
  else if (/^(持股|持股清單|現股|現股清單|庫存|模擬持股|部位)$/.test(text)) investSay_(ctx, investHoldingsText_());
  else if (/^(交易紀錄|交易記錄|模擬交易|模擬|交易|委託|下單紀錄)$/.test(text)) investSay_(ctx, investTradesText_());
  else if (/^(報酬率|投資報酬率?|收益率?|績效|損益|權益)$/.test(text)) investSay_(ctx, investReturnText_());
  else if (/^(準確率|模型準確率|勝率|模型)$/.test(text)) investSay_(ctx, investAccuracyText_());
  else if (/^(選股|今日選股|股票|股票推薦|台股)$/.test(text)) investSay_(ctx, investStockText_());
  else if (/^(虛擬貨幣|加密貨幣|幣|幣圈)$/.test(text)) investSay_(ctx, investRecoText_('daily_crypto_recommendations', '🪙 虛擬貨幣推薦'));
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

function investLatest_(rows) {
  return rows.slice().sort((x, y) => (x.date < y.date ? -1 : 1)).pop();
}

function investMd_(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${Number(date.slice(5, 7))}/${Number(date.slice(8))}` : date;
}

function investUnit_(row) {
  return row.asset_type === '股票' ? ' 股' : '';
}

function investPendingLines_() {
  const pending = investRows_('sim_orders').filter((o) => o.side === 'buy' && o.status === 'pending');
  if (!pending.length) return [];
  return ['', '⏳ 待成交（下一個交易日開盤買進）'].concat(pending.map((o) => `${o.code} ${o.name}｜${investNum_(o.signal_score, 1)} 分`));
}

/** 目前模擬持股與每檔收益率 */
function investHoldingsText_() {
  const eq = investLatest_(investRows_('sim_equity'));
  if (!eq) return '📂 模擬持股\n還沒有資料，排程跑過一次之後才會有。';
  const holdings = investRows_('sim_holdings').sort((x, y) => Number(y.market_value) - Number(x.market_value));
  const lines = [`📂 模擬持股 ${eq.date}（${holdings.length} 檔）`];
  if (!holdings.length) lines.push('目前沒有持股。');
  else {
    const cost = holdings.reduce((sum, h) => sum + Number(h.cost), 0);
    const pnl = holdings.reduce((sum, h) => sum + Number(h.pnl), 0);
    lines.push(`持股市值 ${investNum_(eq.market_value)}`, `未實現 ${investSigned_(pnl, 0)}（${investSigned_(cost ? (pnl / cost) * 100 : 0)}%）`);
    holdings.forEach((h) => lines.push(
      '',
      `${Number(h.pnl) >= 0 ? '🟢' : '🔴'} ${h.code} ${h.name}`,
      `　收益率 ${investSigned_(h.pnl_pct)}%（${investSigned_(h.pnl, 0)}）`,
      `　${investNum_(h.qty, 8)}${investUnit_(h)}｜進 ${investNum_(h.entry_price, 8)} → 現 ${investNum_(h.last_price, 8)}`,
      `　${investMd_(h.entry_date)} 進場，持有 ${h.bars_held || '—'} 天｜市值 ${investNum_(h.market_value)}`,
      `　停損 ${investNum_(h.stop_price, 6)}／停利 ${investNum_(h.target_price, 6)}`,
    ));
  }
  return lines.concat(investPendingLines_(), ['', `現金 ${investNum_(eq.cash)}`, '⚠️ 純模擬，沒有實際下單']).join('\n');
}

/** 模擬買賣紀錄：最近的成交、出場損益、取消的委託 */
function investTradesText_() {
  const orders = investRows_('sim_orders');
  if (!orders.length) return '📝 模擬交易紀錄\n還沒有任何委託。';
  const positions = investRows_('sim_positions');
  const byId = Object.fromEntries(positions.map((p) => [p.id, p]));
  const filled = orders.filter((o) => o.status === 'filled')
    .sort((x, y) => (x.fill_date === y.fill_date ? Number(y.id) - Number(x.id) : x.fill_date < y.fill_date ? 1 : -1));
  const lines = [`📝 模擬交易紀錄（成交 ${filled.length} 筆）`];
  filled.slice(0, 12).forEach((o) => {
    const p = byId[o.position_id] || {};
    const head = `${investMd_(o.fill_date)} ${o.side === 'buy' ? '🟢 買進' : '📤 賣出'} ${o.code} ${o.name}`;
    const detail = `　${investNum_(o.qty, 8)}${investUnit_(o)} @ ${investNum_(o.price, 8)}｜金額 ${investNum_(o.amount)}`;
    lines.push('', head, o.side === 'sell' ? `${detail}\n　${o.reason}｜損益 ${investSigned_(p.pnl, 0)}（${investSigned_(p.pnl_pct)}%）` : detail);
  });
  if (filled.length > 12) lines.push('', `…更早的 ${filled.length - 12} 筆請看試算表`);
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  if (cancelled.length) lines.push('', `⚪ 取消 ${cancelled.length} 筆（現金不足）：${cancelled.slice(-5).map((o) => `${o.code} ${o.name}`).join('、')}`);
  return lines.concat(investPendingLines_(), ['', '⚠️ 純模擬，沒有實際下單']).join('\n');
}

/** 投資報酬率：總權益、累計／當日報酬率、已出場交易統計、近幾日走勢 */
function investReturnText_() {
  const history = investRows_('sim_equity').sort((x, y) => (x.date < y.date ? -1 : 1));
  const eq = history[history.length - 1];
  if (!eq) return '📈 投資報酬率\n還沒有資料，排程跑過一次之後才會有。';
  const initial = Number(eq.equity) / (1 + Number(eq.total_return_pct) / 100);
  const lines = [
    `📈 投資報酬率 ${eq.date}`,
    `總權益 ${investNum_(eq.equity)}（起始 ${investNum_(Math.round(initial / 1000) * 1000)}）`,
    `累計報酬率 ${investSigned_(eq.total_return_pct)}%`,
    `當日報酬率 ${investSigned_(eq.daily_return_pct)}%`,
    '',
    `現金 ${investNum_(eq.cash)}`,
    `持股市值 ${investNum_(eq.market_value)}（${eq.open_positions} 檔）`,
    `已實現損益 ${investSigned_(eq.realized_pnl, 0)}`,
    `未實現損益 ${investSigned_(eq.unrealized_pnl, 0)}`,
  ];
  const closed = investRows_('sim_positions').filter((p) => p.status === 'closed');
  if (closed.length) {
    const wins = closed.filter((p) => Number(p.pnl) > 0).length;
    const avg = closed.reduce((sum, p) => sum + Number(p.pnl_pct), 0) / closed.length;
    lines.push('', `已出場 ${closed.length} 筆｜勝率 ${investNum_((wins / closed.length) * 100, 1)}%｜平均 ${investSigned_(avg)}%`);
  } else lines.push('', '還沒有出場的交易。');
  if (history.length > 1) {
    lines.push('', '近幾日');
    history.slice(-7).reverse().forEach((e) => lines.push(`${investMd_(e.date)}　${investNum_(e.equity)}　${investSigned_(e.daily_return_pct)}%`));
  }
  return lines.concat(['', '⚠️ 純模擬，沒有實際下單']).join('\n');
}

/** 模型準確率：各種訊號之後實際漲跌 */
function investAccuracyText_() {
  const rows = investRows_('sim_accuracy');
  if (!rows.length) return '🎯 模型準確率\n還沒有資料，排程跑過一次之後才會有。';
  const get = (kind, horizon) => rows.find((r) => r.kind === kind && r.horizon === horizon) || { n: '0', win: '', avg: '' };
  const cell = (r) => (r.win === '' ? '—' : `${r.win}%（${r.n} 筆${r.avg === '' ? '' : `，平均 ${investSigned_(r.avg)}%`}）`);
  const lines = [`🎯 模型準確率 ${rows[0].date}`, `累計記錄 ${get('訊號數', '').n} 筆訊號`];
  ['BUY', 'WATCH', 'SKIP'].forEach((action) => lines.push(
    '',
    `【${action}】之後上漲的比例`,
    `　5 日：${cell(get(action, 't5'))}`,
    `　10 日：${cell(get(action, 't10'))}`,
    `　20 日：${cell(get(action, 't20'))}`,
    `　照策略操作：${cell(get(action, 'trade'))}`,
  ));
  lines.push('', `方向準確率（BUY 漲、SKIP 沒漲才算對）\n　5 日 ${cell(get('方向', 't5'))}｜20 日 ${cell(get('方向', 't20'))}`);
  if (Number(get('BUY', 't5').n) < 30) lines.push('', `BUY 目前只有 ${get('BUY', 't5').n} 筆走完 5 個交易日，少於 30 筆時數字還不可靠。`);
  lines.push('', 'BUY 明顯優於 SKIP 才代表模型有鑑別力。');
  return lines.join('\n');
}

/** 投資分析的排程呼叫：把文字推給綁定的人 */
function investPush_(body) {
  const text = String((body && body.text) || '').trim();
  const users = investUsers_();
  if (!text) return { ok: false, error: '沒有內容' };
  if (!users.length) return { ok: false, error: '還沒有人綁定投資日報（在 LINE 傳「綁定投資 <代碼>」）' };
  const failed = users.filter((to) => lineApi_('message/push', { to, messages: [textMsg_(text, investQuick_())] }).getResponseCode() !== 200);
  return failed.length ? { ok: false, error: `LINE 推播失敗 ${failed.length}/${users.length}` } : { ok: true, sent: users.length };
}
