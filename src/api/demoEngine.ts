/**
 * Demo-mode engine — a self-contained in-memory simulation of SoDEX so the
 * terminal is fully explorable without any API keys.
 *
 * The engine mirrors every REST/account function used by `services.ts`:
 *  - Market data (tickers, book tickers, mark prices, klines, funding rates)
 *  - Account data (balances, positions, open orders, trades, fee rate)
 *  - Write ops (place / replace / modify / cancel orders, schedule-cancel,
 *    leverage, margin)
 *
 * A 1.2-second background tick drives realistic price movement and, through
 * it, order fills and position PnL. Limit orders fill when price crosses;
 * market orders fill instantly against the best book price.
 *
 * Toggling `isDemoMode` off resets the engine so demo state cannot leak into
 * a real session.
 */

import { DEMO_TICKERS, DEMO_POSITIONS, DEMO_BALANCE, getDemoLivePrice } from './demoData';

// ---------- Types ----------

export type Market = 'spot' | 'perps';

export interface DemoTickerRow {
  symbol: string;
  lastPrice: number;
  /** Price 24h ago — used to derive open / change / percent for consumers. */
  openPrice: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  fundingRate: number;
  openInterest: number;
  nextFundingTime: number;
  markPrice: number;
  indexPrice: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

export interface DemoOrder {
  orderID: number;
  clOrdID: string;
  market: Market;
  symbol: string;
  side: 1 | 2;          // 1=BUY, 2=SELL
  type: 1 | 2;          // 1=LIMIT, 2=MARKET
  timeInForce: 1 | 3 | 4;
  price?: number;
  quantity: number;
  executedQty: number;
  avgFillPrice: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';
  reduceOnly: boolean;
  positionSide: 1;
  createdAt: number;
  updatedAt: number;
}

export interface DemoPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  avgEntryPrice: number;
  markPrice: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  liquidationPrice: number;
}

export interface DemoTrade {
  tradeID: number;
  orderID: number;
  clOrdID: string;
  symbol: string;
  side: 1 | 2;
  price: number;
  quantity: number;
  feeAmt: number;
  time: number;
}

export interface DemoBalance {
  id: number;
  coin: string;
  total: number;
  locked: number;
  price: number;
  marginRatio: number;
}

// ---------- Internal state ----------

const TICK_MS = 1200;
// Funding interval is 8h per SoDEX docs; we fake it by moving the timestamp
// forward whenever `now` passes it.
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

// Realistic demo funding rates, seeded from `demoData.DEMO_FUNDING_RATES`
// where possible but fleshed out for every DEMO_TICKERS symbol.
const INITIAL_FUNDING_RATES: Record<string, number> = {
  'BTC-USD': 0.0001,
  'ETH-USD': -0.00015,
  'SOL-USD': 0.00022,
  'BNB-USD': 0.00008,
  'ARB-USD': -0.0003,
  'OP-USD': 0.00018,
  'AVAX-USD': 0.00012,
  'DOGE-USD': -0.00005,
  'LINK-USD': 0.0002,
  'SUI-USD': 0.00035,
  'WLD-USD': -0.00022,
  'INJ-USD': 0.00015,
};

interface DemoState {
  tickers: Map<string, DemoTickerRow>;
  balances: DemoBalance[];
  positions: DemoPosition[];
  /** Keyed by perps+spot order id (numeric). */
  orders: Map<number, DemoOrder>;
  trades: DemoTrade[];
  nextOrderId: number;
  nextTradeId: number;
  // Running/simulation state
  tickTimer: ReturnType<typeof setInterval> | null;
  tickListeners: Set<() => void>;
  initialised: boolean;
  scheduledCancel: { at: number; market: Market } | null;
  leverage: Map<string, { leverage: number; marginMode: 1 | 2 }>;
  accountID: number;
}

