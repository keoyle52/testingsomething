/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ AI Auto-Configure                                                   │
 * │ One-click smart defaults for every trading bot.                     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * The challenge: bot configuration overwhelms beginners. Grid range,
 * geometric vs arithmetic spacing, ATR-aware TWAP slices, post-only
 * spread offsets — every parameter has a "right" value that depends on
 * current market conditions. A power user adjusts these by feel; a
 * beginner stares at the inputs and freezes.
 *
 * This module solves that with a single button: "AI Auto-Configure".
 * On click, the bot page calls `buildContext(symbol, market)` to fetch
 * a snapshot of the market, then asks one of the bot-specific
 * `recommend*` functions for a complete preset. The preset is then
 * applied to the form fields with `setField()`.
 *
 * Key design choices:
 *  1. **Pure rule-based**, no LLM. Reasoning is transparent (the user
 *     can see exactly which rule fired) and the call is instant — no
 *     network round-trip for the LLM. The LLM-powered AI Strategist
 *     elsewhere in the app handles the high-conviction "what should I
 *     trade *right now*" question; this module handles the lower-
 *     stakes "give me a sane starting point".
 *  2. **Conservative bias**. Auto-configure must never recommend
 *     dangerous defaults (e.g. 25x leverage, oversized position).
 *     Worst case the user gets a slightly under-tuned setup, never an
 *     unsafe one.
 *  3. **Budget-aware**. Where the user has already entered a budget,
 *     the recommender respects it; where they haven't, it suggests
 *     a small, safe figure (e.g. 100 USDT) rather than 0.
 *  4. **Single source of truth for ATR/range math**. Both this module
 *     and `aiOrchestrator.ts` need volatility classification — keep
 *     the formulas in sync to avoid jarring UX where the dashboard
 *     calls a market "calm" but auto-configure picks volatile presets.
 */

import { fetchKlines, fetchOrderbook } from './services';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Snapshot of market state used by the recommenders. Returned by
 *  `buildContext()`; can also be constructed manually for tests. */
export interface MarketContext {
  symbol: string;
  market: 'spot' | 'perps';
  /** Last close on the 1h chart — used as the centre price. */
  price: number;
  /** ATR(14) on 1h as a fraction (0.01 = 1%). */
  atrPct: number;
  /** 24h price change as a percentage (sign = direction). */
  change24hPct: number;
  /** Highest 1h close in the last 24 candles. */
  high24h: number;
  /** Lowest 1h close in the last 24 candles. */
  low24h: number;
  /** Top of the order book — used for tight bid/ask placement. */
  bestBid: number;
  bestAsk: number;
  /** Mid-to-spread distance, in basis points. */
  spreadBps: number;
}

/** Generic preset shape returned by `recommend*` helpers. The actual
 *  field names match each bot store; renderers spread these straight
 *  into `setField()` calls. */
export type Preset = Record<string, string | number>;

export interface RecommendationResult<P extends Preset = Preset> {
  preset: P;
  /** Short, plain-English explanation of *why* these values were
   *  chosen. Surface this in a toast or inline note so the user
   *  learns the rule of thumb. */
  rationale: string;
  /** Short label describing the detected market mood. */
  regimeLabel: string;
}

// ─── Context builder ──────────────────────────────────────────────────────────

/**
 * Fetch klines from `market`, then transparently retry on the other
 * market if the response is empty. Common case: SoDEX testnet spot
 * has no kline history for `BTC_USDC`, but the BTC-USD perp does.
 *
 * `fetchKlines` already normalises the symbol to the right venue
 * format internally (BTC_USDC ↔ BTC-USD), so passing the same string
 * to either market just works.
 */
async function fetchKlinesWithFallback(symbol: string, market: 'spot' | 'perps'): Promise<Array<Record<string, unknown>>> {
  // Primary attempt — the venue the user actually picked.
  try {
    const primary = await fetchKlines(symbol, '1h', 24, market) as Array<Record<string, unknown>>;
    if (Array.isArray(primary) && primary.length >= 5) return primary;
  } catch {
    // ignore — fall through to the alternate market
  }

  // Cross-venue fallback. We pass the same input symbol and let
  // fetchKlines apply its own normalisation; this keeps the retry
  // simple even for unusual quote-asset spellings.
  const alt: 'spot' | 'perps' = market === 'spot' ? 'perps' : 'spot';
  try {
    const fallback = await fetchKlines(symbol, '1h', 24, alt) as Array<Record<string, unknown>>;
    if (Array.isArray(fallback) && fallback.length >= 5) return fallback;
  } catch {
    // ignore — caller decides how to surface the empty result
  }

  return [];
}

