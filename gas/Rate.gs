/* ============================================================
 * 日幣匯率：臺灣銀行現金賣出（FinMind 每日整理），抓不到時用國際參考匯率
 * FinMind 常封鎖 Google 的共用 IP，所以網站會在使用者的瀏覽器直接查，
 * 再回報給這裡（reportRate_，與國際匯率比對過才採用）。大致即可。
 * ============================================================ */

const RATE_CACHE_KEY = 'rate_JPY_TWD_v2';

/** @return {{rate: number, date: string, source: string} | null} 1 JPY = rate TWD */
function jpyRate_() {
  if (jpyRate_.memo !== undefined) return jpyRate_.memo;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(RATE_CACHE_KEY);
  if (hit) return (jpyRate_.memo = JSON.parse(hit));
  let rate = null;
  const errors = [];
  for (const fetcher of [fetchBotCashRate_, reportedRate_, fetchReferenceRate_]) {
    try {
      rate = fetcher();
      if (rate) break;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (rate) {
    if (errors.length) rate.note = errors.join('；'); // 主要來源失敗的原因，方便排查
    // 臺銀資料 6 小時更新一次；用備援時 1 小時後再試臺銀
    cache.put(RATE_CACHE_KEY, JSON.stringify(rate), 3600);
    PropertiesService.getScriptProperties().setProperty('LAST_JPY_RATE', JSON.stringify(rate));
  } else {
    const last = prop_('LAST_JPY_RATE');
    rate = last ? JSON.parse(last) : null;
  }
  return (jpyRate_.memo = rate);
}

function fetchBotCashRate_() {
  const start = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), TZ, 'yyyy-MM-dd');
  const token = prop_('FINMIND_TOKEN'); // 選填：Google 的共用 IP 容易撞到免登入的次數上限
  const res = UrlFetchApp.fetch(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=JPY&start_date=${start}`, {
    muteHttpExceptions: true,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = res.getContentText();
  if (res.getResponseCode() !== 200) throw new Error(`FinMind HTTP ${res.getResponseCode()}：${body.slice(0, 120)}`);
  const rows = (JSON.parse(body).data || []).filter((r) => Number(r.cash_sell) > 0);
  if (!rows.length) throw new Error(`FinMind 沒有資料：${body.slice(0, 120)}`);
  const last = rows[rows.length - 1];
  return last ? { rate: Number(last.cash_sell), date: last.date, source: '臺灣銀行現金賣出' } : null;
}

// 網站回報的臺銀匯率（5 天內有效）
function reportedRate_() {
  const raw = prop_('REPORTED_JPY_RATE');
  if (!raw) throw new Error('沒有網站回報的匯率');
  const r = JSON.parse(raw);
  if (daysBetween_(r.date, todayStr_()) > 5) throw new Error(`網站回報的匯率太舊（${r.date}）`);
  return r;
}

/** 網站回報臺銀匯率；和國際匯率差太多（±8%）就不採用 */
function reportRate_(report) {
  const rate = Number(report && report.rate);
  const date = report && report.date;
  if (!(rate > 0) || !isValidDate_(date) || daysBetween_(date, todayStr_()) > 14) return false;
  const ref = fetchReferenceRate_();
  if (!ref || Math.abs(rate - ref.rate) / ref.rate > 0.08) return false;
  const current = prop_('REPORTED_JPY_RATE');
  if (current && JSON.parse(current).date > date) return false;
  PropertiesService.getScriptProperties().setProperty('REPORTED_JPY_RATE', JSON.stringify({ rate, date, source: '臺灣銀行現金賣出' }));
  CacheService.getScriptCache().remove(RATE_CACHE_KEY);
  jpyRate_.memo = undefined;
  return true;
}

function fetchReferenceRate_() {
  if (fetchReferenceRate_.memo) return fetchReferenceRate_.memo;
  const res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/JPY', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const data = JSON.parse(res.getContentText());
  const rate = data.rates && Number(data.rates.TWD);
  if (!rate) return null;
  return (fetchReferenceRate_.memo = { rate: Math.round(rate * 10000) / 10000, date: Utilities.formatDate(new Date(data.time_last_update_unix * 1000), TZ, 'yyyy-MM-dd'), source: '國際參考匯率' });
}

/* ---------- 換算（rate 由呼叫端傳入，方便測試） ---------- */
function convertAmount_(amount, from, to, fx) {
  const n = Number(amount) || 0;
  if (!from || from === to) return n;
  if (!fx || !fx.rate) return null;
  if (from === 'JPY' && to === 'TWD') return n * fx.rate;
  if (from === 'TWD' && to === 'JPY') return n / fx.rate;
  return null;
}

function fmtMoney_(n, cur) {
  const v = Math.round(Number(n) || 0);
  if (cur === 'JPY') return `¥${v.toLocaleString()}`;
  if (cur === 'TWD') return `NT$${v.toLocaleString()}`;
  return `${v.toLocaleString()} ${cur || ''}`.trim();
}

/* ---------- 其他幣別：國際參考匯率（以台幣為基準） ---------- */
function referenceRates_() {
  if (referenceRates_.memo) return referenceRates_.memo;
  const cache = CacheService.getScriptCache();
  const hit = cache.get('ref_rates_TWD');
  if (hit) return (referenceRates_.memo = JSON.parse(hit));
  const out = {};
  try {
    const res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/TWD', { muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());
    const date = Utilities.formatDate(new Date(data.time_last_update_unix * 1000), TZ, 'yyyy-MM-dd');
    for (const c of CURRENCY_CODES) {
      if (c !== 'TWD' && data.rates && data.rates[c]) out[c] = { rate: Math.round((1 / data.rates[c]) * 10000) / 10000, date, source: '國際參考匯率' };
    }
    if (Object.keys(out).length) cache.put('ref_rates_TWD', JSON.stringify(out), 3600);
  } catch (err) {
    console.warn('國際參考匯率讀取失敗', err);
  }
  return (referenceRates_.memo = out);
}

/** 1 單位 cur ＝多少台幣；日幣用臺銀現金賣出 */
function rateFor_(cur) {
  if (!cur || cur === 'TWD') return { rate: 1 };
  if (cur === 'JPY') return jpyRate_();
  return referenceRates_()[cur] || null;
}

/**
 * 在 LINE 上輸入的花費有寫幣別時，換算成旅程的幣別再記錄（行程花費一律以旅程幣別儲存）
 * @return {{cost: number, note: string}} note 是要附在回覆後面的說明
 */
function costInCurrency_(amount, from, to) {
  const n = Math.max(0, Number(amount) || 0);
  const target = to || 'TWD';
  if (!n || !from || from === target) return { cost: n, note: '' };
  const twd = toTWD_(n, from);
  const r = rateFor_(target);
  if (twd == null || !r || !r.rate) return { cost: n, note: `\n⚠️ 查不到 ${from} 的匯率，先直接記成 ${n}，請到網站確認金額` };
  return { cost: Math.round((twd / r.rate) * 100) / 100, note: `（由 ${fmtMoney_(n, from)} 換算）` };
}

/* ---------- 金額：一律以台幣為主 ---------- */
function ntd_(n) {
  return `NT$${Math.round(Number(n) || 0).toLocaleString()}`;
}

function toTWD_(amount, cur) {
  const r = rateFor_(cur);
  return r && r.rate ? (Number(amount) || 0) * r.rate : null;
}

// 加總用：換不了就先用原數字
function twdOrRaw_(amount, cur) {
  const v = toTWD_(amount, cur);
  return v == null ? Number(amount) || 0 : v;
}

// 台幣只顯示台幣；外幣顯示「NT$47（¥230）」
function showMoney_(amount, cur) {
  if (!cur || cur === 'TWD') return ntd_(amount);
  const v = toTWD_(amount, cur);
  return v == null ? fmtMoney_(amount, cur) : `${ntd_(v)}（${fmtMoney_(amount, cur)}）`;
}

function fareCurrency_(a, currency) {
  return a.travelCostCurrency || currency;
}

function fareText_(a, currency) {
  return Number(a.travelCost) ? showMoney_(a.travelCost, fareCurrency_(a, currency)) : '';
}

function rateText_(cur) {
  const c = cur || 'JPY';
  const r = rateFor_(c);
  return r && r.source ? `${r.source}：1 ${c === 'JPY' ? '日圓' : c} ≈ ${r.rate} 台幣（${r.date}）` : '目前查不到匯率';
}
