import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  Brain, TrendingUp, TrendingDown, Minus, RefreshCw,
  CheckCircle2, XCircle, SkipForward, Target, Clock,
  Activity, Newspaper, BarChart3, Zap, AlertTriangle, Wallet,
} from 'lucide-react';
import { fetchKlines, fetchTickers, fetchOrderbook, fetchFundingRates, placeOrder, updatePerpsLeverage } from '../api/services';
import { useLiveTicker, type LiveTicker } from '../api/useLiveTicker';
import { fetchSosoNews, fetchEtfCurrentMetrics, getNewsTitle } from '../api/sosoServices';
import { aggregateInstitutionalBtcFlow } from '../api/sosoExtraServices';
import { analyzeSentiment } from '../api/geminiClient';
import { useSettingsStore } from '../store/settingsStore';
import { useBotPnlStore } from '../store/botPnlStore';
import {
  usePredictorStore,
  computeNetPerformance,
  type PredictionDirection,
  type SignalSnapshot,
  type PredictionEntry,
} from '../store/predictorStore';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { cn } from '../lib/utils';
import toast from 'react-hot-toast';

// ─── Constants ────────────────────────────────────────────────────────────────
const CYCLE_MS      = 5 * 60 * 1000;
// Both TTLs MUST exceed CYCLE_MS, otherwise the predictor cache misses
// every cycle and we re-hit SoSoValue (and Gemini for news) needlessly.
// 6 / 8 minutes give us guaranteed hits on consecutive cycles while
// staying short enough that data refreshes within ~one extra cycle.
const NEWS_TTL_MS   = 6 * 60 * 1000;
const ETF_TTL_MS    = 8 * 60 * 1000;
// Treasury aggregation runs through ~8 SoSoValue calls per refresh, so we
// cache aggressively (30 min) — institutional buys aren't intra-day data.
const TREASURY_TTL_MS = 30 * 60 * 1000;
const LS_NEWS_KEY   = 'predictor_news_cache';
const LS_ETF_KEY    = 'predictor_etf_cache';
const LS_TREASURY_KEY = 'predictor_treasury_cache';
const KLINES_LIMIT  = 40;               // enough for EMA-21 + microstructure
const BTC_SYMBOL_HINT = 'BTC';        // substring match against fetchTickers result
const NEUTRAL_WIDE  = 0.18;             // self-correcting threshold when accuracy drops
const ORDERBOOK_HISTORY = 30;           // rolling window for dynamic imbalance z-score
// 12 signals total — the conviction floor is **dynamic**. Default 2 lets the
// engine fire whenever the weighted score has crossed the threshold AND at
// least two signals back it. After two consecutive losses the floor jumps
// to 3 to demand stronger consensus until accuracy recovers; after a win it
// relaxes back. Static "3" was producing zero trades in calm regimes.
const MIN_CONVICTION_BASE = 2;
const MIN_CONVICTION_AFTER_LOSSES = 3;
function dynamicConvictionFloor(consecutiveLosses: number): number {
  return consecutiveLosses >= 2 ? MIN_CONVICTION_AFTER_LOSSES : MIN_CONVICTION_BASE;
}
// Warmup gate — first N cycles after Start are observed but not traded so the
// adaptive components (orderbook z-score history, funding-momentum baseline)
// have *some* data to calibrate against before risking capital. The orderbook
// signal already gracefully falls back to fixed cuts while history < 5
// samples, so we don't need a long warmup; 3 cycles (~15 min) is enough
// for the funding-momentum prevRef to populate while keeping the user's
// total wait time short.
const WARMUP_CYCLES = 3;

// Score-margin gate — once the threshold is cleared, the score must clear
// it by at least this multiplier before a trade fires. Stops "marginal
// scores" (e.g. score=0.10 vs threshold=0.09 — only 11% over) from firing,
// since those almost always resolve into noise that the round-trip taker
// fee (~0.08%) eats. Empirically observed on a 4-trade live sample where
// 3 of 4 firing trades had Math.abs(score)/threshold ≈ 1.05–1.20 and lost
// by an average of −0.10%, while wins were +0.03% (asymmetric). 1.30
// requires the score to be at least 30% past the threshold — which
// corresponds to a meaningfully aligned ensemble, not a borderline edge.
const SCORE_MARGIN_MULT = 1.30;

// ─── Weights ──────────────────────────────────────────────────────────────────
// Designed for the 5-minute horizon, where technical momentum
// dominates and slow macro signals (news / ETF flow) only add edge at
// the margins.
//   Tech cluster   = 0.55  — microstructure + ROC + EMA + MACD + RSI
//   Flow + Sent.   = 0.27  — orderbook z-score + news + ETF
//   Mean reversion = 0.08  — VWAP deviation
//   Funding        = 0.10  — absolute rate + change momentum
// Sum = 1.00
// 12 weights now — tech cluster trimmed slightly to make room for the
// new institutional-treasury macro signal (sourced from
// /btc-treasuries). MicroStrategy/Tesla/etc. tend to forecast 1–3 day
// drifts; on the 5-min horizon the weight is intentionally small (0.05).
const W = {
  microstructure:  0.17,
  roc:             0.14,
  ema:             0.11,
  macd:            0.06,
  rsi:             0.04,
  orderBook:       0.12,
  news:            0.08,
  etf:             0.07,
  vwap:            0.07,
  fundingRate:     0.04,
  fundingMomentum: 0.05,
  treasury:        0.05,
} as const;

/**
 * Volatility-adaptive neutral threshold tuned for a "fee-aware airdrop
 * volume" goal: produce as many trades as possible while keeping
 * expected value positive after the round-trip taker fee (~0.08%).
 *
 * Calibrated against typical BTC 1-min ATR(14) which sits around
 * 0.08-0.20% in calm regimes and >0.30% in active ones. The previous
 * ladder cut at 0.10% which was killing the entire calm regime
 * (~50% of market hours) and producing zero trades.
 *
 *   ATR < 0.04%  → 0.30  truly dead market — refuse outright.
 *   ATR < 0.08%  → 0.13  calm regime — demand consensus.
 *   ATR < 0.16%  → 0.09  normal regime — fire on decent scores.
 *   ATR < 0.28%  → 0.06  active regime — almost any directional bias.
 *   ATR ≥ 0.28%  → 0.04  volatile regime — fire often.
 *
 * If recent accuracy collapses (<45% over the last 20 decided trades)
 * the threshold widens to NEUTRAL_WIDE regardless of ATR — a circuit
 * breaker that pauses aggression until the engine recovers.
 */
function computeNeutralThreshold(atrPct: number, accuracyBelow45: boolean): number {
  if (accuracyBelow45) return NEUTRAL_WIDE;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0.10;
  if (atrPct < 0.04) return 0.30;   // dead market — fee guard
  if (atrPct < 0.08) return 0.13;
  if (atrPct < 0.16) return 0.09;
  if (atrPct < 0.28) return 0.06;
  return 0.04;                       // volatile → fire often
}

// ─── Technical Indicator Helpers ─────────────────────────────────────────────
function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++)
    result.push(values[i] * k + result[i - 1] * (1 - k));
  return result;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

interface TechResult {
  rsi: number; rsiSignal: number;
  emaSignal: number; macdSignal: number;
  microstructureSignal: number; volumeSpike: boolean;
  // Extended signals
  vwapDeviation: number;   // (close - VWAP) / VWAP, raw ratio
  vwapSignal: number;      // -1..+1, mean-reversion bias
  rocSignal: number;       // -1..+1, momentum (trend-following)
  atrPct: number;          // ATR as % of price (volatility regime)
}

interface Kline {
  close: number;
  volume: number;
  high?: number;
  low?: number;
}

function computeIndicators(klines: Kline[]): TechResult {
  const closes  = klines.map((k) => Number(k.close));
  const volumes = klines.map((k) => Number(k.volume));
  // Fallback: approximate high/low from close series when not supplied.
  // This keeps ATR defined even if the kline endpoint returns a reduced
  // payload.
  const highs = klines.map((k, i) => Number(k.high ?? Math.max(k.close, klines[i - 1]?.close ?? k.close)));
  const lows  = klines.map((k, i) => Number(k.low  ?? Math.min(k.close, klines[i - 1]?.close ?? k.close)));
  const empty: TechResult = {
    rsi: 50, rsiSignal: 0, emaSignal: 0, macdSignal: 0,
    microstructureSignal: 0, volumeSpike: false,
    vwapDeviation: 0, vwapSignal: 0, rocSignal: 0, atrPct: 0,
  };
  if (closes.length < 5) return empty;

  const last = closes.length - 1;

  // RSI — gradient: extremes ±1, mid-range proportional signal
  const rsi = calcRSI(closes);
  let rsiSignal: number;
  if      (rsi <= 25) rsiSignal =  1.0;
  else if (rsi <= 35) rsiSignal =  0.6;
  else if (rsi <= 45) rsiSignal =  0.2;
  else if (rsi >= 75) rsiSignal = -1.0;
  else if (rsi >= 65) rsiSignal = -0.6;
  else if (rsi >= 55) rsiSignal = -0.2;
  else rsiSignal = 0;  // 45-55: truly neutral

  // EMA 9/21 — gradient signal based on % spread
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  let emaSignal = 0;
  if (ema9.length && ema21.length) {
    const spread = (ema9[last] - ema21[last]) / ema21[last];
    // map: >0.002% → +1, 0.0001–0.002% → proportional, mirror for negative
    emaSignal = Math.max(-1, Math.min(1, spread / 0.002));
  }

  // MACD — histogram direction (not just zero-cross)
  let macdSignal = 0;
  if (closes.length >= 26) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const sig9 = calcEMA(macdLine, 9);
    const histNow  = macdLine[last]     - sig9[last];
    const histPrev = macdLine[last - 1] - sig9[last - 1];
    // zero-cross = full signal; histogram growing in direction = half signal
    if      (histPrev <= 0 && histNow > 0)  macdSignal =  1;
    else if (histPrev >= 0 && histNow < 0)  macdSignal = -1;
    else if (histNow > 0 && histNow > histPrev) macdSignal =  0.5;
    else if (histNow < 0 && histNow < histPrev) macdSignal = -0.5;
  }

  // Price microstructure: HH/HL pattern + velocity + volume
  let microstructureSignal = 0;
  if (closes.length >= 5) {
    const c = closes.slice(-5);
    // candle direction pattern (last 3)
    const allUp   = c[2] > c[1] && c[3] > c[2] && c[4] > c[3];
    const allDown = c[2] < c[1] && c[3] < c[2] && c[4] < c[3];
    const patternScore = allUp ? 1 : allDown ? -1 : (c[4] > c[3] ? 0.3 : -0.3);
    // velocity: rate of change last 60s vs prev 60s  (approximated by last 1 vs prev 1)
    const velNow  = (c[4] - c[3]) / (c[3] || 1);
    const velPrev = (c[3] - c[2]) / (c[2] || 1);
    const velAcc  = velNow > velPrev ? 0.3 : velNow < velPrev ? -0.3 : 0;
    // volume spike
    const recentVol = volumes[last] ?? 0;
    const avg10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, volumes.length - 1));
    const spikeBoost = avg10 > 0 && recentVol > avg10 * 2 ? 0.4 * Math.sign(patternScore) : 0;
    microstructureSignal = Math.max(-1, Math.min(1, patternScore * 0.5 + velAcc * 0.3 + spikeBoost));
  }

  const recentVol = volumes[last] ?? 0;
  const avg10v = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, volumes.length - 1));
  const volumeSpike = avg10v > 0 && recentVol > avg10v * 2;

  // VWAP — volume-weighted average price across the full kline window.
  // Deviation expressed as ratio of current close; mean-reversion bias:
  // price stretched far from VWAP tends to retrace within 5 min.
  // Threshold 0.15% (≈ one typical 5-min BTC move) maps to ±1 signal.
  let vwapDeviation = 0;
  let vwapSignal = 0;
  {
    let pvSum = 0;
    let vSum  = 0;
    for (let i = 0; i < closes.length; i++) {
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      const v = volumes[i];
      if (v > 0 && Number.isFinite(typical)) {
        pvSum += typical * v;
        vSum  += v;
      }
    }
    if (vSum > 0) {
      const vwap = pvSum / vSum;
      vwapDeviation = vwap > 0 ? (closes[last] - vwap) / vwap : 0;
      // Mean reversion: price above VWAP → expect down, below → expect up.
      // Sign is inverted. Scale 0.3% — only produces a meaningful signal
      // when price has genuinely stretched far from VWAP, so it doesn't
      // constantly fight ROC in trending regimes.
      vwapSignal = Math.max(-1, Math.min(1, -vwapDeviation / 0.003));
    }
  }

  // ROC — blended rate-of-change over 5 and 15 one-minute bars. Trend
  // following: sustained upward drift → positive signal. Scale factor
  // 0.003 (0.3%) chosen as roughly one standard deviation of 5-min BTC
  // moves under normal conditions.
  let rocSignal = 0;
  if (closes.length >= 16) {
    const roc5  = (closes[last] - closes[last - 5])  / (closes[last - 5]  || 1);
    const roc15 = (closes[last] - closes[last - 15]) / (closes[last - 15] || 1);
    const blended = roc5 * 0.6 + roc15 * 0.4;
    rocSignal = Math.max(-1, Math.min(1, blended / 0.003));
  } else if (closes.length >= 6) {
    const roc5 = (closes[last] - closes[last - 5]) / (closes[last - 5] || 1);
    rocSignal = Math.max(-1, Math.min(1, roc5 / 0.003));
  }

  // ATR — Wilder-style true range averaged over 14 bars (or what's
  // available). Expressed as a % of the current close so downstream
  // logic can treat volatility rejim-agnostically.
  let atrPct = 0;
  if (closes.length >= 2) {
    const period = Math.min(14, closes.length - 1);
    let trSum = 0;
    let count = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      if (i <= 0) continue;
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1]),
      );
      if (Number.isFinite(tr)) {
        trSum += tr;
        count += 1;
      }
    }
    const atr = count > 0 ? trSum / count : 0;
    atrPct = closes[last] > 0 ? (atr / closes[last]) * 100 : 0;
  }

  return {
    rsi, rsiSignal, emaSignal, macdSignal,
    microstructureSignal, volumeSpike,
    vwapDeviation, vwapSignal, rocSignal, atrPct,
  };
}