/**
 * Fetch a complete market context in a single round-trip pair.
 *
 * Uses 24× 1h candles for ATR + 24h range, and the L1 order book for
 * tight bid/ask. Both endpoints are already cached server-side so
 * repeated Auto-Configure presses don't hammer the API.
 *
 * SoDEX **spot kline coverage is patchy** — newly-listed pairs and
 * less-traded markets often return an empty array on testnet even
 * when the orderbook is live. Since spot and perps for the same base
 * asset (e.g. BTC_USDC vs BTC-USD) track the same price action via
 * arbitrage, we transparently fall back to the perps equivalent when
 * the requested market has no candles. The orderbook itself stays
 * sourced from the requested market so spread / BBO figures still
 * reflect the venue the user is actually trading on.
 *
 * Throws if BOTH markets fail — callers should `try/catch` and
 * surface a toast.
 */
export async function buildContext(symbol: string, market: 'spot' | 'perps'): Promise<MarketContext> {
  const klines = await fetchKlinesWithFallback(symbol, market);
  if (klines.length < 5) {
    throw new Error(
      `Not enough klines for ${symbol} — got ${klines.length}, need ≥5. ` +
      `Try a more liquid pair (BTC, ETH, SOL).`,
    );
  }
  const ob = await fetchOrderbook(symbol, market, 1);

  // Parse OHLC from the SoDEX-aliased fields. fetchKlines normalises
  // these to {open, high, low, close} so we can read directly.
  const closes  = klines.map((k) => parseFloat(String(k.close ?? k.c ?? 0)));
  const highs   = klines.map((k) => parseFloat(String(k.high  ?? k.h ?? 0)));
  const lows    = klines.map((k) => parseFloat(String(k.low   ?? k.l ?? 0)));
  const last    = closes[closes.length - 1];
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`Invalid last close for ${symbol}`);
  }

  // ATR(14) using true range = max(high-low, |high-prevClose|, |low-prevClose|).
  // We cap the lookback at min(14, klines-1) so the function still
  // works when only ~10 candles are available.
  const atrPeriod = Math.min(14, klines.length - 1);
  let atrSum = 0;
  for (let i = klines.length - atrPeriod; i < klines.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    );
    atrSum += tr;
  }
  const atr = atrSum / atrPeriod;
  const atrPct = atr / last;

  // 24h range = highest high vs lowest low across the candles. (Not
  // strictly the same as 24h ticker change, but close enough for
  // auto-configure decisions.)
  const high24h = Math.max(...highs);
  const low24h  = Math.min(...lows);
  const first   = closes[Math.max(0, closes.length - 24)];
  const change24hPct = first > 0 ? ((last - first) / first) * 100 : 0;

  // Order book L1
  const bidArr = (ob as { bids?: unknown[][] }).bids ?? [];
  const askArr = (ob as { asks?: unknown[][] }).asks ?? [];
  const bestBid = parseFloat(String(bidArr[0]?.[0] ?? last));
  const bestAsk = parseFloat(String(askArr[0]?.[0] ?? last));
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

  return {
    symbol,
    market,
    price: last,
    atrPct,
    change24hPct,
    high24h,
    low24h,
    bestBid: bestBid > 0 ? bestBid : last,
    bestAsk: bestAsk > 0 ? bestAsk : last,
    spreadBps: Math.max(0, spreadBps),
  };
}

// ─── Volatility classifier ────────────────────────────────────────────────────

type Volatility = 'low' | 'medium' | 'high';

/** Cheap volatility bucket. Thresholds derived from BTC 1h ATR
 *  histograms over the last year (low ≈ <0.4%, high ≈ >1.0%). */
function bucketVolatility(atrPct: number): Volatility {
  if (atrPct < 0.004) return 'low';
  if (atrPct < 0.010) return 'medium';
  return 'high';
}

/** Friendly mood label for the rationale string. */
function moodLabel(vol: Volatility, change: number): string {
  const dir = change >  1.5 ? 'rising' : change < -1.5 ? 'falling' : 'sideways';
  return `${vol} volatility, ${dir}`;
}

// ─── Bot-specific recommenders ────────────────────────────────────────────────

