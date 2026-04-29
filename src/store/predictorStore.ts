import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PredictionDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type PredictionResult = 'CORRECT' | 'WRONG' | 'SKIPPED' | 'PENDING';

export interface SignalSnapshot {
  // SoSoValue signals
  newsSentiment: number;        // -1 to +1
  etfFlow: number;              // -1 to +1
  newsLastFetched: number | null;
  etfLastFetched: number | null;
  newsFallback?: boolean;           // true when SoSoValue news was unavailable
  etfFallback?: boolean;            // true when SoSoValue ETF was unavailable
  // Order book
  orderBookImbalance: number;   // raw ratio bid/(bid+ask)
  orderBookSignal: number;      // -1 to +1 (gradient, dynamic z-score based)
  orderBookZScore?: number;     // z-score of current imbalance vs recent history
  // Funding rate
  fundingRate: number;          // raw value
  fundingRateSignal: number;    // -1 to +1
  fundingMomentum?: number;     // change rate between cycles
  fundingMomentumSignal?: number; // -1 to +1
  // Price microstructure
  microstructureSignal: number; // -1 to +1
  volumeSpike: boolean;
  // Technical
  rsi: number;
  rsiSignal: number;
  emaSignal: number;
  macdSignal: number;
  // Multi-factor extensions
  vwapDeviation?: number;       // raw % deviation from VWAP
  vwapSignal?: number;          // -1 to +1 (mean-reversion)
  rocSignal?: number;           // rate-of-change signal, -1 to +1
  atrPct?: number;              // ATR as % of price (volatility regime)
  // 9th signal — institutional BTC treasury flow (last 30d)
  treasuryNetBtc?: number;      // raw BTC accumulated by treasury cos. in 30d
  treasurySignal?: number;      // -1 to +1, normalised
  treasuryTopBuyer?: string;    // ticker of biggest 30d buyer
  treasuryFallback?: boolean;   // true when SoSoValue treasury data unavailable
  // Composite
  weightedScore: number;
  agreementCount: number;       // how many signals agree with proposed direction (pre-conviction)
  totalSignals: number;         // total non-neutral signals counted
  /** Populated only when the cycle resolved to NEUTRAL; null otherwise.
   *  'weak_score'     — |weightedScore| did not clear the threshold
   *  'marginal_score' — cleared threshold but by less than the margin
   *                     multiplier required to overcome round-trip fee + noise
   *  'low_conviction' — score cleared threshold but too few signals agreed
   *  'warmup'         — observation-only cycle while the engine calibrates
   *                     adaptive components (first ~10 cycles after Start) */
  neutralReason?: 'weak_score' | 'marginal_score' | 'low_conviction' | 'warmup' | null;
}

export interface PredictionEntry {
  id: string;
  timestamp: number;
  direction: PredictionDirection;
  confidence: number;          // 0–100
  entryPrice: number;
  exitPrice: number | null;
  result: PredictionResult;
  pricePct: number | null;     // actual % change after 5 min
  /** Net % after entry+exit taker fees (leverage-free). Computed at
   *  resolution. Positive = would have been profitable at 1x leverage. */
  netPricePct?: number | null;
  /** Taker fee rate snapshot used for net PnL computation (e.g. 0.0004). */
  feeRateUsed?: number;
  signals: SignalSnapshot;
}

interface PredictorState {
  // current cycle
  currentPrediction: PredictionDirection;
  currentConfidence: number;
  currentSignals: SignalSnapshot | null;
  cycleStartTime: number | null;   // epoch ms when current 5-min window started
  entryPrice: number | null;

  // history (max 100)
  history: PredictionEntry[];

  // accuracy stats
  correct: number;
  wrong: number;
  skipped: number;