const _state: DemoState = {
  tickers: new Map(),
  balances: [],
  positions: [],
  orders: new Map(),
  trades: [],
  nextOrderId: 100_001,
  nextTradeId: 200_001,
  tickTimer: null,
  tickListeners: new Set(),
  initialised: false,
  scheduledCancel: null,
  leverage: new Map(),
  accountID: 99_999,
};

// ---------- Helpers ----------

/**
 * Convert a perps-style symbol (e.g. `BTC-USD`) to the spot-style underscore
 * form (`BTC_USDC`) and vice-versa. The demo engine stores tickers under the
 * perps-style keys, so non-perps callers must normalise first.
 */
function normaliseSymbolForKey(symbol: string): string {
  if (!symbol) return symbol;
  let s = symbol.replace(/_/g, '-');
  s = s.replace(/-USDC$/i, '-USD');
  return s.toUpperCase();
}

function jitter(base: number, pct: number): number {
  const delta = base * pct * (Math.random() * 2 - 1);
  return base + delta;
}

function ensureInit(): void {
  if (_state.initialised) return;

  // Seed tickers from DEMO_TICKERS
  for (const row of DEMO_TICKERS) {
    const last = row.lastPrice;
    const open = last / (1 + row.change24h / 100);
    const volume = row.volume24h / last; // rough base volume
    const fundingRate = INITIAL_FUNDING_RATES[row.symbol] ?? 0.0001;
    _state.tickers.set(row.symbol, {
      symbol: row.symbol,
      lastPrice: last,
      openPrice: open,
      high: Math.max(last, open) * 1.01,
      low: Math.min(last, open) * 0.99,
      volume,
      quoteVolume: row.volume24h,
      fundingRate,
      openInterest: row.volume24h * 0.1,
      nextFundingTime: Date.now() + FUNDING_INTERVAL_MS,
      markPrice: last,
      indexPrice: last,
      bidPrice: last * 0.9995,
      askPrice: last * 1.0005,
      bidSize: Math.random() * 20 + 5,
      askSize: Math.random() * 20 + 5,
    });
  }

  // Seed positions
  _state.positions = DEMO_POSITIONS.map((p) => ({
    symbol: p.symbol,
    side: p.side as 'LONG' | 'SHORT',
    size: p.size,
    avgEntryPrice: p.avgEntryPrice,
    markPrice: p.markPrice,
    leverage: p.leverage,
    margin: p.margin,
    unrealizedPnl: p.unrealizedPnl,
    // Simple linear approximation so the number isn't 0.
    liquidationPrice: p.side === 'LONG'
      ? p.avgEntryPrice * (1 - 1 / p.leverage * 0.95)
      : p.avgEntryPrice * (1 + 1 / p.leverage * 0.95),
  }));

  // Seed balances — one demo USDC-equivalent + small BTC bag
  _state.balances = [
    { id: 1, coin: 'vUSDC', total: DEMO_BALANCE, locked: 0, price: 1, marginRatio: 1 },
    { id: 2, coin: 'vBTC', total: 0.05, locked: 0, price: _state.tickers.get('BTC-USD')?.lastPrice ?? 0, marginRatio: 0.5 },
  ];

  _state.initialised = true;
  startTicker();
}

function startTicker(): void {
  if (_state.tickTimer) return;
  _state.tickTimer = setInterval(tick, TICK_MS);
}

function stopTicker(): void {
  if (!_state.tickTimer) return;
  clearInterval(_state.tickTimer);
  _state.tickTimer = null;
}

/**
 * One simulation step:
 *  1. Move every ticker by ~±0.2% with tiny bias toward mean-reversion.
 *  2. Update book bid/ask around the new mid.
 *  3. Update positions' markPrice / unrealizedPnl.
 *  4. Try to fill any open orders whose trigger price was crossed.
 *  5. Fire the scheduled-cancel "dead man's switch" if its timer elapsed.
 *  6. Notify subscribers (so useLiveTicker-like hooks can re-render).
 */
