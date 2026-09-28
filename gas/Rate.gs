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

function fareIn_(a, currency) {
  const v = convertAmount_(a.travelCost, a.travelCostCurrency || currency, currency, jpyRate_());
  return v == null ? Number(a.travelCost) || 0 : v;
}

function fareText_(a, currency) {
  const cost = Number(a.travelCost) || 0;
  if (!cost) return '';
  const cur = a.travelCostCurrency || currency;
  const conv = cur === currency ? null : convertAmount_(cost, cur, currency, jpyRate_());
  return fmtMoney_(cost, cur) + (conv == null ? '' : `（≈${fmtMoney_(conv, currency)}）`);
}

function rateText_() {
  const fx = jpyRate_();
  return fx ? `${fx.source}：1 日圓 ≈ ${fx.rate} 台幣（${fx.date}）` : '目前查不到匯率';
}
