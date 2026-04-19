import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  Brain, TrendingUp, TrendingDown, Minus, RefreshCw,
  CheckCircle2, XCircle, SkipForward, Target, Clock,
  Activity, Newspaper, BarChart3, Zap, AlertTriangle,
} from 'lucide-react';
import { useLivePrice } from '../api/useLiveTicker';
import { fetchKlines } from '../api/services';
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
const CYCLE_MS = 5 * 60 * 1000;          // 5-minute prediction window
const NEWS_TTL_MS = 3 * 60 * 1000;       // 3-min cache for news
const ETF_TTL_MS = 5 * 60 * 1000;        // 5-min cache for ETF
const LS_NEWS_KEY = 'predictor_news_cache';
const LS_ETF_KEY  = 'predictor_etf_cache';
const KLINES_LIMIT = 30;                  // 30 x 1-min candles = enough for all indicators
const BTC_SYMBOL = 'BTC-USDC';

// ─── Weights ─────────────────────────────────────────────────────────────────
const WEIGHTS = {
  news:       0.25,
  etf:        0.20,
  rsi:        0.15,
  ema:        0.15,
  macd:       0.10,
  bollinger:  0.10,
  momentum:   0.05,
};

// ─── Technical Indicator Helpers ─────────────────────────────────────────────
function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

interface Indicators {
  rsi: number;
  rsiSignal: number;
  emaSignal: number;
  macdSignal: number;
  bollingerSignal: number;
  momentumSignal: number;
  volumeSpike: boolean;
}

