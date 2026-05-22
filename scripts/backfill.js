// 과거 배당 이력을 Yahoo Finance에서 가져와 predictions.json에 시뮬레이션 스냅샷을 채움.
// 실행: node scripts/backfill.js [--months=12]
//
// 동작:
//   1) 각 ETF의 지난 N개월 배당 이력 + 가격 이력 조회
//   2) 각 ex-div 날짜에 대해 D-1 시점 기준으로 모든 지표(HV20, RSI14, MA20, 거래량 등) 재계산
//   3) 그 시점의 baseStock/QQQ/^VIX 데이터로 entry 평가까지 재현
//   4) actual = 실제 배당금, priceAfterExDiv = ex-div + 1 거래일 종가
//   5) 이미 존재하는 (tk, exDivDate)는 skip
//
// 주의:
//   - 과거 이벤트(CPI/FOMC/EARNINGS)는 정확히 모르므로 entry 평가에서 이벤트 조건은 항상 통과로 가정
//   - 따라서 entryPct/Grade는 실제 당시와 다를 수 있음 (양적 지표는 정확)

import fs from 'fs/promises';
import path from 'path';

const ETFS = ['NVDY', 'AMDY', 'TSMY', 'AMDW', 'PLTW'];
const BASE_MAP = { NVDY: 'NVDA', AMDW: 'AMD', AMDY: 'AMD', TSMY: 'TSM', PLTW: 'PLTR' };
const ETF_CAPTURE = 0.65;
const DATA_PATH = 'public/predictions.json';
const WEIGHTS = { critical: 5, high: 4, mid: 3, low: 2, bonus: 1 };

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const MONTHS = parseInt(args.months) || 12;
const RANGE_DAYS = MONTHS * 31 + 60; // 여유분 (HV20 계산에 직전 20일 추가 필요)