function tick(): void {
  const now = Date.now();

  for (const t of _state.tickers.values()) {
    const newLast = getDemoLivePrice(t.lastPrice);
    t.lastPrice = newLast;
    t.markPrice = jitter(newLast, 0.0005);
    t.indexPrice = jitter(newLast, 0.0004);
    t.bidPrice = newLast * (1 - 0.0003 - Math.random() * 0.0005);
    t.askPrice = newLast * (1 + 0.0003 + Math.random() * 0.0005);
    t.bidSize = Math.random() * 20 + 5;
    t.askSize = Math.random() * 20 + 5;
    if (newLast > t.high) t.high = newLast;
    if (newLast < t.low) t.low = newLast;
    // tiny incremental volume per tick
    const vol = Math.random() * 0.5;
    t.volume += vol;
    t.quoteVolume += vol * newLast;
    if (now >= t.nextFundingTime) {
      t.nextFundingTime = now + FUNDING_INTERVAL_MS;
      t.fundingRate = jitter(t.fundingRate, 0.5);
    }
  }

  // Update positions with new mark price and PnL
  for (const p of _state.positions) {
    const ticker = _state.tickers.get(p.symbol);
    if (!ticker) continue;
    p.markPrice = ticker.markPrice;
    const dir = p.side === 'LONG' ? 1 : -1;
    p.unrealizedPnl = dir * p.size * (p.markPrice - p.avgEntryPrice);
  }

  // Try to fill any NEW / PARTIALLY_FILLED orders
  for (const order of _state.orders.values()) {
    if (order.status !== 'NEW' && order.status !== 'PARTIALLY_FILLED') continue;
    const ticker = _state.tickers.get(normaliseSymbolForKey(order.symbol));
    if (!ticker) continue;
    tryFill(order, ticker);
  }

  // Scheduled cancel-all
  if (_state.scheduledCancel && now >= _state.scheduledCancel.at) {
    const targetMarket = _state.scheduledCancel.market;
    for (const o of _state.orders.values()) {
      if (o.market !== targetMarket) continue;
      if (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') {
        o.status = 'CANCELED';
        o.updatedAt = now;
      }
    }
    _state.scheduledCancel = null;
  }

  // Fan-out notifications — copy the list first so listeners can unsubscribe
  // themselves during the callback without mutating the iterator.
  for (const listener of Array.from(_state.tickListeners)) {
    try {
      listener();
    } catch {
      // listener errors must not break the simulation loop
    }
  }
}

/**
 * Decide whether an order should be filled on this tick and, if so, apply
 * the fill: update order state, mint a trade record, and adjust the
 * corresponding position.
 */
function tryFill(order: DemoOrder, ticker: DemoTickerRow): void {
  const remaining = order.quantity - order.executedQty;
  if (remaining <= 0) {
    order.status = 'FILLED';
    order.updatedAt = Date.now();
    return;
  }

  let fillPrice = 0;
  if (order.type === 2) {
    // Market — fill immediately at best ask/bid with tiny slippage
    fillPrice = order.side === 1 ? ticker.askPrice : ticker.bidPrice;
  } else if (order.type === 1 && order.price != null) {
    // LIMIT: buy fills when ask <= price; sell fills when bid >= price
    if (order.side === 1 && ticker.askPrice <= order.price) {
      fillPrice = Math.min(order.price, ticker.askPrice);
    } else if (order.side === 2 && ticker.bidPrice >= order.price) {
      fillPrice = Math.max(order.price, ticker.bidPrice);
    }
  }
  if (fillPrice <= 0) return;

  // Partial fills make the simulation feel alive for larger orders.
  // Small orders go full-fill in one tick.
  const fillQty = order.quantity < 0.1
    ? remaining
    : remaining * (0.5 + Math.random() * 0.5);

  const totalQty = order.executedQty + fillQty;
  const newAvg = (order.executedQty * order.avgFillPrice + fillQty * fillPrice) / totalQty;
  order.executedQty = totalQty;
  order.avgFillPrice = newAvg;
  order.status = totalQty >= order.quantity - 1e-9 ? 'FILLED' : 'PARTIALLY_FILLED';
  order.updatedAt = Date.now();

  // Record trade
  const feeRate = 0.0004;
  const fee = fillQty * fillPrice * feeRate;
  const trade: DemoTrade = {
    tradeID: _state.nextTradeId++,
    orderID: order.orderID,
    clOrdID: order.clOrdID,
    symbol: order.symbol,
    side: order.side,
    price: fillPrice,
    quantity: fillQty,
    feeAmt: fee,
    time: Date.now(),
  };
  _state.trades.unshift(trade);
  if (_state.trades.length > 500) _state.trades.length = 500;

  // Adjust position (perps only — spot just moves balance)
  if (order.market === 'perps') {
    applyPerpsFillToPosition(order, fillQty, fillPrice);
  } else {
    applySpotFillToBalance(order, fillQty, fillPrice, fee);
  }
}

