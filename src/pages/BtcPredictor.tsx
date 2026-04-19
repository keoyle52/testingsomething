import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  Brain, TrendingUp, TrendingDown, Minus, RefreshCw,
  CheckCircle2, XCircle, SkipForward, Target, Clock,
  Activity, Newspaper, BarChart3, Zap, AlertTriangle, Wallet,
} from 'lucide-react';
import { fetchKlines, fetchTickers, fetchOrderbook, fetchFundingRates, placeOrder, updatePerpsLeverage } from '../api/services';
import { useLiveTicker, type LiveTicker } from '../api/useLiveTicker';
import { fetchSosoNews, fetchEtfCurrentMetrics, getNewsTitle } from '../api/sosoServices';
import { analyzeSentiment } from '../api/geminiClient';
import { useSettingsStore } from '../store/settingsStore';
import {
  usePredictorStore,
  type PredictionDirection,
  type SignalSnapshot,
  type PredictionEntry,
} from '../store/predictorStore';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';
import toast from 'react-hot-toast';

// ─── Constants ────────────────────────────────────────────────────────────────
const CYCLE_MS      = 5 * 60 * 1000;
const NEWS_TTL_MS   = 3 * 60 * 1000;
const ETF_TTL_MS    = 5 * 60 * 1000;
const LS_NEWS_KEY   = 'predictor_news_cache';
const LS_ETF_KEY    = 'predictor_etf_cache';
const KLINES_LIMIT  = 40;               // enough for EMA-21 + microstructure
const BTC_SYMBOL_HINT = 'BTC';        // substring match against fetchTickers result
const NEUTRAL_BASE  = 0.08;             // default neutral threshold (lowered so normal market produces signals)
const NEUTRAL_WIDE  = 0.14;             // self-correcting threshold when accuracy drops

// ─── Weights (must sum to 1.0) ────────────────────────────────────────────────
const W = {
  orderBook:      0.28,
  fundingRate:    0.18,
  news:           0.15,
  microstructure: 0.14,
  etf:            0.12,
  ema:            0.07,
  rsi:            0.04,
  macd:           0.02,
} as const;

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
}