function computeIndicators(klines: { close: number; volume: number }[]): Indicators {
  const closes = klines.map((k) => Number(k.close));
  const volumes = klines.map((k) => Number(k.volume));

  if (closes.length < 5) {
    return { rsi: 50, rsiSignal: 0, emaSignal: 0, macdSignal: 0, bollingerSignal: 0, momentumSignal: 0, volumeSpike: false };
  }

  // RSI
  const rsi = calcRSI(closes);
  let rsiSignal = 0;
  if (rsi < 30) rsiSignal = 1;
  else if (rsi > 70) rsiSignal = -1;
  else if (rsi >= 40 && rsi <= 60) rsiSignal = 0;
  else rsiSignal = rsi < 50 ? 0.3 : -0.3;

  // EMA crossover (9 vs 21)
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const last  = closes.length - 1;
  let emaSignal = 0;
  if (ema9[last] > ema21[last]) emaSignal = 1;
  else if (ema9[last] < ema21[last]) emaSignal = -1;

  // MACD (12, 26, 9)
  let macdSignal = 0;
  if (closes.length >= 26) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signal9  = calcEMA(macdLine, 9);
    const histNow  = macdLine[last] - signal9[last];
    const histPrev = last > 0 ? macdLine[last - 1] - signal9[last - 1] : 0;
    if (histNow > 0 && histNow > histPrev) macdSignal = 1;
    else if (histNow < 0 && histNow < histPrev) macdSignal = -1;
    else macdSignal = histNow > 0 ? 0.4 : -0.4;
  }

  // Bollinger Bands (20, 2)
  let bollingerSignal = 0;
  const bbPeriod = Math.min(20, closes.length);
  const slice = closes.slice(-bbPeriod);
  const mean = slice.reduce((a, b) => a + b, 0) / bbPeriod;
  const stdDev = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / bbPeriod);
  const upper = mean + 2 * stdDev;
  const lower = mean - 2 * stdDev;
  const lastClose = closes[last];
  if (lastClose >= upper) bollingerSignal = -1;
  else if (lastClose <= lower) bollingerSignal = 1;
  else {
    // relative position within band: 0=bottom, 1=top → map to -0.5..+0.5
    const pos = (lastClose - lower) / (upper - lower);
    bollingerSignal = (0.5 - pos);
  }

  // Momentum: last 3 candles HH/LL pattern
  let momentumSignal = 0;
  if (closes.length >= 4) {
    const c = closes.slice(-4);
    const allUp   = c[1] > c[0] && c[2] > c[1] && c[3] > c[2];
    const allDown = c[1] < c[0] && c[2] < c[1] && c[3] < c[2];
    if (allUp) momentumSignal = 1;
    else if (allDown) momentumSignal = -1;
    else momentumSignal = closes[last] > closes[last - 1] ? 0.3 : -0.3;
  }

  // Volume spike
  const recentVol = volumes[last] ?? 0;
  const avg10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / Math.min(10, volumes.length - 1);
  const volumeSpike = avg10 > 0 && recentVol > avg10 * 1.5;

  return { rsi, rsiSignal, emaSignal, macdSignal, bollingerSignal, momentumSignal, volumeSpike };
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
  const { sosoApiKey, geminiApiKey } = useSettingsStore();
  const btcPrice = useLivePrice(BTC_SYMBOL, 0);

  const {
    currentPrediction, currentConfidence, currentSignals,
    cycleStartTime, entryPrice,
    history, correct, wrong, skipped,
    setCurrentPrediction, resolvePrediction, addHistoryEntry, resetStats,
  } = usePredictorStore();

  const [isRunning, setIsRunning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Press Start to begin predictions');
  const [, setPendingEntryId] = useState<string | null>(null);

  const btcPriceRef      = useRef(btcPrice);
  const isRunningRef     = useRef(false);
  const cycleTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { btcPriceRef.current = btcPrice; }, [btcPrice]);

  // ── Fetch news sentiment via shared cache ──────────────────────────────────
  const fetchNewsSentiment = useCallback(async (): Promise<{ score: number; fetchedAt: number }> => {
    const cached = lsRead<{ score: number }>(LS_NEWS_KEY);
    if (cached && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
      return { score: cached.data.score, fetchedAt: cached.fetchedAt };
    }
    if (!sosoApiKey) return { score: 0, fetchedAt: Date.now() };

    try {
      const result = await fetchSosoNews(1, 10);
      const items  = result.list ?? [];
      if (items.length === 0) return { score: 0, fetchedAt: Date.now() };

      // Score with Gemini if available, else fallback to 0
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
      const score = count > 0 ? total / count : 0;
      lsWrite(LS_NEWS_KEY, { score });
      return { score, fetchedAt: Date.now() };
    } catch {
      return { score: 0, fetchedAt: Date.now() };
    }
  }, [sosoApiKey, geminiApiKey]);

  // ── Fetch ETF flow via shared cache ───────────────────────────────────────
  const fetchEtfSignal = useCallback(async (): Promise<{ score: number; fetchedAt: number }> => {
    const cached = lsRead<{ score: number }>(LS_ETF_KEY);
    if (cached && Date.now() - cached.fetchedAt < ETF_TTL_MS) {
      return { score: cached.data.score, fetchedAt: cached.fetchedAt };
    }
    if (!sosoApiKey) return { score: 0, fetchedAt: Date.now() };

    try {
      const metrics = await fetchEtfCurrentMetrics('us-btc-spot');
      const flow = metrics?.dailyNetInflow?.value ?? 0;
      // Normalise: ±$500M maps to ±1
      const score = Math.max(-1, Math.min(1, (flow ?? 0) / 5e8));
      lsWrite(LS_ETF_KEY, { score });
      return { score, fetchedAt: Date.now() };
    } catch {
      return { score: 0, fetchedAt: Date.now() };
    }
  }, [sosoApiKey]);

  // ── Run full prediction cycle ─────────────────────────────────────────────
  const runPredictionCycle = useCallback(async () => {
    if (!isRunningRef.current) return;
    setIsAnalyzing(true);
    setStatusMsg('Collecting signals…');

    try {
      const price = btcPriceRef.current;

      // 1. Fetch klines for technical indicators
      setStatusMsg('Fetching 1-min candles…');
      let klines: { close: number; volume: number }[] = [];
      try {
        const raw = await fetchKlines(BTC_SYMBOL, '1m', KLINES_LIMIT, 'perps');
        klines = (raw as Record<string, unknown>[]).map((k) => ({ close: Number(k.close ?? k.c ?? 0), volume: Number(k.volume ?? k.v ?? 0) }));
      } catch { /* proceed with empty */ }

      // 2. Technical indicators
      const tech = computeIndicators(klines);

      // 3. News + ETF (cache-first)
      setStatusMsg('Checking SoSoValue signals…');
      const [newsResult, etfResult] = await Promise.allSettled([
        fetchNewsSentiment(),
        fetchEtfSignal(),
      ]);
      const news = newsResult.status === 'fulfilled' ? newsResult.value : { score: 0, fetchedAt: Date.now() };
      const etf  = etfResult.status === 'fulfilled'  ? etfResult.value  : { score: 0, fetchedAt: Date.now() };

      // 4. Weighted score
      const score =
        news.score           * WEIGHTS.news      +
        etf.score            * WEIGHTS.etf       +
        tech.rsiSignal       * WEIGHTS.rsi       +
        tech.emaSignal       * WEIGHTS.ema       +
        tech.macdSignal      * WEIGHTS.macd      +
        tech.bollingerSignal * WEIGHTS.bollinger +
        tech.momentumSignal  * WEIGHTS.momentum;

      const direction: PredictionDirection =
        score >  0.1 ? 'UP' :
        score < -0.1 ? 'DOWN' : 'NEUTRAL';

      const confidence = Math.min(100, Math.round(Math.abs(score) * 100 / 0.5 * 100));

      const signals: SignalSnapshot = {
        newsSentiment: news.score,
        etfFlow: etf.score,
        rsi: tech.rsi,
        rsiSignal: tech.rsiSignal,
        emaSignal: tech.emaSignal,
        macdSignal: tech.macdSignal,
        bollingerSignal: tech.bollingerSignal,
        momentumSignal: tech.momentumSignal,
        weightedScore: score,
        newsLastFetched: news.fetchedAt,
        etfLastFetched: etf.fetchedAt,
      };

      setCurrentPrediction(direction, confidence, signals, price);

      // 5. Store as PENDING history entry
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
          ? 'Score too close to call — NEUTRAL, skipped'
          : `Prediction: ${direction} (score ${score.toFixed(3)}) — waiting 5 min…`,
      );

      // 6. Schedule resolution after 5 minutes
      if (direction !== 'NEUTRAL') {
        if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
        resolveTimerRef.current = setTimeout(() => {
          const exitPrice = btcPriceRef.current;
          resolvePrediction(id, exitPrice);
          setPendingEntryId(null);
          setStatusMsg('Last prediction resolved. Starting next cycle…');
        }, CYCLE_MS);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setStatusMsg(`Error: ${msg}`);
      toast.error(`Predictor error: ${msg}`);
    } finally {
      setIsAnalyzing(false);
    }

    // 7. Schedule next cycle
    if (isRunningRef.current) {
      if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
      cycleTimerRef.current = setTimeout(runPredictionCycle, CYCLE_MS);
    }
  }, [fetchNewsSentiment, fetchEtfSignal, setCurrentPrediction, addHistoryEntry, resolvePrediction]);

  const handleStart = useCallback(() => {
    if (!sosoApiKey) {
      toast.error('Set your SoSoValue API key in Settings first.');
      return;
    }
    isRunningRef.current = true;
    setIsRunning(true);
    setStatusMsg('Starting first prediction cycle…');
    void runPredictionCycle();
  }, [sosoApiKey, runPredictionCycle]);

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

  // ── Derived stats ──────────────────────────────────────────────────────────
  const total    = correct + wrong;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;

  const sparkValues: (0 | 1)[] = history
    .filter((e) => e.result === 'CORRECT' || e.result === 'WRONG')
    .slice(0, 10)
    .map((e) => (e.result === 'CORRECT' ? 1 : 0))
    .reverse();

  const signals = currentSignals;

  // ── Signal table rows ──────────────────────────────────────────────────────
  type SignalDef = {
    label: string;
    value: string;
    signal: number;
    weight: number;
    poweredBy?: boolean;
    fetchedAt?: number | null;
  };

  const signalRows: SignalDef[] = signals ? [
    {
      label: 'News Sentiment',
      value: signals.newsSentiment >= 0.1 ? 'Bullish' : signals.newsSentiment <= -0.1 ? 'Bearish' : 'Neutral',
      signal: signals.newsSentiment,
      weight: WEIGHTS.news,
      poweredBy: true,
      fetchedAt: signals.newsLastFetched,
    },
    {
      label: 'BTC ETF Flow',
      value: signals.etfFlow >= 0 ? `+${(signals.etfFlow * 500).toFixed(0)}M` : `${(signals.etfFlow * 500).toFixed(0)}M`,
      signal: signals.etfFlow,
      weight: WEIGHTS.etf,
      poweredBy: true,
      fetchedAt: signals.etfLastFetched,
    },
    {
      label: `RSI (14)`,
      value: signals.rsi.toFixed(1),
      signal: signals.rsiSignal,
      weight: WEIGHTS.rsi,
    },
    {
      label: 'EMA 9/21 Cross',
      value: signals.emaSignal > 0 ? 'EMA9 > EMA21' : signals.emaSignal < 0 ? 'EMA9 < EMA21' : 'No cross',
      signal: signals.emaSignal,
      weight: WEIGHTS.ema,
    },
    {
      label: 'MACD Histogram',
      value: signals.macdSignal > 0 ? 'Rising' : signals.macdSignal < 0 ? 'Falling' : 'Flat',
      signal: signals.macdSignal,
      weight: WEIGHTS.macd,
    },
    {
      label: 'Bollinger Bands',
      value: signals.bollingerSignal >= 0.8 ? 'Near lower' : signals.bollingerSignal <= -0.8 ? 'Near upper' : 'Mid-band',
      signal: signals.bollingerSignal,
      weight: WEIGHTS.bollinger,
    },
    {
      label: 'Price Momentum',
      value: signals.momentumSignal >= 0.8 ? 'HH pattern' : signals.momentumSignal <= -0.8 ? 'LL pattern' : 'Mixed',
      signal: signals.momentumSignal,
      weight: WEIGHTS.momentum,
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
          </Card>
        </div>

        {/* ── RIGHT: Accuracy + History ── */}
        <div className="flex flex-col gap-6">

          {/* Accuracy Tracker */}
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
              <Target size={16} className="text-primary" />
              <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">Accuracy Tracker</h2>
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
                <div className="text-xs text-text-muted">Overall Accuracy</div>
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
