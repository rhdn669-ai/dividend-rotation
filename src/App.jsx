import { useState, useEffect, useCallback, useMemo } from "react";

// ─── 상수 ──────────────────────────────────────────────────────────────────
const APP_VERSION = "1.0.12";
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
};

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
    const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    const aboveMA20 = ma20 != null ? meta.regularMarketPrice > ma20 : null;
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
      fiveDayReturn, rsi14, ma20, aboveMA20, lastDiv, lastDivDate,
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
function evaluateConditions(quotes, targetTicker, events, manualVix) {
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
    detail: todayEv ? `오늘 ${todayEv.label}` : tmrEv ? `내일 ${tmrEv.label}` : "이벤트 없음",
    priority: "critical",
  });
  total++; if (evOk) score++;

  // 2. 실적 발표 (NVDA/AMD/TSMC - 오늘부터 2일 이내)
  const BASE_MAP = { NVDY: "NVDA", AMDW: "AMD", AMDY: "AMD", TSMY: "TSM", PLTW: "PLTR" };
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
    detail: earningsEv ? `${earningsEv.date} ${earningsEv.label}` : "2일 이내 실적 발표 없음",
    priority: "critical",
  });
  total++; if (earningsOk) score++;

  // 3. 기준 종목 시간외 또는 당일
  const baseQ = quotes[targetCo];
  const baseName = targetCo;
  if (baseQ?.ok && baseQ.preMarketChange != null) {
    const ok = Math.abs(baseQ.preMarketChange) <= 2;
    results.push({
      label: `${baseName} 시간외 ±2% 이내`,
      ok,
      detail: `시간외 ${baseQ.preMarketChange > 0 ? "+" : ""}${baseQ.preMarketChange?.toFixed(2)}%`,
      priority: "high",
    });
    total++; if (ok) score++;
  } else if (baseQ?.ok) {
    const ok = Math.abs(baseQ.changePct) <= 3;
    results.push({
      label: `${baseName} 당일 변동 ±3% 이내`,
      ok,
      detail: `당일 ${baseQ.changePct > 0 ? "+" : ""}${baseQ.changePct?.toFixed(2)}%`,
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
    const ok = Math.abs(tq.changePct) <= 4;
    results.push({
      label: `${targetTicker} 변동 ±4% 이내`,
      ok,
      detail: `${tq.changePct > 0 ? "+" : ""}${tq.changePct?.toFixed(2)}%`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // 5. QQQ 나스닥
  const qqqQ = quotes["QQQ"];
  if (qqqQ?.ok) {
    const ok = qqqQ.changePct > -2;
    results.push({
      label: "나스닥(QQQ) -2% 이상",
      ok,
      detail: `QQQ ${qqqQ.changePct > 0 ? "+" : ""}${qqqQ.changePct?.toFixed(2)}%`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }

  // 6. VIX 통합 (프리미엄 적정 + 극도공포 회피)
  const vixQ = quotes["^VIX"];
  const vixVal = vixQ?.ok ? vixQ.price : (manualVix ? parseFloat(manualVix) : null);
  if (vixVal != null && !isNaN(vixVal)) {
    const ok = vixVal >= 15 && vixVal < 30;
    const tag = vixVal >= 30 ? " ⚠️극도공포 회피" : vixVal >= 25 ? " 고변동 주의" : vixVal >= 15 ? " 프리미엄 최적" : " 프리미엄 낮음";
    results.push({
      label: "VIX 15~30 (프리미엄 적정)",
      ok,
      detail: `VIX ${vixVal.toFixed(2)}${!vixQ?.ok ? " (수동)" : ""}${tag}`,
      priority: "critical",
    });
    total++; if (ok) score++;
  } else {
    results.push({ label: "VIX 15~30 (프리미엄 적정)", ok: false, detail: "수동 입력 필요", priority: "critical" });
    total++;
  }

  // 7. ETF 거래량 정상 (0.5~2.5배, 조건7+④ 통합)
  if (tq?.ok && tq.volRatio != null) {
    const ok = tq.volRatio >= 0.5 && tq.volRatio <= 2.5;
    const tag = tq.volRatio > 2.5 ? " ⚠️폭증" : tq.volRatio > 1.8 ? " 증가주의" : tq.volRatio < 0.5 ? " 너무적음" : " 정상";
    results.push({
      label: `${targetTicker} 거래량 정상 (평균 대비 0.5~2.5배)`,
      ok,
      detail: `오늘 ${fmtVol(tq.todayVol)} / 평균 ${fmtVol(tq.avgVol20)} (${tq.volRatio.toFixed(2)}배)${tag}`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // 8. 기준 종목 거래량 급증
  if (baseQ?.ok && baseQ.volRatio != null) {
    const ok = baseQ.volRatio < 2.0;
    results.push({
      label: `${baseName} 거래량 급증 없음`,
      ok,
      detail: `${baseName} 평균 대비 ${baseQ.volRatio.toFixed(2)}배${baseQ.volRatio >= 2 ? " ⚠️급등락 가능성" : " 정상"}`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  // ③ 기준 종목 5일 모멘텀
  if (baseQ?.ok && baseQ.fiveDayReturn != null) {
    const ok = baseQ.fiveDayReturn > -3;
    const tag = baseQ.fiveDayReturn > 5 ? " 강세" : baseQ.fiveDayReturn > 0 ? " 양호" : baseQ.fiveDayReturn > -3 ? " 약세" : " 급락";
    results.push({
      label: `${baseName} 5일 모멘텀`,
      ok,
      detail: `최근 5거래일 ${baseQ.fiveDayReturn > 0 ? "+" : ""}${baseQ.fiveDayReturn.toFixed(2)}%${tag}`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }



  // RSI (기준 종목 14일 — 과매수/과매도 회피)
  if (baseQ?.ok && baseQ.rsi14 != null) {
    const ok = baseQ.rsi14 >= 30 && baseQ.rsi14 <= 70;
    const tag = baseQ.rsi14 > 70 ? " 과매수 주의" : baseQ.rsi14 < 30 ? " 과매도 (반등 가능)" : " 적정 구간";
    results.push({
      label: `${baseName} RSI 30~70`,
      ok,
      detail: `RSI ${baseQ.rsi14.toFixed(1)}${tag}`,
      priority: "mid",
    });
    total++; if (ok) score++;
  }

  // MA20 (기준 종목 20일 이평선 위 = 상승 추세)
  if (baseQ?.ok && baseQ.aboveMA20 != null) {
    const ok = baseQ.aboveMA20;
    const diff = baseQ.ma20 ? ((baseQ.price - baseQ.ma20) / baseQ.ma20 * 100) : 0;
    results.push({
      label: `${baseName} MA20 위 (상승 추세)`,
      ok,
      detail: `현재 $${baseQ.price?.toFixed(2)} / MA20 $${baseQ.ma20?.toFixed(2)} (${diff > 0 ? "+" : ""}${diff.toFixed(1)}%)`,
      priority: "high",
    });
    total++; if (ok) score++;
  }

  // ETF 자체 5일 모멘텀
  if (tq?.ok && tq.fiveDayReturn != null) {
    const ok = tq.fiveDayReturn > -5;
    const tag = tq.fiveDayReturn > 3 ? " 강세" : tq.fiveDayReturn > 0 ? " 양호" : tq.fiveDayReturn > -5 ? " 약세" : " 급락";
    results.push({
      label: `${targetTicker} 5일 모멘텀`,
      ok,
      detail: `최근 5거래일 ${tq.fiveDayReturn > 0 ? "+" : ""}${tq.fiveDayReturn.toFixed(2)}%${tag}`,
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
  results.push({
    label: "배당락일 1~3일 전",
    ok: divOk,
    detail: `다음 ${divTypeLabel} 배당락 D-${daysToDiv}`,
    priority: "bonus",
  });
  total++; if (divOk) score++;

  // 가중치 점수 (critical=5, high=4, mid=3, low=2, bonus=1)
  const WEIGHTS = { critical: 5, high: 4, mid: 3, low: 2, bonus: 1 };
  let wScore = 0, wMax = 0;
  results.forEach(r => {
    const w = WEIGHTS[r.priority] ?? 1;
    wMax += w;
    if (r.ok) wScore += w;
  });
  const pct = wMax > 0 ? Math.round((wScore / wMax) * 100) : 0;

  // Critical veto: critical 조건 1개라도 실패 시 진입 적합 차단
  const failedCritical = results.filter(r => r.priority === "critical" && !r.ok);
  const criticalFails = failedCritical.length;
  const criticalVeto = criticalFails > 0;

  let signal = "위험", signalColor = "#ef4444";
  if (criticalVeto) {
    // critical 실패 1개 → 주의 관찰, 2개 이상 → 위험
    signal = criticalFails >= 2 ? "위험 (Critical 다수 실패)" : "주의 관찰 (Critical 실패)";
    signalColor = criticalFails >= 2 ? "#ef4444" : "#f59e0b";
  } else if (pct >= 80) { signal = "진입 적합"; signalColor = "#22c55e"; }
  else if (pct >= 50) { signal = "주의 관찰"; signalColor = "#f59e0b"; }

  return { results, score: wScore, total: wMax, pct, signal, signalColor, failedCritical, criticalVeto };
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
  const [marketTime, setMarketTime] = useState(() => new Date());
  const [tab, setTab] = useState("signal");
  const [showEventModal, setShowEventModal] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [newEvent, setNewEvent] = useState({ date: "", type: "CPI", label: "" });
  const [newLog, setNewLog] = useState({
    date: new Date().toISOString().slice(0, 10),
    from: "NVDY", to: "AMDW", note: "",
  });

  // storage 자동 저장
  useEffect(() => storage.set(STORAGE_KEYS.events, events), [events]);
  useEffect(() => storage.set(STORAGE_KEYS.log, rotationLog), [rotationLog]);
  useEffect(() => storage.set(STORAGE_KEYS.vix, manualVix), [manualVix]);
  useEffect(() => storage.set(STORAGE_KEYS.ticker, activeTicker), [activeTicker]);
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

  const TABS = [
    { id: "signal", label: "📊 진입신호" },
    { id: "market", label: "💹 시장현황" },
    { id: "calendar", label: "📅 이벤트" },
    { id: "log", label: "🔄 회전이력" },
    { id: "guide", label: "📖 가이드" },
    { id: "glossary", label: "📚 용어" },
    { id: "history", label: "📈 기록" },
    { id: "timezone", label: "🕐 시간대" },
    { id: "dividend", label: "💰 배당순위" },
  ];

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
      <div style={{ display: "flex", background: C.card, borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex: 1, minWidth: 72, padding: "11px 6px", background: "none", border: "none", borderBottom: tab === t.id ? `2px solid ${C.blue}` : "2px solid transparent", color: tab === t.id ? C.blue : C.muted, fontSize: 10, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

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
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 6, letterSpacing: 0.3 }}>YieldMax · 주배당 (매주 목요일)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {["NVDY", "AMDY", "TSMY"].map((tk) => (
                  <button key={tk} onClick={() => setActiveTicker(tk)}
                    style={{ flex: 1, padding: "11px", background: activeTicker === tk ? C.blue : C.card, border: `1px solid ${activeTicker === tk ? "#3b82f6" : C.border}`, borderRadius: 12, color: activeTicker === tk ? "#fff" : C.muted, fontWeight: 700, fontSize: 15, cursor: "pointer", transition: "all 0.15s" }}>
                    {tk}
                    {quotes[tk]?.ok && <div style={{ fontSize: 10, fontWeight: 400, marginTop: 3, opacity: 0.85 }}>${quotes[tk].price?.toFixed(2)}</div>}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 6, letterSpacing: 0.3 }}>Roundhill · 주배당 (매주 월요일)</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["AMDW", "PLTW"].map((tk) => (
                  <button key={tk} onClick={() => setActiveTicker(tk)}
                    style={{ flex: 1, padding: "11px", background: activeTicker === tk ? C.blue : C.card, border: `1px solid ${activeTicker === tk ? "#3b82f6" : C.border}`, borderRadius: 12, color: activeTicker === tk ? "#fff" : C.muted, fontWeight: 700, fontSize: 15, cursor: "pointer", transition: "all 0.15s" }}>
                    {tk}
                    {quotes[tk]?.ok && <div style={{ fontSize: 10, fontWeight: 400, marginTop: 3, opacity: 0.85 }}>${quotes[tk].price?.toFixed(2)}</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* 전체 비교 */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 0.3 }}>전체 비교 — 클릭하면 상세 확인</div>
                <button onClick={saveSnapshot}
                  style={{ background: C.blue, border: "none", borderRadius: 7, color: "#fff", padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📥 저장</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {[...allEvaluations].sort((a, b) => b.pct - a.pct).map((ev) => (
                  <div key={ev.ticker} onClick={() => setActiveTicker(ev.ticker)}
                    style={{ display: "flex", alignItems: "center", gap: 8, background: activeTicker === ev.ticker ? `${ev.signalColor}12` : C.card, border: `1px solid ${activeTicker === ev.ticker ? ev.signalColor + "60" : C.border}`, borderRadius: 10, padding: "8px 12px", cursor: "pointer", transition: "all 0.15s" }}>
                    <span style={{ fontWeight: 800, fontSize: 12, color: activeTicker === ev.ticker ? ev.signalColor : C.text, minWidth: 36 }}>{ev.ticker}</span>
                    <div style={{ flex: 1, height: 5, background: C.border, borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 99, background: ev.signalColor, width: `${ev.pct}%`, transition: "width 0.5s ease" }} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: ev.signalColor, minWidth: 32, textAlign: "right" }}>{ev.pct}%</span>
                    <span style={{ fontSize: 10, color: ev.signalColor, minWidth: 52 }}>{ev.signal}</span>
                  </div>
                ))}
              </div>
            </div>

                        {/* 신호 카드 */}
            <div style={{ background: C.card, border: `2px solid ${evaluation.signalColor}40`, borderRadius: 16, padding: "18px", marginBottom: 14, textAlign: "center", boxShadow: `0 4px 20px ${evaluation.signalColor}15` }}>
              <div style={{ fontSize: 30, fontWeight: 800, color: evaluation.signalColor }}>{evaluation.signal}</div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>{activeTicker} 진입 조건 {evaluation.score}/{evaluation.total} 충족</div>
              <div style={{ height: 5, background: C.border, borderRadius: 99, marginTop: 10, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 99, background: evaluation.signalColor, width: `${evaluation.pct}%`, transition: "width 0.5s ease" }} />
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 5 }}>{evaluation.pct}% 충족</div>
            </div>

            {/* 우선순위별 그룹 */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.red, marginBottom: 6, letterSpacing: 0.5 }}>🔴 핵심 조건</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {sortedResults.filter((r) => r.priority === "high").map((r, i) => (
                <ConditionCard key={"h" + i} r={r} C={C} />
              ))}
            </div>

            {sortedResults.some((r) => r.priority === "mid") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.amber, marginBottom: 6, letterSpacing: 0.5 }}>🟡 보조 조건</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "mid").map((r, i) => (
                    <ConditionCard key={"m" + i} r={r} C={C} />
                  ))}
                </div>
              </>
            )}

            {sortedResults.some((r) => r.priority === "low") && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.green, marginBottom: 6, letterSpacing: 0.5 }}>🟢 참고 조건</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {sortedResults.filter((r) => r.priority === "low").map((r, i) => (
                    <ConditionCard key={"l" + i} r={r} C={C} />
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
                        {krwStr && <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{krwStr}</div>}
                        <div style={{ fontSize: 11, fontWeight: 600, marginTop: 1, color: q.changePct >= 0 ? C.green : C.red }}>
                          {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                        </div>
                      </div>
                    ) : <div style={{ fontSize: 10, color: C.red }}>로드 실패 (CORS - 배포 후 정상화)</div>}
                  </div>
                  {q.ok && q.preMarketChange != null && (
                    <div style={{ marginTop: 7, padding: "5px 9px", background: "#f8fafc", borderRadius: 6, fontSize: 10, color: C.sub }}>
                      시간외: <span style={{ color: q.preMarketChange >= 0 ? C.green : C.red, fontWeight: 600 }}>{q.preMarketChange >= 0 ? "+" : ""}{q.preMarketChange?.toFixed(2)}%</span>
                      {" "}(${q.preMarketPrice?.toFixed(2)})
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
        // VIX 반영 조정 계수 (기준 VIX=18, 0.4~2.5배 제한)
        const vixNow = quotes["^VIX"]?.price ?? (manualVix ? parseFloat(manualVix) : 18);
        const BASE_VIX = 18;
        const vixAdj = Math.min(2.5, Math.max(0.4, vixNow / BASE_VIX));
        const ranked = ETF_TICKERS
          .map(tk => {
            const q = quotes[tk];
            const divWeekday = isW(tk) ? 1 : 4;
            const todayDow = new Date().getDay();
            const daysToDiv = (divWeekday - todayDow + 7) % 7 || 7;
            const estDiv = q?.lastDiv ? q.lastDiv * vixAdj : null;
            const estAnnual = estDiv ? estDiv * 52 : null;
            const estYield = estAnnual && q?.price ? (estAnnual / q.price) * 100 : null;
            const histAnnual = q?.lastDiv ? q.lastDiv * 52 : null;
            const histYield = histAnnual && q?.price ? (histAnnual / q.price) * 100 : null;
            return { tk, q, daysToDiv, estDiv, estAnnual, estYield, histAnnual, histYield };
          })
          .sort((a, b) => (b.estYield ?? -1) - (a.estYield ?? -1));

        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
        const vixLabel = vixNow >= 25 ? "고변동 — 프리미엄 높음" : vixNow >= 15 ? "정상 — 프리미엄 적정" : "저변동 — 프리미엄 낮음";
        const vixColor = vixNow >= 25 ? "#22c55e" : vixNow >= 15 ? "#f59e0b" : "#94a3b8";
        return (
          <div style={{ padding: "0 2px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>예상 배당 순위</div>

            {/* VIX 현재 상태 */}
            <div style={{ background: `${vixColor}18`, border: `1.5px solid ${vixColor}55`, borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>현재 VIX (기준 18)</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{vixNow.toFixed(2)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: vixColor }}>{vixLabel}</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>조정계수 ×{vixAdj.toFixed(2)}</div>
              </div>
            </div>

            {ranked.map(({ tk, q, daysToDiv, estDiv, estAnnual, estYield, histAnnual, histYield }, i) => {
              if (!q?.ok) return null;
              const yieldColor = estYield >= 60 ? "#22c55e" : estYield >= 40 ? "#f59e0b" : "#94a3b8";
              return (
                <div key={tk} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 15px", marginBottom: 10, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{medals[i]}</span>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{tk}</div>
                        <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{isW(tk) ? "Roundhill 월요일" : "YieldMax 목요일"}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: yieldColor }}>{estYield ? estYield.toFixed(1) + "%" : "-"}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>VIX반영 연환산</div>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                    <div style={{ background: "#f0fdf4", borderRadius: 8, padding: "8px 10px", border: "1px solid #bbf7d0" }}>
                      <div style={{ fontSize: 9, color: "#166534", marginBottom: 2, fontWeight: 600 }}>VIX 반영 예상 (1회)</div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#15803d" }}>{estDiv ? `$${estDiv.toFixed(4)}` : "-"}</div>
                      <div style={{ fontSize: 9, color: "#166534" }}>연 {estAnnual ? `$${estAnnual.toFixed(2)}${quotes["KRW=X"]?.price ? ` ≈ ₩${Math.round(estAnnual * quotes["KRW=X"].price).toLocaleString()}` : ""}` : "-"}</div>
                    </div>
                    <div style={{ background: C.bg, borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>최근 실제 배당 (1회)</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{q.lastDiv ? `$${q.lastDiv.toFixed(4)}` : "-"}</div>
                      <div style={{ fontSize: 9, color: C.muted }}>연 {histAnnual ? `$${histAnnual.toFixed(2)}${quotes["KRW=X"]?.price ? ` ≈ ₩${Math.round(histAnnual * quotes["KRW=X"].price).toLocaleString()}` : ""}` : "-"} ({histYield ? histYield.toFixed(1) + "%" : "-"})</div>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 10, color: C.muted }}>현재가 ${q.price?.toFixed(2)}{quotes["KRW=X"]?.price ? ` (≈₩${Math.round(q.price * quotes["KRW=X"].price).toLocaleString()})` : ""} · 배당락 {q.lastDivDate ?? "-"} · D-{daysToDiv}</div>
                    <div style={{ fontSize: 10, color: q.changePct >= 0 ? C.green : C.red, fontWeight: 600 }}>
                      {q.changePct >= 0 ? "▲" : "▼"} {Math.abs(q.changePct)?.toFixed(2)}%
                    </div>
                  </div>
                </div>
              );
            })}

            <div style={{ background: "#1e3a5f", borderRadius: 10, padding: "11px 14px", marginTop: 4 }}>
              <div style={{ fontSize: 10, color: "#93c5fd", fontWeight: 700, marginBottom: 4 }}>ℹ️ 계산 방식</div>
              <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.7 }}>
                · VIX 반영 예상 = 최근 배당 × (현재VIX ÷ 기준VIX 18)<br/>
                · 실제 배당은 기초종목(NVDA/AMD 등) 개별 IV 기준이므로 차이 있음<br/>
                · 조정계수 범위: 0.4~2.5배 제한
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
