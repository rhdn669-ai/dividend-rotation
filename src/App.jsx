import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { isFirebaseConfigured } from "./lib/firebase.js";
import { watchAuth, signInGoogle, signOutUser, fetchCloudState, writeCloudState, subscribeCloudState, mergeCloudAndLocal } from "./lib/cloudSync.js";

// ─── 상수 ──────────────────────────────────────────────────────────────────
const APP_VERSION = "1.0.37";
const BASE_MAP = { NVDY: "NVDA", AMDW: "AMD", AMDY: "AMD", TSMY: "TSM", PLTW: "PLTR" };
const ETF_CAPTURE = 0.65; // ETF가 옵션 프리미엄을 캡처하는 추정 비율

// ─── 부분 점수 헬퍼 (각 조건마다 0~만점 사이 그라데이션 점수) ────────────────
function pScore(value, table) {
  // table: [[threshold, score], ...] 첫 매칭 시 score 반환
  if (value == null || isNaN(value)) return 0;
  for (const [thresh, score] of table) if (value <= thresh) return score;
  return 0;
}

function vixPScore(v) {
  if (v == null || isNaN(v)) return 0;
  if (v >= 16 && v <= 22) return 5;       // 이상
  if (v >= 14 && v < 16) return 4;        // 약간 낮음
  if (v > 22 && v <= 25) return 4;        // 약간 높음
  if (v > 25 && v <= 28) return 2.5;      // 변동 큼
  if (v >= 12 && v < 14) return 2;        // 너무 낮음
  if (v > 28 && v < 30) return 1;         // 경계
  return 0;
}

function rsiPScore(r) {
  if (r == null || isNaN(r)) return 0;
  const d = Math.abs(r - 50);
  if (d <= 10) return 3;     // 40~60
  if (d <= 15) return 2.5;   // 35~65
  if (d <= 20) return 1.5;   // 30~70
  if (d <= 25) return 0.5;   // 25~75
  return 0;
}
const TICKERS = ["NVDY", "AMDW", "AMDY", "TSMY", "PLTW", "NVDA", "AMD", "TSM", "PLTR", "^VIX", "QQQ", "KRW=X", "^IXIC", "^KS11"];

// 기본 이벤트 데이터 (Claude Code에서 분리 시 src/data/events.js로 이동)
// 출처: federalreserve.gov, bls.gov, 각 사 IR
const DEFAULT_EVENTS = [
  // 실적 발표 (검증된 일정)
  { date: "2026-05-20", type: "EARNINGS", label: "NVDA 실적 발표 (장 마감 후)" },
  { date: "2026-07-16", type: "EARNINGS", label: "TSMC 실적 발표" },
  { date: "2026-08-04", type: "EARNINGS", label: "AMD 실적 발표 (미확정)" },
  // FOMC / CPI (사용자가 federalreserve.gov / bls.gov에서 직접 확인 후 업데이트 필요)
  { date: "2026-06-17", type: "FOMC", label: "FOMC 결정 (예상)" },
  { date: "2026-07-15", type: "CPI", label: "CPI 발표 (예상)" },
];

const EVENT_COLORS = {
  CPI: "#ef4444",
  FOMC: "#f97316",
  EARNINGS: "#a855f7",
  DIVIDEND: "#22c55e",
};

// localStorage 키 prefix (CLAUDE.md 규칙)
const STORAGE_KEYS = {
  events: "dividend-rotation:events",
  log: "dividend-rotation:log",
  vix: "dividend-rotation:vix",
  ticker: "dividend-rotation:active-ticker",
  scoreHistory: "dividend-rotation:score-history",
  tabOrder: "dividend-rotation:tab-order",
};

const DEFAULT_TABS = [
  { id: "signal", label: "📊 진입신호" },
  { id: "market", label: "💹 시장현황" },
  { id: "calendar", label: "📅 이벤트" },
  { id: "log", label: "🔄 회전이력" },
  { id: "guide", label: "📖 가이드" },
  { id: "glossary", label: "📚 용어" },
  { id: "history", label: "📈 기록" },
  { id: "timezone", label: "🕐 시간대" },
  { id: "dividend", label: "💰 배당순위" },
  { id: "divaccuracy", label: "🎯 배당예측" },
  { id: "entryvalid", label: "📊 진입검증" },
];

