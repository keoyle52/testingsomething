import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Identifier for every bot variant the terminal can run. Kept narrow so
 * the dashboard widget can render a stable per-bot stat strip.
 */
export type BotKey = 'grid' | 'twap' | 'dca' | 'news' | 'predictor' | 'copy' | 'marketmaker';

export interface BotTrade {
  /** Always positive when winning, negative when losing. */
  pnlUsdt: number;
  ts: number;            // epoch ms when the trade resolved
  /** Free-text label (e.g. `"BTC-USD long closed at TP"`). */
  note?: string;
}

interface BotStats {
  /** Sum of pnlUsdt across all-time trades. */
  totalPnl: number;
  /** Sum of pnlUsdt for trades resolved in the last 24h. */
  todayPnl: number;
  /** Total trades counted (todayPnl + historical). */
  trades: number;
  /** Winning trades only (pnl > 0). */
  wins: number;
  /** Last 50 trades, newest first — feeds the inline mini-chart. */
  recent: BotTrade[];
  /** Last update epoch ms — used to refresh the 24h window lazily. */
  lastUpdated: number;
}

interface BotPnlStoreState {
  bots: Record<BotKey, BotStats>;
  /**
   * Append a resolved trade to a given bot. Updates totals, todayPnl,
   * win rate, and the recent-trades window. Idempotent on simple cases.
   */
  recordTrade: (bot: BotKey, trade: BotTrade) => void;
  /** Wipe all stats for one bot (used by Reset buttons). */
  resetBot: (bot: BotKey) => void;
  /** Wipe all bots — only used by tests / settings reset. */
  resetAll: () => void;
}

const emptyStats = (): BotStats => ({
  totalPnl: 0,
  todayPnl: 0,
  trades: 0,
  wins: 0,
  recent: [],
  lastUpdated: 0,
});

const initialBots: Record<BotKey, BotStats> = {
  grid: emptyStats(),
  twap: emptyStats(),
  dca: emptyStats(),
  news: emptyStats(),
  predictor: emptyStats(),
  copy: emptyStats(),
  marketmaker: emptyStats(),
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * Recompute `todayPnl` from the recent-trades window so a stale 24h sum
 * is corrected the next time stats are read or written. Pure function so
 * we can apply it both at write time and inside selectors if needed.
 */
function recomputeToday(stats: BotStats): BotStats {
  const cutoff = Date.now() - DAY_MS;
  const todayTrades = stats.recent.filter((t) => t.ts >= cutoff);
  const todayPnl = todayTrades.reduce((s, t) => s + t.pnlUsdt, 0);
  return { ...stats, todayPnl };
}

export const useBotPnlStore = create<BotPnlStoreState>()(
  persist(
    (set) => ({
      bots: initialBots,
      recordTrade: (bot, trade) =>
        set((state) => {
          const prev = state.bots[bot] ?? emptyStats();
          const recent = [trade, ...prev.recent].slice(0, 50);
          const win = trade.pnlUsdt > 0 ? 1 : 0;
          const next: BotStats = recomputeToday({
            totalPnl: prev.totalPnl + trade.pnlUsdt,
            todayPnl: prev.todayPnl + trade.pnlUsdt,    // recomputed below
            trades: prev.trades + 1,
            wins: prev.wins + win,
            recent,
            lastUpdated: Date.now(),
          });
          return { bots: { ...state.bots, [bot]: next } };
        }),
      resetBot: (bot) =>
        set((state) => ({
          bots: { ...state.bots, [bot]: emptyStats() },
        })),
      resetAll: () => set({ bots: initialBots }),
    }),
    {
      name: 'bot-pnl-store-v1',
      // Only persist the bots map — the action functions are reconstructed.
      partialize: (s) => ({ bots: s.bots }),
      // After rehydrating, recompute todayPnl per bot so a long absence
      // doesn't leave a stale 24h figure in the UI.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        for (const key of Object.keys(state.bots) as BotKey[]) {
          state.bots[key] = recomputeToday(state.bots[key]);
        }
      },
    },
  ),
);

/** Derived helper — win rate (0..1) for a single bot. */
export function getWinRate(stats: BotStats): number {
  if (stats.trades === 0) return 0;
  return stats.wins / stats.trades;
}

/**
 * Display-friendly label for each bot, used by the dashboard tracker.
 * Keep in sync with the BotKey union; defined as a const-asserted record
 * so the type-checker enforces exhaustiveness.
 */
export const BOT_LABELS: Record<BotKey, string> = {
  grid:        'Grid Bot',
  twap:        'TWAP Bot',
  dca:         'DCA Bot',
  news:        'News Bot',
  predictor:   'BTC Predictor',
  copy:        'Copy Trader',
  marketmaker: 'Market Maker',
};