  // ── Trading settings (optional auto-order placement) ──
  /** When true, predictor places a market order on each non-neutral prediction. */
  autoTradeEnabled: boolean;
  /** Notional order size in USDT. Converted to BTC quantity at order time. */
  tradeAmountUsdt: string;
  /** Leverage applied before placing the order. SoDEX cap = 25x. */
  tradeLeverage: number;
  /** When true, on a NEUTRAL prediction the open position is also closed. */
  closeOnNeutral: boolean;
  /** When true, at the start of every new prediction cycle the existing
   *  position is closed and a fresh one is opened in the new direction —
   *  even if the direction is unchanged. Primary use-case: volume farming
   *  for airdrop eligibility. Costs 2x taker fees per cycle. */
  renewEveryCycle: boolean;
  /** When true, the predictor evaluates an ATR-scaled stop-loss on every
   *  live BTC tick and force-closes the position when the unrealised loss
   *  exceeds `slAtrMult × ATR%`. Defends against the tail-risk pattern
   *  where a single 5-minute cycle gives the position room to take a
   *  full-distance adverse move that erases multiple winning trades. */
  stopLossEnabled: boolean;
  /** Multiplier applied to the latest 1-min ATR(14)% to compute the
   *  intracycle stop-loss distance. 1.5 means "stop out at 1.5x normal
   *  volatility against me" — tight enough to cap tail risk, wide
   *  enough to avoid noise stop-outs in calm regimes. */
  slAtrMult: number;

  // ── Currently open bot-managed position ──
  openPosition: OpenPosition | null;

  // actions
  setCurrentPrediction: (d: PredictionDirection, conf: number, signals: SignalSnapshot, price: number) => void;
  resolvePrediction: (id: string, exitPrice: number) => void;
  addHistoryEntry: (entry: PredictionEntry) => void;
  resetStats: () => void;
  setAutoTradeEnabled: (v: boolean) => void;
  setTradeAmountUsdt: (v: string) => void;
  setTradeLeverage: (v: number) => void;
  setCloseOnNeutral: (v: boolean) => void;
  setRenewEveryCycle: (v: boolean) => void;
  setStopLossEnabled: (v: boolean) => void;
  setSlAtrMult: (v: number) => void;
  setOpenPosition: (p: OpenPosition | null) => void;
}

/**
 * Round-trip taker fee rate used to compute the net-PnL metric. SoDEX
 * Tier-1 perps taker = 0.04%. One cycle => entry + exit = 2x takerRate.
 * Kept as a constant here so the store has no dependency on services.ts.
 * Call sites may override by passing an explicit rate to resolvePrediction.
 */
export const DEFAULT_TAKER_FEE_RATE = 0.0004;

/**
 * Snapshot of the position the predictor opened. Tracks just enough
 * to display PnL in the UI and to send the matching reduce-only close.
 */
export interface OpenPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** BTC quantity sent to the exchange (notional / entryPrice). */
  quantity: number;
  /** USDT amount the user requested when opening. */
  notionalUsdt: number;
  entryPrice: number;
  leverage: number;
  openedAt: number;
}

