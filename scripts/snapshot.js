// Auto-snapshot dividend predictions (run by GitHub Actions)
import fs from 'fs/promises';
import path from 'path';

const ETFS = ['NVDY', 'AMDY', 'TSMY', 'AMDW', 'PLTW'];
const BASE_MAP = { NVDY: 'NVDA', AMDW: 'AMD', AMDY: 'AMD', TSMY: 'TSM', PLTW: 'PLTR' };
const ETF_CAPTURE = 0.65;
const DATA_PATH = 'public/predictions.json';

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

function extractData(json) {
  const meta = json?.chart?.result?.[0]?.meta;
  const quote = json?.chart?.result?.[0]?.indicators?.quote?.[0];
  const closes = (quote?.close ?? []).filter(v => v != null);
  const divEvents = json?.chart?.result?.[0]?.events?.dividends;
  const divArr = divEvents ? Object.values(divEvents).sort((a, b) => b.date - a.date) : [];
  return {
    price: meta?.regularMarketPrice,
    hv20: calcHV20(closes),
    dividends: divArr.map(d => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount })),
  };
}

async function main() {
  let data;
  try { data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8')); }
  catch { data = { snapshots: [], updatedAt: null }; }

  const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow = nowEt.getDay();
  const todayET = nowEt.toISOString().slice(0, 10);
  console.log(`ET: ${nowEt.toString()}, dow=${dow}`);

  const captureY = dow === 3;
  const captureW = dow === 5;
  let changed = false;

  if (captureY || captureW) {
    const vix = (await fetchYahoo('^VIX'))?.chart?.result?.[0]?.meta?.regularMarketPrice;
    for (const tk of ETFS) {
      const isW = ['AMDW', 'PLTW'].includes(tk);
      if (isW && !captureW) continue;
      if (!isW && !captureY) continue;
      const exDate = new Date(nowEt);
      exDate.setDate(exDate.getDate() + (isW ? 3 : 1));
      const exDateStr = exDate.toISOString().slice(0, 10);
      if (data.snapshots.some(s => s.tk === tk && s.exDivDate === exDateStr)) { console.log(`Skip ${tk} ${exDateStr}`); continue; }
      try {
        const etfD = extractData(await fetchYahoo(tk));
        const baseD = extractData(await fetchYahoo(BASE_MAP[tk]));
        if (!etfD.price || !baseD.hv20) continue;
        const predicted = etfD.price * (baseD.hv20 / 100) * Math.sqrt(7 / 365) * 0.4 * ETF_CAPTURE;
        const predictedAnnual = predicted * 52;
        data.snapshots.push({
          ts: new Date().toISOString(), tk, exDivDate: exDateStr,
          predicted: +predicted.toFixed(6), predictedAnnual: +predictedAnnual.toFixed(2),
          predictedYield: +((predictedAnnual / etfD.price) * 100).toFixed(2),
          hv20: +baseD.hv20.toFixed(2), vix: vix ? +vix.toFixed(2) : null,
          etfPrice: +etfD.price.toFixed(4), basePrice: baseD.price ? +baseD.price.toFixed(2) : null,
          actual: null, actualPaidDate: null, accuracy: null, errorPct: null,
        });
        changed = true;
        console.log(`Captured ${tk} ${exDateStr}: $${predicted.toFixed(4)}`);
      } catch (e) { console.error(`Err ${tk}:`, e.message); }
    }
  }

  for (const snap of data.snapshots.filter(s => s.actual == null)) {
    try {
      const etfD = extractData(await fetchYahoo(snap.tk));
      const match = etfD.dividends.find(d => d.date >= snap.exDivDate);
      if (match) {
        snap.actual = +match.amount.toFixed(6);
        snap.actualPaidDate = match.date;
        snap.accuracy = +((match.amount / snap.predicted) * 100).toFixed(2);
        snap.errorPct = +(((match.amount - snap.predicted) / snap.predicted) * 100).toFixed(2);
        changed = true;
        console.log(`Matched ${snap.tk} ${snap.exDivDate}: $${match.amount.toFixed(4)}`);
      }
    } catch (e) { console.error(`Match err ${snap.tk}:`, e.message); }
  }

  if (changed) {
    data.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`Saved ${data.snapshots.length} snapshots`);
  } else console.log('No changes');
}

main().catch(e => { console.error(e); process.exit(1); });
