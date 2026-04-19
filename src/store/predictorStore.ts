import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PredictionDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type PredictionResult = 'CORRECT' | 'WRONG' | 'SKIPPED' | 'PENDING';

export interface SignalSnapshot {
  newsSentiment: number;    // -1 to +1
  etfFlow: number;          // -1 to +1
  rsi: number;              // raw RSI value
  rsiSignal: number;        // -1 to +1
  emaSignal: number;        // -1 to +1
  macdSignal: number;       // -1 to +1
  bollingerSignal: number;  // -1 to +1
  momentumSignal: number;   // -1 to +1
  weightedScore: number;    // final weighted sum
  newsLastFetched: number | null;
  etfLastFetched: number | null;
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

  // actions
  setCurrentPrediction: (d: PredictionDirection, conf: number, signals: SignalSnapshot, price: number) => void;
  resolvePrediction: (id: string, exitPrice: number) => void;
  addHistoryEntry: (entry: PredictionEntry) => void;
  resetStats: () => void;
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
        })),

      resetStats: () =>
        set({ history: [], correct: 0, wrong: 0, skipped: 0, currentPrediction: 'NEUTRAL', currentConfidence: 0, currentSignals: null, cycleStartTime: null, entryPrice: null }),
    }),
    {
      name: 'predictor-store-v1',
      partialize: (s) => ({
        history: s.history,
        correct: s.correct,
        wrong: s.wrong,
        skipped: s.skipped,
      }),
    },
  ),
);