function applyPerpsFillToPosition(order: DemoOrder, fillQty: number, fillPrice: number): void {
  const dir = order.side === 1 ? 1 : -1;
  let pos = _state.positions.find((p) => p.symbol === order.symbol);
  const signedSize = pos
    ? (pos.side === 'LONG' ? pos.size : -pos.size) + dir * fillQty
    : dir * fillQty;

  if (!pos) {
    pos = {
      symbol: order.symbol,
      side: dir > 0 ? 'LONG' : 'SHORT',
      size: Math.abs(fillQty),
      avgEntryPrice: fillPrice,
      markPrice: fillPrice,
      leverage: _state.leverage.get(order.symbol)?.leverage ?? 5,
      margin: fillQty * fillPrice / 5,
      unrealizedPnl: 0,
      liquidationPrice: dir > 0 ? fillPrice * 0.8 : fillPrice * 1.2,
    };
    _state.positions.push(pos);
    return;
  }

  if (signedSize === 0) {
    _state.positions = _state.positions.filter((p) => p !== pos);
    return;
  }

  const oldSigned = pos.side === 'LONG' ? pos.size : -pos.size;
  const sameSide = Math.sign(oldSigned) === dir;
  if (sameSide) {
    const totalQty = pos.size + fillQty;
    pos.avgEntryPrice = (pos.avgEntryPrice * pos.size + fillPrice * fillQty) / totalQty;
    pos.size = totalQty;
  } else {
    // Reducing / flipping
    const newSigned = oldSigned + dir * fillQty;
    if (Math.sign(newSigned) !== Math.sign(oldSigned) && newSigned !== 0) {
      pos.side = newSigned > 0 ? 'LONG' : 'SHORT';
      pos.avgEntryPrice = fillPrice;
      pos.size = Math.abs(newSigned);
    } else {
      pos.size = Math.abs(newSigned);
    }
  }
  pos.margin = pos.size * pos.avgEntryPrice / pos.leverage;
}

function applySpotFillToBalance(order: DemoOrder, fillQty: number, fillPrice: number, fee: number): void {
  const notional = fillQty * fillPrice;
  const usd = _state.balances.find((b) => b.coin === 'vUSDC');
  if (!usd) return;
  if (order.side === 1) {
    usd.total -= notional + fee;
  } else {
    usd.total += notional - fee;
  }
}

// ---------- Public API ----------

/**
 * Initialise the demo engine and begin ticking. Safe to call repeatedly.
 */
export function startDemoEngine(): void {
  ensureInit();
  startTicker();
}

/**
 * Tear down demo state. Called when the user leaves demo mode so fake orders
 * / positions cannot bleed into a live trading session.
 */
export function stopDemoEngine(): void {
  stopTicker();
  _state.tickers.clear();
  _state.positions = [];
  _state.balances = [];
  _state.orders.clear();
  _state.trades = [];
  _state.scheduledCancel = null;
  _state.leverage.clear();
  _state.initialised = false;
}