/**
 * Grid Bot preset.
 *
 * The core insight: range width should track actual recent
 * volatility. We anchor on the wider of:
 *   - ATR-based projection: ±(ATR × 8 hours)  — covers ~1 day move
 *   - Realised 24h range: high24h..low24h     — what actually happened
 *
 * This way the bot still works in a sleepy market (ATR projection
 * dominates) and in a volatile one (realised range dominates).
 *
 * Spacing: GEOMETRIC for >0.5% ATR (constant percent per rung) so
 * profit-per-grid is uniform; ARITHMETIC otherwise (simpler maths
 * + lower precision strain on tick-size rounding).
 *
 * Mode: NEUTRAL by default — grids are inherently mean-reverting and
 * picking a directional bias usually hurts. Only switches to LONG
 * for very strong uptrends where shorting near the top is risky.
 */
export function recommendGridBot(ctx: MarketContext, budgetUsdt = 200): RecommendationResult {
  const vol = bucketVolatility(ctx.atrPct);
  const atrProjected = ctx.price * ctx.atrPct * 8;            // ATR × ~8h horizon
  const realisedRange = (ctx.high24h - ctx.low24h) / 2;
  const halfRange = Math.max(atrProjected, realisedRange, ctx.price * 0.015); // floor: ±1.5%
  const lower = ctx.price - halfRange;
  const upper = ctx.price + halfRange;

  // Grid count grows with volatility — more rungs let us catch more
  // wiggle, but rungs need enough spacing to clear fees so we cap at
  // 30 to keep ~0.1% min step in normal markets.
  const gridCount = vol === 'low' ? 12 : vol === 'medium' ? 20 : 28;

  // Quantity per grid sized so total commitment ≤ budget.
  const amountPerGrid = Math.max(0.0001, (budgetUsdt / gridCount) / ctx.price);

  // Strong uptrend → LONG mode (ride the trend with long-only entries).
  // Strong downtrend → keep NEUTRAL (shorting near a falling knife is
  // risky for a beginner). Sideways → NEUTRAL.
  const mode: 'NEUTRAL' | 'LONG' | 'SHORT' =
    ctx.change24hPct >  3 ? 'LONG' : 'NEUTRAL';

  return {
    preset: {
      symbol: ctx.symbol,
      lowerPrice: lower.toFixed(2),
      upperPrice: upper.toFixed(2),
      gridCount: String(gridCount),
      amountPerGrid: amountPerGrid.toFixed(6),
      spacing: vol === 'low' ? 'ARITHMETIC' : 'GEOMETRIC',
      mode,
    },
    regimeLabel: moodLabel(vol, ctx.change24hPct),
    rationale:
      `Detected ${moodLabel(vol, ctx.change24hPct)} (ATR ${(ctx.atrPct * 100).toFixed(2)}%). ` +
      `Set range ${lower.toFixed(0)}–${upper.toFixed(0)} (±${((halfRange / ctx.price) * 100).toFixed(2)}%) ` +
      `with ${gridCount} ${vol === 'low' ? 'arithmetic' : 'geometric'} rungs. ` +
      `Mode: ${mode}.`,
  };
}

/**
 * TWAP Bot preset.
 *
 * Slicing strategy: more slices in volatile markets (smooths price
 * impact), fewer in calm markets (less overhead). Interval shrinks
 * with volatility so we don't hold inventory too long while price
 * is whipping.
 *
 * Price band guard scaled to 3× ATR — wider than typical noise so
 * we don't skip slices unnecessarily, tight enough to avoid filling
 * during an obvious dump.
 *
 * `totalUsdt` defaults to 1000 if no budget passed — typical
 * "execute a position" size. The user adjusts manually.
 */
export function recommendTwapBot(ctx: MarketContext, totalUsdt = 1000): RecommendationResult {
  const vol = bucketVolatility(ctx.atrPct);
  const slices      = vol === 'low' ? 6  : vol === 'medium' ? 12 : 20;
  const intervalSec = vol === 'low' ? 90 : vol === 'medium' ? 60 : 30;
  // Price band guard: skip slice if price > N × ATR away from TWAP target.
  // 3× ATR is wide enough to ignore noise but tight enough to catch dumps.
  const priceBandPct = Math.max(0.3, Math.min(1.5, ctx.atrPct * 100 * 3));

  return {
    preset: {
      symbol: ctx.symbol,
      slices: String(slices),
      intervalSec: String(intervalSec),
      totalUsdt: String(totalUsdt),
      priceBandPct: priceBandPct.toFixed(2),
      orderType: 'limit',
    },
    regimeLabel: moodLabel(vol, ctx.change24hPct),
    rationale:
      `${vol === 'high' ? 'High' : vol === 'medium' ? 'Medium' : 'Low'}-vol market — ` +
      `slicing into ${slices} parts every ${intervalSec}s with ` +
      `±${priceBandPct.toFixed(2)}% price-band guard. ` +
      `Total notional ${totalUsdt} USDT.`,
  };
}