// ─── Cache helpers (shared with other pages via sosoValueClient memory cache) ─
interface CacheItem<T> { data: T; fetchedAt: number }

function lsRead<T>(key: string): CacheItem<T> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as CacheItem<T>) : null;
  } catch { return null; }
}

function lsWrite<T>(key: string, data: T) {
  try { localStorage.setItem(key, JSON.stringify({ data, fetchedAt: Date.now() })); } catch { /* ignore */ }
}

// ─── Sparkline component ──────────────────────────────────────────────────────
const Sparkline: React.FC<{ values: (0 | 1)[]; size?: number }> = ({ values, size = 8 }) => {
  if (values.length === 0) return <span className="text-text-muted text-xs">—</span>;
  return (
    <div className="flex items-center gap-[3px]">
      {values.map((v, i) => (
        <div
          key={i}
          className={cn('rounded-sm', v === 1 ? 'bg-emerald-400' : 'bg-red-400')}
          style={{ width: size, height: size }}
        />
      ))}
    </div>
  );
};

// ─── Countdown timer ──────────────────────────────────────────────────────────
const CountdownTimer: React.FC<{ cycleStartTime: number | null }> = ({ cycleStartTime }) => {
  // Tick a 'now' state once per second rather than recomputing the
  // derived remaining value inside the effect — avoids a synchronous
  // setState on every cycleStartTime change (react-hooks/set-state-in-effect).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!cycleStartTime) return;
    // Interval-only update; no synchronous setState inside the effect body.
    // `now` was seeded from `Date.now()` on mount so the first render is
    // accurate, and subsequent cycleStartTime changes only delay the
    // next tick by at most 1 second — imperceptible to the user.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cycleStartTime]);

  const remaining = cycleStartTime
    ? Math.max(0, CYCLE_MS - (now - cycleStartTime))
    : CYCLE_MS;

  const secs  = Math.floor(remaining / 1000);
  const mins  = Math.floor(secs / 60);
  const secsR = secs % 60;
  const pct   = ((CYCLE_MS - remaining) / CYCLE_MS) * 100;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
          <circle
            cx="48" cy="48" r="40" fill="none"
            stroke="var(--color-primary)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 40}`}
            strokeDashoffset={`${2 * Math.PI * 40 * (1 - pct / 100)}`}
            className="transition-all duration-1000"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-text-primary font-mono">
            {String(mins).padStart(2, '0')}:{String(secsR).padStart(2, '0')}
          </span>
          <span className="text-[10px] text-text-muted uppercase tracking-wide">remaining</span>
        </div>
      </div>
    </div>
  );
};