/**
 * Subscribe to per-tick notifications. Returned function unsubscribes.
 * Useful for custom live widgets (we also expose the underlying state
 * via the `fetch*` helpers below for polling consumers).
 */
export function subscribeToDemoTicks(listener: () => void): () => void {
  _state.tickListeners.add(listener);
  return () => _state.tickListeners.delete(listener);
}

// ----- Market data -----

export function getDemoTickers(_market: Market) {
  ensureInit();
  return Array.from(_state.tickers.values()).map((t) => ({
    symbol: t.symbol,
    lastPx: t.lastPrice.toFixed(2),
    lastPrice: t.lastPrice,
    close: t.lastPrice,
    openPx: t.openPrice.toFixed(2),
    highPx: t.high.toFixed(2),
    lowPx: t.low.toFixed(2),
    priceChangePercent: ((t.lastPrice - t.openPrice) / t.openPrice) * 100,
    changePct: ((t.lastPrice - t.openPrice) / t.openPrice) * 100,
    volume: t.volume.toFixed(2),
    quoteVolume: t.quoteVolume.toFixed(2),
    bidPx: t.bidPrice.toFixed(2),
    askPx: t.askPrice.toFixed(2),
    bidPrice: t.bidPrice,
    askPrice: t.askPrice,
    bidSz: t.bidSize.toFixed(4),
    askSz: t.askSize.toFixed(4),
    markPrice: t.markPrice,
    indexPrice: t.indexPrice,
    fundingRate: t.fundingRate,
    nextFundingTime: t.nextFundingTime,
    openInterest: t.openInterest,
    openTime: Date.now() - 24 * 60 * 60 * 1000,
    closeTime: Date.now(),
  }));
}

export function getDemoMiniTickers(market: Market) {
  return getDemoTickers(market).map((t) => ({
    symbol: t.symbol,
    lastPx: t.lastPx,
    openPx: t.openPx,
    highPx: t.highPx,
    lowPx: t.lowPx,
    volume: t.volume,
    quoteVolume: t.quoteVolume,
    openTime: t.openTime,
    closeTime: t.closeTime,
  }));
}

export function getDemoBookTickers(market: Market) {
  return getDemoTickers(market).map((t) => ({
    symbol: t.symbol,
    bidPx: t.bidPx,
    askPx: t.askPx,
    bidSz: t.bidSz,
    askSz: t.askSz,
    bidPrice: t.bidPrice,
    askPrice: t.askPrice,
    bid: t.bidPrice,
    ask: t.askPrice,
  }));
}

export function getDemoMarkPrices() {
  ensureInit();
  return Array.from(_state.tickers.values()).map((t) => ({
    symbol: t.symbol,
    fundingRate: t.fundingRate,
    nextFundingTime: t.nextFundingTime,
    indexPrice: t.indexPrice,
    markPrice: t.markPrice,
    openInterest: t.openInterest,
  }));
}

export function getDemoFundingRates() {
  ensureInit();
  return Array.from(_state.tickers.values()).map((t) => ({
    symbol: t.symbol,
    fundingRate: t.fundingRate,
    nextFundingTime: t.nextFundingTime,
    markPrice: t.markPrice,
  }));
}

export function getDemoOrderbook(symbol: string, _market: Market, limit = 20) {
  ensureInit();
  const key = normaliseSymbolForKey(symbol);
  const t = _state.tickers.get(key);
  if (!t) return { blockTime: Date.now(), blockHeight: 0, updateID: 0, bids: [], asks: [] };
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < limit; i++) {
    const bidP = (t.bidPrice * (1 - i * 0.0003)).toFixed(2);
    const askP = (t.askPrice * (1 + i * 0.0003)).toFixed(2);
    const sz = (Math.random() * 5 + 0.1).toFixed(4);
    bids.push([bidP, sz]);
    asks.push([askP, sz]);
  }
  return {
    blockTime: Date.now(),
    blockHeight: 1_000_000,
    updateID: _state.nextTradeId,
    bids,
    asks,
  };
}

