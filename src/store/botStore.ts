import { create } from 'zustand';

/**
 * Professional-grade Grid Bot configuration. Mirrors the parameter
 * surface of the major centralised exchanges (Binance / Bybit / OKX),
 * including arithmetic vs geometric spacing, conditional trigger price,
 * grid-wide TP/SL, and leverage for perpetuals.
 */
interface GridBotState {
  // ── Core ──────────────────────────────────────────────────────
  symbol: string;
  lowerPrice: string;
  upperPrice: string;
  gridCount: string;
  amountPerGrid: string;
  isSpot: boolean;
  mode: 'NEUTRAL' | 'LONG' | 'SHORT';
  /** Arithmetic = constant price step; Geometric = constant percent step. */
  spacing: 'ARITHMETIC' | 'GEOMETRIC';
  /** Optional leverage (perps only). */
  leverage: string;
  // ── Conditional start ─────────────────────────────────────────
  /** When set, the bot waits until last price crosses this trigger
   *  before placing initial orders. Empty string = start immediately. */
  triggerPrice: string;
  triggerDirection: 'CROSS_DOWN' | 'CROSS_UP';
  // ── Stop conditions ───────────────────────────────────────────
  /** Stop the entire grid + cancel orders if price drops to this level. */
  stopLossPrice: string;
  /** Stop the entire grid + cancel orders if price rises to this level. */
  takeProfitPrice: string;
  /** Stop & close everything once realized PnL hits this absolute value. */
  trailingProfitUsd: string;
  // ── Status ────────────────────────────────────────────────────
  status: 'STOPPED' | 'RUNNING' | 'ARMED' | 'ERROR';
  activeOrders: number;
  totalInvestment: number;
  completedGrids: number;
  realizedPnl: number;
  setField: <K extends keyof GridBotState>(field: K, value: GridBotState[K]) => void;
  resetStats: () => void;
}

/**
 * Market Maker Bot — high-volume, low-fee farming bot.
 *
 * Designed to maximise traded volume per dollar of fee spent. The
 * mechanism:
 *  1. Posts paired buy + sell **limit orders** with `timeInForce: GTX`
 *     (post-only). The exchange REJECTS any side that would cross the
 *     spread, guaranteeing every fill is a MAKER fill — typically half
 *     the fee of a TAKER order on SoDEX.
 *  2. As the market wiggles, one side gets filled, leaving small
 *     inventory. The bot re-posts the opposite side at the new BBO
 *     to flatten and continue the cycle.
 *  3. Stale orders (price moved beyond `requoteBps`) are cancelled
 *     and re-quoted at the current BBO so we don't sit too far back
 *     from the queue and miss fills.
 *
 * Caps that protect the user:
 *  - `budgetUsdt`: collateral committed at any moment (open orders +
 *                  unhedged inventory).
 *  - `volumeTargetUsdt`: stops the bot when traded volume reaches this.
 *  - `feeBudgetUsdt`: stops the bot when estimated fees reach this.
 *
 * The bot is spot-only — perps would add inventory leverage tracking,
 * orthogonal complexity. SoDEX's airdrop volume metric reportedly
 * counts spot trades equally so spot is the right surface for farming.
 */
interface MarketMakerBotState {
  // ── Configuration ─────────────────────────────────────────────
  /** Spot trading pair, e.g. BTC_USDC. */
  symbol: string;
  /** Maximum capital (in USDT-equivalent) the bot may have committed
   *  to open orders + inventory at any moment. Hard ceiling. */
  budgetUsdt: string;
  /** USDT-equivalent notional per individual limit order. Each ladder
   *  layer uses this size. Smaller = smoother cycles, more orders. */
  orderSizeUsdt: string;
  /** Number of buy + sell layers to keep open simultaneously. 1 = pure
   *  ping-pong; 3 = small ladder. Keep low to avoid rate-limit pressure. */
  layers: string;
  /** Spread offset in basis points from BBO. 0 = join the queue at
   *  current bid/ask; 5 = step inside by 5 bps (fills slower but
   *  smaller adverse selection). */
  spreadBps: string;
  /** Re-quote when the BBO moves more than this many bps from our
   *  posted price. Lower = more cancel/replace cycles + more taker
   *  risk if not careful. Higher = stale-order risk. */
  requoteBps: string;
  /** Optional volume target (USDT). Bot auto-stops when reached.
   *  Empty string = no cap. */
  volumeTargetUsdt: string;
  /** Optional fee budget (USDT). Bot auto-stops when estimated cumul-
   *  ative maker fee reaches this. Empty string = no cap. */
  feeBudgetUsdt: string;
  /** SoDEX maker fee rate as a decimal (e.g. 0.0001 = 1bp). Used only
   *  for the fee estimator since the API doesn't reliably echo per-fill
   *  fee. Default 0.0001 (1bp) is a safe assumption for most makers. */
  makerFeeRate: string;

