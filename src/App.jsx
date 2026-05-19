import { useState, useEffect, useCallback, useMemo } from "react";

// ─── 상수 ──────────────────────────────────────────────────────────────────
const TICKERS = ["NVDY", "AMDW", "AMDY", "TSMY", "PLTW", "NVDA", "AMD", "TSM", "PLTR", "^VIX", "QQQ"];

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
    const volumes = rawQ?.volume?.filter((v) => v != null) || [];
    const recentVols = volumes.slice(-21, -1);
    const avgVol20 = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : null;
    const todayVol = meta.regularMarketVolume || volumes[volumes.length - 1] || null;
    const volRatio = avgVol20 && todayVol ? todayVol / avgVol20 : null;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    return {
      ticker, ok: true,
      price: meta.regularMarketPrice,
      prevClose,
      changePct: ((meta.regularMarketPrice - prevClose) / prevClose) * 100,
      marketState: meta.marketState,
      preMarketPrice: meta.preMarketPrice,
      preMarketChange: meta.preMarketPrice ? ((meta.preMarketPrice - meta.regularMarketPrice) / meta.regularMarketPrice) * 100 : null,
      todayVol, avgVol20, volRatio,
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
    priority: "high",
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
    priority: "high",
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
      priority: "mid",
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

  // 6. VIX
  const vixQ = quotes["^VIX"];
  const vixVal = vixQ?.ok ? vixQ.price : (manualVix ? parseFloat(manualVix) : null);
  if (vixVal != null && !isNaN(vixVal)) {
    const ok = vixVal < 20;
    const tag = vixVal >= 30 ? " ⚠️극도공포" : vixVal >= 20 ? " 주의" : " 안정";
    results.push({
      label: "VIX 공포지수 20 미만",
      ok,
      detail: `VIX ${vixVal.toFixed(2)}${!vixQ?.ok ? " (수동)" : ""}${tag}`,
      priority: "high",
    });
    total++; if (ok) score++;
  } else {
    results.push({ label: "VIX 공포지수 20 미만", ok: false, detail: "수동 입력 필요", priority: "high" });
    total++;
  }

  // 7. ETF 거래량 (통상적 경험칙)
  if (tq?.ok && tq.volRatio != null) {
    const ok = tq.volRatio >= 0.5 && tq.volRatio <= 1.8;
    const tag = tq.volRatio > 2.5 ? " ⚠️폭증" : tq.volRatio > 1.8 ? " 증가주의" : tq.volRatio < 0.5 ? " 너무적음" : " 정상";
    results.push({
      label: `${targetTicker} 거래량 정상 (20일 평균 대비)`,
      ok,
      detail: `오늘 ${fmtVol(tq.todayVol)} / 평균 ${fmtVol(tq.avgVol20)} (${tq.volRatio.toFixed(2)}배)${tag}`,
      priority: "mid",
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
      priority: "mid",
    });
    total++; if (ok) score++;
  }

  // 9. 배당락 D-day
  const nextDiv = events
    .filter((e) => e.type === "DIVIDEND" && e.date >= todayStr && (!targetTicker || e.label.includes(targetTicker) || !e.label.match(/NVDY|AMDW/)))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (nextDiv) {
    const diff = Math.round((new Date(nextDiv.date) - today) / 86400000);
    const ok = diff >= 1 && diff <= 3;
    results.push({
      label: "배당락일 1~3거래일 전",
      ok,
      detail: diff === 0 ? `오늘 배당락일 (${nextDiv.label})` : `D-${diff} (${nextDiv.label})`,
      priority: "low",
    });
    total++; if (ok) score++;
  }

  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  let signal = "위험", signalColor = "#ef4444";
  if (pct >= 80) { signal = "진입 적합"; signalColor = "#22c55e"; }
  else if (pct >= 50) { signal = "주의 관찰"; signalColor = "#f59e0b"; }

  return { results, score, total, pct, signal, signalColor };
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

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await Promise.all(TICKERS.map(fetchQuote));
    const map = {};
    res.forEach((r) => { map[r.ticker] = r; });
    setQuotes(map);
    setLastUpdate(new Date());
    setLoading(false);
  }, []);

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

  const fmtTime = (d) => d ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
  const fmtDate = (s) => { const d = new Date(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const dDays = (s) => Math.ceil((new Date(s) - new Date(todayStr)) / 86400000);

  const TABS = [
    { id: "signal", label: "📊 진입신호" },
    { id: "market", label: "💹 시장현황" },
    { id: "calendar", label: "📅 이벤트" },
    { id: "log", label: "🔄 회전이력" },
    { id: "guide", label: "📖 가이드" },
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
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>NVDY / AMDW Rotation v3</div>
          </div>
          <button onClick={refresh} disabled={loading}
            style={{ background: loading ? C.border : C.blue, border: "none", borderRadius: 8, color: loading ? C.muted : "#fff", padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ display: "inline-block", animation: loading ? "spin 1s linear infinite" : "none" }}>↻</span>
            {loading ? "갱신중" : "새로고침"}
          </button>
        </div>
        {lastUpdate && (
          <div style={{ fontSize: 9, color: "#cbd5e1", marginTop: 6 }}>
            마지막 갱신: {fmtTime(lastUpdate)} · 1분 자동갱신 · Yahoo Finance (딜레이 15~20분)
          </div>
        )}
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
              {["NVDY", "AMDW", "AMDY", "TSMY", "PLTW"].map((tk) => (
                <button key={tk} onClick={() => setActiveTicker(tk)}
                  style={{ flex: 1, padding: "11px", background: activeTicker === tk ? C.blue : C.card, border: `1px solid ${activeTicker === tk ? "#3b82f6" : C.border}`, borderRadius: 12, color: activeTicker === tk ? "#fff" : C.muted, fontWeight: 700, fontSize: 15, cursor: "pointer", transition: "all 0.15s" }}>
                  {tk}
                  {quotes[tk]?.ok && <div style={{ fontSize: 10, fontWeight: 400, marginTop: 3, opacity: 0.85 }}>${quotes[tk].price?.toFixed(2)}</div>}
                </button>
              ))}
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
              const displayName = tk === "^VIX" ? "VIX" : tk;
              return (
                <div key={tk} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 15px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{displayName}</div>
                    {q.ok ? (
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 17, fontWeight: 700 }}>{tk === "^VIX" ? q.price?.toFixed(2) : `$${q.price?.toFixed(2)}`}</div>
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