function computeIndicators(klines: { close: number; volume: number }[]): TechResult {
  const closes  = klines.map((k) => Number(k.close));
  const volumes = klines.map((k) => Number(k.volume));
  const empty: TechResult = { rsi: 50, rsiSignal: 0, emaSignal: 0, macdSignal: 0, microstructureSignal: 0, volumeSpike: false };
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

  return { rsi, rsiSignal, emaSignal, macdSignal, microstructureSignal, volumeSpike };
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
  const [remaining, setRemaining] = useState(CYCLE_MS);

  useEffect(() => {
    if (!cycleStartTime) { setRemaining(CYCLE_MS); return; }
    const tick = () => {
      const elapsed = Date.now() - cycleStartTime;
      setRemaining(Math.max(0, CYCLE_MS - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cycleStartTime]);

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
    autoTradeEnabled, tradeAmountUsdt, tradeLeverage, closeOnNeutral,
    setAutoTradeEnabled, setTradeAmountUsdt, setTradeLeverage, setCloseOnNeutral,
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
  const klinesRef = useRef<{ close: number; volume: number }[]>([]);

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

  // ── Order book + funding via REST (fetched each cycle) ───────────────────
  const prevFundingRef = useRef(0);

  // ── Self-correcting neutral threshold ──────────────────────────────────
  const last20Decided = history.filter((e) => e.result === 'CORRECT' || e.result === 'WRONG').slice(0, 20);
  const acc20 = last20Decided.length >= 5
    ? last20Decided.filter((e) => e.result === 'CORRECT').length / last20Decided.length
    : null;
  const neutralThreshold = (acc20 !== null && acc20 < 0.45) ? NEUTRAL_WIDE : NEUTRAL_BASE;

  // ── Run full prediction cycle ───────────────────────────────────────────
  const neutralThresholdRef = useRef(neutralThreshold);
  useEffect(() => { neutralThresholdRef.current = neutralThreshold; }, [neutralThreshold]);

  // ── Trade-settings refs (so the cycle reads latest values reactively) ──
  const autoTradeEnabledRef = useRef(autoTradeEnabled);
  const tradeAmountUsdtRef  = useRef(tradeAmountUsdt);
  const tradeLeverageRef    = useRef(tradeLeverage);
  const closeOnNeutralRef   = useRef(closeOnNeutral);
  const openPositionRef     = useRef(openPosition);
  useEffect(() => { autoTradeEnabledRef.current = autoTradeEnabled; }, [autoTradeEnabled]);
  useEffect(() => { tradeAmountUsdtRef.current  = tradeAmountUsdt;  }, [tradeAmountUsdt]);
  useEffect(() => { tradeLeverageRef.current    = tradeLeverage;    }, [tradeLeverage]);
  useEffect(() => { closeOnNeutralRef.current   = closeOnNeutral;   }, [closeOnNeutral]);
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
    setStatusMsg('Collecting signals…');

    try {
      const price = btcPriceRef.current;

      // 1. Klines → technical indicators
      setStatusMsg('Fetching 1-min candles…');
      let klines: { close: number; volume: number }[] = [];
      try {
        const raw = await fetchKlines(btcSymbolRef.current, '1m', KLINES_LIMIT, 'perps');
        klines = (raw as Record<string, unknown>[]).map((k) => ({
          close: Number(k.close ?? k.c ?? 0),
          volume: Number(k.volume ?? k.v ?? 0),
        }));
      } catch { /* proceed with empty */ }
      klinesRef.current = klines;   // share with fallback functions
      const tech = computeIndicators(klines);

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
      let obSignal = 0;
      if (imb >= 0.65) obSignal = 1;
      else if (imb <= 0.35) obSignal = -1;

      // 3. Funding rate — REST fetch
      let frRate = 0;
      try {
        const rates = await fetchFundingRates() as Record<string, unknown>[];
        const sym = btcSymbolRef.current.toUpperCase();
        const row = rates.find((r) =>
          String(r.symbol ?? r.s ?? r.symbolName ?? '').toUpperCase() === sym ||
          String(r.symbol ?? '').toUpperCase().includes('BTC'),
        );
        if (row) {
          const raw = row.fundingRate ?? row.funding_rate ?? row.fr ?? row.rate ?? row.f;
          frRate = raw !== undefined ? parseFloat(String(raw)) : 0;
        }
      } catch { /* keep 0 */ }
      let frSignal = 0;
      const prevFr = prevFundingRef.current;
      if (frRate > 0.0001) frSignal = -1;
      else if (frRate < -0.0001) frSignal = 1;
      else if (prevFr !== 0) frSignal = frRate > prevFr ? -0.5 : frRate < prevFr ? 0.5 : 0;
      prevFundingRef.current = frRate !== 0 ? frRate : prevFr;

      // 4. News + ETF (cache-first, shared with other pages)
      setStatusMsg('Checking SoSoValue signals…');
      const [newsResult, etfResult] = await Promise.allSettled([
        fetchNewsSentiment(),
        fetchEtfSignal(),
      ]);
      const news = newsResult.status === 'fulfilled' ? newsResult.value : { score: newsFallbackScore(), fromFallback: true, fetchedAt: Date.now() };
      const etf  = etfResult.status === 'fulfilled'  ? etfResult.value  : { score: etfFallbackScore(),  fromFallback: true, fetchedAt: Date.now() };

      // 5. Weighted score
      const score =
        obSignal                   * W.orderBook      +
        frSignal                   * W.fundingRate    +
        news.score                 * W.news           +
        tech.microstructureSignal  * W.microstructure +
        etf.score                  * W.etf            +
        tech.emaSignal             * W.ema            +
        tech.rsiSignal             * W.rsi            +
        tech.macdSignal            * W.macd;

      const threshold = neutralThresholdRef.current;
      // Normalise against realistic max (weighted sum if all signals fire = 1.0,
      // but in practice max reachable is ~0.55 when funding is N/A)
      const realisticMax = 0.55;
      const confidence = Math.min(100, Math.round((Math.abs(score) / realisticMax) * 100));

      const direction: PredictionDirection =
        score >  threshold ? 'UP'  :
        score < -threshold ? 'DOWN' : 'NEUTRAL';

      // Count how many signals agree with the direction
      const signalValues = [obSignal, frSignal, news.score, tech.microstructureSignal,
                            etf.score, tech.emaSignal, tech.rsiSignal, tech.macdSignal];
      const dirSign = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
      const nonNeutral = signalValues.filter((v) => Math.abs(v) > 0.05);
      const agreeing   = nonNeutral.filter((v) => Math.sign(v) === dirSign);
      const agreementCount = direction === 'NEUTRAL' ? 0 : agreeing.length;
      const totalSignals   = nonNeutral.length;

      const signals: SignalSnapshot = {
        newsSentiment: news.score,
        etfFlow: etf.score,
        newsLastFetched: news.fetchedAt,
        etfLastFetched: etf.fetchedAt,
        newsFallback: !!(news as { fromFallback?: boolean }).fromFallback,
        etfFallback:  !!(etf  as { fromFallback?: boolean }).fromFallback,
        orderBookImbalance: imb,
        orderBookSignal: obSignal,
        fundingRate: frRate,
        fundingRateSignal: frSignal,
        microstructureSignal: tech.microstructureSignal,
        volumeSpike: tech.volumeSpike,
        rsi: tech.rsi,
        rsiSignal: tech.rsiSignal,
        emaSignal: tech.emaSignal,
        macdSignal: tech.macdSignal,
        weightedScore: score,
        agreementCount,
        totalSignals,
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
          ? `Score ${score.toFixed(3)} within ±${threshold} threshold — NEUTRAL, skipped`
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
        }
        // else: same direction — keep the existing position
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
  }, [fetchNewsSentiment, fetchEtfSignal, setCurrentPrediction, addHistoryEntry, resolvePrediction, placePredictorOrder, closePredictorPosition]);

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
    {
      label: 'Order Book Imbalance',
      value: `${(signals.orderBookImbalance * 100).toFixed(1)}% bids`,
      signal: signals.orderBookSignal,
      weight: W.orderBook,
    },
    {
      label: 'Funding Rate Momentum',
      value: signals.fundingRate !== 0 ? `${(signals.fundingRate * 100).toFixed(4)}%` : 'N/A',
      signal: signals.fundingRateSignal,
      weight: W.fundingRate,
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
      label: 'Price Microstructure',
      value: signals.microstructureSignal >= 0.5 ? 'HH/HL + Vol' : signals.microstructureSignal <= -0.5 ? 'LH/LL + Vol' : 'Mixed',
      signal: signals.microstructureSignal,
      weight: W.microstructure,
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
      label: 'EMA 9/21 Cross',
      value: signals.emaSignal > 0 ? 'EMA9 > EMA21' : signals.emaSignal < 0 ? 'EMA9 < EMA21' : 'No cross',
      signal: signals.emaSignal,
      weight: W.ema,
    },
    {
      label: 'RSI (14) Extreme',
      value: `${signals.rsi.toFixed(1)}${signals.rsi < 30 ? ' — Oversold' : signals.rsi > 70 ? ' — Overbought' : ' — Neutral zone'}`,
      signal: signals.rsiSignal,
      weight: W.rsi,
    },
    {
      label: 'MACD Zero Cross',
      value: signals.macdSignal === 1 ? 'Crossed above 0' : signals.macdSignal === -1 ? 'Crossed below 0' : 'No cross',
      signal: signals.macdSignal,
      weight: W.macd,
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
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {btcPrice > 0 && (() => {
                const dir = openPosition.side === 'LONG' ? 1 : -1;
                const pnlUsdt = (btcPrice - openPosition.entryPrice) * openPosition.quantity * dir;
                const pnlPct  = ((btcPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100 * dir;
                const positive = pnlUsdt >= 0;
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
                  <span className={cn(
                    'text-2xl font-black tracking-wider',
                    currentPrediction === 'UP' ? 'text-emerald-400' :
                    currentPrediction === 'DOWN' ? 'text-red-400' : 'text-text-muted',
                  )}>
                    {currentPrediction === 'UP' ? '↑ UP' : currentPrediction === 'DOWN' ? '↓ DOWN' : '— NEUTRAL'}
                  </span>
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
                  <div className="text-[10px] text-text-muted">threshold ±0.1</div>
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
                &nbsp;— Order Book, Funding Rate, Klines (EMA · RSI · MACD · Microstructure)
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
              {neutralThreshold > NEUTRAL_BASE && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-400 border border-amber-400/20 font-semibold">
                  Auto-wide threshold
                </span>
              )}
            </div>
            <div className="p-5 flex flex-col gap-4">
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
