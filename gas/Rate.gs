/* ============================================================
 * 日幣匯率：臺灣銀行現金賣出（FinMind 每日整理），抓不到時用國際參考匯率
 * 大致即可，快取 6 小時
 * ============================================================ */

const RATE_CACHE_KEY = 'rate_JPY_TWD';

/** @return {{rate: number, date: string, source: string} | null} 1 JPY = rate TWD */
function jpyRate_() {
  if (jpyRate_.memo !== undefined) return jpyRate_.memo;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(RATE_CACHE_KEY);
  if (hit) return (jpyRate_.memo = JSON.parse(hit));
  let rate = null;
  for (const fetcher of [fetchBotCashRate_, fetchReferenceRate_]) {
    try {
      rate = fetcher();
      if (rate) break;
    } catch (err) {
      console.warn('匯率來源失敗', err);
    }
  }
  if (rate) {
    cache.put(RATE_CACHE_KEY, JSON.stringify(rate), 6 * 3600);
    PropertiesService.getScriptProperties().setProperty('LAST_JPY_RATE', JSON.stringify(rate));
  } else {
    const last = prop_('LAST_JPY_RATE');
    rate = last ? JSON.parse(last) : null;
  }
  return (jpyRate_.memo = rate);
}

function fetchBotCashRate_() {
  const start = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), TZ, 'yyyy-MM-dd');
  const res = UrlFetchApp.fetch(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=JPY&start_date=${start}`, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const rows = (JSON.parse(res.getContentText()).data || []).filter((r) => Number(r.cash_sell) > 0);
  const last = rows[rows.length - 1];
  return last ? { rate: Number(last.cash_sell), date: last.date, source: '臺灣銀行現金賣出' } : null;
}

function fetchReferenceRate_() {
  const res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/JPY', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const data = JSON.parse(res.getContentText());
  const rate = data.rates && Number(data.rates.TWD);
  if (!rate) return null;
  return { rate: Math.round(rate * 10000) / 10000, date: Utilities.formatDate(new Date(data.time_last_update_unix * 1000), TZ, 'yyyy-MM-dd'), source: '國際參考匯率' };
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