export const usePredictorStore = create<PredictorState>()(
  persist(
    (set, get) => ({
      currentPrediction: 'NEUTRAL',
      currentConfidence: 0,
      currentSignals: null,
      cycleStartTime: null,
      entryPrice: null,
      history: [],
      correct: 0,
      wrong: 0,
      skipped: 0,

      // Trading defaults: disabled, conservative size + leverage
      autoTradeEnabled: false,
      tradeAmountUsdt: '100',
      tradeLeverage: 5,
      closeOnNeutral: false,
      renewEveryCycle: false,
      // Stop-loss defaults: ON at 1.5x ATR. Empirically calibrated against
      // a 5-trade live sample where a single −0.19% loss erased four
      // ~+0% wins; with ATR ~0.10–0.15% that translates to a stop
      // distance of ~0.15–0.22% which would have capped the worst trade
      // before it ran the full cycle.
      stopLossEnabled: true,
      slAtrMult: 1.5,
      openPosition: null,

      setAutoTradeEnabled: (v) => set({ autoTradeEnabled: v }),
      setTradeAmountUsdt: (v) => set({ tradeAmountUsdt: v }),
      // SoDEX caps perps leverage at 25x — enforce here.
      setTradeLeverage: (v) => set({ tradeLeverage: Math.max(1, Math.min(25, v)) }),
      setCloseOnNeutral: (v) => set({ closeOnNeutral: v }),
      setRenewEveryCycle: (v) => set({ renewEveryCycle: v }),
      setStopLossEnabled: (v) => set({ stopLossEnabled: v }),
      // Clamp to a sensible range so users can't disable the SL via 0
      // (use the toggle for that) or set absurdly wide values.
      setSlAtrMult: (v) => set({ slAtrMult: Math.max(0.5, Math.min(5, v)) }),
      setOpenPosition: (p) => set({ openPosition: p }),

      setCurrentPrediction: (direction, confidence, signals, price) =>
        set({
          currentPrediction: direction,
          currentConfidence: confidence,
          currentSignals: signals,
          cycleStartTime: Date.now(),
          entryPrice: price,
        }),

      resolvePrediction: (id, exitPrice) => {
        const state = get();
        const entry = state.history.find((e) => e.id === id);
        if (!entry || entry.result !== 'PENDING') return;
        if (entry.entryPrice <= 0) return;

        const pct = ((exitPrice - entry.entryPrice) / entry.entryPrice) * 100;
        let result: PredictionResult;
        if (entry.direction === 'NEUTRAL') {
          result = 'SKIPPED';
        } else if (entry.direction === 'UP') {
          result = pct > 0 ? 'CORRECT' : 'WRONG';
        } else {
          result = pct < 0 ? 'CORRECT' : 'WRONG';
        }

        // Compute net % after round-trip taker fees. Only meaningful for
        // non-neutral trades — NEUTRAL predictions place no orders.
        const feeRateUsed = DEFAULT_TAKER_FEE_RATE;
        const netPricePct = entry.direction === 'NEUTRAL'
          ? null
          : (entry.direction === 'UP' ? pct : -pct) - 2 * feeRateUsed * 100;

        set((s) => ({
          history: s.history.map((e) =>
            e.id === id
              ? { ...e, exitPrice, pricePct: pct, result, netPricePct, feeRateUsed }
              : e,
          ),
          correct: result === 'CORRECT' ? s.correct + 1 : s.correct,
          wrong:   result === 'WRONG'   ? s.wrong + 1   : s.wrong,
          skipped: result === 'SKIPPED' ? s.skipped + 1 : s.skipped,
        }));
      },

      addHistoryEntry: (entry) =>
        set((s) => ({
          history: [entry, ...s.history].slice(0, 100),
          skipped: entry.result === 'SKIPPED' ? s.skipped + 1 : s.skipped,
        })),

      resetStats: () =>
        set({ history: [], correct: 0, wrong: 0, skipped: 0, currentPrediction: 'NEUTRAL', currentConfidence: 0, currentSignals: null, cycleStartTime: null, entryPrice: null, openPosition: null }),
    }),
    {
      name: 'predictor-store-v2',
      partialize: (s) => ({
        history: s.history,
        correct: s.correct,
        wrong: s.wrong,
        skipped: s.skipped,
        autoTradeEnabled: s.autoTradeEnabled,
        tradeAmountUsdt: s.tradeAmountUsdt,
        tradeLeverage: s.tradeLeverage,
        closeOnNeutral: s.closeOnNeutral,
        renewEveryCycle: s.renewEveryCycle,
        openPosition: s.openPosition,
      }),
    },
  ),
);

/**
 * Derive aggregate net performance from the history window. Directional
 * sign is baked into `netPricePct` so simple summation is correct.
 */
export function computeNetPerformance(history: PredictionEntry[]): {
  tradesCount: number;
  totalNetPct: number;
  avgNetPct: number;
  winRate: number;
  bestNetPct: number;
  worstNetPct: number;
} {
  const resolved = history.filter(
    (e) => e.direction !== 'NEUTRAL'
        && (e.result === 'CORRECT' || e.result === 'WRONG')
        && typeof e.netPricePct === 'number',
  );
  if (resolved.length === 0) {
    return { tradesCount: 0, totalNetPct: 0, avgNetPct: 0, winRate: 0, bestNetPct: 0, worstNetPct: 0 };
  }
  let total = 0, best = -Infinity, worst = Infinity, wins = 0;
  for (const e of resolved) {
    const net = e.netPricePct as number;
    total += net;
    if (net > best)  best  = net;
    if (net < worst) worst = net;
    if (net > 0) wins += 1;
  }
  return {
    tradesCount: resolved.length,
    totalNetPct: total,
    avgNetPct: total / resolved.length,
    winRate: wins / resolved.length,
    bestNetPct: best,
    worstNetPct: worst,
  };
}