  // ── Live status ───────────────────────────────────────────────
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  /** Stats since the most recent Start press. */
  ordersPlaced: number;
  ordersFilled: number;
  ordersCancelled: number;
  /** Cumulative traded volume in USDT (sum of fill qty × fill price). */
  volumeUsdt: number;
  /** Estimated cumulative maker fee paid in USDT. */
  feesUsdt: number;
  /** Net inventory (in base asset units). Positive = long, negative = short. */
  inventoryBase: number;
  /** Wall-clock when the current run started. null = idle. */
  sessionStartedAt: number | null;

  // ── Setters ───────────────────────────────────────────────────
  setField: <K extends keyof MarketMakerBotState>(field: K, value: MarketMakerBotState[K]) => void;
  /**
   * Atomically add `delta` to a numeric field. This is the *only*
   * correct way to accumulate multiple increments from within the
   * same reconcile tick — `setField('x', mm.x + delta)` reads `mm.x`
   * from a stale closure and silently overwrites previous calls in
   * the same pass (e.g. three fills in one tick would only count as
   * one because the setter sees the same base value every time).
   */
  bumpField: (
    field: 'ordersPlaced' | 'ordersFilled' | 'ordersCancelled' | 'volumeUsdt' | 'feesUsdt' | 'inventoryBase',
    delta: number,
  ) => void;
  resetStats: () => void;
}

interface BotStoreState {
  gridBot: GridBotState;
  marketMakerBot: MarketMakerBotState;
}

export const useBotStore = create<BotStoreState>((set) => ({
  gridBot: {
    symbol: 'BTC_USDC',
    lowerPrice: '60000',
    upperPrice: '70000',
    gridCount: '10',
    amountPerGrid: '0.01',
    isSpot: true,
    mode: 'NEUTRAL',
    spacing: 'ARITHMETIC',
    leverage: '1',
    triggerPrice: '',
    triggerDirection: 'CROSS_UP',
    stopLossPrice: '',
    takeProfitPrice: '',
    trailingProfitUsd: '',
    status: 'STOPPED',
    activeOrders: 0,
    totalInvestment: 0,
    completedGrids: 0,
    realizedPnl: 0,
    setField: (field, value) =>
      set((state) => ({
        gridBot: { ...state.gridBot, [field]: value },
      })),
    resetStats: () =>
      set((state) => ({
        gridBot: {
          ...state.gridBot,
          activeOrders: 0,
          totalInvestment: 0,
          completedGrids: 0,
          realizedPnl: 0,
          status: 'STOPPED'
        },
      })),
  },
  // Defaults tuned for a quick-start, low-risk farming session on BTC.
  // 100 USDT budget × 10 USDT per order × 2 layers ≈ 4 active orders
  // worth 40 USDT. With ~1bp maker fee and ~0.05% per BTC tick, the
  // bot will turn over the budget many times per hour at fee cost
  // well under 0.1% of farmed volume.
  marketMakerBot: {
    symbol: 'BTC_USDC',
    budgetUsdt: '100',
    orderSizeUsdt: '10',
    layers: '2',
    spreadBps: '0',         // join the BBO
    requoteBps: '5',        // re-quote when 5bps off
    volumeTargetUsdt: '',
    feeBudgetUsdt: '',
    makerFeeRate: '0.0001', // 1bp default
    status: 'STOPPED',
    ordersPlaced: 0,
    ordersFilled: 0,
    ordersCancelled: 0,
    volumeUsdt: 0,
    feesUsdt: 0,
    inventoryBase: 0,
    sessionStartedAt: null,
    setField: (field, value) =>
      set((state) => ({
        marketMakerBot: { ...state.marketMakerBot, [field]: value },
      })),
    // Functional update — reads the *current* store value via `state`
    // rather than a closed-over snapshot, so repeated calls in the
    // same event loop accumulate correctly.
    bumpField: (field, delta) =>
      set((state) => ({
        marketMakerBot: {
          ...state.marketMakerBot,
          [field]: (state.marketMakerBot[field] as number) + delta,
        },
      })),
    resetStats: () =>
      set((state) => ({
        marketMakerBot: {
          ...state.marketMakerBot,
          status: 'STOPPED',
          ordersPlaced: 0,
          ordersFilled: 0,
          ordersCancelled: 0,
          volumeUsdt: 0,
          feesUsdt: 0,
          inventoryBase: 0,
          sessionStartedAt: null,
        },
      })),
  },
}));
