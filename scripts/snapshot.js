// Auto-snapshot dividend predictions + entry validation (run by GitHub Actions)
import fs from 'fs/promises';
import path from 'path';

const ETFS = ['NVDY', 'AMDY', 'TSMY', 'AMDW', 'PLTW'];
const BASE_MAP = { NVDY: 'NVDA', AMDW: 'AMD', AMDY: 'AMD', TSMY: 'TSM', PLTW: 'PLTR' };
const ETF_CAPTURE = 0.65;
const DATA_PATH = 'public/predictions.json';

const DEFAULT_EVENTS = [
  { date: "2026-05-20", type: "EARNINGS", label: "NVDA 실적 발표 (장 마감 후)" },
  { date: "2026-07-16", type: "EARNINGS", label: "TSMC 실적 발표" },
  { date: "2026-08-04", type: "EARNINGS", label: "AMD 실적 발표 (미확정)" },
  { date: "2026-06-17", type: "FOMC", label: "FOMC 결정 (예상)" },
  { date: "2026-07-15", type: "CPI", label: "CPI 발표 (예상)" },
];

const WEIGHTS = { critical: 5, high: 4, mid: 3, low: 2, bonus: 1 };

async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=60d&events=div`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
  if (!r.ok) throw new Error(`Yahoo ${ticker} ${r.status}`);
  return await r.json();
}

function calcHV20(closes) {
  if (closes.length < 21) return null;
  const rets = [];
  for (let i = closes.length - 20; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function calcRSI(closes) {
  if (closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / 14, avgL = losses / 14;
  return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
}

function extractFull(json) {
  const meta = json?.chart?.result?.[0]?.meta;
  const quote = json?.chart?.result?.[0]?.indicators?.quote?.[0];
  const closes = (quote?.close ?? []).filter(v => v != null);
  const volumes = (quote?.volume ?? []).filter(v => v != null);
  const divEvents = json?.chart?.result?.[0]?.events?.dividends;
  const divArr = divEvents ? Object.values(divEvents).sort((a, b) => b.date - a.date) : [];
  const price = meta?.regularMarketPrice;
  const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const recentVols = volumes.slice(-21, -1);
  const avgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : null;
  const todayVol = meta?.regularMarketVolume || volumes[volumes.length - 1] || null;
  const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const fiveDay = closes.length >= 6 ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
  return {
    price, changePct, closes,
    hv20: calcHV20(closes), rsi14: calcRSI(closes),
    ma20, aboveMA20: ma20 ? price > ma20 : null,
    fiveDayReturn: fiveDay,
    volRatio: avgVol && todayVol ? todayVol / avgVol : null,
    dividends: divArr.map(d => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount })),
  };
}

function evaluateEntry(quotes, tk, events) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const dayAfterStr = new Date(today.getTime() + 172800000).toISOString().slice(0, 10);
  const baseStock = BASE_MAP[tk];
  const baseQ = quotes[baseStock];
  const tq = quotes[tk];
  const qqq = quotes['QQQ'];
  const vix = quotes['^VIX']?.price;
  const r = [];

  const cpifomc = events.find(e => (e.date === todayStr || e.date === tomorrowStr) && (e.type === 'CPI' || e.type === 'FOMC'));
  r.push({ ok: !cpifomc, p: 'critical', l: 'CPI/FOMC' });

  const earn = events.find(e => e.type === 'EARNINGS' && [todayStr, tomorrowStr, dayAfterStr].includes(e.date) &&
    (e.label.includes(baseStock) || (['NVDA','AMD','TSM'].includes(baseStock) && e.label.includes('TSMC'))));
  r.push({ ok: !earn, p: 'critical', l: '실적 임박 없음' });

  if (baseQ) r.push({ ok: Math.abs(baseQ.changePct) <= 3, p: 'high', l: `${baseStock} 변동` });
  if (tq) r.push({ ok: Math.abs(tq.changePct) <= 4, p: 'low', l: `${tk} 변동` });
  if (qqq) r.push({ ok: qqq.changePct > -2, p: 'mid', l: 'QQQ' });
  if (vix != null) r.push({ ok: vix >= 15 && vix < 30, p: 'critical', l: 'VIX 15~30' });
  if (tq?.volRatio != null) r.push({ ok: tq.volRatio >= 0.5 && tq.volRatio <= 2.5, p: 'low', l: `${tk} 거래량` });
  if (baseQ?.volRatio != null) r.push({ ok: baseQ.volRatio < 2.0, p: 'low', l: `${baseStock} 거래량` });
  if (baseQ?.rsi14 != null) r.push({ ok: baseQ.rsi14 >= 30 && baseQ.rsi14 <= 70, p: 'mid', l: `${baseStock} RSI` });
  if (baseQ?.aboveMA20 != null) r.push({ ok: baseQ.aboveMA20, p: 'high', l: `${baseStock} MA20` });
  if (baseQ?.fiveDayReturn != null) r.push({ ok: baseQ.fiveDayReturn > -3, p: 'mid', l: `${baseStock} 5일` });
  if (tq?.fiveDayReturn != null) r.push({ ok: tq.fiveDayReturn > -5, p: 'low', l: `${tk} 5일` });
  r.push({ ok: true, p: 'bonus', l: '배당락 D-1' });

  let wScore = 0, wMax = 0;
  r.forEach(c => { const w = WEIGHTS[c.p] ?? 1; wMax += w; if (c.ok) wScore += w; });
  const pct = wMax > 0 ? Math.round((wScore / wMax) * 100) : 0;
  const criticalFails = r.filter(c => c.p === 'critical' && !c.ok).length;
  const failedLabels = r.filter(c => !c.ok).map(c => c.l);

  let grade;
  if (criticalFails >= 2) grade = 'F';
  else if (criticalFails === 1) grade = 'C';
  else if (pct >= 95) grade = 'S';
  else if (pct >= 90) grade = 'A+';
  else if (pct >= 85) grade = 'A';
  else if (pct >= 80) grade = 'B+';
  else if (pct >= 70) grade = 'B';
  else if (pct >= 60) grade = 'C+';
  else if (pct >= 50) grade = 'C';
  else if (pct >= 35) grade = 'D';
  else grade = 'F';

  return { pct, score: wScore, total: wMax, grade, criticalFails, failedLabels };
}

async function main() {
  let data;
  try { data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8')); }
  catch { data = { snapshots: [], updatedAt: null }; }

  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = nowEt.getDay();
  const todayET = nowEt.toISOString().slice(0, 10);
  console.log(`ET: ${nowEt.toString()}, dow=${dow}`);

  const hour = nowEt.getHours();
  // 미국 장 마감 직전(14:00~16:00 ET) 캡처. 다른 시간은 매칭만 수행
  const inCaptureWindow = hour >= 14 && hour <= 16;
  const captureY = dow === 3 && inCaptureWindow;
  const captureW = dow === 5 && inCaptureWindow;
  let changed = false;

  // 모든 티커 데이터를 한 번에 받아두기 (재사용)
  const allTickers = [...new Set([...ETFS, ...ETFS.map(t => BASE_MAP[t]), 'QQQ', '^VIX'])];
  const quotes = {};
  for (const t of allTickers) {
    try { quotes[t] = extractFull(await fetchYahoo(t)); }
    catch (e) { console.error(`Failed ${t}:`, e.message); }
  }

  // 1) 스냅샷 캡처 (D-1)
  if (captureY || captureW) {
    for (const tk of ETFS) {
      const isW = ['AMDW', 'PLTW'].includes(tk);
      if (isW && !captureW) continue;
      if (!isW && !captureY) continue;
      const exDate = new Date(nowEt);
      exDate.setDate(exDate.getDate() + (isW ? 3 : 1));
      const exDateStr = exDate.toISOString().slice(0, 10);
      if (data.snapshots.some(s => s.tk === tk && s.exDivDate === exDateStr)) {
        console.log(`Skip ${tk} ${exDateStr}`);
        continue;
      }
      const etf = quotes[tk];
      const base = quotes[BASE_MAP[tk]];
      if (!etf?.price || !base?.hv20) { console.log(`Missing data ${tk}`); continue; }

      const predicted = etf.price * (base.hv20 / 100) * Math.sqrt(7 / 365) * 0.4 * ETF_CAPTURE;
      const entry = evaluateEntry(quotes, tk, DEFAULT_EVENTS);

      data.snapshots.push({
        ts: new Date().toISOString(), tk, exDivDate: exDateStr,
        predicted: +predicted.toFixed(6),
        predictedAnnual: +(predicted * 52).toFixed(2),
        predictedYield: +((predicted * 52 / etf.price) * 100).toFixed(2),
        hv20: +base.hv20.toFixed(2),
        vix: quotes['^VIX']?.price ? +quotes['^VIX'].price.toFixed(2) : null,
        etfPrice: +etf.price.toFixed(4),
        basePrice: base.price ? +base.price.toFixed(2) : null,
        // 진입 신호 데이터 (NEW)
        entryPct: entry.pct,
        entryScore: entry.score,
        entryTotal: entry.total,
        entryGrade: entry.grade,
        criticalFails: entry.criticalFails,
        failedLabels: entry.failedLabels,
        // 매칭 후 채워질 값
        actual: null, actualPaidDate: null, accuracy: null, errorPct: null,
        // 결과 검증 (NEW, ex-div+1 후 채워짐)
        priceAfterExDiv: null, capitalChangePct: null, netReturnPct: null, profitable: null,
      });
      changed = true;
      console.log(`Captured ${tk} ${exDateStr}: pred $${predicted.toFixed(4)} · entry ${entry.pct}% (${entry.grade})`);
    }
  }

  // 2) 실제 배당 + 결과 매칭
  for (const snap of data.snapshots.filter(s => s.actual == null || s.priceAfterExDiv == null)) {
    const etf = quotes[snap.tk];
    if (!etf) continue;

    // 실제 배당 매칭
    if (snap.actual == null) {
      const match = etf.dividends.find(d => d.date >= snap.exDivDate);
      if (match) {
        snap.actual = +match.amount.toFixed(6);
        snap.actualPaidDate = match.date;
        snap.accuracy = +((match.amount / snap.predicted) * 100).toFixed(2);
        snap.errorPct = +(((match.amount - snap.predicted) / snap.predicted) * 100).toFixed(2);
        changed = true;
        console.log(`Matched div ${snap.tk}: $${match.amount.toFixed(4)}`);
      }
    }

    // 결과 검증: ex-div + 1 거래일 이후 가격으로 자본손익 계산
    if (snap.priceAfterExDiv == null && snap.actual != null) {
      // closes 배열의 마지막 값(현재가) 또는 ex-div + 1 거래일의 종가
      // 간단히: 현재 시점이 ex-div + 2일 이상 지났으면 현재 종가 사용
      const exD = new Date(snap.exDivDate);
      const daysSince = (nowEt - exD) / 86400000;
      if (daysSince >= 1) {
        const priceAfter = etf.price;
        const capitalChange = ((priceAfter - snap.etfPrice) / snap.etfPrice) * 100;
        const divReturn = (snap.actual / snap.etfPrice) * 100;
        const netReturn = divReturn + capitalChange;
        snap.priceAfterExDiv = +priceAfter.toFixed(4);
        snap.capitalChangePct = +capitalChange.toFixed(2);
        snap.netReturnPct = +netReturn.toFixed(2);
        snap.profitable = netReturn > 0;
        changed = true;
        console.log(`Outcome ${snap.tk}: T+${daysSince.toFixed(1)}d, priceAfter $${priceAfter.toFixed(2)}, net ${netReturn.toFixed(2)}% (${snap.profitable ? '+' : '-'})`);
      }
    }
  }

  if (changed) {
    data.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`Saved ${data.snapshots.length} snapshots`);
  } else console.log('No changes');
}

main().catch(e => { console.error(e); process.exit(1); });
