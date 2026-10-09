/* ============================================================
 * 投資日報：跟「投資分析」專案（github.com/Froststin/invest-analysis）共用這個官方帳號
 *
 *  - 誰能用：INVEST_PUBLIC 為 true 時，所有好友都能查詢；每日推播仍只給綁定過的人
 *  - 推播：投資分析的每日排程 POST <網頁應用程式網址>?src=invest&key=<INVEST_PUSH_KEY>，
 *          body {"text": "..."}，只推給綁定過的人（INVEST_USERS），其他人不會收到
 *  - 查詢：綁定過的人傳「投資」叫出選單，點按鈕（或直接傳「持股」「交易紀錄」「報酬率」「準確率」
 *          「選股」「虛擬貨幣」）就讀投資分析的試算表回覆；每則回覆下方都帶同一排按鈕
 *  - 綁定：傳「綁定投資 <一次性代碼>」，代碼用過即失效
 *
 * 指令碼屬性：
 *   INVEST_SHEET_ID   投資分析的試算表
 *   INVEST_PUSH_KEY   推播用的金鑰
 *   INVEST_BIND_CODE  一次性綁定代碼（用過會清空）
 *   INVEST_USERS      綁定的 LINE userId（逗號分隔）
 *   INVEST_MENU_VERSION / INVEST_MENU_IDS / INVEST_MENU_TRIED_AT   投資分頁圖文選單（自動維護）
 *
 * 圖文選單：「旅遊｜投資」雙分頁選單（圖片由 tools/make_invest_menu.py 產生）。INVEST_PUBLIC 為 true 時是
 * 所有人的預設選單，false 時只有綁定的人會換成這組。改了圖或按鈕就把 INVEST_MENU_VERSION 加 1。
 * 從 true 改回 false 時，要把 Config.gs 的 RICHMENU_VERSION 加 1，讓預設選單重建回原本的旅遊選單。
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
  sim_equity: ['date', 'account', 'cash', 'market_value', 'equity', 'daily_return_pct', 'total_return_pct', 'open_positions',
    'realized_pnl', 'unrealized_pnl'],
  sim_holdings: ['snapshot', 'date', 'asset_type', 'code', 'name', 'entry_date', 'entry_price', 'qty', 'cost',
    'last_price', 'market_value', 'pnl', 'pnl_pct', 'stop_price', 'target_price', 'bars_held'],
  sim_accuracy: ['snapshot', 'date', 'account', 'kind', 'horizon', 'n', 'win', 'avg'],
  sim_params: ['date', 'account', 'params_json', 'reason', 'metrics_json', 'created_at'],
};

// true：官方帳號的所有好友都能查詢投資內容（選股、模擬交易、準確率），圖文選單也都有「投資」分頁。
// false：只有用代碼綁定過的人能用。每日推播不受這個設定影響，一律只推給綁定的人。
const INVEST_PUBLIC = true;

// 模擬交易有兩個獨立帳戶（各自的資金、報酬率、參數）；sim_equity 另有一列「合計」
const INVEST_ACCOUNTS = ['股票', '虛擬貨幣'];
// 還沒優化過的帳戶用這組預設參數（要跟投資分析 stock_reco/config.py 的 CONFIG 一致）
const INVEST_DEFAULT_PARAMS = { min_tech_score_for_signal: 60, target_return: 0.1, stop_loss: 0.08, hold_days: 20 };

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
  const eq = investEquity_().pop();
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

/** 某個帳戶（預設「合計」）的每日權益，由舊到新 */
function investEquity_(account) {
  const name = account || '合計';
  return investRows_('sim_equity').filter((e) => e.account === name).sort((x, y) => (x.date < y.date ? -1 : 1));
}