async function fetchYahoo(ticker, rangeDays) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${rangeDays}d&events=div`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
  if (!r.ok) throw new Error(`Yahoo ${ticker} ${r.status}`);
  return await r.json();
}

function extractSeries(json) {
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const volumes = quote?.volume ?? [];
  const divEvents = result.events?.dividends;
  const divs = divEvents ? Object.values(divEvents).sort((a, b) => a.date - b.date) : [];
  // 날짜별 정렬, null close는 제거하며 인덱스 alignment 유지
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) {
      series.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: closes[i],
        volume: volumes[i] ?? null,
      });
    }
  }
  return {
    series,
    dividends: divs.map(d => ({
      date: new Date(d.date * 1000).toISOString().slice(0, 10),
      amount: d.amount,
    })),
  };
}

function calcHV20(closes) {
  if (closes.length < 21) return null;
  const tail = closes.slice(-21);
  const rets = [];
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i] / tail[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function calcRSI(closes) {
  if (closes.length < 15) return null;
  const tail = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i] - tail[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / 14, avgL = losses / 14;
  return avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
}

// 시리즈[0..idx]까지의 데이터로 그 시점 quote 객체 생성
function snapshotAt(series, idx) {
  if (idx < 0 || idx >= series.length) return null;
  const closes = series.slice(0, idx + 1).map(s => s.close);
  const volumes = series.slice(0, idx + 1).map(s => s.volume);
  const price = closes[closes.length - 1];
  const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const recentVols = volumes.slice(-21, -1).filter(v => v != null);
  const avgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : null;
  const todayVol = volumes[volumes.length - 1] ?? null;
  const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const fiveDay = closes.length >= 6 ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
  return {
    price, changePct,
    hv20: calcHV20(closes), rsi14: calcRSI(closes),
    ma20, aboveMA20: ma20 ? price > ma20 : null,
    fiveDayReturn: fiveDay,
    volRatio: avgVol && todayVol ? todayVol / avgVol : null,
  };
}

function findIdxByDate(series, dateStr, mode = 'lastBefore') {
  // mode: 'lastBefore' → 해당 날짜 직전 거래일 (D-1)
  //       'firstAfter' → 해당 날짜 이후 첫 거래일 (D+1)
  if (mode === 'lastBefore') {
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].date < dateStr) return i;
    }
    return -1;
  }
  for (let i = 0; i < series.length; i++) {
    if (series[i].date > dateStr) return i;
  }
  return -1;
}

function evaluateEntryBackfill(qMap, tk) {
  // 과거 이벤트(CPI/FOMC/EARNINGS)는 모르므로 통과 처리
  const baseStock = BASE_MAP[tk];
  const baseQ = qMap[baseStock];
  const tq = qMap[tk];
  const qqq = qMap['QQQ'];
  const vix = qMap['^VIX']?.price;
  const r = [];
  r.push({ ok: true, p: 'critical', l: 'CPI/FOMC (백필 가정)' });
  r.push({ ok: true, p: 'critical', l: '실적 임박 없음 (백필 가정)' });
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
  console.log(`Backfill: months=${MONTHS}, range=${RANGE_DAYS}d`);

  let data;
  try { data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8')); }
  catch { data = { snapshots: [], updatedAt: null }; }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - MONTHS);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  // 모든 티커 시리즈 받기
  const allTickers = [...new Set([...ETFS, ...ETFS.map(t => BASE_MAP[t]), 'QQQ', '^VIX'])];
  const tickerData = {};
  for (const t of allTickers) {
    try {
      const json = await fetchYahoo(t, RANGE_DAYS);
      const series = extractSeries(json);
      if (!series) { console.error(`Failed extract ${t}`); continue; }
      tickerData[t] = series;
      console.log(`${t}: ${series.series.length} bars, ${series.dividends.length} divs`);
    } catch (e) {
      console.error(`Failed ${t}:`, e.message);
    }
  }

  let added = 0, skipped = 0;
  for (const tk of ETFS) {
    const etfData = tickerData[tk];
    if (!etfData) continue;
    const baseTicker = BASE_MAP[tk];
    const baseData = tickerData[baseTicker];
    if (!baseData) continue;

    for (const div of etfData.dividends) {
      if (div.date < cutoffStr) continue;
      // 이미 존재하는 (tk, exDivDate)?
      // ex-div 날짜는 배당 지급일과 동일하다고 가정 (Yahoo 데이터 기준)
      if (data.snapshots.some(s => s.tk === tk && s.exDivDate === div.date)) {
        skipped++;
        continue;
      }

      // D-1 시점 인덱스 (ETF 기준)
      const dM1 = findIdxByDate(etfData.series, div.date, 'lastBefore');
      if (dM1 < 0) continue;
      const etfDm1 = etfData.series[dM1];

      // baseStock의 같은 D-1 날짜에 해당하는 인덱스
      const baseDm1 = findIdxByDate(baseData.series, div.date, 'lastBefore');
      if (baseDm1 < 0) continue;

      // 그 시점 quote 객체들
      const qMap = {};
      qMap[tk] = snapshotAt(etfData.series, dM1);
      qMap[baseTicker] = snapshotAt(baseData.series, baseDm1);
      if (tickerData['QQQ']) {
        const qIdx = findIdxByDate(tickerData['QQQ'].series, div.date, 'lastBefore');
        if (qIdx >= 0) qMap['QQQ'] = snapshotAt(tickerData['QQQ'].series, qIdx);
      }
      if (tickerData['^VIX']) {
        const vIdx = findIdxByDate(tickerData['^VIX'].series, div.date, 'lastBefore');
        if (vIdx >= 0) qMap['^VIX'] = snapshotAt(tickerData['^VIX'].series, vIdx);
      }

      if (!qMap[tk]?.price || qMap[baseTicker]?.hv20 == null) {
        console.log(`Missing data ${tk} ${div.date}`);
        continue;
      }

      // 예측 계산 (snapshot.js와 동일 공식의 단순 버전)
      const predicted = qMap[tk].price * (qMap[baseTicker].hv20 / 100) * Math.sqrt(7 / 365) * 0.4 * ETF_CAPTURE;
      const entry = evaluateEntryBackfill(qMap, tk);

      // ex-div + 1 거래일 종가
      const afterIdx = findIdxByDate(etfData.series, div.date, 'firstAfter');
      const priceAfter = afterIdx >= 0 ? etfData.series[afterIdx].close : null;
      let capitalChangePct = null, netReturnPct = null, profitable = null;
      if (priceAfter != null) {
        capitalChangePct = ((priceAfter - qMap[tk].price) / qMap[tk].price) * 100;
        const divReturn = (div.amount / qMap[tk].price) * 100;
        netReturnPct = divReturn + capitalChangePct;
        profitable = netReturnPct > 0;
      }

      data.snapshots.push({
        ts: new Date(div.date).toISOString(),
        tk, exDivDate: div.date,
        predicted: +predicted.toFixed(6),
        predictedAnnual: +(predicted * 52).toFixed(2),
        predictedYield: +((predicted * 52 / qMap[tk].price) * 100).toFixed(2),
        hv20: +qMap[baseTicker].hv20.toFixed(2),
        vix: qMap['^VIX']?.price ? +qMap['^VIX'].price.toFixed(2) : null,
        etfPrice: +qMap[tk].price.toFixed(4),
        basePrice: qMap[baseTicker].price ? +qMap[baseTicker].price.toFixed(2) : null,
        entryPct: entry.pct,
        entryScore: entry.score,
        entryTotal: entry.total,
        entryGrade: entry.grade,
        criticalFails: entry.criticalFails,
        failedLabels: entry.failedLabels,
        actual: +div.amount.toFixed(6),
        actualPaidDate: div.date,
        accuracy: +((div.amount / predicted) * 100).toFixed(2),
        errorPct: +(((div.amount - predicted) / predicted) * 100).toFixed(2),
        priceAfterExDiv: priceAfter != null ? +priceAfter.toFixed(4) : null,
        capitalChangePct: capitalChangePct != null ? +capitalChangePct.toFixed(2) : null,
        netReturnPct: netReturnPct != null ? +netReturnPct.toFixed(2) : null,
        profitable,
        backfilled: true,
      });
      added++;
      console.log(`+ ${tk} ${div.date}: pred $${predicted.toFixed(4)} / actual $${div.amount.toFixed(4)} (err ${(((div.amount - predicted) / predicted) * 100).toFixed(1)}%) · entry ${entry.pct}% (${entry.grade}) · net ${netReturnPct != null ? netReturnPct.toFixed(2) + '%' : '-'}`);
    }
  }

  // 정렬 (ex-div 날짜 오름차순)
  data.snapshots.sort((a, b) => a.exDivDate.localeCompare(b.exDivDate));
  data.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nDone. Added ${added}, skipped ${skipped}. Total snapshots: ${data.snapshots.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