// ─── localStorage Helper (CF Pages 배포 후 정상 작동) ──────────────────────
const storage = {
  get(key, fallback = null) {
    try {
      const v = typeof window !== "undefined" && window.localStorage?.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try {
      if (typeof window !== "undefined") window.localStorage?.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ─── Yahoo Finance API ─────────────────────────────────────────────────────
// 배포 후 CF Pages Functions(/api/quote)로 프록시 권장
async function fetchQuote(ticker) {
  try {
    const url = `/api/quote?ticker=${encodeURIComponent(ticker)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed");
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const rawQ = data?.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!meta) throw new Error("no meta");
    const closes = rawQ?.close?.filter((v) => v != null) || [];
    // closes[-1] = 오늘 현재가, closes[-2] = 전일 종가 (배당 미조정 실제값)
    const prevCloseFromArray = closes.length >= 2 ? closes[closes.length - 2] : null;
    const fiveDayReturn = closes.length >= 6
      ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      : null;
    const divEvents = data?.chart?.result?.[0]?.events?.dividends;
    const divArr = divEvents ? Object.values(divEvents).sort((a, b) => b.date - a.date) : [];
    const lastDiv = divArr.length > 0 ? divArr[0].amount : null;
    const lastDivDate = divArr.length > 0 ? new Date(divArr[0].date * 1000).toISOString().slice(0, 10) : null;
    // HV5: 5일 단기 실현 변동성 (forward IV proxy)
    let hv5 = null;
    if (closes.length >= 6) {
      const rets5 = [];
      for (let i = closes.length - 5; i < closes.length; i++) rets5.push(Math.log(closes[i] / closes[i - 1]));
      const m5 = rets5.reduce((a, b) => a + b, 0) / rets5.length;
      const v5 = rets5.reduce((s, r) => s + (r - m5) ** 2, 0) / rets5.length;
      hv5 = Math.sqrt(v5) * Math.sqrt(252) * 100;
    }
    const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    const aboveMA20 = ma20 != null ? meta.regularMarketPrice > ma20 : null;
    // HV20: 20일 연환산 실현 변동성 (%)
    let hv20 = null;
    if (closes.length >= 21) {
      const rets = [];
      for (let i = closes.length - 20; i < closes.length; i++) {
        rets.push(Math.log(closes[i] / closes[i - 1]));
      }
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
      hv20 = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }
    let rsi14 = null;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const avgG = gains / 14, avgL = losses / 14;
      rsi14 = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
    }
    const volumes = rawQ?.volume?.filter((v) => v != null) || [];
    const recentVols = volumes.slice(-21, -1);
    const avgVol20 = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : null;
    const todayVol = meta.regularMarketVolume || volumes[volumes.length - 1] || null;
    const volRatio = avgVol20 && todayVol ? todayVol / avgVol20 : null;
    const prevClose = prevCloseFromArray;
    return {
      ticker, ok: true,
      price: meta.regularMarketPrice,
      prevClose,
      changePct: prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : 0,
      marketState: meta.marketState,
      preMarketPrice: meta.preMarketPrice,
      preMarketChange: meta.preMarketPrice ? ((meta.preMarketPrice - meta.regularMarketPrice) / meta.regularMarketPrice) * 100 : null,
      todayVol, avgVol20, volRatio,
      fiveDayReturn, rsi14, ma20, aboveMA20, hv20, hv5, lastDiv, lastDivDate,
      timestamp: new Date(),
    };
  } catch (e) {
    return { ticker, ok: false, error: e.message };
  }
}

function fmtVol(v) {
  if (!v) return "-";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(0) + "K";
  return String(v);
}

// ─── 미국 장 상태 ────────────────────────────────────────────────────────────
function getMarketStatus(now) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const hm = et.getHours() * 60 + et.getMinutes();
  const etStr = et.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  if (day === 0 || day === 6) return { label: "주말 마감", color: "#94a3b8", etStr };
  if (hm >= 570 && hm < 960)  return { label: "정규장", color: "#22c55e", etStr };
  if (hm >= 240 && hm < 570)  return { label: "프리마켓", color: "#f59e0b", etStr };
  if (hm >= 960 && hm < 1200) return { label: "시간외", color: "#f97316", etStr };
  return { label: "마감", color: "#94a3b8", etStr };
}

// ─── 진입 조건 평가기 ──────────────────────────────────────────────────────
// 가중치는 추후 src/lib/evaluator.js로 분리 권장
function evaluateConditions(quotes, targetTicker, events, manualVix, learnedThreshold = null, scoreFitness = null) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const dayAfterStr = new Date(today.getTime() + 172800000).toISOString().slice(0, 10);
  const results = [];
  let score = 0, total = 0;

  // 1. CPI/FOMC (오늘 또는 내일)
  const todayEv = events.find((e) => e.date === todayStr && (e.type === "CPI" || e.type === "FOMC"));
  const tmrEv = events.find((e) => e.date === tomorrowStr && (e.type === "CPI" || e.type === "FOMC"));
  const evOk = !todayEv && !tmrEv;
  results.push({
    label: "CPI/FOMC 이벤트 없음",
    ok: evOk,
    partialScore: evOk ? 5 : 0,
    detail: todayEv ? `오늘 ${todayEv.label}` : tmrEv ? `내일 ${tmrEv.label}` : "이벤트 없음",
    priority: "critical",
  });
  total++; if (evOk) score++;

  // 2. 실적 발표 (NVDA/AMD/TSMC - 오늘부터 2일 이내)
  const targetCo = BASE_MAP[targetTicker] || "NVDA";
  const earningsEv = events.find((e) =>
    e.type === "EARNINGS" &&
    [todayStr, tomorrowStr, dayAfterStr].includes(e.date) &&
    (e.label.includes(targetCo) || (["NVDA","AMD","TSM"].includes(targetCo) && e.label.includes("TSMC")))
  );
  const earningsOk = !earningsEv;
  results.push({
    label: ["NVDA","AMD","TSM"].includes(targetCo) ? `${targetCo}/TSMC 실적 발표 임박 없음` : `${targetCo} 실적 발표 임박 없음`,
    ok: earningsOk,
    partialScore: earningsOk ? 5 : 0,
    detail: earningsEv ? `${earningsEv.date} ${earningsEv.label}` : "2일 이내 실적 발표 없음",
    priority: "critical",
  });
  total++; if (earningsOk) score++;

  // 3. 기준 종목 시간외 또는 당일
  const baseQ = quotes[targetCo];
  const baseName = targetCo;
  if (baseQ?.ok && baseQ.preMarketChange != null) {
    const abs = Math.abs(baseQ.preMarketChange);
    const ps = pScore(abs, [[0.5, 4], [1.0, 3.5], [1.5, 2.5], [2.0, 1.5], [3.0, 0.5]]);
    const ok = abs <= 2;
    results.push({
      label: `${baseName} 시간외 ±2% 이내`,
      ok, partialScore: ps,
      detail: `시간외 ${baseQ.preMarketChange > 0 ? "+" : ""}${baseQ.preMarketChange?.toFixed(2)}% · ${ps.toFixed(1)}/4점`,
      priority: "high",
    });
    total++; if (ok) score++;
  } else if (baseQ?.ok) {
    const abs = Math.abs(baseQ.changePct);
    const ps = pScore(abs, [[1.0, 4], [2.0, 3], [3.0, 1.5], [4.0, 0.5]]);
    const ok = abs <= 3;
    results.push({
      label: `${baseName} 당일 변동 ±3% 이내`,
      ok, partialScore: ps,
      detail: `당일 ${baseQ.changePct > 0 ? "+" : ""}${baseQ.changePct?.toFixed(2)}% · ${ps.toFixed(1)}/4점`,
      priority: "high",
    });
    total++; if (ok) score++;
  } else {
    results.push({ label: `${baseName} 데이터 없음`, ok: false, detail: "API 로드 실패 (배포 후 정상화)", priority: "high" });
    total++;
  }

  // 4. ETF 자체 변동
  const tq = quotes[targetTicker];
  if (tq?.ok) {
    const abs = Math.abs(tq.changePct);
    const ps = pScore(abs, [[1.0, 2], [2.0, 1.5], [3.0, 1], [4.0, 0.5]]);
    const ok = abs <= 4;
    results.push({
      label: `${targetTicker} 변동 ±4% 이내`,
      ok, partialScore: ps,
      detail: `${tq.changePct > 0 ? "+" : ""}${tq.changePct?.toFixed(2)}% · ${ps.toFixed(1)}/2점`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // 5. QQQ 나스닥
  const qqqQ = quotes["QQQ"];
  if (qqqQ?.ok) {
    const c = qqqQ.changePct;
    let ps = 0;
    if (c >= 1) ps = 3;
    else if (c >= 0) ps = 2.5;
    else if (c >= -1) ps = 2;
    else if (c >= -2) ps = 1;
    const ok = c > -2;
    results.push({
      label: "나스닥(QQQ) -2% 이상",
      ok, partialScore: ps,
      detail: `QQQ ${c > 0 ? "+" : ""}${c?.toFixed(2)}% · ${ps.toFixed(1)}/3점`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }

  // 6. VIX 통합 (프리미엄 적정 + 극도공포 회피)
  const vixQ = quotes["^VIX"];
  const vixVal = vixQ?.ok ? vixQ.price : (manualVix ? parseFloat(manualVix) : null);
  if (vixVal != null && !isNaN(vixVal)) {
    const ps = vixPScore(vixVal);
    const ok = ps >= 2.5;  // 부분점수 50% 이상이면 OK
    const tag = vixVal >= 30 ? " ⚠️극도공포 회피" : vixVal >= 25 ? " 고변동 주의" : vixVal >= 22 ? " 약간 높음" : vixVal >= 16 ? " 이상적" : vixVal >= 14 ? " 약간 낮음" : " 너무 낮음";
    results.push({
      label: "VIX 15~30 (프리미엄 적정)",
      ok, partialScore: ps,
      detail: `VIX ${vixVal.toFixed(2)}${!vixQ?.ok ? " (수동)" : ""}${tag} · ${ps.toFixed(1)}/5점`,
      priority: "critical",
    });
    total++; if (ok) score++;
  } else {
    results.push({ label: "VIX 15~30 (프리미엄 적정)", ok: false, partialScore: 0, detail: "수동 입력 필요", priority: "critical" });
    total++;
  }

  // 7. ETF 거래량 정상 (0.5~2.5배, 조건7+④ 통합)
  if (tq?.ok && tq.volRatio != null) {
    const vr = tq.volRatio;
    let ps = 0;
    if (vr >= 0.8 && vr <= 1.5) ps = 2;
    else if (vr >= 0.5 && vr <= 2.0) ps = 1.5;
    else if (vr >= 0.3 && vr <= 2.5) ps = 1;
    const ok = vr >= 0.5 && vr <= 2.5;
    const tag = vr > 2.5 ? " ⚠️폭증" : vr > 1.8 ? " 증가주의" : vr < 0.5 ? " 너무적음" : " 정상";
    results.push({
      label: `${targetTicker} 거래량 정상`,
      ok, partialScore: ps,
      detail: `오늘 ${fmtVol(tq.todayVol)} / 평균 (${vr.toFixed(2)}배)${tag} · ${ps.toFixed(1)}/2점`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // 8. 기준 종목 거래량 급증
  if (baseQ?.ok && baseQ.volRatio != null) {
    const vr = baseQ.volRatio;
    let ps = 0;
    if (vr < 1.0) ps = 2;
    else if (vr < 1.5) ps = 1.5;
    else if (vr < 2.0) ps = 1;
    else if (vr < 2.5) ps = 0.5;
    const ok = vr < 2.0;
    results.push({
      label: `${baseName} 거래량 급증 없음`,
      ok, partialScore: ps,
      detail: `${baseName} 평균 대비 ${vr.toFixed(2)}배${vr >= 2 ? " ⚠️급등락" : " 정상"} · ${ps.toFixed(1)}/2점`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // ③ 기준 종목 5일 모멘텀
  if (baseQ?.ok && baseQ.fiveDayReturn != null) {
    const r = baseQ.fiveDayReturn;
    let ps = 0;
    if (r >= 3) ps = 3;
    else if (r >= 0) ps = 2.5;
    else if (r >= -1.5) ps = 1.5;
    else if (r >= -3) ps = 0.5;
    const ok = r > -3;
    const tag = r > 5 ? " 강세" : r > 0 ? " 양호" : r > -3 ? " 약세" : " 급락";
    results.push({
      label: `${baseName} 5일 모멘텀`,
      ok, partialScore: ps,
      detail: `최근 5거래일 ${r > 0 ? "+" : ""}${r.toFixed(2)}%${tag} · ${ps.toFixed(1)}/3점`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }



  // RSI (기준 종목 14일 — 과매수/과매도 회피)
  if (baseQ?.ok && baseQ.rsi14 != null) {
    const ps = rsiPScore(baseQ.rsi14);
    const ok = ps >= 1.5;
    const tag = baseQ.rsi14 > 70 ? " 과매수" : baseQ.rsi14 < 30 ? " 과매도" : baseQ.rsi14 >= 40 && baseQ.rsi14 <= 60 ? " 이상적" : " 양호";
    results.push({
      label: `${baseName} RSI 30~70`,
      ok, partialScore: ps,
      detail: `RSI ${baseQ.rsi14.toFixed(1)}${tag} · ${ps.toFixed(1)}/3점`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }

  // MA20 (기준 종목 20일 이평선 위 = 상승 추세)
  if (baseQ?.ok && baseQ.aboveMA20 != null) {
    const diff = baseQ.ma20 ? ((baseQ.price - baseQ.ma20) / baseQ.ma20 * 100) : 0;
    let ps = 0;
    if (diff >= 3) ps = 4;
    else if (diff >= 1) ps = 3.5;
    else if (diff >= 0) ps = 2.5;
    else if (diff >= -1) ps = 1;
    const ok = diff >= 0;
    results.push({
      label: `${baseName} MA20 위 (상승 추세)`,
      ok, partialScore: ps,
      detail: `현재 $${baseQ.price?.toFixed(2)} / MA20 $${baseQ.ma20?.toFixed(2)} (${diff > 0 ? "+" : ""}${diff.toFixed(1)}%) · ${ps.toFixed(1)}/4점`,
      priority: "high",
    });
    total++; if (ok) score++;
  }

  // ETF 자체 5일 모멘텀
  if (tq?.ok && tq.fiveDayReturn != null) {
    const r = tq.fiveDayReturn;
    let ps = 0;
    if (r >= 2) ps = 2;
    else if (r >= 0) ps = 1.5;
    else if (r >= -3) ps = 1;
    else if (r >= -5) ps = 0.5;
    const ok = r > -5;
    const tag = r > 3 ? " 강세" : r > 0 ? " 양호" : r > -5 ? " 약세" : " 급락";
    results.push({
      label: `${targetTicker} 5일 모멘텀`,
      ok, partialScore: ps,
      detail: `최근 5거래일 ${r > 0 ? "+" : ""}${r.toFixed(2)}%${tag} · ${ps.toFixed(1)}/2점`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // 9. 배당락 D-day (YieldMax=매주 목요일, Roundhill=매주 월요일 자동 계산)
  const isW = ["AMDW", "PLTW"].includes(targetTicker);
  const divWeekday = isW ? 1 : 4; // JS: 1=월, 4=목
  const todayDow = today.getDay();
  const daysToDiv = (divWeekday - todayDow + 7) % 7 || 7;
  const divTypeLabel = isW ? "Roundhill 월요일" : "YieldMax 목요일";
  const divOk = daysToDiv >= 1 && daysToDiv <= 3;
  let divPs = 0;
  if (daysToDiv === 1) divPs = 1;
  else if (daysToDiv === 2) divPs = 0.7;
  else if (daysToDiv === 3) divPs = 0.4;
  results.push({
    label: "배당락일 1~3일 전",
    ok: divOk,
    partialScore: divPs,
    detail: `다음 ${divTypeLabel} 배당락 D-${daysToDiv} · ${divPs.toFixed(1)}/1점`,
    priority: "bonus",
  });
  total++; if (divOk) score++;

  // 가중치 점수 (critical=5, high=4, mid=3, low=2, bonus=1) - 부분점수 적용
  const WEIGHTS = { critical: 5, high: 4, mid: 3, low: 2, bonus: 1 };
  let wScore = 0, wMax = 0;
  results.forEach(r => {
    const w = WEIGHTS[r.priority] ?? 1;
    wMax += w;
    // partialScore 있으면 그라데이션 점수, 없으면 기존 ok 방식
    wScore += r.partialScore != null ? r.partialScore : (r.ok ? w : 0);
  });
  const pct = wMax > 0 ? Math.round((wScore / wMax) * 100) : 0;

  // Critical veto: critical 조건 1개라도 실패 시 진입 적합 차단
  const failedCritical = results.filter(r => r.priority === "critical" && !r.ok);
  const criticalFails = failedCritical.length;
  const criticalVeto = criticalFails > 0;

  // 학습된 임계값 적용 (5건+ 검증 시), 기본 80%
  const passThreshold = learnedThreshold?.threshold ?? 80;
  // 점수 시스템 적합도 체크 (역효과인 경우 진입 적합 차단)
  const fitnessUnfit = scoreFitness != null && scoreFitness.corr != null && scoreFitness.corr < -0.1 && scoreFitness.count >= 5;

  let signal = "위험", signalColor = "#ef4444";
  if (criticalVeto) {
    signal = criticalFails >= 2 ? "위험 (Critical 다수 실패)" : "주의 관찰 (Critical 실패)";
    signalColor = criticalFails >= 2 ? "#ef4444" : "#f59e0b";
  } else if (fitnessUnfit) {
    signal = "관망 (점수 신뢰 불가)";
    signalColor = "#f97316";
  } else if (pct >= passThreshold) { signal = "진입 적합"; signalColor = "#22c55e"; }
  else if (pct >= 50) { signal = "주의 관찰"; signalColor = "#f59e0b"; }

  // 등급 (S/A+/A/B+/B/C/D/F)
  let grade;
  if (criticalVeto) grade = criticalFails >= 2 ? "F" : "C";
  else if (pct >= 95) grade = "S";
  else if (pct >= 90) grade = "A+";
  else if (pct >= 85) grade = "A";
  else if (pct >= 80) grade = "B+";
  else if (pct >= 70) grade = "B";
  else if (pct >= 60) grade = "C+";
  else if (pct >= 50) grade = "C";
  else if (pct >= 35) grade = "D";
  else grade = "F";

  // 코멘트 생성 (강점/약점 + 종합)
  const failed = results.filter(r => !r.ok);
  const passed = results.filter(r => r.ok);
  const failedCriticalLabels = failed.filter(r => r.priority === "critical").map(r => r.label.replace(/^[\d\.\s]+/, ""));
  const failedHighLabels = failed.filter(r => r.priority === "high").map(r => r.label.replace(/^[\d\.\s]+/, ""));
  const passedCriticalCount = passed.filter(r => r.priority === "critical").length;
  const passedHighCount = passed.filter(r => r.priority === "high").length;

  const cons = [];
  failedCriticalLabels.forEach(l => cons.push(`🔴 ${l}`));
  failedHighLabels.forEach(l => cons.push(`🟠 ${l}`));
  failed.filter(r => r.priority === "mid").slice(0, 2).forEach(r => cons.push(`🟡 ${r.label}`));

  const pros = [];
  if (passedCriticalCount === 3) pros.push("✅ 이벤트/VIX 핵심 3개 모두 안전");
  else if (passedCriticalCount >= 1) {
    passed.filter(r => r.priority === "critical").slice(0, 2).forEach(r => pros.push(`✅ ${r.label}`));
  }
  if (passedHighCount >= 1) {
    passed.filter(r => r.priority === "high").slice(0, 2).forEach(r => pros.push(`✅ ${r.label}`));
  }

  // 자연어 코멘트 생성 (3단 구조: 판단 → 근거 → 조언)
  const failedCriticalConds = failed.filter(r => r.priority === "critical");
  const failedHighConds = failed.filter(r => r.priority === "high");
  const passedCriticalCnt = passed.filter(r => r.priority === "critical").length;
  const baseStock = ({ NVDY: "NVDA", AMDW: "AMD", AMDY: "AMD", TSMY: "TSM", PLTW: "PLTR" })[targetTicker] || "기초종목";

  // ① 도입부 — 전체 판단
  let intro;
  if (criticalFails >= 2) {
    intro = `핵심 리스크 조건이 ${criticalFails}개 동시에 위반되어 진입은 절대 권장되지 않습니다.`;
  } else if (criticalFails === 1) {
    const c = failedCriticalConds[0];
    if (c.label.includes("CPI") || c.label.includes("FOMC")) {
      intro = "주요 매크로 이벤트(CPI 또는 FOMC)가 임박해 있어 진입은 위험합니다.";
    } else if (c.label.includes("실적")) {
      intro = `${baseStock} 실적 발표가 1~2일 내 임박해 있어 진입은 권장되지 않습니다.`;
    } else if (c.label.includes("VIX")) {
      intro = "VIX 지수가 적정 구간(15~30)을 벗어나 있어 진입은 신중해야 합니다.";
    } else {
      intro = "핵심 조건 1개가 충족되지 않아 진입은 신중해야 합니다.";
    }
  } else if (pct >= 95) {
    intro = "모든 주요 리스크 요인이 해소되었고 부수 지표도 거의 전부 충족되어 최적의 진입 타이밍입니다.";
  } else if (pct >= 85) {
    intro = "이벤트 리스크와 변동성 환경이 양호하여 진입에 적합한 상태입니다.";
  } else if (pct >= 80) {
    intro = "기본적인 진입 조건은 통과했으나 일부 보조 지표가 약합니다.";
  } else if (pct >= 60) {
    intro = "시장 환경에 일부 약점이 있어 진입에 신중한 판단이 필요합니다.";
  } else {
    intro = "다수의 조건이 충족되지 않아 현 시점 진입은 권장되지 않습니다.";
  }

  // ② 근거 — 구체적 이유 나열
  const reasons = [];
  failedCriticalConds.forEach(c => {
    if (c.label.includes("CPI") || c.label.includes("FOMC")) {
      reasons.push("매크로 이벤트는 시장 전체를 ±2~5% 흔들 수 있어 ETF 가격이 크게 변동할 가능성이 높습니다");
    } else if (c.label.includes("실적")) {
      reasons.push(`${baseStock} 실적 발표 후 ±10~15% 갭이 흔하고, IV 크러시로 다음 회 배당금이 평소의 50~70% 수준으로 감소할 수 있습니다`);
    } else if (c.label.includes("VIX")) {
      const vixMatch = c.detail.match(/VIX\s*([\d.]+)/);
      const vixVal = vixMatch ? parseFloat(vixMatch[1]) : null;
      if (vixVal && vixVal >= 30) {
        reasons.push(`현재 VIX ${vixVal.toFixed(1)}로 극도공포 구간에 진입했으며, 시장 추가 하락 시 ETF 가격도 함께 떨어질 위험이 큽니다`);
      } else if (vixVal && vixVal < 15) {
        reasons.push(`현재 VIX ${vixVal.toFixed(1)}로 너무 안정적이라 옵션 프리미엄이 낮아 다음 배당이 평소보다 적을 것으로 예상됩니다`);
      } else {
        reasons.push("VIX가 적정 구간을 벗어나 있어 배당원천(옵션 프리미엄)이 비정상적입니다");
      }
    }
  });
  failedHighConds.forEach(c => {
    if (c.label.includes("MA20")) {
      reasons.push(`${baseStock}가 20일 이동평균선 아래에서 거래 중이라 단기 하락 추세 진입 가능성이 있습니다`);
    } else if (c.label.includes("변동")) {
      reasons.push(`${baseStock}의 당일 변동성이 평소보다 크게 나타나 매수 타이밍이 불리합니다`);
    }
  });
  // mid 실패 1개만 부가 설명
  const midFails = failed.filter(r => r.priority === "mid").slice(0, 1);
  midFails.forEach(c => {
    if (c.label.includes("RSI")) {
      const rsiMatch = c.detail.match(/RSI\s*([\d.]+)/);
      const rsi = rsiMatch ? parseFloat(rsiMatch[1]) : null;
      if (rsi && rsi > 70) reasons.push(`${baseStock} RSI ${rsi.toFixed(0)}로 과매수 구간이라 단기 조정 가능성이 있습니다`);
      else if (rsi && rsi < 30) reasons.push(`${baseStock} RSI ${rsi.toFixed(0)}로 과매도 구간이며 반등 가능성도 있으나 추세 확인이 필요합니다`);
    } else if (c.label.includes("5일 모멘텀")) {
      reasons.push("최근 5거래일 수익률이 마이너스로 단기 약세 흐름이 이어지고 있습니다");
    } else if (c.label.includes("QQQ")) {
      reasons.push("나스닥 시장 전체가 약세를 보이고 있어 개별 ETF도 영향을 받을 수 있습니다");
    }
  });
  // 강점 보강 (critical 통과 + 추세 양호)
  if (criticalFails === 0 && passedCriticalCnt === 3) {
    if (pct >= 85) reasons.push("이벤트 리스크는 모두 없고 VIX·변동성도 적정 구간에 위치합니다");
  }

  // ③ 조언 — 다음 행동
  let advice;
  if (criticalFails >= 2) {
    advice = "즉시 진입은 피하고 이벤트 종료 후 시장 안정을 확인한 뒤 재평가하세요.";
  } else if (criticalFails === 1) {
    const c = failedCriticalConds[0];
    if (c.label.includes("실적")) advice = "실적 발표 결과를 확인하고 다음 배당 사이클에서 재진입을 권장합니다.";
    else if (c.label.includes("CPI") || c.label.includes("FOMC")) advice = "이벤트 종료 후 시장 방향성을 확인하고 진입을 결정하세요.";
    else advice = "해당 조건이 해소될 때까지 대기 후 재평가를 권장합니다.";
  } else if (pct >= 95) {
    advice = `배당락 D-1 마감 직전 매수 → 배당락일 보유 → 다음 회차 ${targetTicker !== "AMDW" && targetTicker !== "PLTW" ? "월요일" : "수요일"} 회전 전략이 유효합니다.`;
  } else if (pct >= 85) {
    advice = "평소 비중으로 D-1 마감 직전 매수 후 배당락일 보유 가능합니다.";
  } else if (pct >= 80) {
    advice = "평소 비중의 70~80%로 보수적 진입을 권장합니다.";
  } else if (pct >= 60) {
    advice = "추세가 명확해질 때까지 한 주 더 관망하거나 소량 분할 매수 검토를 권장합니다.";
  } else {
    advice = "다음 회차에서 환경 개선을 기다린 후 재평가하세요.";
  }

  const reasonText = reasons.length > 0 ? " " + reasons.map(r => r + ".").join(" ") : "";
  const summary = intro + reasonText + " " + advice;
  // 짧은 한줄 요약도 별도 유지
  const summaryShort = intro;

  return { results, score: wScore, total: wMax, pct, signal, signalColor, failedCritical, criticalVeto, grade, summary, summaryShort, pros: pros.slice(0, 3), cons: cons.slice(0, 3), passThreshold, learnedThreshold, scoreFitness, fitnessUnfit };
}


// ─── 자가 학습 헬퍼: 종목별 최적 진입 임계값 ────────────────────────────────
function getLearnedThreshold(targetTicker, predictionLog) {
  if (!predictionLog?.snapshots) return null;
  const items = predictionLog.snapshots.filter(s =>
    s.tk === targetTicker && s.netReturnPct != null && s.entryPct != null
  );
  if (items.length < 5) return null;
  const baseline = items.reduce((a, s) => a + s.netReturnPct, 0) / items.length;
  let best = { th: null, alpha: -Infinity };
  for (let th = 60; th <= 95; th += 5) {
    const sub = items.filter(s => s.entryPct >= th);
    if (sub.length < 3) continue;
    const ar = sub.reduce((a, s) => a + s.netReturnPct, 0) / sub.length;
    const alpha = ar - baseline;
    if (alpha > best.alpha) best = { th, alpha };
  }
  return best.th != null ? { threshold: best.th, alpha: best.alpha, count: items.length } : null;
}

// 종목별 점수-수익 상관계수 (Pearson)
function getScoreFitness(targetTicker, predictionLog) {
  if (!predictionLog?.snapshots) return null;
  const items = predictionLog.snapshots.filter(s =>
    s.tk === targetTicker && s.netReturnPct != null && s.entryPct != null
  );
  if (items.length < 3) return null;
  const xs = items.map(s => s.entryPct);
  const ys = items.map(s => s.netReturnPct);
  const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xm) * (ys[i] - ym);
    dx += (xs[i] - xm) ** 2;
    dy += (ys[i] - ym) ** 2;
  }
  const corr = (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
  return { corr, count: items.length };
}

// ─── 통계 계산 (회전이력 탭용) ─────────────────────────────────────────────
function calcLogStats(log) {
  if (!log || log.length === 0) return null;
  const now = new Date();
  const thisMonth = log.filter((l) => {
    const d = new Date(l.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  const last90 = log.filter((l) => (now - new Date(l.date)) / 86400000 <= 90).length;
  const annualEst = Math.round((last90 / 90) * 365);
  return { total: log.length, thisMonth, last90, annualEst };
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export default function App() {
  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [activeTicker, setActiveTicker] = useState(() => storage.get(STORAGE_KEYS.ticker, "NVDY"));
  const [events, setEvents] = useState(() => storage.get(STORAGE_KEYS.events, DEFAULT_EVENTS));
  const [rotationLog, setRotationLog] = useState(() => storage.get(STORAGE_KEYS.log, []));
  const [manualVix, setManualVix] = useState(() => storage.get(STORAGE_KEYS.vix, ""));
  const [scoreHistory, setScoreHistory] = useState(() => storage.get(STORAGE_KEYS.scoreHistory, []));
  const [predictionLog, setPredictionLog] = useState(null);
  const [predictFilter, setPredictFilter] = useState("ALL");
  useEffect(() => {
    fetch(`/predictions.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setPredictionLog(d || { snapshots: [], updatedAt: null }))
      .catch(() => setPredictionLog({ snapshots: [], updatedAt: null }));
  }, []);
  const [marketTime, setMarketTime] = useState(() => new Date());
  const [tab, setTab] = useState("signal");
  const [showEventModal, setShowEventModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [showTabOrderModal, setShowTabOrderModal] = useState(false);
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [tabOrder, setTabOrder] = useState(() => {
    const saved = storage.get(STORAGE_KEYS.tabOrder, null);
    const defaultIds = DEFAULT_TABS.map((t) => t.id);
    if (!Array.isArray(saved)) return defaultIds;
    // 기존 순서 유지 + 누락된 신규 탭은 뒤에 추가, 사라진 ID는 제거
    const valid = saved.filter((id) => defaultIds.includes(id));
    const missing = defaultIds.filter((id) => !valid.includes(id));
    return [...valid, ...missing];
  });
  const [newEvent, setNewEvent] = useState({ date: "", type: "CPI", label: "" });
  const [newLog, setNewLog] = useState({
    date: new Date().toISOString().slice(0, 10),
    from: "NVDY", to: "AMDW", note: "",
  });

  // 클라우드 sync state
  const [cloudUser, setCloudUser] = useState(null);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const lastSyncedJsonRef = useRef("");

  // storage 자동 저장 (오프라인 캐시)
  useEffect(() => storage.set(STORAGE_KEYS.events, events), [events]);
  useEffect(() => storage.set(STORAGE_KEYS.log, rotationLog), [rotationLog]);
  useEffect(() => storage.set(STORAGE_KEYS.vix, manualVix), [manualVix]);
  useEffect(() => storage.set(STORAGE_KEYS.ticker, activeTicker), [activeTicker]);
  useEffect(() => storage.set(STORAGE_KEYS.tabOrder, tabOrder), [tabOrder]);

  // 인증 상태 구독
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    return watchAuth((u) => {
      setCloudUser(u);
      if (!u) {
        setCloudReady(false);
        lastSyncedJsonRef.current = "";
      }
    });
  }, []);

  // 로그인 후 초기 동기화 + 실시간 구독
  useEffect(() => {
    if (!cloudUser) return;
    let unsubscribe = null;
    let cancelled = false;
    setCloudSyncing(true);
    (async () => {
      try {
        const cloud = await fetchCloudState(cloudUser.uid);
        if (cancelled) return;
        const local = { events, log: rotationLog, vix: manualVix, scoreHistory, tabOrder, activeTicker };
        if (!cloud) {
          // 첫 로그인: 로컬 데이터 업로드
          await writeCloudState(cloudUser.uid, local);
          lastSyncedJsonRef.current = JSON.stringify(local);
        } else {
          // 클라우드 우선 적용
          if (Array.isArray(cloud.events)) setEvents(cloud.events);
          if (Array.isArray(cloud.log)) setRotationLog(cloud.log);
          if (typeof cloud.vix !== "undefined") setManualVix(cloud.vix);
          if (Array.isArray(cloud.scoreHistory)) setScoreHistory(cloud.scoreHistory);
          if (Array.isArray(cloud.tabOrder) && cloud.tabOrder.length) {
            const defaultIds = DEFAULT_TABS.map((t) => t.id);
            const valid = cloud.tabOrder.filter((id) => defaultIds.includes(id));
            const missing = defaultIds.filter((id) => !valid.includes(id));
            setTabOrder([...valid, ...missing]);
          }
          if (typeof cloud.activeTicker === "string") setActiveTicker(cloud.activeTicker);
          lastSyncedJsonRef.current = JSON.stringify({
            events: cloud.events, log: cloud.log, vix: cloud.vix, scoreHistory: cloud.scoreHistory, tabOrder: cloud.tabOrder, activeTicker: cloud.activeTicker,
          });
        }
        setCloudReady(true);
        unsubscribe = subscribeCloudState(cloudUser.uid, (data) => {
          if (!data) return;
          const snapJson = JSON.stringify({
            events: data.events, log: data.log, vix: data.vix, scoreHistory: data.scoreHistory, tabOrder: data.tabOrder, activeTicker: data.activeTicker,
          });
          if (snapJson === lastSyncedJsonRef.current) return; // 자기가 보낸 echo
          lastSyncedJsonRef.current = snapJson;
          if (Array.isArray(data.events)) setEvents(data.events);
          if (Array.isArray(data.log)) setRotationLog(data.log);
          if (typeof data.vix !== "undefined") setManualVix(data.vix);
          if (Array.isArray(data.scoreHistory)) setScoreHistory(data.scoreHistory);
          if (Array.isArray(data.tabOrder) && data.tabOrder.length) {
            const defaultIds = DEFAULT_TABS.map((t) => t.id);
            const valid = data.tabOrder.filter((id) => defaultIds.includes(id));
            const missing = defaultIds.filter((id) => !valid.includes(id));
            setTabOrder([...valid, ...missing]);
          }
          if (typeof data.activeTicker === "string") setActiveTicker(data.activeTicker);
        });
      } catch (e) {
        console.error("[cloud] initial sync failed:", e);
      } finally {
        if (!cancelled) setCloudSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUser]);

  // 로컬 변경 → 클라우드 write (debounced 500ms)
  useEffect(() => {
    if (!cloudUser || !cloudReady) return;
    const snapshot = { events, log: rotationLog, vix: manualVix, scoreHistory, tabOrder, activeTicker };
    const json = JSON.stringify(snapshot);
    if (json === lastSyncedJsonRef.current) return;
    const id = setTimeout(() => {
      lastSyncedJsonRef.current = json;
      writeCloudState(cloudUser.uid, snapshot).catch((e) => console.error("[cloud] write failed:", e));
    }, 500);
    return () => clearTimeout(id);
  }, [events, rotationLog, manualVix, scoreHistory, tabOrder, activeTicker, cloudUser, cloudReady]);
  useEffect(() => {
    const id = setInterval(() => setMarketTime(new Date()), 10000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await Promise.all(TICKERS.map(fetchQuote));
    const map = {};
    res.forEach((r) => { map[r.ticker] = r; });
    setQuotes(map);
    setLastUpdate(new Date());
    setLoading(false);
    // 배당락일 1~3일 전이면 하루 1회 자동저장 (Y=목요일, W=월요일)
    const todayStr = new Date().toISOString().slice(0, 10);
    const _dow = new Date().getDay();
    const daysToThu = (4 - _dow + 7) % 7 || 7;
    const daysToMon = (1 - _dow + 7) % 7 || 7;
    const hasUpcomingDiv = (daysToThu >= 1 && daysToThu <= 3) || (daysToMon >= 1 && daysToMon <= 3);
    if (hasUpcomingDiv) {
      setScoreHistory(prev => {
        if (prev.find(s => s.auto && s.ts?.slice(0, 10) === todayStr)) return prev;
        const snap = {
          ts: new Date().toISOString(),
          auto: true,
          scores: Object.fromEntries(
            ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(tk => [
              tk, evaluateConditions(map, tk, events, manualVix).pct
            ])
          ),
        };
        const updated = [snap, ...prev].slice(0, 200);
        storage.set(STORAGE_KEYS.scoreHistory, updated);
        return updated;
      });
    }
  }, [events, manualVix]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, [refresh]);

  const evaluation = useMemo(
    () => evaluateConditions(quotes, activeTicker, events, manualVix),
    [quotes, activeTicker, events, manualVix]
  );

  const todayStr = new Date().toISOString().slice(0, 10);
  const upcomingEvents = useMemo(
    () => events.filter((e) => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10),
    [events, todayStr]
  );
  const logStats = useMemo(() => calcLogStats(rotationLog), [rotationLog]);
  const marketStatus = useMemo(() => getMarketStatus(marketTime), [marketTime]);

  const saveSnapshot = useCallback(() => {
    const snap = {
      ts: new Date().toISOString(),
      scores: Object.fromEntries(
        ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(tk => [
          tk, evaluateConditions(quotes, tk, events, manualVix).pct
        ])
      ),
    };
    setScoreHistory(prev => {
      const updated = [snap, ...prev].slice(0, 200);
      storage.set(STORAGE_KEYS.scoreHistory, updated);
      return updated;
    });
  }, [quotes, events, manualVix]);
  const allEvaluations = useMemo(
    () => ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(tk => ({
      ticker: tk, ...evaluateConditions(quotes, tk, events, manualVix),
    })),
    [quotes, events, manualVix]
  );

  const fmtTime = (d) => d ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
  const fmtDate = (s) => { const d = new Date(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const dDays = (s) => Math.ceil((new Date(s) - new Date(todayStr)) / 86400000);

  const TABS = useMemo(() => {
    const byId = Object.fromEntries(DEFAULT_TABS.map((t) => [t.id, t]));
    return tabOrder.map((id) => byId[id]).filter(Boolean);
  }, [tabOrder]);

  const C = {
    bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
    text: "#1e293b", sub: "#64748b", muted: "#94a3b8",
    blue: "#1d4ed8", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
  };

  // 우선순위별 정렬 (high → mid → low)
  const sortedResults = [...evaluation.results].sort((a, b) => {
    const order = { high: 0, mid: 1, low: 2 };
    return (order[a.priority] ?? 99) - (order[b.priority] ?? 99);
  });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, sans-serif", paddingBottom: 80 }}>

      {/* 헤더 */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px 12px", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.blue }}>📈 배당회전 타이밍</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>NVDY / AMDW Rotation · v{APP_VERSION}</div>
          </div>
          <button onClick={refresh} disabled={loading}
            style={{ background: loading ? C.border : C.blue, border: "none", borderRadius: 8, color: loading ? C.muted : "#fff", padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {loading ? "갱신중" : "새로고침"}
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
          <div style={{ fontSize: 9, color: "#cbd5e1" }}>
            {lastUpdate ? `갱신: ${fmtTime(lastUpdate)} · Yahoo Finance` : "데이터 로딩 중..."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 9, color: "#94a3b8" }}>ET {marketStatus.etStr}</span>
            <span style={{ background: `${marketStatus.color}25`, color: marketStatus.color, borderRadius: 5, padding: "1px 8px", fontSize: 9, fontWeight: 700 }}>{marketStatus.label}</span>
          </div>
        </div>
        {/* 클라우드 sync 상태 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "6px 8px", background: cloudUser ? "#dcfce7" : isFirebaseConfigured ? "#fef3c7" : "#fee2e2", borderRadius: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: cloudUser ? "#166534" : isFirebaseConfigured ? "#92400e" : "#991b1b", display: "flex", alignItems: "center", gap: 6 }}>
            {!isFirebaseConfigured && <><span>⚠️</span><span>Firebase 미설정 — .env 입력 필요</span></>}
            {isFirebaseConfigured && !cloudUser && <><span>☁️</span><span>로그인하면 기기간 자동 동기화</span></>}
            {cloudUser && <><span>{cloudSyncing ? "⏳" : "✓"}</span><span>{cloudUser.displayName || cloudUser.email} · {cloudSyncing ? "동기화중" : "동기화됨"}</span></>}
          </div>
          {isFirebaseConfigured && !cloudUser && (
            <button onClick={() => signInGoogle().catch((e) => alert("로그인 실패: " + e.message))}
              style={{ background: C.blue, border: "none", borderRadius: 6, color: "#fff", padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              Google 로그인
            </button>
          )}
          {cloudUser && (
            <button onClick={() => signOutUser().catch(() => {})}
              style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: C.sub, padding: "3px 8px", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
              로그아웃
            </button>
          )}
        </div>
        {/* 글로벌 마켓 스트립 */}
        <div style={{ display: "flex", justifyContent: "space-around", gap: 4, marginTop: 8, padding: "6px 4px", background: "#f8fafc", borderRadius: 7 }}>
          {[
            { tk: "KRW=X", label: "환율", fmt: (v) => `₩${v.toFixed(0)}` },
            { tk: "^IXIC", label: "NASDAQ", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
            { tk: "^KS11", label: "KOSPI", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
          ].map(({ tk, label, fmt }) => {
            const q = quotes[tk];
            return (
              <div key={tk} style={{ flex: 1, textAlign: "center", borderRight: tk !== "^KS11" ? "1px solid #e2e8f0" : "none" }}>
                <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>{label}</div>
                {q?.ok ? (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#1e293b" }}>{fmt(q.price)}</div>
                    <div style={{ fontSize: 8, color: q.changePct >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>
                      {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                    </div>
                  </>
                ) : <div style={{ fontSize: 10, color: "#94a3b8" }}>-</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 탭 */}
      <div style={{ display: "flex", background: C.card, borderBottom: `1px solid ${C.border}`, overflowX: "auto", position: "relative" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex: 1, minWidth: 72, padding: "11px 6px", background: "none", border: "none", borderBottom: tab === t.id ? `2px solid ${C.blue}` : "2px solid transparent", color: tab === t.id ? C.blue : C.muted, fontSize: 10, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
        <button onClick={() => setShowTabOrderModal(true)} aria-label="탭 순서 편집"
          title="탭 순서 편집"
          style={{ position: "sticky", right: 0, flex: "0 0 auto", minWidth: 40, padding: "11px 10px", background: `linear-gradient(to right, transparent, ${C.card} 30%)`, border: "none", borderBottom: "2px solid transparent", color: C.sub, fontSize: 14, cursor: "pointer" }}>
          ⚙️
        </button>
      </div>

      {showTabOrderModal && (
        <Modal C={C} onClose={() => setShowTabOrderModal(false)} title="탭 순서 편집">
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, lineHeight: 1.5 }}>
            ☰ 핸들을 잡고 드래그해 순서를 바꾸세요. 변경은 자동 저장됩니다.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "60vh", overflowY: "auto", userSelect: "none" }}>
            {tabOrder.map((id, idx) => {
              const t = DEFAULT_TABS.find((x) => x.id === id);
              if (!t) return null;
              const isDragging = draggingIdx === idx;
              return (
                <div
                  key={id}
                  data-tab-row-idx={idx}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDraggingIdx(idx);
                  }}
                  onPointerMove={(e) => {
                    if (draggingIdx === null) return;
                    const els = document.elementsFromPoint(e.clientX, e.clientY);
                    const overEl = els.find((el) => el?.dataset?.tabRowIdx != null);
                    if (!overEl) return;
                    const overIdx = parseInt(overEl.dataset.tabRowIdx, 10);
                    if (overIdx === draggingIdx || Number.isNaN(overIdx)) return;
                    setTabOrder((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(draggingIdx, 1);
                      next.splice(overIdx, 0, moved);
                      return next;
                    });
                    setDraggingIdx(overIdx);
                  }}
                  onPointerUp={(e) => {
                    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
                    setDraggingIdx(null);
                  }}
                  onPointerCancel={() => setDraggingIdx(null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: isDragging ? "#dbeafe" : "#f8fafc",
                    border: `1px solid ${isDragging ? C.blue : C.border}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    opacity: isDragging ? 0.85 : 1,
                    boxShadow: isDragging ? "0 4px 12px rgba(29,78,216,0.18)" : "none",
                    touchAction: "none",
                    cursor: isDragging ? "grabbing" : "grab",
                    transition: isDragging ? "none" : "background 0.12s, border-color 0.12s",
                  }}
                >
                  <div style={{ fontSize: 16, color: C.muted, lineHeight: 1, pointerEvents: "none" }}>☰</div>
                  <div style={{ flex: 1, fontSize: 13, color: C.text, fontWeight: 600, pointerEvents: "none" }}>{t.label}</div>
                  <div style={{ fontSize: 10, color: C.muted, pointerEvents: "none" }}>{idx + 1}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={() => setTabOrder(DEFAULT_TABS.map((t) => t.id))} style={btnCancel(C)}>기본값 복원</button>
            <button onClick={() => setShowTabOrderModal(false)} style={btnPrimary(C)}>완료</button>
          </div>
        </Modal>
      )}

      <div style={{ padding: 16 }}>

        {/* ── 진입신호 탭 ── */}
        {tab === "signal" && (
          <div>
            {evaluation.criticalVeto && (
              <div style={{ background: evaluation.failedCritical.length >= 2 ? "#fef2f2" : "#fffbeb", border: `2px solid ${evaluation.failedCritical.length >= 2 ? "#ef4444" : "#f59e0b"}`, borderRadius: 10, padding: "11px 14px", marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: evaluation.failedCritical.length >= 2 ? "#991b1b" : "#92400e", marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>⚠️</span>
                  <span>핵심 조건 {evaluation.failedCritical.length}개 실패 — 진입 부적합</span>
                </div>
                <div style={{ fontSize: 10, color: evaluation.failedCritical.length >= 2 ? "#7f1d1d" : "#78350f", lineHeight: 1.6 }}>
                  {evaluation.failedCritical.map((r, i) => (
                    <div key={i}>· {r.label} — {r.detail}</div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: evaluation.failedCritical.length >= 2 ? "#991b1b" : "#92400e", marginTop: 5, fontStyle: "italic" }}>
                  점수와 무관하게 critical 조건 실패 시 진입 비추천
                </div>
              </div>
            )}
            {/* 통합: 전체 비교 + 종목 선택 (그룹별로 표시, 클릭 시 활성화) */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.text, letterSpacing: 0.2 }}>📊 종목 비교 · 탭하면 상세 평가</div>
                <button onClick={saveSnapshot}
                  style={{ background: C.blue, border: "none", borderRadius: 7, color: "#fff", padding: "5px 11px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📥 저장</button>
              </div>

              {[
                { group: "YieldMax · 매주 목요일", tickers: ["NVDY", "AMDY", "TSMY"], color: "#f59e0b" },
                { group: "Roundhill · 매주 월요일", tickers: ["AMDW", "PLTW"], color: "#3b82f6" },
              ].map(({ group, tickers, color }) => (
                <div key={group} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, marginBottom: 5, letterSpacing: 0.4, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: color, display: "inline-block" }}></span>
                    {group}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {tickers
                      .map(tk => allEvaluations.find(ev => ev.ticker === tk))
                      .filter(Boolean)
                      .sort((a, b) => b.pct - a.pct)
                      .map((ev) => {
                        const q = quotes[ev.ticker];
                        const isActive = activeTicker === ev.ticker;
                        const usdkrw = quotes["KRW=X"]?.price;
                        return (
                          <div key={ev.ticker} onClick={() => setActiveTicker(ev.ticker)}
                            style={{ background: isActive ? `${ev.signalColor}10` : C.card, border: `1.5px solid ${isActive ? ev.signalColor + "70" : C.border}`, borderRadius: 11, padding: "9px 12px", cursor: "pointer", transition: "all 0.15s", boxShadow: isActive ? `0 2px 8px ${ev.signalColor}20` : "none" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 5 }}>
                              <span style={{ fontWeight: 800, fontSize: 14, color: isActive ? ev.signalColor : C.text, minWidth: 48 }}>{ev.ticker}</span>
                              <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 99, overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 99, background: ev.signalColor, width: `${ev.pct}%`, transition: "width 0.5s ease" }} />
                              </div>
                              <span style={{ fontSize: 12, fontWeight: 800, color: ev.signalColor, minWidth: 38, textAlign: "right" }}>{ev.pct}%</span>
                              <span style={{ fontSize: 9, color: "#fff", background: ev.signalColor, borderRadius: 5, padding: "2px 6px", fontWeight: 700, whiteSpace: "nowrap" }}>{ev.signal.split(" ")[0]}</span>
                            </div>
                            {q?.ok && (
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: C.muted, paddingLeft: 2 }}>
                                <span>
                                  <span style={{ color: C.text, fontWeight: 600 }}>${q.price?.toFixed(2)}</span>
                                  {usdkrw && <span style={{ color: C.text, fontWeight: 600 }}> · ₩{Math.round(q.price * usdkrw).toLocaleString()}</span>}
                                </span>
                                <span style={{ color: q.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                                  {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>

                        {/* 신호 카드 */}
            <div style={{ background: C.card, border: `2px solid ${evaluation.signalColor}40`, borderRadius: 16, padding: "16px 18px", marginBottom: 14, boxShadow: `0 4px 20px ${evaluation.signalColor}15` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: evaluation.signalColor, lineHeight: 1.1 }}>{evaluation.signal}</div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>{activeTicker} 진입 평가</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 5 }}>
                    <span style={{ fontSize: 28, fontWeight: 800, color: evaluation.signalColor, lineHeight: 1 }}>{evaluation.score.toFixed(1)}</span>
                    <span style={{ fontSize: 14, color: C.muted, fontWeight: 600 }}>/ {evaluation.total}점</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end", marginTop: 3 }}>
                    <span style={{ background: evaluation.signalColor, color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 12, fontWeight: 800 }}>{evaluation.grade}</span>
                    <span style={{ fontSize: 10, color: C.muted }}>{evaluation.pct}%</span>
                  </div>
                  {/* 학습 임계값 적용 상태 */}
                  {evaluation.learnedThreshold && (
                    <div style={{ marginTop: 6, padding: "3px 7px", background: "#ede9fe", borderRadius: 5, fontSize: 9, fontWeight: 700, color: "#5b21b6", textAlign: "right" }}>
                      🧠 {activeTicker} 학습 임계값 {evaluation.passThreshold}% 적용 중 (α +{evaluation.learnedThreshold.alpha.toFixed(2)}%)
                    </div>
                  )}
                  {/* 현재 종목의 점수 시스템 적합도 */}
                  {(() => {
                    if (!predictionLog?.snapshots) return null;
                    const items = predictionLog.snapshots.filter(s => s.tk === activeTicker && s.netReturnPct != null && s.entryPct != null);
                    if (items.length < 3) return null;
                    const xs = items.map(s => s.entryPct);
                    const ys = items.map(s => s.netReturnPct);
                    const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
                    const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
                    let num = 0, dx = 0, dy = 0;
                    for (let i = 0; i < xs.length; i++) {
                      num += (xs[i] - xm) * (ys[i] - ym);
                      dx += (xs[i] - xm) ** 2;
                      dy += (ys[i] - ym) ** 2;
                    }
                    const corr = (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
                    if (corr == null) return null;
                    let status, color, emoji;
                    if (items.length < 5) { status = "검증 부족"; color = "#a78bfa"; emoji = "🔸"; }
                    else if (corr >= 0.5) { status = "점수 유효성 ⭐"; color = "#15803d"; emoji = "⭐"; }
                    else if (corr >= 0.3) { status = "점수 양호"; color = "#65a30d"; emoji = "✅"; }
                    else if (corr >= 0.1) { status = "점수 약함"; color = "#d97706"; emoji = "🔹"; }
                    else if (corr >= -0.1) { status = "점수 무관"; color = "#ea580c"; emoji = "⚪"; }
                    else { status = "점수 부적합"; color = "#b91c1c"; emoji = "❌"; }
                    return (
                      <div style={{ marginTop: 4, padding: "3px 7px", background: `${color}15`, borderRadius: 5, fontSize: 9, fontWeight: 700, color, textAlign: "right" }}>
                        {emoji} {activeTicker} {status} (r={corr.toFixed(2)}, {items.length}건)
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div style={{ height: 6, background: C.border, borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
                <div style={{ height: "100%", borderRadius: 99, background: evaluation.signalColor, width: `${evaluation.pct}%`, transition: "width 0.5s ease" }} />
              </div>

              {/* 자연어 평가 코멘트 */}
              <div style={{ background: `${evaluation.signalColor}10`, borderRadius: 9, padding: "11px 13px", marginBottom: 8, borderLeft: `3px solid ${evaluation.signalColor}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                  <span style={{ fontSize: 11 }}>💬</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: evaluation.signalColor, letterSpacing: 0.3 }}>진입 평가 코멘트</span>
                </div>
                <div style={{ fontSize: 11.5, color: C.text, lineHeight: 1.65 }}>{evaluation.summary}</div>
              </div>

              {/* 강점/약점 */}
              {(evaluation.pros.length > 0 || evaluation.cons.length > 0) && (
                <div style={{ display: "grid", gridTemplateColumns: evaluation.pros.length > 0 && evaluation.cons.length > 0 ? "1fr 1fr" : "1fr", gap: 6 }}>
                  {evaluation.pros.length > 0 && (
                    <div style={{ background: "#f0fdf4", borderRadius: 8, padding: "8px 10px", border: "1px solid #bbf7d0" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#166534", marginBottom: 4 }}>강점</div>
                      {evaluation.pros.map((p, i) => (
                        <div key={i} style={{ fontSize: 10, color: "#15803d", lineHeight: 1.5 }}>{p}</div>
                      ))}
                    </div>
                  )}
                  {evaluation.cons.length > 0 && (
                    <div style={{ background: "#fef2f2", borderRadius: 8, padding: "8px 10px", border: "1px solid #fecaca" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#991b1b", marginBottom: 4 }}>약점</div>
                      {evaluation.cons.map((c, i) => (
                        <div key={i} style={{ fontSize: 10, color: "#b91c1c", lineHeight: 1.5 }}>{c}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 우선순위별 그룹 */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.red, marginBottom: 6, letterSpacing: 0.5 }}>🔴 핵심 조건 (Critical · 5점)</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {sortedResults.filter((r) => r.priority === "critical").map((r, i) => (
                <ConditionCard key={"c" + i} r={r} C={C} />
              ))}
            </div>

            {sortedResults.some((r) => r.priority === "high") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#f97316", marginBottom: 6, letterSpacing: 0.5 }}>🟠 중요 조건 (High · 4점)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "high").map((r, i) => (
                    <ConditionCard key={"h" + i} r={r} C={C} />
                  ))}
                </div>
              </>
            )}

            {sortedResults.some((r) => r.priority === "mid") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, marginBottom: 6, letterSpacing: 0.5 }}>🟡 보조 조건 (Mid · 3점)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "mid").map((r, i) => (
                    <ConditionCard key={"m" + i} r={r} C={C} />
                  ))}
                </div>
              </>
            )}

            {sortedResults.some((r) => r.priority === "low") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.green, marginBottom: 6, letterSpacing: 0.5 }}>🟢 참고 조건 (Low · 2점)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "low").map((r, i) => (
                    <ConditionCard key={"l" + i} r={r} C={C} />
                  ))}
                </div>
              </>
            )}

            {sortedResults.some((r) => r.priority === "bonus") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", marginBottom: 6, letterSpacing: 0.5 }}>⚪ 보너스 조건 (Bonus · 1점)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "bonus").map((r, i) => (
                    <ConditionCard key={"b" + i} r={r} C={C} />
                  ))}
                </div>
              </>
            )}

            {/* VIX 수동 입력 */}
            {!quotes["^VIX"]?.ok && (
              <div style={{ marginTop: 12, padding: "11px 13px", background: "#fffbeb", borderRadius: 10, border: "1px solid #fde68a" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#92400e", marginBottom: 7 }}>📌 VIX 수동 입력</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="number" placeholder="예: 18.5" value={manualVix}
                    onChange={(e) => setManualVix(e.target.value)}
                    style={{ flex: 1, background: "#fff", border: "1px solid #fde68a", borderRadius: 8, padding: "7px 10px", fontSize: 13, color: C.text }} />
                  <span style={{ fontSize: 11, color: "#92400e", minWidth: 60, textAlign: "right" }}>
                    {manualVix && parseFloat(manualVix) < 20 ? "✅안정" : manualVix && parseFloat(manualVix) < 30 ? "⚠️주의" : manualVix ? "🔴위험" : ""}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "#b45309", marginTop: 5 }}>finance.yahoo.com/quote/%5EVIX</div>
              </div>
            )}

            <div style={{ marginTop: 14, padding: "11px 13px", background: "#f1f5f9", borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 10, color: C.sub, lineHeight: 1.6 }}>
              ⚠️ <strong>참고</strong>: 일부 조건은 통상적 경험칙입니다. 미국 배당 15% 원천징수 / 금융소득 연 2,000만원 초과 시 종합과세 (출처: 국세청)
            </div>
          </div>
        )}

        {/* ── 시장현황 탭 ── */}
        {tab === "market" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {TICKERS.map((tk) => {
              const q = quotes[tk]; if (!q) return null;
              const NAMES = { "^VIX": "VIX", "KRW=X": "환율 USD/KRW", "^IXIC": "NASDAQ", "^KS11": "KOSPI" };
              const displayName = NAMES[tk] || tk;
              const isIndex = ["^VIX", "^IXIC", "^KS11", "KRW=X"].includes(tk);
              const usdkrw = quotes["KRW=X"]?.price;
              const krwStr = !isIndex && usdkrw && q.price ? ` ≈ ₩${Math.round(q.price * usdkrw).toLocaleString()}` : "";
              return (
                <div key={tk} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 15px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{displayName}</div>
                    {q.ok ? (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 17, fontWeight: 700 }}>{isIndex ? (tk === "KRW=X" ? `₩${q.price?.toFixed(2)}` : q.price?.toLocaleString(undefined, { maximumFractionDigits: 2 })) : `$${q.price?.toFixed(2)}`}</div>
                        {!isIndex && usdkrw && q.price && <div style={{ fontSize: 17, fontWeight: 700, color: C.sub, marginTop: 2 }}>₩{Math.round(q.price * usdkrw).toLocaleString()}</div>}
                        <div style={{ fontSize: 11, fontWeight: 600, marginTop: 1, color: q.changePct >= 0 ? C.green : C.red }}>
                          {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                        </div>
                      </div>
                    ) : <div style={{ fontSize: 10, color: C.red }}>로드 실패 (CORS - 배포 후 정상화)</div>}
                  </div>
                  {q.ok && q.preMarketChange != null && (
                    <div style={{ marginTop: 7, padding: "5px 9px", background: "#f8fafc", borderRadius: 6, fontSize: 10, color: C.sub }}>
                      시간외: <span style={{ color: q.preMarketChange >= 0 ? C.green : C.red, fontWeight: 600 }}>{q.preMarketChange >= 0 ? "+" : ""}{q.preMarketChange?.toFixed(2)}%</span>
                      {" "}(${q.preMarketPrice?.toFixed(2)}{usdkrw ? ` · ₩${Math.round(q.preMarketPrice * usdkrw).toLocaleString()}` : ""})
                    </div>
                  )}
                  {q.ok && q.todayVol && tk !== "^VIX" && (
                    <div style={{ marginTop: 5, padding: "5px 9px", background: q.volRatio > 2 ? "#fff7ed" : "#f8fafc", borderRadius: 6, fontSize: 10, color: q.volRatio > 2 ? "#c2410c" : C.sub, display: "flex", justifyContent: "space-between" }}>
                      <span>거래량 {fmtVol(q.todayVol)}</span>
                      {q.volRatio && <span style={{ fontWeight: 600, color: q.volRatio > 2 ? C.red : q.volRatio > 1.8 ? C.amber : C.green }}>평균 {q.volRatio.toFixed(2)}배{q.volRatio > 2 ? " ⚠️" : ""}</span>}
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: 10, color: "#cbd5e1", textAlign: "center", marginTop: 4 }}>Yahoo Finance (비공식, 딜레이) · 거래 의사결정은 공식 거래소 확인</div>
          </div>
        )}

        {/* ── 이벤트 탭 ── */}
        {tab === "calendar" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>예정 이벤트</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>총 {upcomingEvents.length}건</div>
              </div>
              <button onClick={() => setShowEventModal(true)}
                style={{ background: C.blue, border: "none", borderRadius: 8, color: "#fff", padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ 추가</button>
            </div>
            {upcomingEvents.length === 0 && <div style={{ textAlign: "center", color: "#cbd5e1", padding: "40px 0", fontSize: 13 }}>예정 이벤트 없음</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {upcomingEvents.map((ev, i) => {
                const d = dDays(ev.date);
                return (
                  <div key={i} style={{ background: C.card, border: `1px solid ${EVENT_COLORS[ev.type] || C.border}30`, borderRadius: 10, padding: "11px 13px", display: "flex", justifyContent: "space-between", alignItems: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ background: EVENT_COLORS[ev.type] || "#64748b", borderRadius: 6, padding: "3px 7px", fontSize: 9, fontWeight: 700, color: "#fff", minWidth: 50, textAlign: "center" }}>{ev.type}</div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{ev.label}</div>
                        <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>
                          {fmtDate(ev.date)} · {d === 0 ? "오늘" : d > 0 ? `D-${d}` : `D+${-d}`}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => setEvents((p) => p.filter((x) => !(x.date === ev.date && x.label === ev.label)))}
                      style={{ background: "none", border: "none", color: C.muted, fontSize: 15, cursor: "pointer", padding: "4px 6px" }}>✕</button>
                  </div>
                );
              })}
            </div>
            {showEventModal && (
              <Modal C={C} onClose={() => setShowEventModal(false)} title="이벤트 추가">
                <input type="date" value={newEvent.date}
                  onChange={(e) => setNewEvent((p) => ({ ...p, date: e.target.value }))}
                  style={inputStyle(C)} />
                <select value={newEvent.type}
                  onChange={(e) => setNewEvent((p) => ({ ...p, type: e.target.value }))}
                  style={inputStyle(C)}>
                  <option value="CPI">CPI 발표</option>
                  <option value="FOMC">FOMC</option>
                  <option value="EARNINGS">실적 발표</option>
                  <option value="DIVIDEND">배당락일</option>
                </select>
                <input type="text" placeholder="이벤트명" value={newEvent.label}
                  onChange={(e) => setNewEvent((p) => ({ ...p, label: e.target.value }))}
                  style={inputStyle(C)} />
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={() => setShowEventModal(false)} style={btnCancel(C)}>취소</button>
                  <button onClick={() => {
                    if (!newEvent.date || !newEvent.label) return;
                    setEvents((p) => [...p, { ...newEvent }].sort((a, b) => a.date.localeCompare(b.date)));
                    setNewEvent({ date: "", type: "CPI", label: "" });
                    setShowEventModal(false);
                  }} style={btnPrimary(C)}>추가</button>
                </div>
              </Modal>
            )}
            <div style={{ marginTop: 13, fontSize: 10, color: C.muted, lineHeight: 1.6 }}>
              📌 CPI/FOMC: federalreserve.gov / bls.gov · 실적: 각 회사 IR · 배당락일: YieldMax/Roundhill 공식
            </div>
          </div>
        )}

        {/* ── 회전이력 탭 ── */}
        {tab === "log" && (
          <div>
            {logStats && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                <StatCard label="이번달" value={logStats.thisMonth} C={C} />
                <StatCard label="최근 90일" value={logStats.last90} C={C} />
                <StatCard label="연간 추정" value={logStats.annualEst} C={C} />
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>전체 기록 ({rotationLog.length}건)</div>
              <button onClick={() => setShowLogModal(true)}
                style={{ background: C.blue, border: "none", borderRadius: 8, color: "#fff", padding: "7px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>+ 기록</button>
            </div>
            {rotationLog.length === 0 && (
              <div style={{ textAlign: "center", color: "#cbd5e1", padding: "40px 0", fontSize: 13 }}>
                회전 이력 없음<br /><span style={{ fontSize: 11 }}>회전할 때마다 기록해두세요</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[...rotationLog].reverse().map((log, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 13px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ background: "#dbeafe", color: C.blue, borderRadius: 6, padding: "2px 7px", fontSize: 11, fontWeight: 700 }}>{log.from}</span>
                      <span style={{ fontSize: 12, color: C.muted }}>→</span>
                      <span style={{ background: "#dcfce7", color: "#16a34a", borderRadius: 6, padding: "2px 7px", fontSize: 11, fontWeight: 700 }}>{log.to}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 11, color: C.muted }}>{log.date}</div>
                      <button onClick={() => {
                        if (confirm("이 기록을 삭제할까요?")) {
                          const idx = rotationLog.length - 1 - i;
                          setRotationLog((p) => p.filter((_, j) => j !== idx));
                        }
                      }} style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer" }}>✕</button>
                    </div>
                  </div>
                  {log.note && <div style={{ fontSize: 11, color: C.sub, marginTop: 7, paddingTop: 7, borderTop: "1px solid #f1f5f9" }}>{log.note}</div>}
                </div>
              ))}
            </div>
            {showLogModal && (
              <Modal C={C} onClose={() => setShowLogModal(false)} title="회전 기록">
                <input type="date" value={newLog.date}
                  onChange={(e) => setNewLog((p) => ({ ...p, date: e.target.value }))}
                  style={inputStyle(C)} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select value={newLog.from} onChange={(e) => setNewLog((p) => ({ ...p, from: e.target.value }))} style={{ ...inputStyle(C), flex: 1 }}>
                    <option>NVDY</option><option>AMDW</option><option>AMDY</option><option>TSMY</option><option>PLTW</option><option>현금</option>
                  </select>
                  <span style={{ color: C.muted }}>→</span>
                  <select value={newLog.to} onChange={(e) => setNewLog((p) => ({ ...p, to: e.target.value }))} style={{ ...inputStyle(C), flex: 1 }}>
                    <option>NVDY</option><option>AMDW</option><option>AMDY</option><option>TSMY</option><option>PLTW</option><option>현금</option>
                  </select>
                </div>
                <input type="text" placeholder="메모 (선택)" value={newLog.note}
                  onChange={(e) => setNewLog((p) => ({ ...p, note: e.target.value }))}
                  style={inputStyle(C)} />
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={() => setShowLogModal(false)} style={btnCancel(C)}>취소</button>
                  <button onClick={() => {
                    if (!newLog.date) return;
                    setRotationLog((p) => [...p, { ...newLog }]);
                    setNewLog({ date: new Date().toISOString().slice(0, 10), from: "NVDY", to: "AMDW", note: "" });
                    setShowLogModal(false);
                  }} style={btnPrimary(C)}>저장</button>
                </div>
              </Modal>
            )}
            <div style={{ marginTop: 13, padding: "10px 12px", background: "#f1f5f9", borderRadius: 8, fontSize: 10, color: C.sub, lineHeight: 1.6 }}>
              💡 회전이 많을수록 세금·수수료 누적. 금융소득 연 2,000만원 초과 시 종합과세 (출처: 국세청)
            </div>
          </div>
        )}

        {/* ── 가이드 탭 ── */}
        {tab === "guide" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {[
              { title: "📌 기본 회전 흐름", content: "① NVDY 배당 확보 → ② 배당락일 장 초반 30~90분 관찰 → ③ 주가 안정 확인 → ④ AMDW 이동 → ⑤ AMDW 배당 확보 → ⑥ NVDY 복귀" },
              { title: "🚫 절대 진입 금지", content: "CPI/FOMC 발표일 · NVDA/AMD/TSMC 실적 발표 전후 · 나스닥 급락 · 반도체 섹터 급등락 · VIX 20 이상 · 거래량 폭증(2.5배+)" },
              { title: "📊 거래량 신호 (경험칙)", content: "정상: 20일 평균 대비 0.5~1.8배 / 주의: 1.8~2.5배 / 위험: 2.5배+ / 주가 하락 + 거래량 증가 = 매도세 강함 → 진입 금지" },
              { title: "✅ NVDY 진입 조건", content: "배당락 1~2거래일 전 / NVDA 시간외 ±2% 이내 / VIX 20 미만 / 거래량 정상 / 반도체 섹터 안정" },
              { title: "✅ AMDW 진입 조건", content: "AMD 급등락 직후 피하기 / 실적 발표 전후 2거래일 피하기 / 거래량 정상 / 시장 안정 구간에서만" },
              { title: "✅ AMDY 진입 조건", content: "AMD 급등락 직후 피하기 / 실적 발표 전후 2거래일 피하기 / 거래량 정상 / 시장 안정 구간에서만" },
              { title: "✅ TSMY 진입 조건", content: "TSM/TSMC 실적 발표 전후 2거래일 피하기 / TSM 급등락 ±3% 이내 / VIX 20 미만 / 거래량 정상" },
              { title: "✅ PLTW 진입 조건", content: "PLTR 급등락 직후 피하기 / PLTR 실적 발표 전후 2거래일 피하기 / 거래량 정상 / 시장 안정 구간에서만" },
              { title: "💡 현실적 운영", content: "전체의 50%만 회전 전략에 사용. 나머지 50%는 장기보유. 급등 시 재진입 기회 확보 목적." },
              { title: "⚠️ 핵심 주의사항", content: "이 앱은 투자 참고용 도구이며 투자 권유가 아닙니다. 배당락일 주가는 배당만큼 하락하는 경향이 있으며 변동성에 따라 손실이 더 클 수 있습니다. 세금·스프레드 비용을 반드시 감안하세요.", warning: true },
              { title: "📚 데이터 출처", content: "시세: Yahoo Finance (비공식, 딜레이 15~20분) / CPI: bls.gov / FOMC: federalreserve.gov / 실적: 각 회사 IR / 배당락일: YieldMax, Roundhill" },
            ].map((item, i) => (
              <div key={i} style={{ background: item.warning ? "#fff5f5" : C.card, border: `1px solid ${item.warning ? "#fecaca" : C.border}`, borderRadius: 12, padding: "13px 15px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: item.warning ? "#dc2626" : C.sub, marginBottom: 7 }}>{item.title}</div>
                <div style={{ fontSize: 11, color: item.warning ? "#ef4444" : C.sub, lineHeight: 1.7 }}>{item.content}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── 용어 탭 ── */}
        {tab === "glossary" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {[
              { term: "CPI", full: "소비자물가지수 (Consumer Price Index)", desc: "물가상승률 지표. 발표 시 금리 변동 가능성에 따라 주식·채권 시장 변동성 급증. 매월 중순 미국 노동통계국(BLS) 발표." },
              { term: "FOMC", full: "연방공개시장위원회 (Federal Open Market Committee)", desc: "미국 기준금리를 결정하는 기구. 연 8회 회의 개최. 발표일 전후 시장 변동성이 급증하므로 진입을 피하는 것이 원칙." },
              { term: "VIX", full: "공포지수 (CBOE Volatility Index)", desc: "S&P500 옵션의 30일 예상 변동성 지수. 20 미만: 시장 안정 / 20~30: 주의 구간 / 30 이상: 극도 공포. 높을수록 커버드콜 ETF 리스크 증가." },
              { term: "커버드콜", full: "Covered Call", desc: "보유 주식의 콜옵션을 매도해 프리미엄 수익을 얻는 전략. NVDY·AMDW 등 월배당 수익의 원천. 주가 급등 시 추가 수익이 제한되는 단점." },
              { term: "ETF", full: "상장지수펀드 (Exchange Traded Fund)", desc: "주식처럼 거래소에서 매매 가능한 펀드. 이 앱의 NVDY·AMDW·AMDY·TSMY·PLTW는 모두 커버드콜 전략 ETF." },
              { term: "배당락일", full: "Ex-Dividend Date", desc: "이 날 이후 매수하면 배당을 받지 못함. 배당락일 당일 주가는 배당금만큼 하락하는 경향이 있어 진입 타이밍으로 활용." },
              { term: "YieldMax", full: "YieldMax ETF (운용사)", desc: "커버드콜 ETF 전문 운용사. NVDY·AMDY·TSMY·PLTW 등 운용. 매주 목요일 배당락." },
              { term: "Roundhill", full: "Roundhill Investments (운용사)", desc: "위클리 커버드콜 ETF 운용사. AMDW 등 운용. 매주 배당 지급이 특징." },
              { term: "QQQ", full: "나스닥 100 ETF (Invesco QQQ)", desc: "나스닥 100 지수를 추종하는 ETF. 기술주 전반의 흐름을 대표. -2% 이하 급락 시 반도체 섹터 전반에 영향." },
              { term: "시간외 거래", full: "Pre/After-Market Trading", desc: "정규 장(미 동부 9:30~16:00) 외 시간의 거래. 실적 발표 등 이슈에 먼저 반응. ±2% 이상이면 다음 날 변동성 신호." },
              { term: "NVDA", full: "엔비디아 (NVIDIA Corporation)", desc: "AI·데이터센터용 GPU 제조사. NVDY의 기반 종목. TSMC에서 위탁 생산." },
              { term: "AMD", full: "AMD (Advanced Micro Devices)", desc: "CPU·GPU 제조사. AMDW·AMDY의 기반 종목. TSMC에서 위탁 생산." },
              { term: "TSM", full: "TSMC (Taiwan Semiconductor)", desc: "세계 최대 반도체 파운드리. NVDA·AMD 칩을 위탁 생산. TSMY의 기반 종목. 실적 발표가 반도체 섹터 전반에 영향." },
              { term: "PLTR", full: "팔란티어 (Palantir Technologies)", desc: "빅데이터·AI 분석 소프트웨어 기업. PLTW의 기반 종목. 정부 계약 의존도 높아 정책 변화에 민감." },
              { term: "원천징수", full: "Withholding Tax", desc: "미국 배당 수령 시 15% 자동 차감. 한미 조세조약에 의한 세율. 금융소득 연 2,000만원 초과 시 종합과세 대상 (출처: 국세청)." },
            ].map((item, i) => (
              <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 15px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: C.blue }}>{item.term}</span>
                  <span style={{ fontSize: 10, color: C.muted }}>{item.full}</span>
                </div>
                <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.8 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        )}
        {/* ── 기록 탭 ── */}
              {tab === "dividend" && (() => {
        const ETF_TICKERS = ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"];
        const isW = (tk) => ["AMDW", "PLTW"].includes(tk);
        const vixNow = quotes["^VIX"]?.price ?? (manualVix ? parseFloat(manualVix) : 18);

        // 종목별 자가 캘리브레이션 (검증 데이터 5건 이상 시)
        const calibratedCapture = {};
        if (predictionLog?.snapshots) {
          ETF_TICKERS.forEach(tk => {
            const items = predictionLog.snapshots.filter(s => s.tk === tk && s.actual != null && s.predicted > 0);
            if (items.length >= 5) {
              const avgRatio = items.reduce((a, s) => a + (s.actual / s.predicted), 0) / items.length;
              calibratedCapture[tk] = +(ETF_CAPTURE * avgRatio).toFixed(3);
            } else {
              calibratedCapture[tk] = ETF_CAPTURE;
            }
          });
        }

        const ranked = ETF_TICKERS
          .map(tk => {
            const q = quotes[tk];
            const baseQ = quotes[BASE_MAP[tk]];
            const divWeekday = isW(tk) ? 1 : 4;
            const todayDow = new Date().getDay();
            const daysToDiv = (divWeekday - todayDow + 7) % 7 || 7;

            // ① HV 블렌딩 + HV20 floor + Vol Premium
            // - 블렌딩: 변동성 확장 시 단기 비중 (HV5×0.6 + HV20×0.4)
            // - Floor: HV20 미만 방지 (옵션 IV는 빨리 안 떨어짐)
            // - Vol Premium: 실제 IV ≈ HV × 1.1 (옵션 시장 프리미엄)
            const hv20 = baseQ?.hv20;
            const hv5 = baseQ?.hv5;
            const VOL_PREMIUM = 1.1;
            const blendedHV = (hv5 != null && hv20 != null) ? hv5 * 0.6 + hv20 * 0.4 : hv20;
            const hvFloor = blendedHV != null && hv20 != null ? Math.max(blendedHV, hv20) : (blendedHV ?? hv20);
            const hv = hvFloor != null ? hvFloor * VOL_PREMIUM : null;

            // ② 실적 임박 IV 부스트
            const today = new Date();
            const baseTk = BASE_MAP[tk];
            let ivBoost = 1.0;
            let earningsDays = null;
            const earnEv = events.find(e => e.type === "EARNINGS" && (e.label.includes(baseTk) || (["NVDA","AMD","TSM"].includes(baseTk) && e.label.includes("TSMC"))));
            if (earnEv) {
              earningsDays = Math.ceil((new Date(earnEv.date) - today) / 86400000);
              if (earningsDays >= 0 && earningsDays <= 7) ivBoost = 1.5;
              else if (earningsDays > 7 && earningsDays <= 14) ivBoost = 1.2;
            }

            // ③ 종목별 캡처율 (캘리브레이션 또는 기본 0.65)
            const capture = calibratedCapture[tk] ?? ETF_CAPTURE;

            // 최종 예상
            const weekPremYield = hv != null ? (hv / 100) * Math.sqrt(7 / 365) * 0.4 * ivBoost : null;
            const hvDiv = weekPremYield && q?.price ? q.price * weekPremYield * capture : null;
            const hvAnnual = hvDiv ? hvDiv * 52 : null;
            const hvYield = hvAnnual && q?.price ? (hvAnnual / q.price) * 100 : null;

            // 직전 배당금
            const lastDiv = q?.lastDiv;
            const histAnnual = lastDiv ? lastDiv * 52 : null;
            const histYield = histAnnual && q?.price ? (histAnnual / q.price) * 100 : null;

            const isCalibrated = calibratedCapture[tk] != null && calibratedCapture[tk] !== ETF_CAPTURE;

            return { tk, q, baseQ, daysToDiv, hv, hv20, hv5, ivBoost, earningsDays, capture, isCalibrated, hvDiv, hvAnnual, hvYield, lastDiv, histAnnual, histYield };
          })
          .sort((a, b) => (b.hvYield ?? -1) - (a.hvYield ?? -1));

        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
        const vixLabel = vixNow >= 25 ? "고변동 · 프리미엄 ↑" : vixNow >= 15 ? "정상 · 프리미엄 적정" : "저변동 · 프리미엄 ↓";
        const vixColor = vixNow >= 25 ? "#22c55e" : vixNow >= 15 ? "#f59e0b" : "#94a3b8";
        const usdkrw = quotes["KRW=X"]?.price;
        return (
          <div style={{ padding: "0 2px" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>📊 예상 배당 순위</div>

            {/* VIX 현재 상태 */}
            <div style={{ background: `${vixColor}15`, border: `1.5px solid ${vixColor}55`, borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>현재 VIX</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{vixNow.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: vixColor }}>{vixLabel}</div>
              </div>
            </div>

            {ranked.map(({ tk, q, baseQ, daysToDiv, hv, hv5, hv20, ivBoost, earningsDays, capture, isCalibrated, hvDiv, hvAnnual, hvYield, lastDiv, histAnnual, histYield }, i) => {
              if (!q?.ok) return null;
              const yieldColor = hvYield == null ? "#94a3b8" : hvYield >= 60 ? "#22c55e" : hvYield >= 40 ? "#f59e0b" : "#94a3b8";
              return (
                <div key={tk} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "0", marginBottom: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)", overflow: "hidden" }}>
                  {/* 카드 헤더 */}
                  <div style={{ background: `linear-gradient(135deg, ${yieldColor}10, ${yieldColor}05)`, padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 22 }}>{medals[i]}</span>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: -0.3 }}>{tk}</div>
                          <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{isW(tk) ? "🔵 Roundhill · 매주 월요일" : "🟡 YieldMax · 매주 목요일"}</div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 24, fontWeight: 800, color: yieldColor, lineHeight: 1 }}>{hvYield ? hvYield.toFixed(1) + "%" : "-"}</div>
                        <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>예상 연환산</div>
                      </div>
                    </div>
                  </div>

                  {/* 두 가지 배당 정보 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                    {/* HV 기반 예상 */}
                    <div style={{ padding: "12px 14px", borderRight: `1px solid ${C.border}`, background: "#f8faff" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                        <span style={{ fontSize: 11 }}>🎯</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#1e40af" }}>HV 기반 예상</span>
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: "#1d4ed8", lineHeight: 1.2 }}>{hvDiv ? `$${hvDiv.toFixed(4)}` : "-"}</div>
                      {hvDiv && usdkrw && <div style={{ fontSize: 17, fontWeight: 800, color: "#1d4ed8", lineHeight: 1.2, marginTop: 1 }}>₩{Math.round(hvDiv * usdkrw).toLocaleString()}</div>}
                      <div style={{ fontSize: 9, color: "#475569", marginTop: 7, paddingTop: 7, borderTop: `1px dashed ${C.border}` }}>
                        <div>연 {hvAnnual ? `$${hvAnnual.toFixed(2)}` : "-"}</div>
                        {hvAnnual && usdkrw && <div>₩{Math.round(hvAnnual * usdkrw).toLocaleString()}</div>}
                      </div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 5, lineHeight: 1.4 }}>
                        {BASE_MAP[tk]} HV {hv5 != null && hv20 != null ? `5d ${hv5.toFixed(0)}%/20d ${hv20.toFixed(0)}%` : `${hv20?.toFixed(0) ?? "-"}%`} <span style={{ color: "#7c3aed" }}>· IV프리미엄 ×1.1</span>
                        {ivBoost > 1 && <span style={{ color: "#dc2626", fontWeight: 700 }}> · IV×{ivBoost.toFixed(1)} (실적 D-{earningsDays})</span>}
                        {isCalibrated && <span style={{ color: "#0891b2", fontWeight: 700 }}> · 캘리 {capture.toFixed(2)}</span>}
                      </div>
                    </div>

                    {/* 직전 배당금 */}
                    <div style={{ padding: "12px 14px", background: "#fafafa" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                        <span style={{ fontSize: 11 }}>📊</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#475569" }}>직전 배당금</span>
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, lineHeight: 1.2 }}>{lastDiv ? `$${lastDiv.toFixed(4)}` : "-"}</div>
                      {lastDiv && usdkrw && <div style={{ fontSize: 17, fontWeight: 800, color: C.text, lineHeight: 1.2, marginTop: 1 }}>₩{Math.round(lastDiv * usdkrw).toLocaleString()}</div>}
                      <div style={{ fontSize: 9, color: "#475569", marginTop: 7, paddingTop: 7, borderTop: `1px dashed ${C.border}` }}>
                        <div>연 {histAnnual ? `$${histAnnual.toFixed(2)}` : "-"}</div>
                        {histAnnual && usdkrw && <div>₩{Math.round(histAnnual * usdkrw).toLocaleString()}</div>}
                      </div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 5 }}>{q.lastDivDate ?? "-"} · {histYield ? histYield.toFixed(1) + "%" : "-"}</div>
                    </div>
                  </div>

                  {/* 카드 푸터 */}
                  <div style={{ padding: "10px 14px", background: C.bg, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 10, color: C.muted }}>
                      <span style={{ color: C.text, fontWeight: 600 }}>${q.price?.toFixed(2)}</span>
                      {usdkrw && <span style={{ color: C.text, fontWeight: 600 }}> · ₩{Math.round(q.price * usdkrw).toLocaleString()}</span>}
                      <span style={{ marginLeft: 6, color: q.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                        {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ background: daysToDiv <= 3 ? "#fef3c7" : "#e2e8f0", color: daysToDiv <= 3 ? "#92400e" : "#475569", borderRadius: 6, padding: "3px 9px", fontSize: 10, fontWeight: 700 }}>D-{daysToDiv}</div>
                  </div>
                </div>
              );
            })}

            <div style={{ background: "#1e3a5f", borderRadius: 10, padding: "12px 14px", marginTop: 4 }}>
              <div style={{ fontSize: 11, color: "#93c5fd", fontWeight: 700, marginBottom: 6 }}>ℹ️ 정밀 예측 계산 방식</div>
              <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.7 }}>
                <strong style={{color:"#93c5fd"}}>① HV 블렌딩 + HV20 floor</strong> = max(HV5×60% + HV20×40%, HV20) (단기 강조 + 하방 보호)<br/><strong style={{color:"#c4b5fd"}}>② Vol Premium</strong> = ×1.1 (옵션 IV ≈ HV × 1.1, 학계 평균)<br/>
                <strong style={{color:"#fca5a5"}}>③ 실적 IV 부스트</strong>: 실적 D-7 이내 ×1.5 / D-14 이내 ×1.2<br/>
                <strong style={{color:"#67e8f9"}}>④ 캘리브레이션</strong>: 검증 5건+ 시 종목별 자동 캡처율 조정<br/>
                <strong style={{color:"#cbd5e1"}}>최종 공식</strong>: ETF가 × HV블렌딩(floor) × VolPremium × √(7/365) × 0.4 × IV부스트 × 캡처율<br/>
                · 📊 직전 배당금: Yahoo Finance 최근 1회 실제 지급액<br/>
                · 순위는 HV 기반 예상 수익률 기준
              </div>
            </div>
          </div>
        );
      })()}

            {(tab === "divaccuracy" || tab === "entryvalid") && (() => {
        if (!predictionLog) return <div style={{ textAlign: "center", padding: 40, color: C.muted }}>불러오는 중...</div>;
        const allSnaps = [...(predictionLog.snapshots || [])].sort((a, b) => b.exDivDate.localeCompare(a.exDivDate));

        const calcTickerSummary = () => ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(t => {
          const items = allSnaps.filter(s => s.tk === t);
          const m = items.filter(s => s.actual != null);
          const ae = m.map(s => Math.abs(s.errorPct ?? 0));
          const avgErr = ae.length ? ae.reduce((a, b) => a + b, 0) / ae.length : null;
          const validated = m.filter(s => s.netReturnPct != null);
          const wins = validated.filter(s => s.profitable).length;
          const winRate = validated.length ? (wins / validated.length) * 100 : null;
          const avgNet = validated.length ? validated.reduce((a, s) => a + s.netReturnPct, 0) / validated.length : null;
          const cumReturn = validated.reduce((a, s) => a + s.netReturnPct, 0);
          return { tk: t, total: items.length, matched: m.length, avgErr, winRate, avgNet, cumReturn, validated: validated.length };
        });
        const tickerSummary = calcTickerSummary();

        const snaps = predictFilter === "ALL" ? allSnaps : allSnaps.filter(s => s.tk === predictFilter);
        const matched = snaps.filter(s => s.actual != null);
        const pending = snaps.filter(s => s.actual == null);
        const usdkrw = quotes["KRW=X"]?.price;

        // 배당예측 통계
        const errors = matched.map(s => s.errorPct).filter(e => e != null);
        const absErrors = errors.map(Math.abs);
        const avgError = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
        const avgAbsError = absErrors.length ? absErrors.reduce((a, b) => a + b, 0) / absErrors.length : null;
        const hitRate = matched.length ? (absErrors.filter(e => e <= 20).length / matched.length) * 100 : null;
        const stdErr = errors.length > 1 ? Math.sqrt(errors.reduce((s, e) => s + (e - avgError) ** 2, 0) / errors.length) : null;
        const bestPred = matched.length ? matched.reduce((b, s) => Math.abs(s.errorPct) < Math.abs(b.errorPct) ? s : b) : null;
        const worstPred = matched.length ? matched.reduce((w, s) => Math.abs(s.errorPct) > Math.abs(w.errorPct) ? s : w) : null;

        // 진입검증 통계
        const validated = matched.filter(s => s.netReturnPct != null && s.entryPct != null);
        const returns = validated.map(s => s.netReturnPct);
        const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
        const stdReturn = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length) : null;
        const sharpe = stdReturn > 0 ? avgReturn / stdReturn : null;
        const cumReturn = returns.reduce((a, b) => a + b, 0);
        const wins = validated.filter(s => s.profitable);
        const losses = validated.filter(s => !s.profitable);
        const winRate = validated.length ? (wins.length / validated.length) * 100 : null;
        const avgWin = wins.length ? wins.reduce((a, s) => a + s.netReturnPct, 0) / wins.length : 0;
        const avgLoss = losses.length ? losses.reduce((a, s) => a + s.netReturnPct, 0) / losses.length : 0;
        const rrRatio = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : null;
        const maxWin = returns.length ? Math.max(...returns) : null;
        const maxLoss = returns.length ? Math.min(...returns) : null;
        const bestEntry = validated.length ? validated.reduce((b, s) => s.netReturnPct > b.netReturnPct ? s : b) : null;
        const worstEntry = validated.length ? validated.reduce((w, s) => s.netReturnPct < w.netReturnPct ? s : w) : null;

        const isAccuracy = tab === "divaccuracy";
        const tabTitle = isAccuracy ? "🎯 배당예측 정확도" : "📊 진입검증 분석";

        // 미니 통계 카드 컴포넌트
        const StatCard = ({ label, value, sub, color = C.text }) => (
          <div style={{ background: C.bg, borderRadius: 8, padding: "10px 11px", border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.muted, marginBottom: 3, letterSpacing: 0.2 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
            {sub && <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>{sub}</div>}
          </div>
        );

        const fmtPct = (v, dp = 1) => v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}%`;
        const colorByReturn = (v) => v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.muted;
        const colorByError = (v) => v == null ? C.muted : v <= 10 ? C.green : v <= 20 ? C.amber : C.red;

        return (
          <div style={{ padding: "0 2px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{tabTitle}</div>
              <div style={{ fontSize: 10, color: C.muted }}>{predictFilter === "ALL" ? `전체 ${allSnaps.length}건` : `${predictFilter} ${snaps.length}건`}</div>
            </div>

            {/* 종목 필터 */}
            <div style={{ display: "flex", gap: 4, marginBottom: 12, overflowX: "auto" }}>
              {["ALL", "NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(t => (
                <button key={t} onClick={() => setPredictFilter(t)}
                  style={{ flex: 1, minWidth: 50, padding: "7px 4px", background: predictFilter === t ? C.blue : C.card, color: predictFilter === t ? "#fff" : C.muted, border: `1px solid ${predictFilter === t ? C.blue : C.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {t === "ALL" ? "전체" : t}
                </button>
              ))}
            </div>

            {/* === 배당예측 탭 === */}
            {isAccuracy && (
              <>
                {/* 핵심 지표 4개 */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 13px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>📊 예측 정확도 지표</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <StatCard label="적중률 (±20%)" value={hitRate != null ? `${hitRate.toFixed(0)}%` : "-"}
                      sub={`${matched.length}건 중 ${absErrors.filter(e => e <= 20).length}건`}
                      color={hitRate != null && hitRate >= 70 ? C.green : hitRate != null && hitRate >= 50 ? C.amber : C.red} />
                    <StatCard label="평균 절대오차" value={avgAbsError != null ? `±${avgAbsError.toFixed(1)}%` : "-"}
                      sub={`낮을수록 정확`}
                      color={colorByError(avgAbsError)} />
                    <StatCard label="예측 편향" value={fmtPct(avgError, 1)}
                      sub={avgError == null ? "" : avgError > 5 ? "과대평가 경향" : avgError < -5 ? "과소평가 경향" : "균형 잡힘"}
                      color={avgError == null ? C.muted : Math.abs(avgError) < 5 ? C.green : C.amber} />
                    <StatCard label="오차 표준편차" value={stdErr != null ? `±${stdErr.toFixed(1)}%` : "-"}
                      sub="일관성 (낮을수록 안정)"
                      color={stdErr == null ? C.muted : stdErr < 10 ? C.green : stdErr < 20 ? C.amber : C.red} />
                  </div>
                </div>

                {/* 베스트 / 워스트 예측 */}
                {bestPred && worstPred && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
                    <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#166534", marginBottom: 4 }}>🥇 가장 정확한 예측</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#15803d" }}>{bestPred.tk} · {fmtPct(bestPred.errorPct, 1)}</div>
                      <div style={{ fontSize: 9, color: "#166534", marginTop: 2 }}>{bestPred.exDivDate} · 예상 ${bestPred.predicted.toFixed(4)}</div>
                    </div>
                    <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "#991b1b", marginBottom: 4 }}>❌ 가장 부정확한 예측</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#b91c1c" }}>{worstPred.tk} · {fmtPct(worstPred.errorPct, 1)}</div>
                      <div style={{ fontSize: 9, color: "#991b1b", marginTop: 2 }}>{worstPred.exDivDate} · 예상 ${worstPred.predicted.toFixed(4)}</div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* === 진입검증 탭 === */}
            {!isAccuracy && (() => {
              // 점수-수익 상관계수 (Pearson)
              const corr = (() => {
                if (validated.length < 2) return null;
                const xs = validated.map(s => s.entryPct);
                const ys = validated.map(s => s.netReturnPct);
                const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
                const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
                let num = 0, dx = 0, dy = 0;
                for (let i = 0; i < xs.length; i++) {
                  num += (xs[i] - xm) * (ys[i] - ym);
                  dx += (xs[i] - xm) ** 2;
                  dy += (ys[i] - ym) ** 2;
                }
                return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
              })();
              const corrLabel = corr == null ? "-" : corr.toFixed(2);
              const corrJudge = corr == null ? "검증 부족" : corr >= 0.5 ? "강한 상관 (시스템 유효)" : corr >= 0.3 ? "중간 상관" : corr >= 0.1 ? "약한 상관" : corr >= -0.1 ? "무상관 (점수↔수익 무관)" : "역상관 (시스템 결함)";
              const corrColor = corr == null ? C.muted : corr >= 0.5 ? C.green : corr >= 0.3 ? "#84cc16" : corr >= 0.1 ? C.amber : corr >= -0.1 ? "#f97316" : C.red;

              // 임계값 시뮬레이션
              const thresholds = [70, 80, 85, 90, 95];
              const sims = thresholds.map(th => {
                const items = validated.filter(s => s.entryPct >= th);
                const cnt = items.length;
                const ar = cnt ? items.reduce((a, s) => a + s.netReturnPct, 0) / cnt : null;
                const wr = cnt ? (items.filter(s => s.profitable).length / cnt) * 100 : null;
                return { th, cnt, ar, wr };
              });
              // 베이스라인 (무조건 진입)
              const baselineCount = validated.length;
              const baselineAvg = avgReturn;

              return (
                <>
                  {/* 🎯 핵심 검증: 점수↔수익 상관관계 */}
                  <div style={{ background: C.card, border: `2px solid ${corrColor}40`, borderRadius: 12, padding: "14px 15px", marginBottom: 12, boxShadow: `0 2px 8px ${corrColor}10` }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>🎯 점수 시스템 유효성</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 10, color: C.muted }}>점수↔수익 상관계수 (Pearson)</div>
                        <div style={{ fontSize: 28, fontWeight: 800, color: corrColor, lineHeight: 1, marginTop: 3 }}>{corrLabel}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: corrColor }}>{corrJudge}</div>
                        <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>{validated.length}건 검증</div>
                      </div>
                    </div>
                    {/* 상관계수 시각화 바 (-1 ~ +1) */}
                    <div style={{ position: "relative", height: 14, background: "linear-gradient(to right, #fee2e2, #fef3c7, #dcfce7)", borderRadius: 7 }}>
                      {corr != null && (
                        <div style={{ position: "absolute", top: -3, left: `${((corr + 1) / 2) * 100}%`, width: 4, height: 20, background: corrColor, borderRadius: 2, transform: "translateX(-2px)" }} />
                      )}
                      <div style={{ position: "absolute", top: "50%", left: "50%", width: 1, height: "100%", background: "#94a3b860", transform: "translate(-50%, -50%)" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 8, color: C.muted }}>
                      <span>-1 (역상관)</span>
                      <span>0 (무관)</span>
                      <span>+1 (강상관)</span>
                    </div>
                  </div>

                  {/* 📊 기본 성과 (3개로 축소) */}
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 13px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>📊 진입 성과 요약</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                      <StatCard label="평균 수익" value={avgReturn != null ? fmtPct(avgReturn, 2) : "-"} sub={`회당`} color={colorByReturn(avgReturn)} />
                      <StatCard label="승률" value={winRate != null ? `${winRate.toFixed(0)}%` : "-"} sub={`${wins.length}승 ${losses.length}패`} color={winRate == null ? C.muted : winRate >= 70 ? C.green : winRate >= 50 ? C.amber : C.red} />
                      <StatCard label="손익비" value={rrRatio != null ? `${rrRatio.toFixed(2)}x` : "-"} sub={avgWin && avgLoss ? `${avgWin.toFixed(1)}/${avgLoss.toFixed(1)}` : ""} color={rrRatio == null ? C.muted : rrRatio >= 1.5 ? C.green : rrRatio >= 1 ? C.amber : C.red} />
                    </div>
                  </div>

                  {/* 🔬 임계값 시뮬레이션 */}
                  {validated.length > 0 && (
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 13px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>🔬 임계값 전략 비교 — "X% 이상만 진입한다면?"</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", background: "#f3f4f6", borderRadius: 7 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.text, minWidth: 80 }}>전체 (베이스라인)</span>
                          <span style={{ fontSize: 10, color: C.muted, minWidth: 36 }}>{baselineCount}건</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: colorByReturn(baselineAvg), flex: 1, textAlign: "right" }}>{baselineAvg != null ? fmtPct(baselineAvg, 2) : "-"}</span>
                          <span style={{ fontSize: 9, color: C.muted, minWidth: 50, textAlign: "right" }}>승률 {winRate != null ? winRate.toFixed(0) + "%" : "-"}</span>
                        </div>
                        {sims.map(s => {
                          const alpha = s.ar != null && baselineAvg != null ? s.ar - baselineAvg : null;
                          return (
                            <div key={s.th} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", background: C.bg, borderRadius: 7, border: alpha != null && alpha > 0.5 ? "1px solid #bbf7d0" : "1px solid transparent" }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: C.text, minWidth: 80 }}>{s.th}% 이상</span>
                              <span style={{ fontSize: 10, color: C.muted, minWidth: 36 }}>{s.cnt}건</span>
                              <span style={{ fontSize: 11, fontWeight: 700, color: colorByReturn(s.ar), flex: 1, textAlign: "right" }}>{s.ar != null ? fmtPct(s.ar, 2) : "-"}</span>
                              <span style={{ fontSize: 9, color: s.wr == null ? C.muted : s.wr >= 70 ? C.green : s.wr >= 50 ? C.amber : C.red, minWidth: 50, textAlign: "right" }}>승률 {s.wr != null ? s.wr.toFixed(0) + "%" : "-"}</span>
                              {alpha != null && (
                                <span style={{ fontSize: 9, fontWeight: 700, color: alpha > 0 ? C.green : alpha < 0 ? C.red : C.muted, minWidth: 50, textAlign: "right" }}>α {alpha > 0 ? "+" : ""}{alpha.toFixed(2)}%</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                        · α (알파) = 임계값 전략 평균수익 - 베이스라인. 양수면 점수 시스템이 알파 생성<br/>
                        · 초록 테두리 = α &gt;0.5%로 의미있는 개선
                      </div>
                    </div>
                  )}

                  {/* 🤖 자가 학습: 최적 임계값 추천 */}
                  {validated.length >= 5 && (() => {
                    // 전체 베이스라인
                    const findOptimal = (items, baseline) => {
                      if (items.length < 5) return null;
                      let best = { th: null, alpha: -Infinity, cnt: 0, ar: null, wr: null };
                      for (let th = 60; th <= 95; th += 5) {
                        const subset = items.filter(s => s.entryPct >= th);
                        if (subset.length < 3) continue;
                        const ar = subset.reduce((a, s) => a + s.netReturnPct, 0) / subset.length;
                        const alpha = ar - baseline;
                        if (alpha > best.alpha) {
                          const wins = subset.filter(s => s.profitable).length;
                          best = { th, alpha, cnt: subset.length, ar, wr: (wins / subset.length) * 100 };
                        }
                      }
                      return best.th != null ? best : null;
                    };

                    const overallOptimal = findOptimal(validated, baselineAvg);
                    const tickerOptimal = ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(t => {
                      const items = validated.filter(s => s.tk === t);
                      const baseline = items.length ? items.reduce((a, s) => a + s.netReturnPct, 0) / items.length : 0;
                      return { tk: t, count: items.length, optimal: findOptimal(items, baseline) };
                    });

                    return (
                      <div style={{ background: "linear-gradient(135deg, #fef3c7 0%, #ddd6fe 100%)", border: "2px solid #a78bfa", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                          <span style={{ fontSize: 14 }}>🤖</span>
                          <span style={{ fontSize: 11, fontWeight: 800, color: "#5b21b6", letterSpacing: 0.3 }}>시스템 자가 학습 (Auto-calibration)</span>
                        </div>

                        {/* 전체 권장 임계값 */}
                        {overallOptimal && (
                          <div style={{ background: "#fff", borderRadius: 10, padding: "11px 13px", marginBottom: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <div>
                                <div style={{ fontSize: 10, color: "#6b21a8", fontWeight: 600 }}>전체 권장 진입선</div>
                                <div style={{ fontSize: 24, fontWeight: 800, color: "#7c3aed", lineHeight: 1, marginTop: 3 }}>{overallOptimal.th}%+</div>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <div style={{ fontSize: 16, fontWeight: 800, color: overallOptimal.alpha > 0 ? "#15803d" : "#b91c1c" }}>α {overallOptimal.alpha > 0 ? "+" : ""}{overallOptimal.alpha.toFixed(2)}%</div>
                                <div style={{ fontSize: 9, color: "#6b21a8" }}>{overallOptimal.cnt}건 · 승률 {overallOptimal.wr.toFixed(0)}%</div>
                              </div>
                            </div>
                            <div style={{ fontSize: 9, color: "#6b21a8", marginTop: 6, lineHeight: 1.5 }}>
                              이 임계값 이상에서만 진입했다면 베이스라인 대비 평균 {overallOptimal.alpha > 0 ? "+" : ""}{overallOptimal.alpha.toFixed(2)}% 초과수익
                            </div>
                          </div>
                        )}

                        {/* 종목별 최적 */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "10px 12px" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#6b21a8", marginBottom: 6 }}>📊 종목별 최적 임계값</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {tickerOptimal.map(({ tk, count, optimal }) => (
                              <div key={tk} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "#faf5ff", borderRadius: 6 }}>
                                <span style={{ fontSize: 11, fontWeight: 800, color: "#5b21b6", minWidth: 50 }}>{tk}</span>
                                <span style={{ fontSize: 9, color: "#7c3aed", minWidth: 36 }}>{count}건</span>
                                {optimal ? (
                                  <>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed", flex: 1, textAlign: "right" }}>{optimal.th}%+</span>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: optimal.alpha > 0 ? "#15803d" : "#b91c1c", minWidth: 60, textAlign: "right" }}>α {optimal.alpha > 0 ? "+" : ""}{optimal.alpha.toFixed(2)}%</span>
                                  </>
                                ) : (
                                  <span style={{ fontSize: 10, color: "#a78bfa", flex: 1, textAlign: "right", fontStyle: "italic" }}>검증 부족 (5건+ 필요)</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div style={{ fontSize: 9, color: "#6b21a8", marginTop: 8, lineHeight: 1.5 }}>
                          ✨ 검증 데이터가 쌓일수록 권장 임계값이 정교해집니다 (자율 학습)
                        </div>
                      </div>
                    );
                  })()}

                  {/* 🧠 종목별 점수 시스템 적합도 (per-ticker learning) */}
                  {validated.length >= 3 && (() => {
                    const pearson = (xs, ys) => {
                      if (xs.length < 2) return null;
                      const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
                      const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
                      let num = 0, dx = 0, dy = 0;
                      for (let i = 0; i < xs.length; i++) {
                        num += (xs[i] - xm) * (ys[i] - ym);
                        dx += (xs[i] - xm) ** 2;
                        dy += (ys[i] - ym) ** 2;
                      }
                      return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
                    };

                    const tickerAnalysis = ["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(t => {
                      const items = validated.filter(s => s.tk === t);
                      const cnt = items.length;
                      if (cnt < 2) return { tk: t, cnt, corr: null, status: "데이터 부족", label: "최소 3건 필요", color: C.muted, emoji: "⏳" };
                      const corr = pearson(items.map(s => s.entryPct), items.map(s => s.netReturnPct));
                      const avgRet = items.reduce((a, s) => a + s.netReturnPct, 0) / cnt;
                      let status, label, color, emoji;
                      if (cnt < 5) { status = "검증 부족"; label = `${cnt}건 (5건+ 권장)`; color = "#a78bfa"; emoji = "🔸"; }
                      else if (corr == null || isNaN(corr)) { status = "측정 불가"; label = "데이터 분산 없음"; color = C.muted; emoji = "⚪"; }
                      else if (corr >= 0.5) { status = "매우 유효"; label = "점수 시스템 적극 활용"; color = C.green; emoji = "⭐"; }
                      else if (corr >= 0.3) { status = "양호"; label = "점수 시스템 신뢰 가능"; color = "#84cc16"; emoji = "✅"; }
                      else if (corr >= 0.1) { status = "약함"; label = "점수 + 다른 지표 병행"; color = C.amber; emoji = "🔹"; }
                      else if (corr >= -0.1) { status = "무관"; label = "점수와 수익 관련 없음"; color = "#f97316"; emoji = "⚪"; }
                      else { status = "역효과"; label = "⚠️ 점수 시스템 부적합"; color = C.red; emoji = "❌"; }
                      return { tk, cnt, corr, avgRet, status, label, color, emoji };
                    });

                    return (
                      <div style={{ background: "linear-gradient(135deg, #ecfeff 0%, #cffafe 100%)", border: "2px solid #06b6d4", borderRadius: 12, padding: "14px 15px", marginBottom: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                          <span style={{ fontSize: 14 }}>🧠</span>
                          <span style={{ fontSize: 11, fontWeight: 800, color: "#155e75", letterSpacing: 0.3 }}>종목별 점수 시스템 적합도</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {tickerAnalysis.map(({ tk, cnt, corr, avgRet, status, label, color, emoji }) => (
                            <div key={tk} style={{ background: "#fff", borderRadius: 9, padding: "9px 12px", borderLeft: `4px solid ${color}` }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontSize: 14 }}>{emoji}</span>
                                  <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{tk}</span>
                                  <span style={{ fontSize: 9, color: C.muted }}>{cnt}건</span>
                                </div>
                                <div style={{ textAlign: "right" }}>
                                  <span style={{ fontSize: 12, fontWeight: 800, color }}>{status}</span>
                                  {corr != null && <span style={{ fontSize: 10, color, marginLeft: 5 }}>r={corr.toFixed(2)}</span>}
                                </div>
                              </div>
                              <div style={{ fontSize: 10, color: C.muted, marginLeft: 24 }}>{label}{avgRet != null && ` · 평균 ${avgRet > 0 ? "+" : ""}${avgRet.toFixed(2)}%`}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 9, color: "#155e75", marginTop: 8, lineHeight: 1.5 }}>
                          ✨ 종목마다 점수 시스템이 다르게 작동합니다. 역효과(❌)면 다른 지표 참고 필요
                        </div>
                      </div>
                    );
                  })()}

                  {/* 📈 구간별 분석 (기존, 위치만 이동) */}
                {validated.length > 0 && (() => {
                  const buckets = [
                    { range: "90~100%", min: 90, max: 101, label: "S/A+/A", color: "#22c55e" },
                    { range: "80~89%", min: 80, max: 90, label: "B+", color: "#84cc16" },
                    { range: "70~79%", min: 70, max: 80, label: "B", color: "#f59e0b" },
                    { range: "60~69%", min: 60, max: 70, label: "C+", color: "#f97316" },
                    { range: "<60%", min: 0, max: 60, label: "C~F", color: "#ef4444" },
                  ].map(b => {
                    const items = validated.filter(s => s.entryPct >= b.min && s.entryPct < b.max);
                    const avgR = items.length ? items.reduce((a, s) => a + s.netReturnPct, 0) / items.length : null;
                    const wr = items.length ? (items.filter(s => s.profitable).length / items.length) * 100 : null;
                    return { ...b, count: items.length, avgR, wr };
                  });
                  const maxBarVal = Math.max(...buckets.map(b => Math.abs(b.avgR || 0)));
                  return (
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 13px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>📈 진입점수 구간별 성과</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {buckets.map(b => {
                          const barW = b.avgR != null && maxBarVal > 0 ? Math.abs(b.avgR) / maxBarVal * 100 : 0;
                          const barColor = b.avgR == null ? C.muted : b.avgR > 0 ? C.green : C.red;
                          return (
                            <div key={b.range} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: C.text, minWidth: 70 }}>{b.range}</span>
                              <span style={{ fontSize: 9, color: b.color, fontWeight: 600, minWidth: 38 }}>{b.label}</span>
                              <div style={{ flex: 1, height: 22, background: C.bg, borderRadius: 5, position: "relative", overflow: "hidden" }}>
                                {b.count > 0 && (
                                  <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${barW}%`, background: barColor + "30", transition: "width 0.5s" }} />
                                )}
                                <div style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", fontSize: 10, fontWeight: 700, color: barColor }}>
                                  {b.count > 0 ? fmtPct(b.avgR, 2) : "데이터 없음"}
                                </div>
                                {b.count > 0 && <div style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", fontSize: 9, color: C.muted }}>{b.count}건 · 승률 {b.wr.toFixed(0)}%</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                        ✨ 높은 점수일수록 양의 수익이면 점수 시스템이 유효함
                      </div>
                    </div>
                  );
                })()}

                  {/* 베스트 / 워스트 진입 */}
                  {bestEntry && worstEntry && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
                      <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 12px" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#166534", marginBottom: 4 }}>🥇 베스트 진입</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#15803d" }}>{bestEntry.tk} · {fmtPct(bestEntry.netReturnPct, 2)}</div>
                        <div style={{ fontSize: 9, color: "#166534", marginTop: 2 }}>{bestEntry.exDivDate} · 점수 {bestEntry.entryPct}% ({bestEntry.entryGrade})</div>
                      </div>
                      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 12px" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: "#991b1b", marginBottom: 4 }}>❌ 워스트 진입</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#b91c1c" }}>{worstEntry.tk} · {fmtPct(worstEntry.netReturnPct, 2)}</div>
                        <div style={{ fontSize: 9, color: "#991b1b", marginTop: 2 }}>{worstEntry.exDivDate} · 점수 {worstEntry.entryPct}% ({worstEntry.entryGrade})</div>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* 종목별 요약 (전체일 때) */}
            {predictFilter === "ALL" && allSnaps.length > 0 && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 8, letterSpacing: 0.3 }}>📋 종목별 요약</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {tickerSummary.map(s => (
                    <div key={s.tk} onClick={() => setPredictFilter(s.tk)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", background: C.bg, borderRadius: 7, cursor: "pointer", border: `1px solid transparent`, transition: "border 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.border = `1px solid ${C.blue}40`}
                      onMouseLeave={e => e.currentTarget.style.border = `1px solid transparent`}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: C.text, minWidth: 50 }}>{s.tk}</span>
                      <span style={{ fontSize: 10, color: C.muted, minWidth: 36 }}>{s.total}건</span>
                      {isAccuracy ? (
                        <span style={{ fontSize: 10, color: s.avgErr == null ? C.muted : colorByError(s.avgErr), flex: 1, textAlign: "right", fontWeight: 600 }}>
                          평균 오차 {s.avgErr != null ? `±${s.avgErr.toFixed(1)}%` : "-"}
                        </span>
                      ) : (
                        <>
                          <span style={{ fontSize: 10, color: colorByReturn(s.cumReturn), minWidth: 70, textAlign: "right", fontWeight: 700 }}>
                            누적 {s.cumReturn != null ? fmtPct(s.cumReturn, 2) : "-"}
                          </span>
                          <span style={{ fontSize: 10, color: s.winRate == null ? C.muted : s.winRate >= 70 ? C.green : s.winRate >= 50 ? C.amber : C.red, minWidth: 50, textAlign: "right" }}>
                            승률 {s.winRate != null ? `${s.winRate.toFixed(0)}%` : "-"}
                          </span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 9, color: C.muted, marginTop: 6, textAlign: "center" }}>종목 행 클릭 시 상세 보기</div>
              </div>
            )}

            {snaps.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: C.muted, fontSize: 12 }}>
                {predictFilter === "ALL" ? "아직 수집된 스냅샷이 없습니다." : `${predictFilter} 데이터 없음.`}<br/><br/>
                미국 장 마감 직전 자동 캡처됩니다.<br/>· 미국 수요일 (KST 목요일 새벽): NVDY/AMDY/TSMY<br/>· 미국 금요일 (KST 토요일 새벽): AMDW/PLTW
              </div>
            )}

            {/* 개별 스냅샷 카드 */}
            {snaps.length > 0 && (
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 6, letterSpacing: 0.3 }}>📜 개별 기록 ({snaps.length}건)</div>
            )}
            {snaps.map((s, i) => {
              const isPending = s.actual == null;
              const errAbs = s.errorPct != null ? Math.abs(s.errorPct) : null;
              const accColor = errAbs == null ? C.muted : errAbs <= 10 ? C.green : errAbs <= 25 ? C.amber : C.red;
              const netColor = s.netReturnPct == null ? C.muted : s.profitable ? C.green : C.red;
              const cardLeftColor = isAccuracy
                ? (isPending ? C.muted : accColor)
                : (s.netReturnPct == null ? C.muted : netColor);
              return (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: `4px solid ${cardLeftColor}`, borderRadius: 10, padding: "11px 13px", marginBottom: 7, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{s.tk} <span style={{ fontSize: 10, color: C.muted, fontWeight: 400 }}>· {s.exDivDate}</span></div>
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>
                        {isAccuracy
                          ? `HV20: ${s.hv20?.toFixed(1)}% · VIX: ${s.vix?.toFixed(2)} · 진입가 $${s.etfPrice?.toFixed(2)}`
                          : `점수 ${s.entryPct}% (${s.entryGrade}) · VIX ${s.vix?.toFixed(2)} · 진입가 $${s.etfPrice?.toFixed(2)}`}
                      </div>
                    </div>
                    {isAccuracy ? (
                      isPending
                        ? <span style={{ background: "#e2e8f0", color: "#475569", borderRadius: 5, padding: "2px 8px", fontSize: 9, fontWeight: 700 }}>대기중</span>
                        : <span style={{ background: `${accColor}25`, color: accColor, borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 800 }}>{fmtPct(s.errorPct, 1)}</span>
                    ) : (
                      s.netReturnPct != null
                        ? <span style={{ background: `${netColor}25`, color: netColor, borderRadius: 5, padding: "3px 9px", fontSize: 11, fontWeight: 800 }}>{fmtPct(s.netReturnPct, 2)}</span>
                        : <span style={{ background: "#e2e8f0", color: "#475569", borderRadius: 5, padding: "2px 8px", fontSize: 9, fontWeight: 700 }}>대기중</span>
                    )}
                  </div>

                  {isAccuracy ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                      <div style={{ background: "#f0f9ff", borderRadius: 7, padding: "6px 9px", border: "1px solid #bae6fd" }}>
                        <div style={{ fontSize: 9, color: "#0c4a6e", fontWeight: 600, marginBottom: 1 }}>🎯 예상</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#075985" }}>${s.predicted?.toFixed(4)}</div>
                        {usdkrw && <div style={{ fontSize: 9, color: "#0c4a6e" }}>₩{Math.round(s.predicted * usdkrw).toLocaleString()}</div>}
                      </div>
                      <div style={{ background: isPending ? C.bg : "#f0fdf4", borderRadius: 7, padding: "6px 9px", border: `1px solid ${isPending ? C.border : "#bbf7d0"}` }}>
                        <div style={{ fontSize: 9, color: isPending ? C.muted : "#166534", fontWeight: 600, marginBottom: 1 }}>📊 실제</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: isPending ? C.muted : "#15803d" }}>{isPending ? "대기" : `$${s.actual?.toFixed(4)}`}</div>
                        {!isPending && usdkrw && <div style={{ fontSize: 9, color: "#166534" }}>₩{Math.round(s.actual * usdkrw).toLocaleString()}</div>}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                      <div style={{ background: C.bg, borderRadius: 7, padding: "6px 9px" }}>
                        <div style={{ fontSize: 9, color: C.muted, fontWeight: 600 }}>진입가</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>${s.etfPrice?.toFixed(2)}</div>
                      </div>
                      <div style={{ background: C.bg, borderRadius: 7, padding: "6px 9px" }}>
                        <div style={{ fontSize: 9, color: C.muted, fontWeight: 600 }}>배당락후</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: s.capitalChangePct == null ? C.muted : s.capitalChangePct >= 0 ? C.green : C.red }}>
                          {s.priceAfterExDiv != null ? `$${s.priceAfterExDiv.toFixed(2)}` : "대기"}
                        </div>
                        {s.capitalChangePct != null && <div style={{ fontSize: 9, color: s.capitalChangePct >= 0 ? C.green : C.red }}>{fmtPct(s.capitalChangePct, 2)}</div>}
                      </div>
                      <div style={{ background: s.profitable ? "#dcfce7" : s.profitable === false ? "#fee2e2" : C.bg, borderRadius: 7, padding: "6px 9px" }}>
                        <div style={{ fontSize: 9, color: s.profitable ? "#166534" : s.profitable === false ? "#991b1b" : C.muted, fontWeight: 600 }}>💰 순수익</div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: netColor }}>
                          {s.netReturnPct != null ? fmtPct(s.netReturnPct, 2) : "대기"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ background: "#1e3a5f", borderRadius: 10, padding: "11px 13px", marginTop: 10 }}>
              <div style={{ fontSize: 10, color: "#93c5fd", fontWeight: 700, marginBottom: 5 }}>ℹ️ 자동 캡처 안내</div>
              <div style={{ fontSize: 9.5, color: "#cbd5e1", lineHeight: 1.7 }}>
                · GitHub Actions가 3시간마다 자동 실행<br/>
                · 미국 수 (KST 목 새벽): NVDY/AMDY/TSMY 캡처<br/>
                · 미국 금 (KST 토 새벽): AMDW/PLTW 캡처<br/>
                · 배당 지급 후 자동 매칭 + 순수익 계산 (ex-div + 1일)<br/>
                · {predictionLog.updatedAt ? `업데이트: ${new Date(predictionLog.updatedAt).toLocaleString("ko-KR")}` : "초기 상태"}
              </div>
            </div>
          </div>
        );
      })()}

            {tab === "timezone" && (
        <div style={{ padding: "0 2px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14 }}>시간대 안내</div>

          <div style={{ background: `${marketStatus.color}18`, border: `1.5px solid ${marketStatus.color}55`, borderRadius: 10, padding: "12px 14px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>현재 미국 동부 시간 (ET)</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: 0.5 }}>{marketStatus.etStr}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>장 상태</div>
              <span style={{ background: `${marketStatus.color}25`, color: marketStatus.color, borderRadius: 6, padding: "4px 14px", fontSize: 14, fontWeight: 700 }}>{marketStatus.label}</span>
            </div>
          </div>

          {[
            { label: "프리마켓", color: "#f59e0b", et: "04:00 – 09:30", summer: "17:00 – 22:30", winter: "18:00 – 23:30", desc: "사전 거래. 유동성 낙고 스프레드 큼." },
            { label: "정규장",   color: "#22c55e", et: "09:30 – 16:00", summer: "22:30 – 05:00", winter: "23:30 – 06:00", desc: "메인 거래 시간. 유동성 최대, 가장 정확한 가격." },
            { label: "시간외",   color: "#f97316", et: "16:00 – 20:00", summer: "05:00 – 09:00", winter: "06:00 – 10:00", desc: "실적 발표 등 이벤트 반응. 유동성 낙음." },
            { label: "마감",     color: "#94a3b8", et: "20:00 – 04:00", summer: "09:00 – 17:00", winter: "10:00 – 18:00", desc: "거래 불가. 주말 포함." },
          ].map(row => (
            <div key={row.label} style={{ background: C.card, borderRadius: 10, padding: "12px 14px", marginBottom: 10, borderLeft: `4px solid ${row.color}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ background: `${row.color}25`, color: row.color, borderRadius: 5, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>{row.label}</span>
                <span style={{ fontSize: 10, color: C.muted }}>ET {row.et}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 7 }}>
                <div style={{ background: C.bg, borderRadius: 7, padding: "7px 10px" }}>
                  <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>🌞 여름 (EDT, 3월말‑3월)</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>KST {row.summer}</div>
                </div>
                <div style={{ background: C.bg, borderRadius: 7, padding: "7px 10px" }}>
                  <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>❄️ 겨울 (EST, 11월‑3월)</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>KST {row.winter}</div>
                </div>
              </div>
              <div style={{ fontSize: 10, color: C.muted }}>{row.desc}</div>
            </div>
          ))}

          <div style={{ background: "#1e3a5f", borderRadius: 10, padding: "12px 14px", marginTop: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#93c5fd", marginBottom: 6 }}>ℹ️ 서머타임 자동 적용</div>
            <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.7 }}>
              이 앱은 <span style={{ color: "#93c5fd", fontWeight: 600 }}>America/New_York</span> 타임존을 사용하여 서머타임을 자동으로 반영합니다.<br/>
              · 여름 (EDT, UTC-4): 3월 둘째 일요일 → 11월 첫째 일요일<br/>
              · 겨울 (EST, UTC-5): 11월 첫째 일요일 → 3월 둘째 일요일
            </div>
          </div>
        </div>
      )}

      {tab === "history" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub }}>점수 · 순위 기록</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>새로고침 시 자동 저장 · 최대 200건</div>
              </div>
              {scoreHistory.length > 0 && (
                <button onClick={() => { setScoreHistory([]); storage.set(STORAGE_KEYS.scoreHistory, []); }}
                  style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, color: C.muted, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>초기화</button>
              )}
            </div>

            {scoreHistory.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 7 }}>1위 횟수 (전체 {scoreHistory.length}건)</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {["NVDY", "AMDY", "TSMY", "AMDW", "PLTW"].map(tk => {
                    const count = scoreHistory.filter(s => Object.entries(s.scores).sort((a, b) => b[1] - a[1])[0]?.[0] === tk).length;
                    return (
                      <div key={tk} style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 4px", textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: C.blue }}>{tk}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginTop: 2 }}>{count}</div>
                        <div style={{ fontSize: 9, color: C.muted }}>회</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {scoreHistory.length === 0 ? (
              <div style={{ textAlign: "center", color: "#cbd5e1", padding: "40px 0", fontSize: 13 }}>
                기록 없음<br /><span style={{ fontSize: 11 }}>새로고침 시 자동 저장됩니다</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {scoreHistory.slice(0, 50).map((snap, i) => {
                  const ranked = Object.entries(snap.scores).sort((a, b) => b[1] - a[1]);
                  const top = ranked[0];
                  const topColor = top[1] >= 80 ? C.green : top[1] >= 50 ? C.amber : C.red;
                  const d = new Date(snap.ts);
                  const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
                  return (
                    <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 13px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ fontSize: 10, color: C.muted }}>{timeStr}</span>
                          {snap.auto && <span style={{ background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px", fontSize: 8, fontWeight: 700 }}>자동</span>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: topColor }}>🥇 {top[0]} {top[1]}%</div>
                          <button onClick={() => setScoreHistory(prev => {
                            const updated = prev.filter((_, idx) => idx !== i);
                            storage.set(STORAGE_KEYS.scoreHistory, updated);
                            return updated;
                          })} style={{ background: "none", border: "none", color: C.muted, fontSize: 14, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>✕</button>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {ranked.map(([tk, pct], j) => {
                          const c = pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red;
                          return (
                            <div key={tk} style={{ flex: 1, textAlign: "center", padding: "5px 2px", background: j === 0 ? `${topColor}12` : "#f8fafc", borderRadius: 7 }}>
                              <div style={{ fontSize: 8, color: C.muted }}>{j + 1}위</div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: c }}>{tk}</div>
                              <div style={{ fontSize: 9, color: c }}>{pct}%</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        input, select, button { outline: none; font-family: inherit; }
        input:focus, select:focus { border-color: #3b82f6 !important; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
      `}</style>
    </div>
  );
}

// ─── 보조 컴포넌트 ─────────────────────────────────────────────────────────
function ConditionCard({ r, C }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${r.ok ? "#16a34a20" : "#dc262620"}`, borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", gap: 9, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <span style={{ fontSize: 16 }}>{r.ok ? "✅" : "❌"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: r.ok ? "#16a34a" : "#dc2626" }}>{r.label}</div>
        <div style={{ fontSize: 10, color: C.muted, marginTop: 1, wordBreak: "break-word" }}>{r.detail}</div>
      </div>
    </div>
  );
}

function StatCard({ label, value, C }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 8px", textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.blue }}>{value}</div>
      <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>{label}</div>
    </div>
  );
}

function Modal({ C, onClose, title, children }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, width: "100%", maxWidth: 320, boxShadow: "0 10px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, color: C.text }}>{title}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>{children}</div>
      </div>
    </div>
  );
}

const inputStyle = (C) => ({ background: "#f8fafc", border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 11px", color: C.text, fontSize: 13, width: "100%" });
const btnCancel = (C) => ({ flex: 1, padding: "9px", background: "#f1f5f9", border: `1px solid ${C.border}`, borderRadius: 8, color: C.sub, fontSize: 13, cursor: "pointer" });
const btnPrimary = (C) => ({ flex: 1, padding: "9px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" });