/**
 * DCA Bot preset.
 *
 * Mode: in clean uptrends we use Buy-the-Dip (only buys after a local
 * pullback), which beats fixed-interval DCA on long-only by capturing
 * better averages. In flat or downtrending markets, fixed DCA is the
 * safer call — Buy-the-Dip can sit waiting forever if the market
 * keeps grinding sideways.
 *
 * Interval: shorter in volatile markets to catch dips faster, longer
 * in calm ones to avoid unnecessary entries.
 *
 * `amountPerOrder`: 50 USDT default — small enough to be safe, large
 * enough that the resulting position is meaningful after 10-20 orders.
 */
export function recommendDcaBot(ctx: MarketContext): RecommendationResult {
  const vol = bucketVolatility(ctx.atrPct);
  const trending = ctx.change24hPct > 1.5;
  const mode: 'fixed' | 'buy-the-dip' = trending ? 'buy-the-dip' : 'fixed';
  const intervalMin = vol === 'low' ? 60 : vol === 'medium' ? 30 : 15;
  const dipPct = mode === 'buy-the-dip'
    ? Math.max(0.4, Math.min(2.0, ctx.atrPct * 100 * 1.5))
    : 0;

  return {
    preset: {
      symbol: ctx.symbol,
      mode,
      intervalMin: String(intervalMin),
      amountPerOrder: '50',
      maxOrders: '20',
      dipPct: dipPct.toFixed(2),
    },
    regimeLabel: moodLabel(vol, ctx.change24hPct),
    rationale:
      mode === 'buy-the-dip'
        ? `Trending up — using Buy-the-Dip mode, only filling after a ${dipPct.toFixed(2)}% local pullback. Interval ${intervalMin}m.`
        : `${vol === 'low' ? 'Sideways' : 'Mixed'} market — using fixed-interval DCA every ${intervalMin}m. ` +
          `20 orders × 50 USDT = 1,000 USDT total commitment.`,
  };
}

/**
 * Market Maker Bot preset.
 *
 * Spread offset: when the book is already tight (≤2 bps), join the
 * BBO directly (offset 0). When wider, step inside by 1bp so we sit
 * in front of the inside quote and get fills faster.
 *
 * Layers: more layers in calm markets (cheap to maintain, captures
 * more wiggles), fewer in volatile markets (one bad fill cycle can
 * leave a stuck inventory).
 *
 * Re-quote threshold: ~2× the current spread, clamped to 3-15bps. A
 * very tight spread (1bp) shouldn't make us re-quote on every print;
 * a wide spread (10bps) shouldn't let us sit far from the BBO.
 *
 * Order size: scaled so total commitment (size × layers × 2 sides)
 * sits at ~40% of the budget, leaving headroom for inventory drift.
 */
export function recommendMarketMakerBot(ctx: MarketContext, budgetUsdt = 100): RecommendationResult {
  const vol = bucketVolatility(ctx.atrPct);
  const layers      = vol === 'low' ? 3 : vol === 'medium' ? 2 : 1;
  const spreadBps   = ctx.spreadBps <= 2 ? 0 : 1;
  const requoteBps  = Math.max(3, Math.min(15, Math.round(ctx.spreadBps * 2)));
  // Target ~40% of budget on the table, split across both sides × layers.
  const orderSizeUsdt = Math.max(5, Math.floor((budgetUsdt * 0.4) / (layers * 2)));

  return {
    preset: {
      symbol: ctx.symbol,
      budgetUsdt: String(budgetUsdt),
      orderSizeUsdt: String(orderSizeUsdt),
      layers: String(layers),
      spreadBps: String(spreadBps),
      requoteBps: String(requoteBps),
      makerFeeRate: '0.0001',
    },
    regimeLabel: moodLabel(vol, ctx.change24hPct),
    rationale:
      `Book spread ${ctx.spreadBps.toFixed(2)}bps, ${vol} volatility — ` +
      `${layers}-layer ladder, ${orderSizeUsdt} USDT per order, ` +
      `${spreadBps === 0 ? 'joining the BBO' : `stepping inside by ${spreadBps}bp`}, ` +
      `re-quote on ${requoteBps}bps drift.`,
  };
}