// ─── History row ──────────────────────────────────────────────────────────────
const HistoryRow: React.FC<{ entry: PredictionEntry; idx: number }> = ({ entry, idx }) => {
  const resultIcon =
    entry.result === 'CORRECT' ? <CheckCircle2 size={14} className="text-emerald-400" /> :
    entry.result === 'WRONG'   ? <XCircle size={14} className="text-red-400" /> :
    entry.result === 'SKIPPED' ? <SkipForward size={14} className="text-text-muted" /> :
                                 <Clock size={14} className="text-amber-400 animate-pulse" />;
  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs transition-colors',
      idx % 2 === 0 ? 'bg-white/[0.02]' : '',
    )}>
      <span className="text-text-muted w-14 shrink-0 font-mono">
        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className={cn(
        'font-bold w-16 shrink-0',
        entry.direction === 'UP' ? 'text-emerald-400' :
        entry.direction === 'DOWN' ? 'text-red-400' : 'text-text-muted',
      )}>
        {entry.direction === 'UP' ? '↑ UP' : entry.direction === 'DOWN' ? '↓ DOWN' : '— NEUTRAL'}
      </span>
      <span className="flex-1 flex items-center justify-center">{resultIcon}</span>
      <span className={cn(
        'w-14 text-right font-mono',
        entry.pricePct === null ? 'text-text-muted' :
        entry.pricePct > 0 ? 'text-emerald-400' : 'text-red-400',
      )}>
        {entry.pricePct !== null ? `${entry.pricePct >= 0 ? '+' : ''}${entry.pricePct.toFixed(2)}%` : '…'}
      </span>
    </div>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export const BtcPredictor: React.FC = () => {
  const { sosoApiKey, geminiApiKey, isDemoMode } = useSettingsStore();

  // ── Symbol discovery from SoDEX REST (used for klines/orderbook/funding) ──
  const [rawTicker, setRawTicker] = useState<LiveTicker[]>([]);
  const [btcSymbol, setBtcSymbol] = useState('BTC-USDC');
  const btcSymbolRef = useRef('BTC-USDC');

  useEffect(() => {
    fetchTickers('perps').then((res) => {
      const arr = Array.isArray(res) ? res as Record<string, unknown>[] : [];
      const row = arr.find((t) => String(t.symbol ?? '').toUpperCase().includes(BTC_SYMBOL_HINT));
      if (!row) return;
      const sym = String(row.symbol);
      const lp  = parseFloat(String(row.lastPrice ?? row.close ?? 0));
      setBtcSymbol(sym);
      btcSymbolRef.current = sym;
      setRawTicker([{
        symbol: sym,
        lastPrice: lp > 0 ? lp : 0,
        change24h: parseFloat(String(row.priceChangePercent ?? row.change ?? 0)),
        volume24h: parseFloat(String(row.quoteVolume ?? row.volume ?? 0)),
      }]);
    }).catch(() => {});
  }, []);

  // Demo mode: useLiveTicker drives price via subscribeToDemoTicks
  const liveTickers = useLiveTicker(rawTicker, [btcSymbol]);
  const demoPrice   = (liveTickers.find((t) => t.symbol === btcSymbol) ?? rawTicker[0])?.lastPrice ?? 0;

  // Live mode: Binance public WebSocket — no API key, sub-second updates
  const [binancePrice, setBinancePrice] = useState(0);
  useEffect(() => {
    if (isDemoMode) return;
    // REST seed
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        const p = parseFloat(String(d.price ?? 0));
        if (p > 0) setBinancePrice(p);
      })
      .catch(() => {});
    // Live stream
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@aggTrade');
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data as string) as Record<string, unknown>;
        const p = parseFloat(String(d.p ?? 0));
        if (p > 0) setBinancePrice(p);
      } catch { /* ignore */ }
    };
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [isDemoMode]);

  const btcPrice = isDemoMode ? demoPrice : (binancePrice || demoPrice);

  const {
    currentPrediction, currentConfidence, currentSignals,
    cycleStartTime, entryPrice,
    history, correct, wrong, skipped,
    setCurrentPrediction, resolvePrediction, addHistoryEntry, resetStats,
    autoTradeEnabled, tradeAmountUsdt, tradeLeverage, closeOnNeutral, renewEveryCycle,
    stopLossEnabled, slAtrMult,
    setAutoTradeEnabled, setTradeAmountUsdt, setTradeLeverage, setCloseOnNeutral, setRenewEveryCycle,
    setStopLossEnabled, setSlAtrMult,
    openPosition, setOpenPosition,
  } = usePredictorStore();

  const [isRunning, setIsRunning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Press Start to begin predictions');
  const [, setPendingEntryId] = useState<string | null>(null);

  const btcPriceRef      = useRef(btcPrice);
  const isRunningRef     = useRef(false);
  const cycleTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { btcPriceRef.current  = btcPrice;  }, [btcPrice]);
  useEffect(() => { btcSymbolRef.current = btcSymbol; }, [btcSymbol]); // keep ref in sync

  // ── Auto-resolve stale PENDING predictions on mount ──────────────────────
  // If user stopped/refreshed before resolution, old PENDINGs stay stuck.
  // Resolve any whose 5-min window has passed using current price.
  useEffect(() => {
    const now = Date.now();
    const pending = history.filter((e) => e.result === 'PENDING' && e.entryPrice > 0);
    if (pending.length === 0) return;
    const stale = pending.filter((e) => now - e.timestamp >= CYCLE_MS);
    if (stale.length === 0) return;
    const exitPrice = btcPriceRef.current;
    if (exitPrice <= 0) {
      toast('BTC price unavailable — cannot resolve stale predictions', { icon: '⚠️' });
      return;
    }
    stale.forEach((entry) => {
      resolvePrediction(entry.id, exitPrice);
    });
    if (stale.length > 0) {
      toast(`${stale.length} stale prediction(s) auto-resolved`, { icon: '⏱️' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // ── Klines cache ref — populated by cycle, reused by fallbacks ───────────
  const klinesRef = useRef<Kline[]>([]);

  // ── Fallback: news → mark-price vs SMA-10 momentum ────────────────────
  const newsFallbackScore = useCallback((): number => {
    const closes = klinesRef.current.map((k) => k.close);
    if (closes.length < 10) return 0;
    const sma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const last  = closes[closes.length - 1];
    // normalise: ±0.5% move from SMA maps to ±1
    return Math.max(-1, Math.min(1, (last - sma10) / sma10 / 0.005));
  }, []);

  // ── Fallback: ETF → continuous RSI score (−1 to +1, full range) ───────
  const etfFallbackScore = useCallback((): number => {
    const closes = klinesRef.current.map((k) => k.close);
    if (closes.length < 15) return 0;
    const rsi = calcRSI(closes);
    // map RSI 0-100 → −1 to +1 linearly (50 = 0)
    return Math.max(-1, Math.min(1, (rsi - 50) / 50));
  }, []);

  // ── Fetch news sentiment via shared cache ──────────────────────────────────
  const fetchNewsSentiment = useCallback(async (): Promise<{ score: number; fromFallback?: boolean; fetchedAt: number }> => {
    const cached = lsRead<{ score: number }>(LS_NEWS_KEY);
    if (cached && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
      return { score: cached.data.score, fetchedAt: cached.fetchedAt };
    }
    if (!sosoApiKey) {
      return { score: newsFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
    }

    try {
      const result = await fetchSosoNews(1, 10);
      const items  = result.list ?? [];
      if (items.length === 0) {
        return { score: newsFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
      }

      let total = 0;
      let count = 0;
      for (const item of items.slice(0, 5)) {
        const title = getNewsTitle(item);
        if (!title || title === '(no title)') continue;
        try {
          const s = geminiApiKey
            ? await analyzeSentiment(title)
            : 'NEUTRAL';
          total += s === 'BULLISH' ? 1 : s === 'BEARISH' ? -1 : 0;
          count++;
        } catch { /* skip individual failures */ }
      }
      const score = count > 0 ? total / count : newsFallbackScore();
      lsWrite(LS_NEWS_KEY, { score });
      return { score, fetchedAt: Date.now() };
    } catch {
      return { score: newsFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
    }
  }, [sosoApiKey, geminiApiKey, newsFallbackScore]);

  // ── Fetch ETF flow via shared cache ───────────────────────────────────────
  const fetchEtfSignal = useCallback(async (): Promise<{ score: number; fromFallback?: boolean; fetchedAt: number }> => {
    const cached = lsRead<{ score: number }>(LS_ETF_KEY);
    if (cached && Date.now() - cached.fetchedAt < ETF_TTL_MS) {
      return { score: cached.data.score, fetchedAt: cached.fetchedAt };
    }
    if (!sosoApiKey) {
      return { score: etfFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
    }

    try {
      const metrics = await fetchEtfCurrentMetrics('us-btc-spot');
      const flow = metrics?.dailyNetInflow?.value ?? null;
      if (flow === null) {
        return { score: etfFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
      }
      const score = Math.max(-1, Math.min(1, flow / 5e8));
      lsWrite(LS_ETF_KEY, { score });
      return { score, fetchedAt: Date.now() };
    } catch {
      return { score: etfFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
    }
  }, [sosoApiKey, etfFallbackScore]);

  // ── Fetch institutional BTC treasury flow (9th signal) ─────────────────
  // Aggregates the last 30 days of MSTR/TSLA/MARA/etc. treasury buys.
  // Cached aggressively — the underlying data changes daily at most.
  const fetchTreasurySignal = useCallback(async (): Promise<{
    signal: number; netBtc: number; topBuyer: string | null; fromFallback?: boolean; fetchedAt: number;
  }> => {
    const cached = lsRead<{ signal: number; netBtc: number; topBuyer: string | null }>(LS_TREASURY_KEY);
    if (cached && Date.now() - cached.fetchedAt < TREASURY_TTL_MS) {
      return { ...cached.data, fetchedAt: cached.fetchedAt };
    }
    try {
      const agg = await aggregateInstitutionalBtcFlow(30);
      const result = {
        signal: agg.signal,
        netBtc: agg.totalBtc,
        topBuyer: agg.topBuyer?.ticker ?? null,
      };
      lsWrite(LS_TREASURY_KEY, result);
      return { ...result, fetchedAt: Date.now() };
    } catch {
      // Demo synth always returns a valid number; real failures land here.
      return { signal: 0, netBtc: 0, topBuyer: null, fromFallback: true, fetchedAt: Date.now() };
    }
  }, []);

  // ── Order book + funding via REST (fetched each cycle) ───────────────────
  const prevFundingRef = useRef(0);
  // Rolling history of bid/(bid+ask) imbalance, used to derive a dynamic
  // z-score so the orderbook signal is calibrated to the instrument's
  // typical state (BTC often sits slightly bid-heavy) rather than fixed
  // 0.35 / 0.65 cut-offs.
  const obImbalanceHistoryRef = useRef<number[]>([]);
  // Warmup counter — increments every cycle; while < WARMUP_CYCLES the
  // engine still computes signals but forces NEUTRAL so ATR/orderbook/
  // funding history can calibrate before any real money moves. Reset
  // back to 0 on Stop so each fresh session re-warms.
  const cycleCountRef = useRef(0);
  // Mirrored into state so the UI can show a "warming up X/10" banner
  // without subscribing to a ref directly.
  const [cycleCount, setCycleCount] = useState(0);

  // ── Volatility-adaptive neutral threshold ────────────────────
  // ATR is measured each cycle; the threshold widens when volatility
  // is low (avoid trading on noise that fees would consume) and narrows
  // when volatility is high (small composite scores still produce real
  // moves). A fallback widening also fires when recent accuracy drops
  // below 45% across the last 20 decided trades.
  const [lastAtrPct, setLastAtrPct] = useState(0);
  const last20Decided = history.filter((e) => e.result === 'CORRECT' || e.result === 'WRONG').slice(0, 20);
  const acc20 = last20Decided.length >= 5
    ? last20Decided.filter((e) => e.result === 'CORRECT').length / last20Decided.length
    : null;
  const accuracyBelow45 = acc20 !== null && acc20 < 0.45;
  const neutralThreshold = computeNeutralThreshold(lastAtrPct, accuracyBelow45);
  // Count consecutive WRONG results from the most recent decided trade
  // backward; stops at the first CORRECT. Drives the dynamic conviction
  // floor — two losses in a row demand stronger consensus.
  const consecutiveLosses = (() => {
    let n = 0;
    for (const e of last20Decided) {
      if (e.result === 'WRONG') n += 1;
      else break;
    }
    return n;
  })();
  const minConvictionFloor = dynamicConvictionFloor(consecutiveLosses);

  // ── Run full prediction cycle ───────────────────────────────────────────
  const neutralThresholdRef = useRef(neutralThreshold);
  useEffect(() => { neutralThresholdRef.current = neutralThreshold; }, [neutralThreshold]);
  // Conviction floor mirrored into a ref so the async cycle reads the
  // latest value without re-creating the callback every time it changes.
  const minConvictionRef = useRef(minConvictionFloor);
  useEffect(() => { minConvictionRef.current = minConvictionFloor; }, [minConvictionFloor]);

  // ── Trade-settings refs (so the cycle reads latest values reactively) ──
  const autoTradeEnabledRef = useRef(autoTradeEnabled);
  const tradeAmountUsdtRef  = useRef(tradeAmountUsdt);
  const tradeLeverageRef    = useRef(tradeLeverage);
  const closeOnNeutralRef   = useRef(closeOnNeutral);
  const renewEveryCycleRef  = useRef(renewEveryCycle);
  const openPositionRef     = useRef(openPosition);
  // Refs for the SL watcher so the effect deps stay minimal (only btcPrice).
  const stopLossEnabledRef  = useRef(stopLossEnabled);
  const slAtrMultRef        = useRef(slAtrMult);
  const lastAtrPctRef       = useRef(0);
  useEffect(() => { autoTradeEnabledRef.current = autoTradeEnabled; }, [autoTradeEnabled]);
  useEffect(() => { tradeAmountUsdtRef.current  = tradeAmountUsdt;  }, [tradeAmountUsdt]);
  useEffect(() => { tradeLeverageRef.current    = tradeLeverage;    }, [tradeLeverage]);
  useEffect(() => { closeOnNeutralRef.current   = closeOnNeutral;   }, [closeOnNeutral]);
  useEffect(() => { renewEveryCycleRef.current  = renewEveryCycle;  }, [renewEveryCycle]);
  useEffect(() => { stopLossEnabledRef.current  = stopLossEnabled;  }, [stopLossEnabled]);
  useEffect(() => { slAtrMultRef.current        = slAtrMult;        }, [slAtrMult]);
  useEffect(() => { lastAtrPctRef.current       = lastAtrPct;       }, [lastAtrPct]);
  useEffect(() => { openPositionRef.current     = openPosition;     }, [openPosition]);

  /**
   * Close the bot-managed open position with a reduce-only market order
   * in the opposite direction. Clears `openPosition` from the store on
   * success. Returns true if a close was attempted.
   */
  const closePredictorPosition = useCallback(async (reason: string): Promise<boolean> => {
    const pos = openPositionRef.current;
    if (!pos) return false;
    try {
      await placeOrder(
        {
          symbol: pos.symbol,
          side: pos.side === 'LONG' ? 2 : 1,   // opposite side
          type: 2,                              // MARKET
          quantity: pos.quantity.toString(),
          reduceOnly: true,
        },
        'perps',
      );
      const exitPrice = btcPriceRef.current;
      const pnlUsdt = exitPrice > 0
        ? (exitPrice - pos.entryPrice) * pos.quantity * (pos.side === 'LONG' ? 1 : -1)
        : 0;
      // Record into the global per-bot PnL store so the dashboard /
      // strip widgets pick up the close immediately.
      if (exitPrice > 0) {
        useBotPnlStore.getState().recordTrade('predictor', {
          pnlUsdt,
          ts: Date.now(),
          note: `${pos.side} ${pos.symbol} closed (${reason})`,
        });
      }
      toast.success(
        `Closed ${pos.side} ${pos.quantity.toFixed(4)} ${pos.symbol}`
        + (exitPrice > 0 ? ` — PnL ${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT` : '')
        + ` (${reason})`,
      );
      setOpenPosition(null);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Close failed: ${msg}`);
      return false;
    }
  }, [setOpenPosition]);

  /**
   * Intracycle stop-loss watcher.
   *
   * The predictor's standard exit is the 5-minute cycle resolution timer.
   * That fixed window lets a position run the full distance against the
   * trade in the worst case — empirically a single −0.19% loss erased
   * four near-break-even wins on a small live sample.
   *
   * This effect closes the position the moment the live BTC tick puts
   * unrealised PnL below `−slAtrMult × ATR%`. ATR is the latest 1-min
   * ATR(14)% computed by the cycle, so the stop adapts to volatility:
   *   ATR 0.10% × 1.5 → SL at −0.15% (calm regime, tight stop)
   *   ATR 0.20% × 1.5 → SL at −0.30% (active regime, wider stop)
   *
   * Skip conditions, in order:
   *   - SL toggle off
   *   - No open position
   *   - ATR not yet computed (first cycle of the run)
   *   - Live price unavailable
   *
   * Only `btcPrice` is in the deps; everything else is read through refs
   * so the effect runs on every tick without re-creating itself.
   */
  const slClosingRef = useRef(false);
  useEffect(() => {
    if (!stopLossEnabledRef.current) return;
    const pos = openPositionRef.current;
    if (!pos) return;
    if (slClosingRef.current) return;        // already firing, don't double-send
    const atrPct = lastAtrPctRef.current;
    if (!atrPct || atrPct <= 0) return;
    if (btcPrice <= 0) return;

    const dir   = pos.side === 'LONG' ? 1 : -1;
    const pnlPct = ((btcPrice - pos.entryPrice) / pos.entryPrice) * 100 * dir;
    const slPct  = -(atrPct * slAtrMultRef.current);

    if (pnlPct <= slPct) {
      slClosingRef.current = true;
      void closePredictorPosition(
        `stop-loss ${pnlPct.toFixed(2)}% ≤ ${slPct.toFixed(2)}% (${slAtrMultRef.current}× ATR ${atrPct.toFixed(2)}%)`,
      ).finally(() => { slClosingRef.current = false; });
    }
  }, [btcPrice, closePredictorPosition]);

  /**
   * Place a market order matching the predicted direction.
   * Quantity is computed from the user-supplied USDT notional and the
   * current BTC price: `qty = notional / btcPrice`. Sets leverage first,
   * then submits the order. On success, records the position so a future
   * close-on-direction-change can target it. Errors are toasted, never
   * thrown.
   */
  const placePredictorOrder = useCallback(async (direction: PredictionDirection): Promise<void> => {
    if (direction === 'NEUTRAL') return;
    const symbol = btcSymbolRef.current;
    const usdtStr = tradeAmountUsdtRef.current;
    const lev    = tradeLeverageRef.current;
    const price  = btcPriceRef.current;
    if (!symbol) {
      toast.error('Auto-trade: BTC symbol not resolved yet');
      return;
    }
    const usdtNum = parseFloat(usdtStr);
    if (!Number.isFinite(usdtNum) || usdtNum <= 0) {
      toast.error(`Auto-trade: invalid USDT amount "${usdtStr}"`);
      return;
    }
    if (price <= 0) {
      toast.error('Auto-trade: BTC price unavailable');
      return;
    }
    // Convert USDT notional → BTC quantity. Round to 4 decimals which is
    // safely within typical SoDEX BTC step size (0.0001). Exchange will
    // re-round if needed via placePerpsOrder normalisation.
    const qtyBtc = Math.max(0.0001, +(usdtNum / price).toFixed(4));
    try {
      // 1. Set leverage (server may reject if open orders/positions exist —
      //    we surface but still attempt the order).
      try {
        await updatePerpsLeverage(symbol, lev, 2);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        toast(`Leverage update skipped: ${m}`, { icon: 'ℹ️' });
      }
      // 2. Place market order
      await placeOrder(
        {
          symbol,
          side: direction === 'UP' ? 1 : 2,  // 1=BUY, 2=SELL
          type: 2,                            // 2=MARKET
          quantity: qtyBtc.toString(),
        },
        'perps',
      );
      // 3. Record the new open position
      setOpenPosition({
        symbol,
        side: direction === 'UP' ? 'LONG' : 'SHORT',
        quantity: qtyBtc,
        notionalUsdt: usdtNum,
        entryPrice: price,
        leverage: lev,
        openedAt: Date.now(),
      });
      toast.success(
        `${direction === 'UP' ? 'LONG' : 'SHORT'} ${qtyBtc} ${symbol} @ ${lev}x (${usdtNum} USDT)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Auto-trade failed: ${msg}`);
    }
  }, [setOpenPosition]);

  const runPredictionCycle = useCallback(async () => {
    if (!isRunningRef.current) return;
    setIsAnalyzing(true);
    // Bump the cycle counter at the top of every run so the warmup gate
    // and the UI banner share a single source of truth.
    cycleCountRef.current += 1;
    setCycleCount(cycleCountRef.current);
    setStatusMsg('Collecting signals…');

    try {
      const price = btcPriceRef.current;

      // 1. Klines → technical indicators
      setStatusMsg('Fetching 1-min candles…');
      let klines: Kline[] = [];
      try {
        const raw = await fetchKlines(btcSymbolRef.current, '1m', KLINES_LIMIT, 'perps');
        klines = (raw as Record<string, unknown>[]).map((k) => ({
          close:  Number(k.close  ?? k.c ?? 0),
          volume: Number(k.volume ?? k.v ?? 0),
          high:   k.high != null || k.h != null ? Number(k.high ?? k.h) : undefined,
          low:    k.low  != null || k.l != null ? Number(k.low  ?? k.l) : undefined,
        }));
      } catch { /* proceed with empty */ }
      klinesRef.current = klines;   // share with fallback functions
      const tech = computeIndicators(klines);
      // Feed ATR back into the adaptive threshold for the NEXT cycle.
      if (Number.isFinite(tech.atrPct)) setLastAtrPct(tech.atrPct);

      // 2. Order book — REST fetch
      let imb = 0.5;
      try {
        const ob = await fetchOrderbook(btcSymbolRef.current, 'perps', 20);
        const bids = (ob.bids ?? []) as [string, string][];
        const asks = (ob.asks ?? []) as [string, string][];
        const bidVol = bids.slice(0, 10).reduce((s, [, v]) => s + parseFloat(v), 0);
        const askVol = asks.slice(0, 10).reduce((s, [, v]) => s + parseFloat(v), 0);
        const tot = bidVol + askVol;
        if (tot > 0) imb = bidVol / tot;
      } catch { /* keep default 0.5 */ }
      // Dynamic calibration: z-score imbalance against rolling history.
      // Fall back to fixed 0.35 / 0.65 cuts until we have >= 5 samples.
      const obHistory = obImbalanceHistoryRef.current;
      obHistory.push(imb);
      if (obHistory.length > ORDERBOOK_HISTORY) obHistory.shift();
      let obSignal = 0;
      let obZ = 0;
      if (obHistory.length >= 5) {
        const mean = obHistory.reduce((a, b) => a + b, 0) / obHistory.length;
        const variance = obHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / obHistory.length;
        const std = Math.sqrt(variance);
        obZ = std > 1e-6 ? (imb - mean) / std : 0;
        obSignal = Math.max(-1, Math.min(1, obZ / 2));
      } else {
        if (imb >= 0.65) obSignal = 1;
        else if (imb <= 0.35) obSignal = -1;
      }

      // 3. Funding rate — REST fetch
      let frRate = 0;
      try {
        const rates = await fetchFundingRates() as Record<string, unknown>[];
        const sym = btcSymbolRef.current.toUpperCase();
        // Prefer exact symbol match; only fall back to "contains BTC" when
        // no exact hit is found, otherwise we might grab ETHBTC or similar.
        const exactRow = rates.find((r) =>
          String(r.symbol ?? r.s ?? r.symbolName ?? '').toUpperCase() === sym,
        );
        const row = exactRow ?? rates.find((r) => {
          const s = String(r.symbol ?? '').toUpperCase();
          return s.startsWith('BTC') && (s.includes('USD') || s.includes('USDC'));
        });
        if (row) {
          const raw = row.fundingRate ?? row.funding_rate ?? row.fr ?? row.rate ?? row.f;
          frRate = raw !== undefined ? parseFloat(String(raw)) : 0;
        } else {
          console.warn('[BtcPredictor] No funding rate row matched symbol', sym, '— got', rates.length, 'rows');
        }
      } catch (err) {
        console.warn('[BtcPredictor] fetchFundingRates failed:', err);
      }
      // Absolute-rate signal (contrarian: positive funding = longs paying,
      // expect mean-reverting pullback). Scaled so ±0.005% → saturate ±1;
      // BTC perp funding typically sits in the 0.003–0.01% range so the
      // previous 0.01% scale produced near-zero signals in normal markets.
      const prevFr = prevFundingRef.current;
      const frSignal = Math.max(-1, Math.min(1, -frRate / 0.00005));
      // Momentum signal — change in funding between cycles. Rising funding
      // often precedes a squeeze in the OPPOSITE direction to the crowd.
      let fundingMomentum = 0;
      let fundingMomentumSignal = 0;
      if (prevFr !== 0 && frRate !== 0) {
        fundingMomentum = frRate - prevFr;
        fundingMomentumSignal = Math.max(-1, Math.min(1, -fundingMomentum / 0.00003));
      }
      prevFundingRef.current = frRate !== 0 ? frRate : prevFr;

      // 4. News + ETF + Treasury (cache-first, shared with other pages)
      setStatusMsg('Checking SoSoValue signals…');
      const [newsResult, etfResult, treasuryResult] = await Promise.allSettled([
        fetchNewsSentiment(),
        fetchEtfSignal(),
        fetchTreasurySignal(),
      ]);
      const news = newsResult.status === 'fulfilled' ? newsResult.value : { score: newsFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
      const etf  = etfResult.status === 'fulfilled'  ? etfResult.value  : { score: etfFallbackScore(),  fromFallback: true, fetchedAt: Date.now() };
      const treasury = treasuryResult.status === 'fulfilled' ? treasuryResult.value : { signal: 0, netBtc: 0, topBuyer: null, fromFallback: true, fetchedAt: Date.now() };

      // 5. Weighted score — full 12-signal ensemble (incl. treasury flow).
      const score =
        tech.microstructureSignal * W.microstructure +
        tech.rocSignal            * W.roc            +
        tech.emaSignal            * W.ema            +
        tech.macdSignal           * W.macd           +
        tech.rsiSignal            * W.rsi            +
        obSignal                  * W.orderBook      +
        news.score                * W.news           +
        etf.score                 * W.etf            +
        tech.vwapSignal           * W.vwap           +
        frSignal                  * W.fundingRate    +
        fundingMomentumSignal     * W.fundingMomentum +
        treasury.signal           * W.treasury;

      const threshold = neutralThresholdRef.current;
      // Realistic max — empirical ceiling for the score when signals are
      // only partially aligned, even in a strong regime.
      const realisticMax = 0.60;
      const confidence = Math.min(100, Math.round((Math.abs(score) / realisticMax) * 100));

      let direction: PredictionDirection =
        score >  threshold ? 'UP'  :
        score < -threshold ? 'DOWN' : 'NEUTRAL';

      // Count how many signals agree with the proposed direction. Uses the
      // full 12-signal vector so conviction reflects real consensus.
      const signalValues = [
        tech.microstructureSignal, tech.rocSignal, tech.emaSignal, tech.macdSignal, tech.rsiSignal,
        obSignal, news.score, etf.score, tech.vwapSignal, frSignal, fundingMomentumSignal,
        treasury.signal,
      ];
      // When the proposed direction is NEUTRAL we still want a "what's
      // the bias?" agreement count for the UI, so count along the sign
      // of the raw score rather than zeroing out.
      const dirSign = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : Math.sign(score);
      const nonNeutral = signalValues.filter((v) => Math.abs(v) > 0.05);
      const agreeing   = nonNeutral.filter((v) => Math.sign(v) === dirSign);
      const agreementCount = agreeing.length;
      const totalSignals = nonNeutral.length;

      // Score-margin filter — once the score clears the threshold, demand
      // it clear it by SCORE_MARGIN_MULT (e.g. 30%) before firing. This
      // strips out the "barely-over" noise band where realised moves are
      // statistically indistinguishable from the round-trip fee. The
      // threshold itself is already volatility-adaptive, so we only need
      // a fixed multiplicative margin on top.
      let marginalScoreFailed = false;
      if (direction !== 'NEUTRAL' && Math.abs(score) < threshold * SCORE_MARGIN_MULT) {
        direction = 'NEUTRAL';
        marginalScoreFailed = true;
      }

      // Conviction filter — even if the weighted score clears the
      // threshold, refuse to trade unless enough independent signals
      // agree. Saves against one large-weight outlier overpowering the
      // ensemble and opening a losing trade.
      const minConviction = minConvictionRef.current;
      let convictionFailed = false;
      if (direction !== 'NEUTRAL' && agreeing.length < minConviction) {
        direction = 'NEUTRAL';
        convictionFailed = true;
      }

      // Warmup gate — first WARMUP_CYCLES cycles are observation-only so
      // the orderbook z-score, ATR baseline, and funding-momentum
      // history have actual data to compare against. Without this, the
      // first several trades fire blind and feed the accuracy circuit
      // breaker garbage that takes another 5+ trades to undo.
      const inWarmup = cycleCountRef.current <= WARMUP_CYCLES;
      if (inWarmup) {
        direction = 'NEUTRAL';
      }

      const neutralReason: 'weak_score' | 'marginal_score' | 'low_conviction' | 'warmup' | null =
        direction === 'NEUTRAL'
          ? (inWarmup ? 'warmup'
            : convictionFailed ? 'low_conviction'
            : marginalScoreFailed ? 'marginal_score'
            : 'weak_score')
          : null;

      // Debug log — always on so the user can open devtools (F12 →
      // Console) and see exactly why each cycle went NEUTRAL or fired.
      // Strips to a single line per cycle.
      console.log(
        `[Predictor] score=${score.toFixed(3)} `
        + `threshold=±${threshold.toFixed(2)} `
        + `(margin ${SCORE_MARGIN_MULT}× = ±${(threshold * SCORE_MARGIN_MULT).toFixed(3)}) `
        + `agreeing=${agreeing.length}/${nonNeutral.length} `
        + `(min ${minConviction}) `
        + `atr=${tech.atrPct.toFixed(2)}% `
        + `→ ${direction}`
        + (marginalScoreFailed ? ' [marginal score]' : '')
        + (convictionFailed ? ' [conviction fail]' : ''),
        {
          microstructure: +tech.microstructureSignal.toFixed(2),
          roc:            +tech.rocSignal.toFixed(2),
          ema:            +tech.emaSignal.toFixed(2),
          macd:           +tech.macdSignal.toFixed(2),
          rsi:            +tech.rsiSignal.toFixed(2),
          orderbook:      +obSignal.toFixed(2),
          news:           +news.score.toFixed(2),
          etf:            +etf.score.toFixed(2),
          vwap:           +tech.vwapSignal.toFixed(2),
          fundingRate:    +frSignal.toFixed(2),
          fundingMom:     +fundingMomentumSignal.toFixed(2),
          treasury:       +treasury.signal.toFixed(2),
        },
      );

      const signals: SignalSnapshot = {
        newsSentiment: news.score,
        etfFlow: etf.score,
        newsLastFetched: news.fetchedAt,
        etfLastFetched: etf.fetchedAt,
        newsFallback: !!(news as { fromFallback?: boolean }).fromFallback,
        etfFallback:  !!(etf  as { fromFallback?: boolean }).fromFallback,
        orderBookImbalance: imb,
        orderBookSignal: obSignal,
        orderBookZScore: obZ,
        fundingRate: frRate,
        fundingRateSignal: frSignal,
        fundingMomentum,
        fundingMomentumSignal,
        microstructureSignal: tech.microstructureSignal,
        volumeSpike: tech.volumeSpike,
        rsi: tech.rsi,
        rsiSignal: tech.rsiSignal,
        emaSignal: tech.emaSignal,
        macdSignal: tech.macdSignal,
        vwapDeviation: tech.vwapDeviation,
        vwapSignal: tech.vwapSignal,
        rocSignal: tech.rocSignal,
        atrPct: tech.atrPct,
        treasuryNetBtc: treasury.netBtc,
        treasurySignal: treasury.signal,
        treasuryTopBuyer: treasury.topBuyer ?? undefined,
        treasuryFallback: !!(treasury as { fromFallback?: boolean }).fromFallback,
        weightedScore: score,
        agreementCount,
        totalSignals,
        neutralReason,
      };

      setCurrentPrediction(direction, confidence, signals, price);

      // 6. Store as history entry
      const id = `pred_${Date.now()}`;
      const entry: PredictionEntry = {
        id,
        timestamp: Date.now(),
        direction,
        confidence,
        entryPrice: price,
        exitPrice: null,
        result: direction === 'NEUTRAL' ? 'SKIPPED' : 'PENDING',
        pricePct: null,
        signals,
      };
      addHistoryEntry(entry);
      setPendingEntryId(direction !== 'NEUTRAL' ? id : null);

      setStatusMsg(
        direction === 'NEUTRAL'
          ? (inWarmup
              ? `Warming up (${cycleCountRef.current}/${WARMUP_CYCLES}) — observing markets while indicators calibrate`
              : convictionFailed
                ? `Score ${score.toFixed(3)} cleared ±${threshold.toFixed(2)} but only ${agreeing.length}/${minConviction} signals agreed — NEUTRAL, skipped`
                : `Score ${score.toFixed(3)} within ±${threshold.toFixed(2)} threshold — NEUTRAL, skipped`)
          : `↑ ${direction} predicted (score ${score.toFixed(3)}, ${agreementCount}/${totalSignals} signals agree) — resolving in 5 min…`,
      );

      // 6.5. Auto-trade: manage open position based on the new prediction
      if (autoTradeEnabledRef.current) {
        const pos = openPositionRef.current;
        const desiredSide: 'LONG' | 'SHORT' | null =
          direction === 'UP'   ? 'LONG'  :
          direction === 'DOWN' ? 'SHORT' : null;

        if (direction === 'NEUTRAL') {
          // Only close on neutral if user opted in
          if (pos && closeOnNeutralRef.current) {
            void closePredictorPosition('neutral prediction');
          }
        } else if (!pos) {
          // No position open — open one matching the prediction
          void placePredictorOrder(direction);
        } else if (pos.side !== desiredSide) {
          // Direction flipped — close then re-open in the new direction
          void (async () => {
            const closed = await closePredictorPosition(`${pos.side} → ${desiredSide}`);
            if (closed) await placePredictorOrder(direction);
          })();
        } else if (renewEveryCycleRef.current) {
          // Same direction, but user opted to renew every cycle (volume
          // farming for airdrop eligibility). Close the existing position
          // and re-open in the same direction to generate fresh volume.
          void (async () => {
            const closed = await closePredictorPosition(`renew ${pos.side} for volume`);
            if (closed) await placePredictorOrder(direction);
          })();
        }
        // else: same direction and renew disabled — keep the existing position
      }

      // 7. Schedule resolution after 5 minutes
      if (direction !== 'NEUTRAL') {
        if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
        resolveTimerRef.current = setTimeout(() => {
          const exitPrice = btcPriceRef.current;
          if (exitPrice <= 0) {
            toast('BTC price unavailable — prediction resolution skipped', { icon: '⚠️' });
            setPendingEntryId(null);
            return;
          }
          resolvePrediction(id, exitPrice);
          setPendingEntryId(null);
          setStatusMsg('Prediction resolved. Starting next cycle…');
        }, CYCLE_MS);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setStatusMsg(`Error: ${msg}`);
      toast.error(`Predictor error: ${msg}`);
    } finally {
      setIsAnalyzing(false);
    }

    // 8. Schedule next cycle
    if (isRunningRef.current) {
      if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = setTimeout(runPredictionCycle, CYCLE_MS);
    }
  }, [fetchNewsSentiment, fetchEtfSignal, fetchTreasurySignal, newsFallbackScore, etfFallbackScore, setCurrentPrediction, addHistoryEntry, resolvePrediction, placePredictorOrder, closePredictorPosition]);

  const handleStart = useCallback(() => {
    if (!sosoApiKey) {
      toast('SoSoValue key missing — running with klines-based fallbacks for news & ETF signals.', { icon: '⚠️' });
    }
    isRunningRef.current = true;
    setIsRunning(true);
    setStatusMsg('Starting first prediction cycle…');

    // Restore timers for any PENDING predictions (in case we stopped then restarted)
    const now = Date.now();
    const pending = history.filter((e) => e.result === 'PENDING' && e.entryPrice > 0);
    const currentPrice = btcPriceRef.current;
    if (currentPrice <= 0) {
      toast('BTC price unavailable — prediction timers will retry on next tick', { icon: '⚠️' });
    } else {
      for (const entry of pending) {
        const elapsed = now - entry.timestamp;
        if (elapsed >= CYCLE_MS) {
          // Already stale — resolve immediately
          resolvePrediction(entry.id, currentPrice);
        } else {
          // Still within window — restore timer
          const remaining = CYCLE_MS - elapsed;
          setTimeout(() => {
            const p = btcPriceRef.current;
            if (p > 0) resolvePrediction(entry.id, p);
            setPendingEntryId(null);
          }, remaining);
        }
      }
    }

    void runPredictionCycle();
  }, [sosoApiKey, runPredictionCycle, history, resolvePrediction]);

  const handleStop = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (cycleTimerRef.current)   clearTimeout(cycleTimerRef.current);
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
    // Reset warmup counter so the next Start re-warms instead of trading
    // immediately on stale calibration data.
    cycleCountRef.current = 0;
    setCycleCount(0);
    setStatusMsg('Stopped. Press Start to resume.');
  }, []);

  useEffect(() => () => {
    if (cycleTimerRef.current)   clearTimeout(cycleTimerRef.current);
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
  }, []);

  // ── Derived stats ──────────────────────────────────────────────────────
  const decided = history.filter((e) => e.result === 'CORRECT' || e.result === 'WRONG');
  const total     = correct + wrong;
  const accuracy  = total > 0 ? Math.round((correct / total) * 100) : null;

  const last10 = decided.slice(0, 10);
  const acc10  = last10.length > 0 ? Math.round(last10.filter((e) => e.result === 'CORRECT').length / last10.length * 100) : null;
  const acc20val = last20Decided.length > 0 ? Math.round(last20Decided.filter((e) => e.result === 'CORRECT').length / last20Decided.length * 100) : null;

  const sparkValues: (0 | 1)[] = last10
    .map((e) => (e.result === 'CORRECT' ? 1 : 0) as 0 | 1)
    .reverse();

  const signals = currentSignals;

  // ── Signal table rows ──────────────────────────────────────────────────────
  type SignalDef = {
    label: string; value: string; signal: number; weight: number;
    poweredBy?: boolean; isFallback?: boolean; fetchedAt?: number | null;
  };

  const signalRows: SignalDef[] = signals ? [
    // Sorted by weight, descending — highest-impact signals on top.
    {
      label: 'Price Microstructure',
      value: signals.microstructureSignal >= 0.5 ? 'HH/HL + Vol' : signals.microstructureSignal <= -0.5 ? 'LH/LL + Vol' : 'Mixed',
      signal: signals.microstructureSignal,
      weight: W.microstructure,
    },
    {
      label: 'ROC 5/15m Momentum',
      value: (signals.rocSignal ?? 0) >= 0.5 ? 'Strong up-drift'
           : (signals.rocSignal ?? 0) <= -0.5 ? 'Strong down-drift'
           : 'Drifting',
      signal: signals.rocSignal ?? 0,
      weight: W.roc,
    },
    {
      label: 'EMA 9/21 Cross',
      value: signals.emaSignal > 0 ? 'EMA9 > EMA21' : signals.emaSignal < 0 ? 'EMA9 < EMA21' : 'No cross',
      signal: signals.emaSignal,
      weight: W.ema,
    },
    {
      label: 'Order Book Imbalance',
      value: signals.orderBookZScore !== undefined
        ? `${(signals.orderBookImbalance * 100).toFixed(1)}% bids (z=${signals.orderBookZScore.toFixed(2)})`
        : `${(signals.orderBookImbalance * 100).toFixed(1)}% bids`,
      signal: signals.orderBookSignal,
      weight: W.orderBook,
    },
    {
      label: 'VWAP Deviation',
      value: (signals.vwapDeviation ?? 0) === 0
        ? 'At VWAP'
        : `${((signals.vwapDeviation ?? 0) * 100 >= 0 ? '+' : '')}${((signals.vwapDeviation ?? 0) * 100).toFixed(2)}%${Math.abs((signals.vwapDeviation ?? 0) * 100) > 0.15 ? ' — stretched' : ''}`,
      signal: signals.vwapSignal ?? 0,
      weight: W.vwap,
    },
    {
      label: 'News Sentiment',
      value: signals.newsSentiment >= 0.1 ? 'Bullish' : signals.newsSentiment <= -0.1 ? 'Bearish' : 'Neutral',
      signal: signals.newsSentiment,
      weight: W.news,
      poweredBy: !signals.newsFallback,
      isFallback: !!signals.newsFallback,
      fetchedAt: signals.newsFallback ? null : signals.newsLastFetched,
    },
    {
      label: 'BTC ETF Flow',
      value: signals.etfFlow >= 0 ? `+${(signals.etfFlow * 500).toFixed(0)}M` : `${(signals.etfFlow * 500).toFixed(0)}M`,
      signal: signals.etfFlow,
      weight: W.etf,
      poweredBy: !signals.etfFallback,
      isFallback: !!signals.etfFallback,
      fetchedAt: signals.etfFallback ? null : signals.etfLastFetched,
    },
    {
      label: 'Funding Momentum',
      value: (signals.fundingMomentum ?? 0) === 0
        ? 'Flat'
        : `${((signals.fundingMomentum ?? 0) * 100 >= 0 ? '+' : '')}${((signals.fundingMomentum ?? 0) * 100).toFixed(4)}% Δ`,
      signal: signals.fundingMomentumSignal ?? 0,
      weight: W.fundingMomentum,
    },
    {
      label: 'MACD Zero Cross',
      value: signals.macdSignal === 1 ? 'Crossed above 0' : signals.macdSignal === -1 ? 'Crossed below 0' : 'No cross',
      signal: signals.macdSignal,
      weight: W.macd,
    },
    {
      label: 'Funding Rate (Contrarian)',
      value: signals.fundingRate !== 0 ? `${(signals.fundingRate * 100).toFixed(4)}%` : 'N/A',
      signal: signals.fundingRateSignal,
      weight: W.fundingRate,
    },
    {
      label: 'RSI (14) Extreme',
      value: `${signals.rsi.toFixed(1)}${signals.rsi < 30 ? ' — Oversold' : signals.rsi > 70 ? ' — Overbought' : ' — Neutral zone'}`,
      signal: signals.rsiSignal,
      weight: W.rsi,
    },
    {
      label: 'Institutional Treasury (30d)',
      value: signals.treasuryNetBtc != null && signals.treasuryNetBtc !== 0
        ? `+${Math.round(signals.treasuryNetBtc).toLocaleString()} BTC${signals.treasuryTopBuyer ? ` (${signals.treasuryTopBuyer} lead)` : ''}`
        : 'No recent buys',
      signal: signals.treasurySignal ?? 0,
      weight: W.treasury,
      poweredBy: !signals.treasuryFallback,
      isFallback: !!signals.treasuryFallback,
    },
  ] : [];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6 max-w-screen-xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-primary flex items-center justify-center shadow-[0_0_20px_rgba(139,92,246,0.4)]">
            <Brain size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text-primary">BTC Price Predictor</h1>
            <p className="text-xs text-text-muted">AI + Technical signals → 5-min direction prediction</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {btcPrice > 0 && (
            <div className="px-4 py-2 rounded-xl bg-surface border border-border">
              <span className="text-xs text-text-muted mr-2">BTC</span>
              <span className="text-sm font-bold text-text-primary font-mono">
                ${btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          {isRunning ? (
            <Button variant="danger" size="sm" onClick={handleStop} icon={<Activity size={14} />}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={handleStart} icon={<Zap size={14} />} disabled={isAnalyzing}>
              Start Predictor
            </Button>
          )}
          <Button
            variant="ghost" size="sm"
            onClick={resetStats}
            icon={<RefreshCw size={14} />}
            disabled={isRunning}
          >
            Reset
          </Button>
        </div>
      </div>

      {/* ── Price bar — always visible ── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-3 rounded-xl bg-surface border border-border">
          <span className="text-[10px] text-text-muted uppercase tracking-widest">Entry Price</span>
          <span className="text-lg font-bold font-mono text-text-primary">
            {entryPrice && entryPrice > 0
              ? `$${entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—'}
          </span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-3 rounded-xl bg-surface border border-primary/30 shadow-[0_0_12px_rgba(0,225,255,0.08)]">
          <span className="text-[10px] text-text-muted uppercase tracking-widest">Live BTC</span>
          <span className="text-lg font-bold font-mono text-primary">
            {btcPrice > 0
              ? `$${btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : <span className="text-text-muted text-sm">Connecting…</span>}
          </span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-3 rounded-xl bg-surface border border-border">
          <span className="text-[10px] text-text-muted uppercase tracking-widest">Δ Since Entry</span>
          {entryPrice && entryPrice > 0 && btcPrice > 0 ? (() => {
            const pct = ((btcPrice - entryPrice) / entryPrice) * 100;
            return (
              <span className={cn(
                'text-lg font-bold font-mono',
                pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-text-muted',
              )}>
                {pct >= 0 ? '+' : ''}{pct.toFixed(3)}%
              </span>
            );
          })() : <span className="text-lg font-bold font-mono text-text-muted">—</span>}
        </div>
      </div>

      {/* Bot PnL strip — live performance widget shared across pages */}
      <BotPnlStrip botKey="predictor" />

      {/* Status bar */}
      <div className={cn(
        'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm border',
        isAnalyzing
          ? 'bg-violet-500/10 border-violet-500/30 text-violet-300'
          : isRunning
            ? 'bg-primary/10 border-primary/30 text-primary'
            : 'bg-surface border-border text-text-muted',
      )}>
        {isAnalyzing
          ? <RefreshCw size={14} className="animate-spin shrink-0" />
          : isRunning
            ? <Activity size={14} className="shrink-0 animate-pulse" />
            : <AlertTriangle size={14} className="shrink-0" />}
        <span>{statusMsg}</span>
        {!sosoApiKey && (
          <span className="ml-auto text-amber-400 text-xs flex items-center gap-1">
            <AlertTriangle size={12} /> SoSoValue API key missing in Settings
          </span>
        )}
      </div>

      {/* ── Auto-Trade settings (collapsed by default) ── */}
      <Card className="p-4">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-[200px]">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <Wallet size={16} className="text-amber-400" />
            </div>
            <div>
              <div className="text-sm font-bold text-text-primary">Auto-Trade</div>
              <div className="text-[10px] text-text-muted">
                {autoTradeEnabled
                  ? `Closes & re-opens on direction change${closeOnNeutral ? ' • closes on NEUTRAL' : ''}`
                  : 'Open a position with the prediction (close on flip)'}
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-auto">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={autoTradeEnabled}
                onChange={(e) => setAutoTradeEnabled(e.target.checked)}
                disabled={isRunning}
              />
              <div className="w-9 h-5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-white/30 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500/80" />
            </label>
          </div>

          {autoTradeEnabled && (
            <>
              <div className="flex flex-col gap-1 min-w-[160px]">
                <label className="text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-between">
                  <span>Amount (USDT)</span>
                  {btcPrice > 0 && parseFloat(tradeAmountUsdt) > 0 && (
                    <span className="font-mono text-text-muted">
                      ≈ {(parseFloat(tradeAmountUsdt) / btcPrice).toFixed(4)} BTC
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={tradeAmountUsdt}
                  onChange={(e) => setTradeAmountUsdt(e.target.value)}
                  disabled={isRunning}
                  className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
                  placeholder="100"
                />
              </div>

              <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
                <label className="text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-between">
                  <span>Leverage</span>
                  <span className="font-mono text-amber-400">{tradeLeverage}x</span>
                </label>
                <input
                  type="range"
                  min={1}
                  max={25}
                  step={1}
                  value={tradeLeverage}
                  onChange={(e) => setTradeLeverage(parseInt(e.target.value, 10))}
                  disabled={isRunning}
                  className="accent-amber-500 disabled:opacity-50"
                />
                <div className="flex justify-between text-[9px] text-text-muted font-mono">
                  <span>1x</span><span>25x (SoDEX max)</span>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={closeOnNeutral}
                  onChange={(e) => setCloseOnNeutral(e.target.checked)}
                  disabled={isRunning}
                  className="accent-amber-500"
                />
                <span>Close on NEUTRAL</span>
              </label>

              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer" title="Every 5-min cycle, close and re-open the position even if direction is unchanged. Doubles taker fees but generates 2x volume — useful for airdrop eligibility.">
                <input
                  type="checkbox"
                  checked={renewEveryCycle}
                  onChange={(e) => setRenewEveryCycle(e.target.checked)}
                  disabled={isRunning}
                  className="accent-amber-500"
                />
                <span>Renew position every cycle <span className="text-text-muted">(volume farming)</span></span>
              </label>

              {/* ── ATR-scaled intracycle stop-loss ──
                  Closes the open position the moment unrealised PnL drops
                  below `−slAtrMult × ATR%`. Adapts to volatility regime
                  automatically: tighter in calm markets, wider in active
                  ones. Defends against the failure mode where a single
                  full-cycle adverse move erases multiple winning trades. */}
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer" title="When unrealised PnL drops below −(multiplier × ATR%), the bot force-closes the position before the 5-min cycle ends. Caps tail-risk losses without affecting normal exits.">
                <input
                  type="checkbox"
                  checked={stopLossEnabled}
                  onChange={(e) => setStopLossEnabled(e.target.checked)}
                  disabled={isRunning}
                  className="accent-amber-500"
                />
                <span>
                  ATR stop-loss
                  {stopLossEnabled && lastAtrPct > 0 && (
                    <span className="text-text-muted ml-1 font-mono">
                      ≈ −{(lastAtrPct * slAtrMult).toFixed(2)}%
                    </span>
                  )}
                </span>
              </label>

              {stopLossEnabled && (
                <div className="flex flex-col gap-1 pl-6">
                  <label className="text-[10px] text-text-muted uppercase tracking-wider flex items-center justify-between">
                    <span>Stop multiplier</span>
                    <span className="font-mono text-amber-400">{slAtrMult.toFixed(1)}× ATR</span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.1}
                    value={slAtrMult}
                    onChange={(e) => setSlAtrMult(parseFloat(e.target.value))}
                    className="accent-amber-500"
                  />
                  <div className="flex justify-between text-[9px] text-text-muted font-mono">
                    <span>0.5× (tight)</span>
                    <span>3× (wide)</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {autoTradeEnabled && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[11px] text-amber-300/90">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>
              <strong>Live trading.</strong> UP → market BUY (long), DOWN → market SELL (short).
              When the prediction flips, the bot closes the existing position with a reduce-only order before opening the new one.
              Leverage is applied via <code>updateLeverage</code> per order.
            </span>
          </div>
        )}
      </Card>

      {/* ── Bot-managed open position panel ── */}
      {openPosition && (
        <Card className={cn(
          'p-4 border-2',
          openPosition.side === 'LONG'
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-red-500/40 bg-red-500/5',
        )}>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className={cn(
                'w-10 h-10 rounded-xl flex items-center justify-center',
                openPosition.side === 'LONG' ? 'bg-emerald-500/20' : 'bg-red-500/20',
              )}>
                {openPosition.side === 'LONG'
                  ? <TrendingUp size={20} className="text-emerald-400" />
                  : <TrendingDown size={20} className="text-red-400" />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-sm font-bold',
                    openPosition.side === 'LONG' ? 'text-emerald-400' : 'text-red-400',
                  )}>
                    {openPosition.side}
                  </span>
                  <span className="text-text-primary font-mono font-semibold">
                    {openPosition.quantity.toFixed(4)} {openPosition.symbol}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">
                    {openPosition.leverage}x
                  </span>
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  Opened {new Date(openPosition.openedAt).toLocaleTimeString()} • entry ${openPosition.entryPrice.toFixed(2)} • notional {openPosition.notionalUsdt} USDT
                  {stopLossEnabled && lastAtrPct > 0 && (() => {
                    // Surface the absolute SL price + how far the live mid
                    // is from it, so the user can read tail-risk at a glance
                    // instead of having to compute ATR × multiplier in their
                    // head every tick.
                    const slPctDist = lastAtrPct * slAtrMult;
                    const dir = openPosition.side === 'LONG' ? 1 : -1;
                    const slPrice = openPosition.entryPrice * (1 - (slPctDist / 100) * dir);
                    return (
                      <span className="text-amber-400/80">
                        {' '}• SL ${slPrice.toFixed(2)} (−{slPctDist.toFixed(2)}%)
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {btcPrice > 0 && (() => {
                const dir = openPosition.side === 'LONG' ? 1 : -1;
                const pnlUsdt = (btcPrice - openPosition.entryPrice) * openPosition.quantity * dir;
                const pnlPct  = ((btcPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100 * dir;
                const positive = pnlUsdt >= 0;
                // Distance to SL as a fraction of total SL distance — used
                // to colour the badge red as the position approaches stop.
                const slPctDist = stopLossEnabled && lastAtrPct > 0 ? lastAtrPct * slAtrMult : 0;
                const slProximity = slPctDist > 0 && pnlPct < 0
                  ? Math.min(1, Math.abs(pnlPct) / slPctDist)
                  : 0;
                return (
                  <div className="flex flex-col items-end">
                    <span className={cn(
                      'text-lg font-bold font-mono',
                      positive ? 'text-emerald-400' : 'text-red-400',
                    )}>
                      {positive ? '+' : ''}{pnlUsdt.toFixed(2)} USDT
                    </span>
                    <span className={cn(
                      'text-[10px] font-mono',
                      positive ? 'text-emerald-400/70' : 'text-red-400/70',
                    )}>
                      {positive ? '+' : ''}{pnlPct.toFixed(3)}%
                      {slProximity > 0.5 && (
                        <span className="ml-1.5 text-amber-400">
                          • {(slProximity * 100).toFixed(0)}% to SL
                        </span>
                      )}
                    </span>
                  </div>
                );
              })()}
              <Button
                variant="danger"
                size="sm"
                onClick={() => void closePredictorPosition('manual close')}
              >
                Close Position
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Main layout: 2/3 left + 1/3 right */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ── LEFT: Prediction Card + Signal Table ── */}
        <div className="lg:col-span-2 flex flex-col gap-6">

          {/* Big Prediction Card */}
          <Card className="p-6">
            <div className="flex items-center justify-between flex-wrap gap-6">

              {/* Direction */}
              <div className="flex flex-col items-center gap-3">
                <div className={cn(
                  'w-32 h-32 rounded-2xl flex flex-col items-center justify-center gap-1 border-2 transition-all duration-500',
                  currentPrediction === 'UP'
                    ? 'bg-emerald-500/15 border-emerald-400 shadow-[0_0_40px_rgba(52,211,153,0.25)]'
                    : currentPrediction === 'DOWN'
                      ? 'bg-red-500/15 border-red-400 shadow-[0_0_40px_rgba(248,113,113,0.25)]'
                      : 'bg-white/5 border-white/15',
                )}>
                  {currentPrediction === 'UP'   && <TrendingUp  size={40} className="text-emerald-400" />}
                  {currentPrediction === 'DOWN' && <TrendingDown size={40} className="text-red-400" />}
                  {currentPrediction === 'NEUTRAL' && <Minus size={40} className="text-text-muted" />}
                  <div className="flex flex-col items-center gap-1">
                    <span className={cn(
                      'text-2xl font-black tracking-wider',
                      currentPrediction === 'UP' ? 'text-emerald-400' :
                      currentPrediction === 'DOWN' ? 'text-red-400' : 'text-text-muted',
                    )}>
                      {currentPrediction === 'UP' ? '↑ UP' : currentPrediction === 'DOWN' ? '↓ DOWN' : '— NEUTRAL'}
                    </span>
                    {currentPrediction === 'NEUTRAL' && signals?.neutralReason && (
                      <span
                        className={cn(
                          'text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full border',
                          signals.neutralReason === 'weak_score'
                            ? 'bg-white/5 text-text-muted border-white/10'
                            : 'bg-amber-400/10 text-amber-400 border-amber-400/30',
                        )}
                        title={(() => {
                          const absScore = Math.abs(signals.weightedScore).toFixed(3);
                          const thr = neutralThreshold.toFixed(2);
                          const marginThr = (neutralThreshold * SCORE_MARGIN_MULT).toFixed(3);
                          switch (signals.neutralReason) {
                            case 'weak_score':
                              return `|score| ${absScore} did not clear ±${thr}`;
                            case 'marginal_score':
                              return `|score| ${absScore} cleared ±${thr} but is below the ${SCORE_MARGIN_MULT}× safety margin (±${marginThr})`;
                            case 'low_conviction':
                              return `Score cleared threshold but only ${signals.agreementCount}/${minConvictionFloor} signals agreed`;
                            case 'warmup':
                              return 'Warmup cycle — observation only';
                            default:
                              return '';
                          }
                        })()}
                      >
                        {signals.neutralReason === 'weak_score' ? 'Weak score'
                         : signals.neutralReason === 'marginal_score' ? 'Marginal score'
                         : signals.neutralReason === 'warmup' ? 'Warmup'
                         : 'Low conviction'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-text-muted mb-1">Confidence</div>
                  <div className="flex items-center gap-2">
                    <div className="w-32 h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-700',
                          currentPrediction === 'UP' ? 'bg-emerald-400' :
                          currentPrediction === 'DOWN' ? 'bg-red-400' : 'bg-white/30',
                        )}
                        style={{ width: `${currentConfidence}%` }}
                      />
                    </div>
                    <span className="text-sm font-bold text-text-primary">{currentConfidence}%</span>
                  </div>
                </div>
              </div>

              {/* Countdown */}
              <CountdownTimer cycleStartTime={cycleStartTime} />

              {/* Score gauge */}
              <div className="flex flex-col items-center gap-3">
                <div className="flex flex-col items-center gap-1">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Weighted Score</div>
                  <div className={cn(
                    'text-4xl font-black font-mono',
                    (signals?.weightedScore ?? 0) > 0 ? 'text-emerald-400' :
                    (signals?.weightedScore ?? 0) < 0 ? 'text-red-400' : 'text-text-muted',
                  )}>
                    {signals ? `${signals.weightedScore >= 0 ? '+' : ''}${signals.weightedScore.toFixed(3)}` : '—'}
                  </div>
                  <div className="text-[10px] text-text-muted" title="Volatility-adaptive. Widens when ATR is low or recent accuracy drops below 45%.">
                    threshold ±{neutralThreshold.toFixed(2)}
                    {signals && ` · ATR ${signals.atrPct?.toFixed(2) ?? '?'}%`}
                    {signals && ` · ${signals.agreementCount}/${signals.totalSignals} agree (min ${minConvictionFloor})`}
                  </div>
                </div>
                {signals && (
                  <div className="flex items-center gap-3 text-[11px] text-text-muted">
                    <span className="flex items-center gap-1">
                      <Newspaper size={10} className="text-amber-400" /> {signals.newsLastFetched ? new Date(signals.newsLastFetched).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'}
                    </span>
                    <span className="flex items-center gap-1">
                      <BarChart3 size={10} className="text-amber-400" /> {signals.etfLastFetched ? new Date(signals.etfLastFetched).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'}
                    </span>
                  </div>
                )}
              </div>

            </div>
          </Card>

          {/* ── Transparent Reasoning Panel ──
              Surfaces every signal as a horizontal bar (length = |contribution|,
              colour = direction) plus a plain-English narrative. Designed to
              answer the "why this prediction?" question at a glance. */}
          {signals && signalRows.length > 0 && (() => {
            const verdictTone =
              currentPrediction === 'UP' ? 'text-emerald-400' :
              currentPrediction === 'DOWN' ? 'text-red-400' : 'text-text-muted';
            const verdictBg =
              currentPrediction === 'UP' ? 'bg-emerald-500/10 border-emerald-500/30' :
              currentPrediction === 'DOWN' ? 'bg-red-500/10 border-red-500/30' :
              'bg-white/5 border-white/15';

            const sortedRows = [...signalRows].sort(
              (a, b) => Math.abs(b.signal * b.weight) - Math.abs(a.signal * a.weight),
            );
            const maxAbs = Math.max(0.001, ...sortedRows.map((r) => Math.abs(r.signal * r.weight)));

            const reasoningPhrase = (signal: number, value: string): string => {
              const dir = signal > 0.05 ? 'Bullish' : signal < -0.05 ? 'Bearish' : 'Neutral';
              return `${value} → ${dir}`;
            };

            return (
              <Card className="p-0 overflow-hidden">
                <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Brain size={16} className="text-violet-400" />
                    <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">Why this prediction?</h2>
                  </div>
                  <div className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold',
                    verdictBg,
                  )}>
                    <span className="text-text-muted">Result:</span>
                    <span className={cn('font-mono', verdictTone)}>
                      {currentConfidence}%
                      {' '}
                      {currentPrediction === 'UP' ? 'UP' : currentPrediction === 'DOWN' ? 'DOWN' : 'NEUTRAL'}
                    </span>
                  </div>
                </div>

                <div className="p-5 flex flex-col gap-2.5">
                  {sortedRows.map((row) => {
                    const contribution = row.signal * row.weight;
                    const positive = contribution >= 0;
                    const fillPct = (Math.abs(contribution) / maxAbs) * 100;
                    return (
                      <div key={row.label} className="flex items-center gap-3">
                        <span className="text-[11px] text-text-secondary w-44 shrink-0 truncate" title={row.label}>
                          {row.label}
                        </span>
                        {/* Centered bar gauge: left half = bearish, right half = bullish */}
                        <div className="flex-1 h-5 relative bg-white/[0.02] border border-white/5 rounded-md overflow-hidden">
                          <div className="absolute inset-y-0 left-1/2 w-[1px] bg-white/15" />
                          {positive ? (
                            <div
                              className="absolute inset-y-0 left-1/2 bg-gradient-to-r from-emerald-500/30 to-emerald-400/80 rounded-r-md transition-[width] duration-500"
                              style={{ width: `${fillPct / 2}%` }}
                            />
                          ) : (
                            <div
                              className="absolute inset-y-0 right-1/2 bg-gradient-to-l from-red-500/30 to-red-400/80 rounded-l-md transition-[width] duration-500"
                              style={{ width: `${fillPct / 2}%` }}
                            />
                          )}
                          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-text-muted font-mono pointer-events-none">
                            <span className="truncate px-2">
                              {reasoningPhrase(row.signal, row.value)}
                              <span className="ml-1 opacity-60">· w {row.weight.toFixed(2)}</span>
                            </span>
                          </div>
                        </div>
                        <span className={cn(
                          'text-xs font-mono font-bold w-16 text-right shrink-0',
                          positive && contribution > 0.005 ? 'text-emerald-400' :
                          !positive && contribution < -0.005 ? 'text-red-400' :
                          'text-text-muted',
                        )}>
                          {contribution >= 0 ? '+' : ''}{contribution.toFixed(3)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="px-5 py-3 border-t border-white/5 flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-2 bg-emerald-400/80 rounded-sm" /> Right of centre = bullish push
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-2 bg-red-400/80 rounded-sm" /> Left of centre = bearish pull
                  </span>
                  <span className="ml-auto">
                    Bar length ∝ <span className="text-text-secondary font-semibold">|signal × weight|</span>
                  </span>
                </div>
              </Card>
            );
          })()}

          {/* Signal Breakdown Table */}
          <Card className="p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2">
              <Activity size={16} className="text-primary" />
              <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">Signal Breakdown</h2>
            </div>
            {signalRows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/5 text-[11px] text-text-muted uppercase tracking-wider">
                      <th className="px-6 py-3 text-left font-semibold">Indicator</th>
                      <th className="px-4 py-3 text-left font-semibold">Value</th>
                      <th className="px-4 py-3 text-left font-semibold">Direction</th>
                      <th className="px-4 py-3 text-right font-semibold">Weight</th>
                      <th className="px-6 py-3 text-right font-semibold">Contribution</th>
                    </tr>
                  </thead>
                  <tbody className="px-2">
                    {signalRows.map((row) => (
                      <tr key={row.label} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-text-primary font-medium">{row.label}</span>
                            {row.poweredBy && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold tracking-wide border border-amber-500/20">
                                SoSoValue
                              </span>
                            )}
                            {row.isFallback && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400 font-semibold tracking-wide border border-slate-500/20" title="SoSoValue API unavailable — using klines-derived fallback">
                                Fallback
                              </span>
                            )}
                          </div>
                          {row.fetchedAt && (
                            <div className="text-[10px] text-text-muted mt-0.5">
                              Updated {new Date(row.fetchedAt).toLocaleTimeString()}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm text-text-secondary font-mono">{row.value}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn(
                            'text-xs font-semibold px-2 py-0.5 rounded-full',
                            row.signal > 0.05 ? 'bg-emerald-400/15 text-emerald-400' :
                            row.signal < -0.05 ? 'bg-red-400/15 text-red-400' :
                            'bg-white/10 text-text-muted',
                          )}>
                            {row.signal > 0.05 ? '↑ Bull' : row.signal < -0.05 ? '↓ Bear' : '— Neutral'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-xs text-text-muted">{(row.weight * 100).toFixed(0)}%</span>
                        </td>
                        <td className="px-6 py-3 text-right">
                          <span className={cn(
                            'text-sm font-mono font-semibold',
                            row.signal * row.weight > 0 ? 'text-emerald-400' :
                            row.signal * row.weight < 0 ? 'text-red-400' : 'text-text-muted',
                          )}>
                            {(row.signal * row.weight) >= 0 ? '+' : ''}{(row.signal * row.weight).toFixed(3)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-6 py-12 text-center text-text-muted text-sm">
                <Brain size={32} className="mx-auto mb-3 opacity-30" />
                Start the predictor to see signal breakdown
              </div>
            )}
            {/* Data source note */}
            <div className="px-6 py-3 border-t border-white/5 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-[10px] text-text-muted">Data sources:</span>
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400" />
                <span className="text-blue-400 font-semibold">SoDEX</span>
                &nbsp;— Order Book (z-score), Funding (rate + momentum), Klines (EMA · RSI · MACD · Microstructure · ROC · VWAP · ATR)
              </span>
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-amber-400 font-semibold">SoSoValue</span>
                &nbsp;— BTC ETF Flow, News Sentiment
              </span>
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-300" />
                <span className="text-yellow-300 font-semibold">Binance</span>
                &nbsp;— Live BTC price feed
              </span>
            </div>
          </Card>
        </div>

        {/* ── RIGHT: Accuracy + History ── */}
        <div className="flex flex-col gap-6">

          {/* Accuracy Tracker */}
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target size={16} className="text-primary" />
                <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">Accuracy Tracker</h2>
              </div>
              {(() => {
                // Surface why the bot may be staying NEUTRAL: ATR-driven
                // "market too quiet" wins over the generic wide-threshold
                // badge because it's the more actionable explanation.
                const atr = signals?.atrPct;
                if (typeof atr === 'number' && atr < 0.10) {
                  return (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-sky-400/15 text-sky-300 border border-sky-400/25 font-semibold"
                      title={`Realized 5-min volatility (ATR) is only ${atr.toFixed(2)}%. Round-trip fee ≈ 0.08%, so the bot will skip most trades until volatility picks up.`}
                    >
                      Market too quiet
                    </span>
                  );
                }
                if (accuracyBelow45) {
                  return (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-400 border border-amber-400/20 font-semibold"
                      title="Recent accuracy < 45% — demanding stronger consensus before trading again"
                    >
                      Auto-wide threshold
                    </span>
                  );
                }
                if (neutralThreshold >= 0.14) {
                  return (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/15 font-semibold"
                      title="Low volatility — wider neutral threshold to keep fees from eating profits"
                    >
                      Low-vol guard
                    </span>
                  );
                }
                return null;
              })()}
            </div>
            <div className="p-5 flex flex-col gap-4">
              {/* Warmup banner — visible while the engine is observation-only.
                  Hidden once the warmup gate releases (cycleCount > WARMUP_CYCLES). */}
              {isRunning && cycleCount > 0 && cycleCount <= WARMUP_CYCLES && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-200 text-[11px]">
                  <RefreshCw size={12} className="animate-spin shrink-0" />
                  <span>
                    <strong>Warming up — cycle {cycleCount}/{WARMUP_CYCLES}.</strong>
                    {' '}Indicators are being calibrated; predictions stay NEUTRAL until the engine has enough data to be confident.
                  </span>
                </div>
              )}
              {/* Small-sample-size advisory — accuracy below ~20 trades is
                  statistical noise. Displayed until enough decided trades
                  exist to draw a real conclusion. */}
              {total > 0 && total < 20 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px]">
                  <AlertTriangle size={12} className="shrink-0" />
                  <span>
                    <strong>Small sample.</strong>
                    {' '}{total} decided trade{total === 1 ? '' : 's'} — at least <span className="font-mono">20</span> are needed before the win-rate is statistically meaningful. Treat the headline number as directional, not a verdict.
                  </span>
                </div>
              )}
              {/* Big accuracy % */}
              <div className="text-center py-2">
                <div className={cn(
                  'text-5xl font-black font-mono mb-1',
                  accuracy === null ? 'text-text-muted' :
                  accuracy >= 60 ? 'text-emerald-400' :
                  accuracy >= 45 ? 'text-amber-400' : 'text-red-400',
                )}>
                  {accuracy !== null ? `${accuracy}%` : '—'}
                </div>
                <div className="text-xs text-text-muted">All-time ({total} predictions)</div>
                {total > 0 && (
                  <div className="w-full h-2 rounded-full bg-white/10 mt-3 overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-700',
                        (accuracy ?? 0) >= 60 ? 'bg-emerald-400' :
                        (accuracy ?? 0) >= 45 ? 'bg-amber-400' : 'bg-red-400',
                      )}
                      style={{ width: `${accuracy ?? 0}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Rolling accuracy rows */}
              <div className="flex flex-col gap-2">
                {[
                  { label: 'Last 10', val: acc10,   n: last10.length },
                  { label: 'Last 20', val: acc20val, n: last20Decided.length },
                  { label: 'All-time', val: accuracy, n: total },
                ].map(({ label, val, n }) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-[11px] text-text-muted w-16 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-700',
                          (val ?? 0) >= 60 ? 'bg-emerald-400' :
                          (val ?? 0) >= 45 ? 'bg-amber-400' : 'bg-red-400/60',
                        )}
                        style={{ width: `${val ?? 0}%` }}
                      />
                    </div>
                    <span className={cn(
                      'text-xs font-bold font-mono w-10 text-right shrink-0',
                      val === null ? 'text-text-muted' :
                      val >= 60 ? 'text-emerald-400' : val >= 45 ? 'text-amber-400' : 'text-red-400',
                    )}>
                      {val !== null && n >= 3 ? `${val}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>

              {/* Counters */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { icon: '✅', label: 'Correct', value: correct, color: 'text-emerald-400' },
                  { icon: '❌', label: 'Wrong',   value: wrong,   color: 'text-red-400' },
                  { icon: '⏭',  label: 'Skipped', value: skipped, color: 'text-text-muted' },
                ].map(({ icon, label, value, color }) => (
                  <div key={label} className="bg-white/[0.03] rounded-xl p-3 text-center border border-white/5">
                    <div className="text-lg">{icon}</div>
                    <div className={cn('text-xl font-bold font-mono', color)}>{value}</div>
                    <div className="text-[10px] text-text-muted mt-0.5">{label}</div>
                  </div>
                ))}
              </div>

              {/* Net PnL panel — fee-aware performance. Treats every non-
                  NEUTRAL prediction as a hypothetical 1x-leverage round-trip
                  and subtracts 2x taker fees so the number reflects what an
                  always-on bot would have actually earned (or lost). */}
              {(() => {
                const netStats = computeNetPerformance(history);
                if (netStats.tradesCount === 0) return null;
                const totalClr = netStats.totalNetPct >= 0 ? 'text-emerald-400' : 'text-red-400';
                const avgClr   = netStats.avgNetPct   >= 0 ? 'text-emerald-400' : 'text-red-400';
                return (
                  <div className="bg-white/[0.02] rounded-xl p-3 border border-white/5 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">Net PnL (after fees, 1x lev.)</span>
                      <span className="text-[10px] text-text-muted" title="Fee used: 0.04% taker × 2 (entry+exit)">{netStats.tradesCount} trades</span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className={cn('text-2xl font-black font-mono', totalClr)}>
                        {netStats.totalNetPct >= 0 ? '+' : ''}{netStats.totalNetPct.toFixed(2)}%
                      </span>
                      <span className="text-[11px] text-text-muted">cumulative</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[10px]">
                      <div className="flex flex-col">
                        <span className="text-text-muted">Avg / trade</span>
                        <span className={cn('font-mono font-bold', avgClr)}>
                          {netStats.avgNetPct >= 0 ? '+' : ''}{netStats.avgNetPct.toFixed(3)}%
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-text-muted">Best</span>
                        <span className="font-mono font-bold text-emerald-400">+{netStats.bestNetPct.toFixed(2)}%</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-text-muted">Worst</span>
                        <span className="font-mono font-bold text-red-400">{netStats.worstNetPct.toFixed(2)}%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-white/5 mt-1">
                      <span className="text-[10px] text-text-muted">Net win rate</span>
                      <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-700',
                            netStats.winRate >= 0.55 ? 'bg-emerald-400' :
                            netStats.winRate >= 0.45 ? 'bg-amber-400' : 'bg-red-400/70',
                          )}
                          style={{ width: `${Math.round(netStats.winRate * 100)}%` }}
                        />
                      </div>
                      <span className={cn(
                        'text-[10px] font-mono font-bold',
                        netStats.winRate >= 0.55 ? 'text-emerald-400' :
                        netStats.winRate >= 0.45 ? 'text-amber-400' : 'text-red-400',
                      )}>
                        {Math.round(netStats.winRate * 100)}%
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Sparkline trend */}
              {sparkValues.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[10px] text-text-muted uppercase tracking-wide">Last {sparkValues.length} results</div>
                  <Sparkline values={sparkValues} size={10} />
                </div>
              )}
            </div>
          </Card>

          {/* Last 10 predictions */}
          <Card className="p-0 overflow-hidden flex-1">
            <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
              <Clock size={16} className="text-primary" />
              <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">Prediction History</h2>
            </div>
            <div className="flex flex-col">
              {history.length === 0 ? (
                <div className="px-5 py-10 text-center text-text-muted text-sm">
                  <Clock size={28} className="mx-auto mb-2 opacity-30" />
                  No predictions yet
                </div>
              ) : (
                <>
                  {/* Column headers */}
                  <div className="flex items-center gap-3 px-3 py-2 text-[10px] text-text-muted uppercase tracking-wider border-b border-white/5">
                    <span className="w-14">Time</span>
                    <span className="w-16">Predict</span>
                    <span className="flex-1 text-center">Result</span>
                    <span className="w-14 text-right">Δ Price</span>
                  </div>
                  {history.slice(0, 10).map((entry, idx) => (
                    <HistoryRow key={entry.id} entry={entry} idx={idx} />
                  ))}
                </>
              )}
            </div>
          </Card>

        </div>
      </div>
    </div>
  );
};