/**
 * Generate a plausible kline series ending at the current demo price.
 * Uses random-walk increments seeded from the ticker so successive calls
 * with the same symbol/interval are close-but-not-identical.
 */
export function getDemoKlines(symbol: string, interval: string, limit = 100) {
  ensureInit();
  const key = normaliseSymbolForKey(symbol);
  const t = _state.tickers.get(key);
  if (!t) return [];

  const intervalMs: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1D': 86_400_000,
    '1w': 604_800_000, '1W': 604_800_000, '1M': 2_592_000_000,
  };
  const step = intervalMs[interval] ?? 3_600_000;
  const now = Date.now();

  const klines: Record<string, unknown>[] = [];
  let price = t.lastPrice * 0.97;
  for (let i = limit - 1; i >= 0; i--) {
    const openTs = now - i * step;
    const o = price;
    const change = price * (Math.random() * 0.012 - 0.006);
    const c = Math.max(0.0001, price + change);
    const h = Math.max(o, c) * (1 + Math.random() * 0.004);
    const l = Math.min(o, c) * (1 - Math.random() * 0.004);
    const v = Math.random() * 500 + 50;
    klines.push({
      t: openTs,
      o: o.toFixed(2),
      h: h.toFixed(2),
      l: l.toFixed(2),
      c: c.toFixed(2),
      v: v.toFixed(4),
      q: (v * c).toFixed(2),
      time: openTs,
      openTime: openTs,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v,
    });
    price = c;
  }
  return klines;
}

// ----- Account data -----

export function getDemoAccountState(_market: Market) {
  ensureInit();
  return {
    aid: _state.accountID,
    accountID: _state.accountID,
    blockTime: Date.now(),
    blockHeight: 1_000_000,
    balances: _state.balances,
    positions: _state.positions,
    orders: Array.from(_state.orders.values()).filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'),
  };
}

export function getDemoBalances(_market: Market) {
  ensureInit();
  return _state.balances.map((b) => ({
    id: b.id,
    coin: b.coin,
    total: b.total.toFixed(6),
    locked: b.locked.toFixed(6),
    balance: b.total,
    available: b.total - b.locked,
    marginRatio: b.marginRatio,
    price: b.price,
  }));
}

export function getDemoPositions() {
  ensureInit();
  return _state.positions.map((p) => ({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    quantity: p.size,
    avgEntryPrice: p.avgEntryPrice,
    entryPrice: p.avgEntryPrice,
    markPrice: p.markPrice,
    leverage: p.leverage,
    margin: p.margin,
    initialMargin: p.margin,
    unrealizedPnl: p.unrealizedPnl,
    pnl: p.unrealizedPnl,
    liquidationPrice: p.liquidationPrice,
    liqPrice: p.liquidationPrice,
  }));
}