/** 某個帳戶目前的策略參數，以及上次優化的日期與原因 */
function investParams_(account) {
  const row = investRows_('sim_params').filter((r) => r.account === account)
    .sort((x, y) => (x.date + x.created_at < y.date + y.created_at ? -1 : 1)).pop();
  let values = INVEST_DEFAULT_PARAMS;
  try {
    if (row) values = Object.assign({}, INVEST_DEFAULT_PARAMS, JSON.parse(row.params_json || '{}'));
  } catch (err) {
    values = INVEST_DEFAULT_PARAMS;
  }
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  return {
    text: `進場技術分 ≥ ${values.min_tech_score_for_signal}｜停利 +${pct(values.target_return)}｜停損 -${pct(values.stop_loss)}｜最長 ${values.hold_days} 天`,
    note: row ? `${investMd_(row.date)} 檢查：${row.reason}` : '預設參數，還沒有優化過',
  };
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

/** 金額：一千以上取整數，小額保留兩位（起始資金小的時候，損益常常只有幾十元） */
function investMoney_(text, signed) {
  const n = Number(text);
  if (text === '' || text == null || !isFinite(n)) return '—';
  const d = Math.abs(n) >= 1000 ? 0 : 2;
  return (signed && n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
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
    investLinkMenu_(ctx.userId);
    say_(ctx, textMsg_(`✅ 已綁定投資日報。\n\n${INVEST_HELP}`));
    return true;
  }
  if (!(INVEST_PUBLIC || investUsers_().includes(ctx.userId)) || !prop_('INVEST_SHEET_ID')) return false;

  let view = '';
  if (/^(投資|投資選單|投資日報|投資功能)$/.test(text)) {
    say_(ctx, withQuick_(investMenuFlex_(), investQuick_()), INVEST_HELP);
  } else if (/^(投資說明|投資指令)$/.test(text)) investSay_(ctx, INVEST_HELP);
  else if (/^(持股|持股清單|持股損益|現股|現股清單|庫存|模擬持股|部位|未實現損益)$/.test(text)) view = 'holdings';
  else if (/^(交易紀錄|交易記錄|模擬交易|模擬|交易|委託|下單紀錄|已實現損益|損益表)$/.test(text)) view = 'trades';
  else if (/^(報酬率|投資報酬率?|收益率?|績效|損益|權益|每日損益)$/.test(text)) view = 'returns';
  else if (/^(準確率|模型準確率|勝率|模型)$/.test(text)) view = 'accuracy';
  else if (/^(選股|今日選股|股票|股票推薦|台股)$/.test(text)) view = 'stocks';
  else if (/^(虛擬貨幣|加密貨幣|幣|幣圈)$/.test(text)) view = 'crypto';
  else return false;
  if (view) {
    const v = investView_(view);
    say_(ctx, withQuick_(v.flex, investQuick_()), v.text); // Flex 被 LINE 拒絕時自動改回純文字
  }
  return true;
}

const INVEST_VIEWS = {
  holdings: () => ({ flex: investHoldingsFlex_(), text: investHoldingsText_() }),
  trades: () => ({ flex: investTradesFlex_(), text: investTradesText_() }),
  returns: () => ({ flex: investReturnFlex_(), text: investReturnText_() }),
  accuracy: () => ({ flex: investAccuracyFlex_(), text: investAccuracyText_() }),
  stocks: () => ({ flex: investRecoFlex_('daily_recommendations', '📊 今日選股'), text: investStockText_() }),
  crypto: () => ({ flex: investRecoFlex_('daily_crypto_recommendations', '🪙 虛擬貨幣推薦'), text: investRecoText_('daily_crypto_recommendations', '🪙 虛擬貨幣推薦') }),
};

function investView_(name) {
  return INVEST_VIEWS[name]();
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

/** 目前持股：先依帳戶（股票在前），同帳戶內依市值由大到小 */
function investHoldings_() {
  return investRows_('sim_holdings').sort((x, y) =>
    (INVEST_ACCOUNTS.indexOf(x.asset_type) - INVEST_ACCOUNTS.indexOf(y.asset_type)) || (Number(y.market_value) - Number(x.market_value)));
}

function investAccountCash_(account) {
  const row = investEquity_(account).pop();
  return row ? `${account}帳戶｜權益 ${investMoney_(row.equity)}｜現金 ${investMoney_(row.cash)}` : `${account}帳戶`;
}

/** 目前模擬持股與每檔收益率 */
function investHoldingsText_() {
  const eq = investEquity_().pop();
  if (!eq) return '📂 模擬持股\n還沒有資料，排程跑過一次之後才會有。';
  const holdings = investHoldings_();
  const lines = [`📂 模擬持股 ${eq.date}（${holdings.length} 檔）`];
  if (!holdings.length) lines.push('目前沒有持股。');
  else {
    const cost = holdings.reduce((sum, h) => sum + Number(h.cost), 0);
    const pnl = holdings.reduce((sum, h) => sum + Number(h.pnl), 0);
    lines.push(`持股市值 ${investNum_(eq.market_value)}`, `未實現 ${investMoney_(pnl, true)}（${investSigned_(cost ? (pnl / cost) * 100 : 0)}%）`);
    holdings.forEach((h, i) => lines.push(
      ...(i === 0 || holdings[i - 1].asset_type !== h.asset_type ? ['', `【${investAccountCash_(h.asset_type)}】`] : []),
      '',
      `${Number(h.pnl) >= 0 ? '🟢' : '🔴'} ${h.code} ${h.name}`,
      `　收益率 ${investSigned_(h.pnl_pct)}%（${investMoney_(h.pnl, true)}）`,
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
    lines.push('', head, o.side === 'sell' ? `${detail}\n　${o.reason}｜損益 ${investMoney_(p.pnl, true)}（${investSigned_(p.pnl_pct)}%）` : detail);
  });
  if (filled.length > 12) lines.push('', `…更早的 ${filled.length - 12} 筆請看試算表`);
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  if (cancelled.length) lines.push('', `⚪ 取消 ${cancelled.length} 筆（現金不足）：${cancelled.slice(-5).map((o) => `${o.code} ${o.name}`).join('、')}`);
  return lines.concat(investPendingLines_(), ['', '⚠️ 純模擬，沒有實際下單']).join('\n');
}

/** 投資報酬率：總權益、累計／當日報酬率、已出場交易統計、近幾日走勢 */
function investReturnText_() {
  const history = investEquity_();
  const eq = history[history.length - 1];
  if (!eq) return '📈 投資報酬率\n還沒有資料，排程跑過一次之後才會有。';
  const initial = Number(eq.equity) / (1 + Number(eq.total_return_pct) / 100);
  const lines = [
    `📈 投資報酬率 ${eq.date}`,
    `總權益 ${investNum_(eq.equity)}（起始 ${investNum_(Math.round(initial / 1000) * 1000)}）`,
    `累計報酬率 ${investSigned_(eq.total_return_pct)}%`,
    `當日報酬率 ${investSigned_(eq.daily_return_pct)}%`,
    '',
    ...INVEST_ACCOUNTS.map((a) => {
      const r = investEquity_(a).pop();
      return r ? `【${a}】權益 ${investMoney_(r.equity)}｜累計 ${investSigned_(r.total_return_pct)}%｜當日 ${investSigned_(r.daily_return_pct)}%` : `【${a}】還沒有資料`;
    }),
    '',
    `現金 ${investNum_(eq.cash)}`,
    `持股市值 ${investNum_(eq.market_value)}（${eq.open_positions} 檔）`,
    `已實現損益 ${investMoney_(eq.realized_pnl, true)}`,
    `未實現損益 ${investMoney_(eq.unrealized_pnl, true)}`,
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

/** 某個帳戶的準確率查詢函式：get(kind, horizon) */
function investAccuracyOf_(rows, account) {
  return (kind, horizon) => rows.find((r) => r.account === account && r.kind === kind && r.horizon === horizon) || { n: '0', win: '', avg: '' };
}

/** 模型準確率：各種訊號之後實際漲跌，兩個帳戶分開看 */
function investAccuracyText_() {
  const rows = investRows_('sim_accuracy');
  if (!rows.length) return '🎯 模型準確率\n還沒有資料，排程跑過一次之後才會有。';
  const cell = (r) => (r.win === '' ? '—' : `${r.win}%（${r.n} 筆${r.avg === '' ? '' : `，平均 ${investSigned_(r.avg)}%`}）`);
  const lines = [`🎯 模型準確率 ${rows[0].date}`];
  INVEST_ACCOUNTS.forEach((account) => {
    const get = investAccuracyOf_(rows, account);
    const prm = investParams_(account);
    lines.push('', `━━ ${account}（${get('訊號數', '').n} 筆訊號）━━`, `參數：${prm.text}`, `　${prm.note}`);
    ['BUY', 'WATCH', 'SKIP'].forEach((action) => lines.push(
      `【${action}】5 日 ${cell(get(action, 't5'))}｜20 日 ${cell(get(action, 't20'))}｜照策略 ${cell(get(action, 'trade'))}`,
    ));
    lines.push(`方向準確率 5 日 ${cell(get('方向', 't5'))}`);
    if (Number(get('BUY', 't5').n) < 30) lines.push(`BUY 目前只有 ${get('BUY', 't5').n} 筆走完 5 個交易日，少於 30 筆時數字還不可靠。`);
  });
  lines.push('', 'BUY 明顯優於 SKIP 才代表模型有鑑別力。帳戶表現過低時會自動重新挑參數。');
  return lines.join('\n');
}

/* ---------- Flex 表格卡片（台股慣例：賺錢紅色、賠錢綠色） ---------- */
const INV = { up: '#D62F2F', down: '#1E9E4A', flat: '#888888', warn: '#E08A00', head: '#0F6E66', sub: '#777777', text: '#222222' };

function invColor_(value) {
  const n = Number(value);
  return value === '' || value == null || !isFinite(n) || n === 0 ? INV.flat : n > 0 ? INV.up : INV.down;
}

function invT_(text, opt) {
  const str = String(text == null ? '' : text);
  return Object.assign({ type: 'text', text: str === '' ? '—' : str, size: 'sm', color: INV.text }, opt || {});
}

function invRow_(cells, opt) {
  return Object.assign({ type: 'box', layout: 'horizontal', margin: 'md', contents: cells }, opt || {});
}

/** 表頭：labels 與 flexes 一一對應；第一欄靠左，其餘靠右 */
function invHead_(labels, flexes) {
  return invRow_(labels.map((l, i) => invT_(l, { size: 'xs', color: INV.sub, flex: flexes[i], align: i ? 'end' : 'start' })), { margin: 'lg' });
}

function invSep_() {
  return { type: 'separator', margin: 'sm' };
}

/** 橫條：ratio 0~1 */
function invBar_(ratio, color) {
  const w = Math.max(2, Math.min(100, Math.round((isFinite(ratio) ? ratio : 0) * 100)));
  return {
    type: 'box', layout: 'vertical', margin: 'xs', height: '6px', backgroundColor: '#EEEEEE', cornerRadius: '3px',
    contents: [{ type: 'box', layout: 'vertical', width: `${w}%`, height: '6px', backgroundColor: color, cornerRadius: '3px', contents: [{ type: 'filler' }] }],
  };
}

function invKv_(label, value, color) {
  return invRow_([invT_(label, { color: INV.sub, flex: 4 }), invT_(value, { flex: 6, align: 'end', weight: 'bold', color: color || INV.text })], { margin: 'sm' });
}

function invBubble_(title, sub, contents) {
  return flexMsg_(`${title} ${sub}`, {
    type: 'bubble', size: 'giga',
    header: { type: 'box', layout: 'vertical', backgroundColor: INV.head, paddingAll: '14px',
      contents: [invT_(title, { color: '#FFFFFF', weight: 'bold', size: 'lg' }), invT_(sub, { color: '#CFEDE9', size: 'xs', margin: 'xs' })] },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px',
      contents: contents.concat([invT_('純模擬，沒有實際下單', { size: 'xxs', color: '#AAAAAA', margin: 'lg', align: 'end' })]) },
  });
}

function invPct_(value) {
  return value === '' || value == null ? '—' : `${investSigned_(value)}%`;
}

/** 持股損益表（未實現） */
function investHoldingsFlex_() {
  const eq = investEquity_().pop();
  if (!eq) return invBubble_('📂 持股損益表', '還沒有資料', [invT_('排程跑過一次之後才會有。', { color: INV.sub })]);
  const holdings = investHoldings_();
  const cost = holdings.reduce((sum, h) => sum + Number(h.cost), 0);
  const pnl = holdings.reduce((sum, h) => sum + Number(h.pnl), 0);
  const maxAbs = Math.max.apply(null, holdings.map((h) => Math.abs(Number(h.pnl_pct))).concat([1]));
  const body = [
    invRow_([
      { type: 'box', layout: 'vertical', flex: 1, contents: [invT_('持股市值', { size: 'xs', color: INV.sub }), invT_(investMoney_(eq.market_value), { size: 'xl', weight: 'bold' })] },
      { type: 'box', layout: 'vertical', flex: 1, contents: [invT_('未實現損益', { size: 'xs', color: INV.sub, align: 'end' }),
        invT_(holdings.length ? `${investMoney_(pnl, true)}（${invPct_(cost ? (pnl / cost) * 100 : 0)}）` : '—', { size: 'md', weight: 'bold', align: 'end', color: invColor_(pnl) })] },
    ], { margin: 'none' }),
  ];
  if (!holdings.length) body.push(invT_('目前沒有持股。', { color: INV.sub, margin: 'lg' }));
  else {
    body.push(invHead_(['標的', '現價', '損益', '收益率'], [5, 3, 3, 3]), invSep_());
    holdings.forEach((h, i) => {
      const color = invColor_(h.pnl);
      if (i === 0 || holdings[i - 1].asset_type !== h.asset_type) {
        body.push(invT_(investAccountCash_(h.asset_type), { size: 'xs', weight: 'bold', color: INV.head, margin: 'lg', wrap: true }));
      }
      body.push(
        invRow_([
          invT_(`${h.name} ${h.code}`, { flex: 5, weight: 'bold', wrap: true }),
          invT_(investNum_(h.last_price, 8), { flex: 3, align: 'end' }),
          invT_(investMoney_(h.pnl, true), { flex: 3, align: 'end', color }),
          invT_(invPct_(h.pnl_pct), { flex: 3, align: 'end', color, weight: 'bold' }),
        ]),
        invBar_(Math.abs(Number(h.pnl_pct)) / maxAbs, color),
        invT_(`${investNum_(h.qty, 8)}${investUnit_(h)}｜進 ${investNum_(h.entry_price, 8)}（${investMd_(h.entry_date)}，${h.bars_held || '—'} 天）｜停損 ${investNum_(h.stop_price, 6)}／停利 ${investNum_(h.target_price, 6)}`,
          { size: 'xxs', color: INV.sub, wrap: true, margin: 'xs' }),
      );
    });
  }
  const pending = investRows_('sim_orders').filter((o) => o.side === 'buy' && o.status === 'pending');
  if (pending.length) body.push(invSep_(), invT_(`⏳ 待成交：${pending.map((o) => `${o.name} ${o.code}`).join('、')}`, { size: 'xs', color: INV.sub, wrap: true, margin: 'md' }));
  body.push(invKv_('現金', investMoney_(eq.cash)));
  return invBubble_('📂 持股損益表', `${eq.date}｜持有 ${holdings.length} 檔`, body);
}

/** 投資報酬率與每日損益表 */
function investReturnFlex_() {
  const history = investEquity_();
  const eq = history[history.length - 1];
  if (!eq) return invBubble_('📈 投資報酬率', '還沒有資料', [invT_('排程跑過一次之後才會有。', { color: INV.sub })]);
  const initial = Number(eq.equity) / (1 + Number(eq.total_return_pct) / 100);
  const closed = investRows_('sim_positions').filter((p) => p.status === 'closed');
  const wins = closed.filter((p) => Number(p.pnl) > 0).length;
  const body = [
    invRow_([
      { type: 'box', layout: 'vertical', flex: 1, contents: [invT_('累計報酬率', { size: 'xs', color: INV.sub }), invT_(invPct_(eq.total_return_pct), { size: 'xxl', weight: 'bold', color: invColor_(eq.total_return_pct) })] },
      { type: 'box', layout: 'vertical', flex: 1, contents: [invT_('當日報酬率', { size: 'xs', color: INV.sub, align: 'end' }), invT_(invPct_(eq.daily_return_pct), { size: 'xl', weight: 'bold', align: 'end', color: invColor_(eq.daily_return_pct) })] },
    ], { margin: 'none' }),
    invHead_(['帳戶', '權益', '當日', '累計'], [3, 4, 3, 3]),
    invSep_(),
  ].concat(INVEST_ACCOUNTS.map((a) => {
    const r = investEquity_(a).pop() || {};
    return invRow_([
      invT_(a, { flex: 3, weight: 'bold' }),
      invT_(investMoney_(r.equity), { flex: 4, align: 'end' }),
      invT_(invPct_(r.daily_return_pct), { flex: 3, align: 'end', color: invColor_(r.daily_return_pct) }),
      invT_(invPct_(r.total_return_pct), { flex: 3, align: 'end', weight: 'bold', color: invColor_(r.total_return_pct) }),
    ]);
  })).concat([
    invSep_(),
    invKv_('合計權益', investMoney_(eq.equity)),
    invKv_('起始資金', investMoney_(Math.round(initial))),
    invKv_('累計損益', investMoney_(Number(eq.equity) - initial, true), invColor_(Number(eq.equity) - initial)),
    invKv_('現金', investMoney_(eq.cash)),
    invKv_(`持股市值（${eq.open_positions} 檔）`, investMoney_(eq.market_value)),
    invKv_('已實現損益', investMoney_(eq.realized_pnl, true), invColor_(eq.realized_pnl)),
    invKv_('未實現損益', investMoney_(eq.unrealized_pnl, true), invColor_(eq.unrealized_pnl)),
    invKv_('已出場交易', closed.length ? `${closed.length} 筆｜勝率 ${investNum_((wins / closed.length) * 100, 1)}%` : '還沒有'),
  ]);
  const days = history.slice(-10);
  if (days.length > 1) {
    const maxAbs = Math.max.apply(null, days.map((e) => Math.abs(Number(e.daily_return_pct))).concat([0.5]));
    body.push(invT_('每日損益表', { weight: 'bold', margin: 'xl' }), invHead_(['日期', '總權益', '當日損益', '當日'], [2, 4, 4, 3]), invSep_());
    days.slice().reverse().forEach((e) => {
      const i = history.indexOf(e);
      const prev = i > 0 ? Number(history[i - 1].equity) : initial;
      const color = invColor_(e.daily_return_pct);
      body.push(
        invRow_([
          invT_(investMd_(e.date), { flex: 2 }),
          invT_(investMoney_(e.equity), { flex: 4, align: 'end' }),
          invT_(investMoney_(Number(e.equity) - prev, true), { flex: 4, align: 'end', color }),
          invT_(invPct_(e.daily_return_pct), { flex: 3, align: 'end', color, weight: 'bold' }),
        ]),
        invBar_(Math.abs(Number(e.daily_return_pct)) / maxAbs, color),
      );
    });
  }
  return invBubble_('📈 投資報酬率', eq.date, body);
}

/** 已實現損益表與成交紀錄 */
function investTradesFlex_() {
  const orders = investRows_('sim_orders');
  const positions = investRows_('sim_positions');
  const closed = positions.filter((p) => p.status === 'closed').sort((x, y) => (x.exit_date < y.exit_date ? 1 : -1));
  const filled = orders.filter((o) => o.status === 'filled')
    .sort((x, y) => (x.fill_date === y.fill_date ? Number(y.id) - Number(x.id) : x.fill_date < y.fill_date ? 1 : -1));
  const body = [invT_('已實現損益表', { weight: 'bold' })];
  if (!closed.length) body.push(invT_('還沒有出場的交易。', { color: INV.sub, size: 'xs', margin: 'sm' }));
  else {
    const total = closed.reduce((sum, p) => sum + Number(p.pnl), 0);
    const wins = closed.filter((p) => Number(p.pnl) > 0).length;
    body.push(invHead_(['出場', '標的', '原因', '損益', '報酬'], [2, 4, 3, 3, 3]), invSep_());
    closed.slice(0, 8).forEach((p) => body.push(invRow_([
      invT_(investMd_(p.exit_date), { flex: 2 }),
      invT_(`${p.name} ${p.code}`, { flex: 4, wrap: true }),
      invT_(p.exit_reason, { flex: 3, align: 'end', size: 'xs', color: /停利/.test(p.exit_reason) ? INV.up : /停損/.test(p.exit_reason) ? INV.down : INV.sub }),
      invT_(investMoney_(p.pnl, true), { flex: 3, align: 'end', color: invColor_(p.pnl) }),
      invT_(invPct_(p.pnl_pct), { flex: 3, align: 'end', weight: 'bold', color: invColor_(p.pnl_pct) }),
    ])));
    body.push(invSep_(), invKv_(`合計 ${closed.length} 筆｜勝率 ${investNum_((wins / closed.length) * 100, 1)}%`, investMoney_(total, true), invColor_(total)));
  }
  body.push(invT_('成交紀錄', { weight: 'bold', margin: 'xl' }));
  if (!filled.length) body.push(invT_('還沒有成交。', { color: INV.sub, size: 'xs', margin: 'sm' }));
  else {
    body.push(invHead_(['日期', '買賣', '標的', '價格', '數量'], [2, 2, 4, 3, 3]), invSep_());
    filled.slice(0, 10).forEach((o) => body.push(invRow_([
      invT_(investMd_(o.fill_date), { flex: 2 }),
      invT_(o.side === 'buy' ? '買進' : '賣出', { flex: 2, align: 'end', weight: 'bold', color: o.side === 'buy' ? INV.up : INV.down }),
      invT_(`${o.name} ${o.code}`, { flex: 4, align: 'end', wrap: true }),
      invT_(investNum_(o.price, 8), { flex: 3, align: 'end' }),
      invT_(investNum_(o.qty, 8), { flex: 3, align: 'end' }),
    ])));
    if (filled.length > 10) body.push(invT_(`…更早的 ${filled.length - 10} 筆請看試算表`, { size: 'xxs', color: INV.sub, margin: 'sm' }));
  }
  const pending = orders.filter((o) => o.side === 'buy' && o.status === 'pending');
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  if (pending.length) body.push(invT_(`⏳ 待成交：${pending.map((o) => `${o.name} ${o.code}`).join('、')}`, { size: 'xs', color: INV.sub, wrap: true, margin: 'lg' }));
  if (cancelled.length) body.push(invT_(`⚪ 現金不足取消 ${cancelled.length} 筆：${cancelled.slice(-5).map((o) => `${o.name} ${o.code}`).join('、')}`, { size: 'xs', color: INV.sub, wrap: true, margin: 'sm' }));
  return invBubble_('📝 交易與已實現損益', `成交 ${filled.length} 筆｜出場 ${closed.length} 筆`, body);
}

/** 模型準確率：兩個帳戶各一張表與目前參數；勝率五成以上紅色、以下綠色 */
function investAccuracyFlex_() {
  const rows = investRows_('sim_accuracy');
  if (!rows.length) return invBubble_('🎯 模型準確率', '還沒有資料', [invT_('排程跑過一次之後才會有。', { color: INV.sub })]);
  const winColor = (r) => (r.win === '' ? INV.flat : Number(r.win) >= 50 ? INV.up : INV.down);
  const horizons = ['t5', 't10', 't20', 'trade'];
  const body = [invT_('各種訊號之後上漲的比例（括號是樣本數）', { size: 'xs', color: INV.sub, wrap: true })];
  INVEST_ACCOUNTS.forEach((account, i) => {
    const get = investAccuracyOf_(rows, account);
    const prm = investParams_(account);
    body.push(
      invT_(`${account}｜${get('訊號數', '').n} 筆訊號`, { weight: 'bold', color: INV.head, margin: i ? 'xl' : 'lg' }),
      invT_(`參數：${prm.text}`, { size: 'xxs', color: INV.text, wrap: true, margin: 'xs' }),
      invT_(prm.note, { size: 'xxs', color: INV.sub, wrap: true, margin: 'xs' }),
      invHead_(['訊號', '5 日', '10 日', '20 日', '照策略'], [3, 3, 3, 3, 3]), invSep_(),
    );
    ['BUY', 'WATCH', 'SKIP'].forEach((action) => {
      body.push(
        invRow_([invT_(action, { flex: 3, weight: 'bold' })].concat(horizons.map((h) => {
          const r = get(action, h);
          return invT_(r.win === '' ? '—' : `${r.win}%`, { flex: 3, align: 'end', weight: 'bold', color: winColor(r) });
        }))),
        invRow_([invT_('平均報酬', { flex: 3, size: 'xxs', color: INV.sub })].concat(horizons.map((h) => {
          const r = get(action, h);
          return invT_(r.win === '' ? `（${r.n}）` : `${investSigned_(r.avg)}%（${r.n}）`, { flex: 3, align: 'end', size: 'xxs', color: r.avg === '' ? INV.sub : invColor_(r.avg) });
        })), { margin: 'xs' }),
      );
    });
    body.push(invRow_([invT_('方向', { flex: 3, weight: 'bold', size: 'xs' })].concat(['t5', 't10', 't20'].map((h) => {
      const r = get('方向', h);
      return invT_(r.win === '' ? '—' : `${r.win}%`, { flex: 3, align: 'end', weight: 'bold', size: 'xs', color: winColor(r) });
    })).concat([invT_(' ', { flex: 3 })])));
    const matured = Number(get('BUY', 't5').n);
    if (matured < 30) body.push(invT_(`BUY 只有 ${matured} 筆走完 5 個交易日，少於 30 筆時數字還不可靠。`, { size: 'xxs', color: INV.sub, wrap: true, margin: 'sm' }));
  });
  body.push(invT_('BUY 明顯優於 SKIP 才代表模型有鑑別力。帳戶表現過低時會自動重新挑參數。', { size: 'xxs', color: INV.sub, wrap: true, margin: 'lg' }));
  return invBubble_('🎯 模型準確率', rows[0].date, body);
}

/** 選股／虛擬貨幣推薦表 */
function investRecoFlex_(table, title) {
  const rows = investRows_(table);
  if (!rows.length) return invBubble_(title, '還沒有資料', [invT_('排程跑過一次之後才會有。', { color: INV.sub })]);
  const date = rows.map((r) => r.trade_date).sort().pop();
  const picks = rows.filter((r) => r.trade_date === date).sort((x, y) => Number(x.rank_no) - Number(y.rank_no));
  const levelColor = (level) => (level === '強烈進場訊號' ? INV.up : level === '可觀察' ? INV.warn : INV.flat);
  const body = [];
  if (table === 'daily_recommendations') {
    const trend = investRows_('market_trend_snapshot').sort((x, y) => (x.trade_date < y.trade_date ? -1 : 1)).pop();
    if (trend) body.push(invT_(`觀察池氛圍：${trend.trend_label}（${trend.bullish_count}/${trend.total_candidates} 檔技術分達標）`, { size: 'xs', color: INV.sub, wrap: true }));
  }
  body.push(invHead_(['標的', '評等', '分數', '收盤'], [5, 4, 2, 3]), invSep_());
  picks.forEach((r) => body.push(
    invRow_([
      invT_(`${r.rank_no}. ${r.name} ${r.code}`, { flex: 5, weight: 'bold', wrap: true }),
      invT_(r.level, { flex: 4, align: 'end', size: 'xs', weight: 'bold', color: levelColor(r.level) }),
      invT_(investNum_(r.score, 1), { flex: 2, align: 'end' }),
      invT_(investNum_(r.close, 8), { flex: 3, align: 'end' }),
    ]),
    invBar_(Number(r.score) / 100, levelColor(r.level)),
  ));
  body.push(invT_('程式依規則產生，僅供參考，非投資建議', { size: 'xxs', color: INV.sub, margin: 'lg', wrap: true }));
  return invBubble_(title, date, body);
}

/**
 * 投資分析的排程呼叫：把內容推給綁定的人
 *   body.text      文字訊息
 *   body.views     要附上的表格卡片（holdings／returns／trades／accuracy／stocks／crypto，最多 4 張）
 *   body.validate  true 時只請 LINE 檢查訊息格式，不真的送出
 */
function investPush_(body) {
  const text = String((body && body.text) || '').trim();
  const views = [].concat((body && body.views) || []).filter((v) => INVEST_VIEWS[v]).slice(0, 4);
  const users = investUsers_();
  if (!text && !views.length) return { ok: false, error: '沒有內容' };
  const cards = views.map((v) => investView_(v).flex);
  const build = (list) => { const m = list.slice(); withQuick_(m[m.length - 1], investQuick_()); return m; };
  const full = build((text ? [textMsg_(text)] : []).concat(cards));
  if (body.validate) {
    const res = lineApi_('message/validate/push', { messages: full });
    return res.getResponseCode() === 200 ? { ok: true, validated: full.length } : { ok: false, error: `LINE 不接受這個格式：${res.getContentText()}` };
  }
  if (!users.length) return { ok: false, error: '還沒有人綁定投資日報（在 LINE 傳「綁定投資 <代碼>」）' };
  // 呼叫端沒收到回應而重試時（rid 相同）不再推一次，避免同一則日報收到兩遍
  const rid = /^[0-9a-f]{8,32}$/.test(String(body.rid || '')) ? `invest_rid_${body.rid}` : '';
  const cache = CacheService.getScriptCache();
  if (rid && cache.get(rid)) return { ok: true, sent: users.length, duplicate: true };
  if (rid) cache.put(rid, '1', 21600);
  let fallback = false;
  const failed = users.filter((to) => {
    let res = lineApi_('message/push', { to, messages: full });
    if (res.getResponseCode() === 400 && cards.length && text) { // 卡片格式被拒絕：至少把文字送到
      fallback = true;
      res = lineApi_('message/push', { to, messages: build([textMsg_(text)]) });
    }
    return res.getResponseCode() !== 200;
  });
  if (failed.length) return { ok: false, error: `LINE 推播失敗 ${failed.length}/${users.length}` };
  return { ok: true, sent: users.length, cards: fallback ? 0 : cards.length };
}

/* ---------- 圖文選單：「旅遊｜投資」雙分頁，只給綁定的人 ---------- */
const INVEST_MENU_VERSION = '1';
const INVEST_MENU_ALIAS = { travel: 'invest-tab-travel', invest: 'invest-tab-invest' };

function investMenuIds_() {
  return prop_('INVEST_MENU_IDS').split(',').filter(Boolean);
}

/** 版本不同時自動重建一次；失敗不影響正常使用，10 分鐘後再試 */
function ensureInvestMenu_() {
  const scope = INVEST_PUBLIC ? 'all' : 'bound';
  const done = () => prop_('INVEST_MENU_VERSION') === INVEST_MENU_VERSION && prop_('INVEST_MENU_SCOPE') === scope;
  if (done() || (!INVEST_PUBLIC && !investUsers_().length) || !prop_('CHANNEL_ACCESS_TOKEN')) return;
  if (Date.now() - Number(prop_('INVEST_MENU_TRIED_AT') || 0) < 10 * 60 * 1000) return;
  withLock_(() => {
    if (done()) return;
    const props = PropertiesService.getScriptProperties();
    props.setProperty('INVEST_MENU_TRIED_AT', String(Date.now()));
    try {
      if (prop_('INVEST_MENU_VERSION') !== INVEST_MENU_VERSION) setupInvestMenus_();
      if (INVEST_PUBLIC) {
        // 開放給所有好友：把雙分頁選單設成整個官方帳號的預設選單
        const res = lineApi_(`user/all/richmenu/${investMenuIds_()[0]}`, null, 'post');
        if (res.getResponseCode() !== 200) throw new Error(`套用預設圖文選單失敗：${res.getContentText()}`);
      }
      props.setProperty('INVEST_MENU_SCOPE', scope);
    } catch (err) {
      console.error(`投資圖文選單重建失敗：${err && err.message}`);
    }
  });
}

function setupInvestMenus_() {
  const TAB_H = 250;
  const ROW_H = 718;
  const cols = (n, row) => Array.from({ length: n }, (_, c) => {
    const x = Math.round((c * 2500) / n);
    return { x, y: TAB_H + row * ROW_H, width: Math.round(((c + 1) * 2500) / n) - x, height: ROW_H };
  });
  const tabs = ['travel', 'invest'].map((name, i) => ({
    bounds: { x: i * 1250, y: 0, width: 1250, height: TAB_H },
    action: { type: 'richmenuswitch', richMenuAliasId: INVEST_MENU_ALIAS[name], data: `invest-menu:${name}` },
  }));
  const defs = {
    travel: { name: '旅程手帖選單（含投資分頁）', chatBarText: '旅程選單',
      areas: cols(3, 0).concat(cols(4, 1)).map((bounds, i) => ({ bounds, action: travelMenuActions_()[i] })) },
    invest: { name: '投資選單', chatBarText: '投資選單',
      areas: cols(3, 0).concat(cols(3, 1)).map((bounds, i) => ({ bounds, action: { type: 'message', text: INVEST_MENU[i][1] } })) },
  };
  // 先確認兩張圖都抓得到，再建立選單，避免留下沒有圖片的空選單
  const images = {};
  Object.keys(defs).forEach((name) => {
    const url = `${SITE_URL}gas/investmenu-${name}-v${INVEST_MENU_VERSION}.png`;
    const img = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (img.getResponseCode() !== 200) throw new Error(`抓不到圖文選單圖片（${img.getResponseCode()}）：${url}`);
    images[name] = img.getBlob().getBytes();
  });

  const ids = {};
  const rollback = (message) => {
    Object.values(ids).forEach((id) => lineApi_(`richmenu/${id}`, null, 'delete')); // 不留半成品
    throw new Error(message);
  };
  Object.keys(defs).forEach((name) => {
    const res = lineApi_('richmenu', Object.assign({ size: { width: 2500, height: 1686 }, selected: true }, defs[name], { areas: tabs.concat(defs[name].areas) }));
    if (res.getResponseCode() !== 200) rollback(`建立投資圖文選單失敗：${res.getContentText()}`);
    ids[name] = JSON.parse(res.getContentText()).richMenuId;
    const up = lineFetch_(`https://api-data.line.me/v2/bot/richmenu/${ids[name]}/content`, { method: 'post', contentType: 'image/png', payload: images[name] });
    if (up.getResponseCode() !== 200) rollback(`上傳投資圖文選單圖片失敗：${up.getContentText()}`);
  });
  // 分頁切換靠別名：已經有就改指到新選單，沒有就建立
  Object.keys(ids).forEach((name) => {
    const alias = INVEST_MENU_ALIAS[name];
    if (lineApi_(`richmenu/alias/${alias}`, { richMenuId: ids[name] }).getResponseCode() === 200) return;
    const made = lineApi_('richmenu/alias', { richMenuAliasId: alias, richMenuId: ids[name] });
    if (made.getResponseCode() !== 200) rollback(`設定圖文選單分頁失敗：${made.getContentText()}`);
  });

  const old = investMenuIds_();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('INVEST_MENU_IDS', `${ids.travel},${ids.invest}`);
  props.setProperty('INVEST_MENU_VERSION', INVEST_MENU_VERSION);
  investUsers_().forEach(investLinkMenu_);
  old.forEach((id) => lineApi_(`richmenu/${id}`, null, 'delete'));
  console.log(`投資圖文選單已建立：${ids.travel}／${ids.invest}`);
}

/** 把某個人的圖文選單換成雙分頁版（預設停在「旅遊」分頁）；選單還沒建立時先不動，下次會自動補上 */
function investLinkMenu_(userId) {
  const travelId = investMenuIds_()[0];
  if (travelId) lineApi_(`user/${userId}/richmenu/${travelId}`, null, 'post');
}
