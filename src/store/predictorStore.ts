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
  orderBookSignal: number;      // -1 / 0 / +1
  // Funding rate
  fundingRate: number;          // raw value
  fundingRateSignal: number;    // -1 / 0 / +1
  // Price microstructure
  microstructureSignal: number; // -1 to +1
  volumeSpike: boolean;
  // Technical
  rsi: number;
  rsiSignal: number;
  emaSignal: number;
  macdSignal: number;
  // Composite
  weightedScore: number;
  agreementCount: number;       // how many signals agree with direction
  totalSignals: number;         // total non-neutral signals counted
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
  setOpenPosition: (p: OpenPosition | null) => void;
}

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
      openPosition: null,

      setAutoTradeEnabled: (v) => set({ autoTradeEnabled: v }),
      setTradeAmountUsdt: (v) => set({ tradeAmountUsdt: v }),
      // SoDEX caps perps leverage at 25x — enforce here.
      setTradeLeverage: (v) => set({ tradeLeverage: Math.max(1, Math.min(25, v)) }),
      setCloseOnNeutral: (v) => set({ closeOnNeutral: v }),
      setRenewEveryCycle: (v) => set({ renewEveryCycle: v }),
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

        set((s) => ({
          history: s.history.map((e) =>
            e.id === id ? { ...e, exitPrice, pricePct: pct, result } : e,
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
