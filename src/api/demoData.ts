// ─── Demo / Mock Data for SoDEX Terminal ─────────────────────────────────────
// Used when isDemoMode = true so juries/guests can explore without API keys.

export const DEMO_TICKERS = [
  { symbol: 'BTC-USD', lastPrice: 84312.5,  change24h:  2.34, volume24h: 1_820_430_000 },
  { symbol: 'ETH-USD', lastPrice:  3241.8,  change24h: -1.12, volume24h:   820_150_000 },
  { symbol: 'SOL-USD', lastPrice:   178.4,  change24h:  4.87, volume24h:   412_340_000 },
  { symbol: 'BNB-USD', lastPrice:   612.3,  change24h:  0.91, volume24h:   190_210_000 },
  { symbol: 'ARB-USD', lastPrice:     1.24, change24h: -3.45, volume24h:   143_000_000 },
  { symbol: 'OP-USD',  lastPrice:     2.87, change24h:  5.12, volume24h:   112_000_000 },
  { symbol: 'AVAX-USD',lastPrice:    38.9,  change24h:  1.76, volume24h:    98_000_000 },
  { symbol: 'DOGE-USD',lastPrice:     0.182,change24h: -2.08, volume24h:    87_000_000 },
  { symbol: 'LINK-USD',lastPrice:    14.72, change24h:  3.21, volume24h:    76_000_000 },
  { symbol: 'SUI-USD', lastPrice:     2.11, change24h:  7.43, volume24h:    65_000_000 },
  { symbol: 'WLD-USD', lastPrice:     4.03, change24h: -1.55, volume24h:    54_000_000 },
  { symbol: 'INJ-USD', lastPrice:    28.6,  change24h:  2.88, volume24h:    48_000_000 },
];

export const DEMO_POSITIONS = [
  {
    symbol: 'BTC-USD',
    side: 'LONG',
    size: 0.15,
    avgEntryPrice: 81_200,
    markPrice: 84_312.5,
    leverage: 5,
    unrealizedPnl: 466.9,
    margin: 2_436,
  },
  {
    symbol: 'ETH-USD',
    side: 'SHORT',
    size: 2.5,
    avgEntryPrice: 3_310,
    markPrice: 3_241.8,
    leverage: 3,
    unrealizedPnl: 170.5,
    margin: 2_758,
  },
  {
    symbol: 'SOL-USD',
    side: 'LONG',
    size: 12,
    avgEntryPrice: 165.2,
    markPrice: 178.4,
    leverage: 4,
    unrealizedPnl: 158.4,
    margin: 495.6,
  },
];

export const DEMO_BALANCE = 12_450.75;
export const DEMO_TOTAL_PNL = 795.8;

export const DEMO_FUNDING_RATES = [
  { symbol: 'BTC-USD', fundingRate: 0.0001,  nextFundingTime: Date.now() + 3_600_000, markPrice: 84_312.5 },
  { symbol: 'ETH-USD', fundingRate: -0.00015, nextFundingTime: Date.now() + 3_600_000, markPrice: 3_241.8  },
  { symbol: 'SOL-USD', fundingRate: 0.00022,  nextFundingTime: Date.now() + 3_600_000, markPrice: 178.4    },
  { symbol: 'BNB-USD', fundingRate: 0.00008,  nextFundingTime: Date.now() + 3_600_000, markPrice: 612.3    },
  { symbol: 'ARB-USD', fundingRate: -0.0003,  nextFundingTime: Date.now() + 3_600_000, markPrice: 1.24     },
  { symbol: 'OP-USD',  fundingRate: 0.00018,  nextFundingTime: Date.now() + 3_600_000, markPrice: 2.87     },
];

export const DEMO_OPEN_ORDERS = [
  { orderId: 'demo-001', symbol: 'BTC-USD', side: 'BUY',  type: 'LIMIT', price: 82_000, quantity: 0.05, status: 'OPEN' },
  { orderId: 'demo-002', symbol: 'ETH-USD', side: 'SELL', type: 'LIMIT', price: 3_400,  quantity: 1.2,  status: 'OPEN' },
];

/**
 * Per-tick price evolution for the demo engine.
 *
 * The previous version was a pure ±0.15% mean-zero random walk, which
 * meant prices barely drifted over a session: with TICK_MS=1.2s, a 3%
 * take-profit would take roughly 3-5 minutes to fire even when it
 * "should" trigger, so the user never saw TP/SL paths exercised in demo.
 *
 * The new version layers a slow random-walking trend on top of the
 * jitter. The trend bias is held in a closure-scoped map so successive
 * ticks consistently push price in the same direction for ~30-60s
 * before reversing — that's the regime the technical indicators are
 * designed to detect, and it's the regime in which TP/SL fires
 * predictably enough for a manual demo to feel responsive.
 *
 * Net behaviour at default 1.2s tick:
 *   - Per-tick delta: ±0.20% (jitter) ± 0.10% (trend bias) ≈ ±0.30%
 *   - 60s drift expectation: ~1.5% in the dominant direction
 *   - Default TP=3% / SL=2% therefore fires in ~1-3 minutes of demo time
 */
const _trendBias = new Map<string, { dir: 1 | -1; until: number }>();

export function getDemoLivePrice(basePrice: number, key?: string): number {
  // Without a key we fall back to a stronger pure-jitter walk — used by
  // legacy callers that don't have a stable identifier. Most callers
  // pass the symbol, which is what we want.
  if (!key) {
    const delta = basePrice * (Math.random() * 0.004 - 0.002);
    return parseFloat((basePrice + delta).toFixed(2));
  }

  const now = Date.now();
  let bias = _trendBias.get(key);
  if (!bias || bias.until <= now) {
    // Pick a fresh trend direction lasting 30-60s. Random sign so
    // sessions alternate between bullish and bearish stretches.
    bias = {
      dir: Math.random() < 0.5 ? 1 : -1,
      until: now + 30_000 + Math.random() * 30_000,
    };
    _trendBias.set(key, bias);
  }

  // Trend pushes ~0.10% in the chosen direction; jitter is ±0.20%.
  const trend = basePrice * 0.001 * bias.dir;
  const jitterDelta = basePrice * (Math.random() * 0.004 - 0.002);
  return parseFloat((basePrice + trend + jitterDelta).toFixed(2));
}

// Generate fake candle history for a symbol (last 60 candles, 1-min)
export function getDemoCandleHistory(basePrice: number) {
  const candles = [];
  let price = basePrice * 0.97;
  const now = Date.now();
  for (let i = 59; i >= 0; i--) {
    const open = price;
    const change = price * (Math.random() * 0.008 - 0.004);
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.002);
    const low  = Math.min(open, close) * (1 - Math.random() * 0.002);
    const volume = Math.random() * 500 + 50;
    candles.push({
      time: Math.floor((now - i * 60_000) / 1000),
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low:  parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: parseFloat(volume.toFixed(3)),
    });
    price = close;
  }
  return candles;
}