export function getDemoOpenOrders(market: Market, symbolFilter?: string) {
  ensureInit();
  const normalizedFilter = symbolFilter ? normaliseSymbolForKey(symbolFilter) : undefined;
  const orders = Array.from(_state.orders.values()).filter((o) => {
    if (o.market !== market) return false;
    if (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED') return false;
    if (normalizedFilter && normaliseSymbolForKey(o.symbol) !== normalizedFilter) return false;
    return true;
  });
  return orders.map(formatOrder);
}

export function getDemoOrderHistory(market: Market, params: { symbol?: string; limit?: number } = {}) {
  ensureInit();
  const normalizedFilter = params.symbol ? normaliseSymbolForKey(params.symbol) : undefined;
  const orders = Array.from(_state.orders.values()).filter((o) => {
    if (o.market !== market) return false;
    if (normalizedFilter && normaliseSymbolForKey(o.symbol) !== normalizedFilter) return false;
    return true;
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = params.limit ? orders.slice(0, params.limit) : orders;
  return limited.map(formatOrder);
}

function formatOrder(o: DemoOrder) {
  return {
    orderID: o.orderID,
    orderId: o.orderID,
    clOrdID: o.clOrdID,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    timeInForce: o.timeInForce,
    price: o.price?.toString(),
    origQty: o.quantity.toString(),
    quantity: o.quantity.toString(),
    executedQty: o.executedQty.toString(),
    executedValue: (o.executedQty * o.avgFillPrice).toString(),
    status: o.status,
    reduceOnly: o.reduceOnly,
    positionSide: o.positionSide,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export function getDemoAccountFills(_market: Market, limit = 50, symbolFilter?: string) {
  ensureInit();
  const normalizedFilter = symbolFilter ? normaliseSymbolForKey(symbolFilter) : undefined;
  const list = _state.trades
    .filter((t) => !normalizedFilter || normaliseSymbolForKey(t.symbol) === normalizedFilter)
    .slice(0, limit);
  return list.map((t) => ({
    tradeID: t.tradeID,
    orderID: t.orderID,
    orderId: t.orderID,
    clOrdID: t.clOrdID,
    symbol: t.symbol,
    side: t.side,
    price: t.price.toString(),
    quantity: t.quantity.toString(),
    feeAmt: t.feeAmt.toString(),
    fee: t.feeAmt,
    time: t.time,
  }));
}

export function getDemoFeeRate() {
  return { makerFee: 0.00012, takerFee: 0.0004 };
}

export function getDemoOrderStatus(orderId: string, symbol: string) {
  ensureInit();
  const n = Number(orderId);
  const order = Number.isFinite(n) ? _state.orders.get(n) : undefined;
  if (!order) return null;
  const trades = _state.trades.filter((t) => t.orderID === order.orderID);
  const totalQty = trades.reduce((s, t) => s + t.quantity, 0);
  const totalValue = trades.reduce((s, t) => s + t.quantity * t.price, 0);
  const totalFee = trades.reduce((s, t) => s + t.feeAmt, 0);
  return {
    orderId,
    status: order.status,
    filledQty: totalQty,
    avgFillPrice: totalQty > 0 ? totalValue / totalQty : 0,
    filledValue: totalValue,
    totalFee,
    symbol,
  };
}

// ----- Write ops -----

export interface PlaceOrderInput {
  symbol: string;
  side: 1 | 2;
  type: 1 | 2;
  quantity: string | number;
  price?: string | number;
  timeInForce?: 1 | 3 | 4;
  reduceOnly?: boolean;
  clOrdID?: string;
}

export function demoPlaceOrder(input: PlaceOrderInput, market: Market) {
  ensureInit();
  const qty = typeof input.quantity === 'number' ? input.quantity : parseFloat(input.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Demo: invalid quantity "${input.quantity}"`);
  }
  const price = input.price != null
    ? (typeof input.price === 'number' ? input.price : parseFloat(input.price))
    : undefined;
  const timeInForce = input.timeInForce ?? (input.type === 2 ? 3 : 1);
  const clOrdID = input.clOrdID ?? `demo-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  const orderID = _state.nextOrderId++;
  const order: DemoOrder = {
    orderID,
    clOrdID,
    market,
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    timeInForce,
    price,
    quantity: qty,
    executedQty: 0,
    avgFillPrice: 0,
    status: 'NEW',
    reduceOnly: input.reduceOnly ?? false,
    positionSide: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  _state.orders.set(orderID, order);

  // Market orders get an immediate best-effort fill so UI doesn't wait for
  // a tick (tick will still potentially partial-fill any remainder).
  if (order.type === 2) {
    const ticker = _state.tickers.get(normaliseSymbolForKey(order.symbol));
    if (ticker) tryFill(order, ticker);
  }

  return {
    code: 0,
    clOrdID,
    orderID,
    orderId: orderID,
    status: order.status,
  };
}

export function demoPlaceBatchOrders(inputs: PlaceOrderInput[], market: Market) {
  return inputs.map((i) => demoPlaceOrder(i, market));
}

export function demoCancelOrder(orderId: string, _symbol: string, _market: Market) {
  ensureInit();
  const n = Number(orderId);
  if (Number.isFinite(n)) {
    const order = _state.orders.get(n);
    if (order && (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED')) {
      order.status = 'CANCELED';
      order.updatedAt = Date.now();
      return { code: 0, clOrdID: order.clOrdID, orderID: n };
    }
  } else {
    // Fall back to clOrdID match
    for (const o of _state.orders.values()) {
      if (o.clOrdID === orderId && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED')) {
        o.status = 'CANCELED';
        o.updatedAt = Date.now();
        return { code: 0, clOrdID: o.clOrdID, orderID: o.orderID };
      }
    }
  }
  return { code: -1, error: 'Demo: order not found or already finalised' };
}

export function demoBatchCancelOrders(orderIds: string[], symbol: string, market: Market) {
  return orderIds.map((id) => demoCancelOrder(id, symbol, market));
}

export function demoCancelAllOrders(symbolFilter: string | undefined, market: Market) {
  ensureInit();
  const filter = symbolFilter ? normaliseSymbolForKey(symbolFilter) : undefined;
  const results: unknown[] = [];
  for (const o of _state.orders.values()) {
    if (o.market !== market) continue;
    if (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED') continue;
    if (filter && normaliseSymbolForKey(o.symbol) !== filter) continue;
    o.status = 'CANCELED';
    o.updatedAt = Date.now();
    results.push({ code: 0, clOrdID: o.clOrdID, orderID: o.orderID });
  }
  return results;
}

export interface DemoReplaceInput {
  symbol: string;
  origOrderID?: string | number;
  origClOrdID?: string;
  price?: string | number;
  quantity?: string | number;
}

export function demoReplaceOrders(replacements: DemoReplaceInput[], _market: Market) {
  ensureInit();
  return replacements.map((r) => {
    const target = r.origOrderID != null
      ? _state.orders.get(Number(r.origOrderID))
      : Array.from(_state.orders.values()).find((o) => o.clOrdID === r.origClOrdID);
    if (!target) return { code: -1, error: 'Demo: order not found' };
    if (target.status !== 'NEW' && target.status !== 'PARTIALLY_FILLED') {
      return { code: -1, error: 'Demo: order not replaceable' };
    }
    if (r.price != null) {
      const p = typeof r.price === 'number' ? r.price : parseFloat(r.price);
      if (Number.isFinite(p) && p > 0) target.price = p;
    }
    if (r.quantity != null) {
      const q = typeof r.quantity === 'number' ? r.quantity : parseFloat(r.quantity);
      if (Number.isFinite(q) && q > 0) target.quantity = q;
    }
    target.updatedAt = Date.now();
    return { code: 0, clOrdID: target.clOrdID, orderID: target.orderID };
  });
}

export function demoUpdateLeverage(symbol: string, leverage: number, marginMode: 1 | 2) {
  ensureInit();
  _state.leverage.set(symbol, { leverage, marginMode });
  // Apply to existing position if any
  const pos = _state.positions.find((p) => p.symbol === symbol);
  if (pos) {
    pos.leverage = leverage;
    pos.margin = pos.size * pos.avgEntryPrice / leverage;
  }
}

export function demoScheduleCancelAll(market: Market, scheduledTimestamp?: number) {
  ensureInit();
  if (scheduledTimestamp == null) {
    _state.scheduledCancel = null;
  } else {
    _state.scheduledCancel = { at: scheduledTimestamp, market };
  }
}

/** Pretty-printable snapshot for debugging. */
export function _debugSnapshot() {
  return {
    tickers: _state.tickers.size,
    orders: _state.orders.size,
    positions: _state.positions.length,
    trades: _state.trades.length,
  };
}
