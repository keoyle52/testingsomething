import axios from 'axios';
import { perpsClient } from './perpsClient';
import { spotClient } from './spotClient';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';
import { signPayload, deriveActionType } from './signer';

// ---------- internal helpers ----------

/**
 * Throw if the exchange returned a body-level error even though HTTP was 200.
 * SoDEX perps API returns `{ code: -1, error: "..." }` on bad requests.
 */
function assertNoBodyError(data: unknown): void {
  if (data && typeof data === 'object' && 'code' in data && data.code !== 0) {
    const d = data as Record<string, unknown>;
    throw new Error(String(d.error ?? d.message ?? `API error code ${d.code}`));
  }
}

/** Monotonically increasing counter suffix used by generateClOrdID. */
let _clOrdSeq = 0;

/**
 * Generate a unique client order ID that satisfies SoDEX constraints:
 * ≤ 36 characters, characters limited to [0-9a-zA-Z_-].
 * Uses a per-session sequence counter to prevent collisions even when
 * multiple orders are created within the same millisecond.
 */
function generateClOrdID(): string {
  const seq = (++_clOrdSeq).toString(36).padStart(4, '0');
  const ts = Date.now().toString(36);
  return `${ts}-${seq}`.slice(0, 36);
}

// ---------- helpers ----------

/**
 * Normalize a trading symbol for the target market.
 * SoDEX perps API uses "BTC-USD" format (hyphen separator).
 * SoDEX spot  API uses "BTC_USDC" format (underscore separator).
 * This helper converts between the two so users don't get "invalid symbol"
 * errors when using one format on the wrong endpoint.
 */
export function normalizeSymbol(symbol: string, market: 'spot' | 'perps'): string {
  if (!symbol) return symbol;
  if (market === 'spot') {
    // Convert to underscore format: BTC-USDC → BTC_USDC, BTC-USD → BTC_USDC
    let sym = symbol.replace(/-/g, '_');
    // If it ends with _USD but not _USDC (perps-style), append C
    if (sym.endsWith('_USD') && !sym.endsWith('_USDC')) {
      sym += 'C';
    }
    return sym;
  }
  // Perps: convert to hyphen format BTC_USDC → BTC-USD
  const sym = symbol.replace(/_/g, '-');
  // Convert spot-style "-USDC" to perps-style "-USD"
  return sym.replace(/-USDC$/, '-USD');
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastError;
}

function getEvmAddress(): string {
  const { privateKey } = useSettingsStore.getState();
  if (!privateKey) return '';
  try {
    let pk = privateKey;
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    return new ethers.Wallet(pk).address;
  } catch {
    return '';
  }
}

function getClient(market: 'spot' | 'perps') {
  return market === 'spot' ? spotClient : perpsClient;
}

/**
 * Parse an order ID string to a numeric value for API parameters that require
 * a uint64. Returns the number if the string is a valid integer, or NaN if not.
 * Callers should fall back to using the raw string as a clOrdID when NaN.
 */
function parseOrderIdNumeric(orderId: string): number {
  return Number(orderId);
}

// ---------- Market Data (Public) ----------

export async function fetchSymbols(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/symbols'));
  return res?.data ?? res ?? [];
}

export interface SymbolPrecision {
  symbolID: number;
  pricePrecision: number;
  tickSize: number;
  quantityPrecision: number;
  stepSize: number;
}

export interface SymbolTradingRules {
  /** Decimal places allowed for quantity on the current symbol (lot-size precision). */
  quantityPrecision: number;
  /** Minimum quantity increment for orders on the current symbol. */
  stepSize: number;
  /** Decimal places allowed for price on the current symbol. */
  pricePrecision: number;
  /** Minimum price increment for orders on the current symbol. */
  tickSize: number;
}

/** Fallback price precision (decimal places) when symbol metadata is unavailable. */
const DEFAULT_PRICE_PRECISION = 2;
/** Fallback tick size for price when symbol metadata is unavailable. */
const DEFAULT_TICK_SIZE = 0.01;
/** Fallback quantity precision (decimal places) when symbol metadata is unavailable. */
const DEFAULT_QUANTITY_PRECISION = 8;
/** Fallback step size for quantity when symbol metadata is unavailable. */
const DEFAULT_STEP_SIZE = 0.00000001;

/**
 * Round a raw value down to the nearest multiple of tickSize and format it
 * with exactly `precision` decimal places, as required by the exchange.
 * Uses integer arithmetic to avoid floating-point drift.
 */
function roundToTick(value: number, tickSize: number, precision: number): string {
  if (tickSize <= 0 || precision < 0) return value.toFixed(Math.max(0, precision));
  const factor = Math.pow(10, precision);
  const tickUnits = Math.round(tickSize * factor);
  const valueUnits = Math.floor(value * factor);
  const remainder = valueUnits % tickUnits;
  const rounded = (valueUnits - remainder) / factor;
  return rounded.toFixed(precision);
}

/**
 * Look up the full symbol entry (including precision metadata) for a given
 * symbol on the specified market.  Returns null when not found.
 */
async function fetchSymbolEntry(symbol: string, market: 'spot' | 'perps'): Promise<Record<string, unknown> | null> {
  try {
    const symbols = await fetchSymbols(market);
    const list = Array.isArray(symbols) ? symbols : (symbols?.symbols ?? symbols?.data ?? []);
    const normalised = normalizeSymbol(symbol, market);
    return list.find(
      (s: Record<string, unknown>) => s.symbol === normalised || s.name === normalised || s.ticker === normalised,
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract SymbolPrecision from a raw symbol entry object.
 * Falls back to safe defaults (8 decimal places, tick = 0.00000001) when fields are missing.
 */
function extractPrecision(entry: Record<string, unknown> | null): Omit<SymbolPrecision, 'symbolID'> {
  const pricePrecision = Number(entry?.pricePrecision ?? DEFAULT_PRICE_PRECISION);
  const tickSize = parseFloat(String(entry?.tickSize ?? DEFAULT_TICK_SIZE)) || DEFAULT_TICK_SIZE;
  const quantityPrecision = Number(entry?.quantityPrecision ?? DEFAULT_QUANTITY_PRECISION);
  const stepSize = parseFloat(String(entry?.stepSize ?? DEFAULT_STEP_SIZE)) || DEFAULT_STEP_SIZE;
  return { pricePrecision, tickSize, quantityPrecision, stepSize };
}

export async function fetchSymbolTradingRules(
  symbol: string,
  market: 'spot' | 'perps',
): Promise<SymbolTradingRules> {
  const entry = await fetchSymbolEntry(symbol, market);
  const { quantityPrecision, stepSize, pricePrecision, tickSize } = extractPrecision(entry);
  return { quantityPrecision, stepSize, pricePrecision, tickSize };
}

/**
 * Look up the numeric symbolID for a given symbol name on the perps market.
 * Returns null if the symbol cannot be found.
 */
export async function fetchPerpsSymbolID(symbol: string): Promise<number | null> {
  try {
    const entry = await fetchSymbolEntry(symbol, 'perps');
    return (entry?.symbolID ?? entry?.id ?? entry?.symbolId ?? null) as number | null;
  } catch {
    return null;
  }
}

/**
 * Fetch the perps account state for the current wallet.
 * Uses /state endpoint which returns WsPerpsState (aid = Account ID).
 * Returns an object containing at minimum `accountID`.
 */
export async function fetchPerpsAccountState(): Promise<{ accountID: number | string; [key: string]: unknown }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res = await withRetry(() => perpsClient.get(`/accounts/${address}/state`));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);
  // WsPerpsState uses `aid` for account ID; also try legacy field names
  const accountID = data.aid ?? data.accountID ?? data.accountId ?? data.account_id ?? data.id;
  if (accountID == null) throw new Error('fetchPerpsAccountState: accountID not found in response');
  return { ...data, accountID };
}

/**
 * Fetch the spot account state for the current wallet.
 * Uses /state endpoint which returns WsSpotState (aid = Account ID).
 * Returns an object containing at minimum `accountID`.
 */
export async function fetchSpotAccountState(): Promise<{ accountID: number | string; [key: string]: unknown }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res = await withRetry(() => spotClient.get(`/accounts/${address}/state`));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);
  // WsSpotState uses `aid` for account ID; also try legacy field names
  const accountID = data.aid ?? data.accountID ?? data.accountId ?? data.account_id ?? data.id;
  if (accountID == null) throw new Error('fetchSpotAccountState: accountID not found in response');
  return { ...data, accountID };
}

/**
 * Look up the numeric symbolID for a given symbol name on the spot market.
 * Returns null if the symbol cannot be found.
 */
export async function fetchSpotSymbolID(symbol: string): Promise<number | null> {
  try {
    const entry = await fetchSymbolEntry(symbol, 'spot');
    return (entry?.symbolID ?? entry?.id ?? entry?.symbolId ?? null) as number | null;
  } catch {
    return null;
  }
}

export async function fetchTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/tickers'));
  const raw = res?.data ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  // Normalize SoDEX field names to common aliases expected by consumers.
  // API uses: lastPx, changePct, bidPx, askPx
  return arr.map((t: Record<string, unknown>) => ({
    ...t,
    lastPrice: t.lastPx ?? t.lastPrice,
    close: t.lastPx ?? t.close,
    priceChangePercent: t.changePct ?? t.priceChangePercent,
    bidPrice: t.bidPx ?? t.bidPrice,
    askPrice: t.askPx ?? t.askPrice,
  }));
}

export async function fetchMiniTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/miniTickers'));
  return res?.data ?? res ?? [];
}

export async function fetchBookTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/bookTickers'));
  const raw = res?.data ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  // Normalize SoDEX field names: bidPx/askPx → bidPrice/askPrice/bid/ask
  return arr.map((t: Record<string, unknown>) => ({
    ...t,
    bidPrice: t.bidPx ?? t.bidPrice,
    askPrice: t.askPx ?? t.askPrice,
    bid: t.bidPx ?? t.bid,
    ask: t.askPx ?? t.ask,
  }));
}

export async function fetchOrderbook(symbol: string, market: 'spot' | 'perps' = 'perps', limit = 20) {
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const res = await withRetry(() => client.get(`/markets/${sym}/orderbook`, { params: { limit } }));
  return res?.data ?? res ?? { bids: [], asks: [] };
}

export async function fetchKlines(
  symbol: string,
  interval = '1h',
  limit = 100,
  market: 'spot' | 'perps' = 'perps',
) {
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const res = await withRetry(() => client.get(`/markets/${sym}/klines`, { params: { interval, limit } }));
  const raw = res?.data ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  // SoDEX RPCKline uses single-char field names: t, o, h, l, c, v, q
  // Normalize to common aliases expected by consumers.
  return arr.map((k: Record<string, unknown>) => ({
    ...k,
    time: k.t ?? k.time ?? k.openTime,
    openTime: k.t ?? k.openTime ?? k.time,
    open: k.o ?? k.open,
    high: k.h ?? k.high,
    low: k.l ?? k.low,
    close: k.c ?? k.close,
    volume: k.v ?? k.volume,
  }));
}

export async function fetchCoins(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/coins'));
  return res?.data ?? res ?? [];
}

export async function fetchMarkPrices() {
  const res = await withRetry(() => perpsClient.get('/markets/mark-prices'));
  return res?.data ?? res ?? [];
}

export async function fetchFundingRates() {
  const res = await withRetry(() => perpsClient.get('/markets/funding-rates'));
  return res?.data ?? res ?? [];
}

// ---------- Account (Private) ----------

export async function fetchAccountInfo(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}`));
  return res?.data ?? res ?? {};
}

export async function fetchBalances(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}/balances`));
  // API returns { blockTime, blockHeight, balances: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.balances ?? []);
}

export async function fetchPositions() {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res = await withRetry(() => perpsClient.get(`/accounts/${address}/positions`));
  // API returns { blockTime, blockHeight, positions: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.positions ?? []);
}

export async function fetchOpenOrders(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}/orders`));
  // API returns { blockTime, blockHeight, orders: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.orders ?? []);
}

// ---------- Trade (Private) ----------

export interface PlaceOrderParams {
  symbol: string;
  side: 1 | 2;           // 1=BUY, 2=SELL
  type: 1 | 2;           // 1=LIMIT, 2=MARKET
  quantity: string;
  price?: string;         // required for LIMIT
  timeInForce?: 1 | 3 | 4; // 1=GTC, 3=IOC, 4=GTX  (FOK not supported by SoDEX)
}

/**
 * Place a **spot** order.
 * Uses the batch endpoint (POST /trade/orders/batch) with BatchNewOrderRequest shape:
 *   { accountID, orders: [{ symbolID, clOrdID, side, type, timeInForce, price?, quantity?, funds? }] }
 * Field order matches the Go struct definition for correct payloadHash computation.
 */
async function placeSpotOrder(params: PlaceOrderParams): Promise<unknown> {
  const [accountState, symbolEntry] = await Promise.all([
    fetchSpotAccountState(),
    fetchSymbolEntry(params.symbol, 'spot'),
  ]);

  const symbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  if (symbolID == null) {
    throw new Error(`placeSpotOrder: symbolID not found for symbol "${params.symbol}"`);
  }

  const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

  // Default timeInForce: IOC (3) for market orders, GTC (1) for limit orders
  const timeInForce = params.timeInForce ?? (params.type === 2 ? 3 : 1);

  // Round price and quantity to exchange-required precision/tick multiples
  const rawQty = parseFloat(params.quantity);
  const quantity = roundToTick(rawQty, stepSize, quantityPrecision);
  const price = params.price !== undefined
    ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
    : undefined;

  // Build BatchNewOrderItem in Go struct field order:
  // symbolID, clOrdID, side, type, timeInForce, price(omitempty), quantity(omitempty), funds(omitempty)
  const orderItem: Record<string, unknown> = {
    symbolID,
    clOrdID: generateClOrdID(),
    side: params.side,
    type: params.type,
    timeInForce,
  };
  if (price !== undefined) orderItem.price = price;
  orderItem.quantity = quantity;

  // Build BatchNewOrderRequest in Go struct field order: accountID, orders
  const payload = {
    accountID: accountState.accountID,
    orders: [orderItem],
  };

  const res = await withRetry(() => spotClient.post('/trade/orders/batch', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);

  // Spot batch response is an array; unwrap first element
  const firstResult = Array.isArray(data) ? data[0] : data;
  return firstResult ?? data;
}

/**
 * Place a **perps** order.
 * Perps payload must be `{ accountID, symbolID, orders: [...] }`.
 * PerpsOrderItem fields must be in Go struct order:
 *   clOrdID, modifier, side, type, timeInForce, price(omitempty), quantity(omitempty),
 *   funds(omitempty), stopPrice(omitempty), stopType(omitempty), triggerType(omitempty),
 *   reduceOnly, positionSide
 */
async function placePerpsOrder(params: PlaceOrderParams): Promise<unknown> {
  const [accountState, symbolEntry] = await Promise.all([
    fetchPerpsAccountState(),
    fetchSymbolEntry(params.symbol, 'perps'),
  ]);

  const symbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  if (symbolID == null) {
    throw new Error(`placePerpsOrder: symbolID not found for symbol "${params.symbol}"`);
  }

  const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

  // Default timeInForce: IOC (3) for market orders, GTC (1) for limit orders
  const timeInForce = params.timeInForce ?? (params.type === 2 ? 3 : 1);

  // Round price and quantity to exchange-required precision/tick multiples
  const rawQty = parseFloat(params.quantity);
  const quantity = roundToTick(rawQty, stepSize, quantityPrecision);
  const price = params.price !== undefined
    ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
    : undefined;

  // Build PerpsOrderItem in Go struct field order (omitempty fields excluded when absent):
  // clOrdID, modifier, side, type, timeInForce, price?, quantity?, funds?, stopPrice?,
  // stopType?, triggerType?, reduceOnly, positionSide
  const order: Record<string, unknown> = {
    clOrdID: generateClOrdID(),
    modifier: 1,        // NORMAL = 1
    side: params.side,
    type: params.type,
    timeInForce,
  };
  if (price !== undefined) order.price = price;
  order.quantity = quantity;
  // funds, stopPrice, stopType, triggerType omitted (omitempty, unused for regular orders)
  order.reduceOnly = false;
  order.positionSide = 1; // BOTH = 1

  // Build PerpsNewOrderRequest in Go struct field order: accountID, symbolID, orders
  const payload = {
    accountID: accountState.accountID,
    symbolID,
    orders: [order],
  };

  const res = await withRetry(() => perpsClient.post('/trade/orders', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);

  // Unwrap the first order result from the response array
  const firstOrder = Array.isArray(data) ? data[0] : (Array.isArray(data?.orders) ? data.orders[0] : data);
  return firstOrder ?? data;
}

export async function placeOrder(params: PlaceOrderParams, market: 'spot' | 'perps' = 'perps') {
  return market === 'perps' ? placePerpsOrder(params) : placeSpotOrder(params);
}

/**
 * Place multiple orders in a single atomic batch request.
 * Returns the full batch response (array of per-order results).
 *
 * This is more efficient than calling placeOrder N times because:
 * - Single HTTP round-trip (lower latency, lower rate-limit cost)
 * - Atomic submission — all orders hit the matching engine together
 */
export async function placeBatchOrders(
  ordersList: PlaceOrderParams[],
  market: 'spot' | 'perps',
): Promise<unknown[]> {
  if (ordersList.length === 0) return [];

  // All orders in a batch must share the same symbol
  const symbol = ordersList[0].symbol;

  if (market === 'spot') {
    const [accountState, symbolEntry] = await Promise.all([
      fetchSpotAccountState(),
      fetchSymbolEntry(symbol, 'spot'),
    ]);

    const symbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
    if (symbolID == null) {
      throw new Error(`placeBatchOrders: symbolID not found for symbol "${symbol}"`);
    }

    const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

    const orders = ordersList.map((params) => {
      const timeInForce = params.timeInForce ?? (params.type === 2 ? 3 : 1);
      const rawQty = parseFloat(params.quantity);
      const quantity = roundToTick(rawQty, stepSize, quantityPrecision);
      const price = params.price !== undefined
        ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
        : undefined;

      // BatchNewOrderItem in Go struct field order
      const orderItem: Record<string, unknown> = {
        symbolID,
        clOrdID: generateClOrdID(),
        side: params.side,
        type: params.type,
        timeInForce,
      };
      if (price !== undefined) orderItem.price = price;
      orderItem.quantity = quantity;
      return orderItem;
    });

    const payload = {
      accountID: accountState.accountID,
      orders,
    };

    const res = await withRetry(() => spotClient.post('/trade/orders/batch', payload));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return Array.isArray(data) ? data : [data];
  } else {
    // Perps
    const [accountState, symbolEntry] = await Promise.all([
      fetchPerpsAccountState(),
      fetchSymbolEntry(symbol, 'perps'),
    ]);

    const symbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
    if (symbolID == null) {
      throw new Error(`placeBatchOrders: symbolID not found for symbol "${symbol}"`);
    }

    const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

    const orders = ordersList.map((params) => {
      const timeInForce = params.timeInForce ?? (params.type === 2 ? 3 : 1);
      const rawQty = parseFloat(params.quantity);
      const quantity = roundToTick(rawQty, stepSize, quantityPrecision);
      const price = params.price !== undefined
        ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
        : undefined;

      // PerpsOrderItem in Go struct field order
      const order: Record<string, unknown> = {
        clOrdID: generateClOrdID(),
        modifier: 1,
        side: params.side,
        type: params.type,
        timeInForce,
      };
      if (price !== undefined) order.price = price;
      order.quantity = quantity;
      order.reduceOnly = false;
      order.positionSide = 1;
      return order;
    });

    const payload = {
      accountID: accountState.accountID,
      symbolID,
      orders,
    };

    const res = await withRetry(() => perpsClient.post('/trade/orders', payload));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    const resultArray = Array.isArray(data) ? data : (Array.isArray(data?.orders) ? data.orders : [data]);
    return resultArray;
  }
}

/**
 * Update perps leverage/margin mode for a symbol.
 * marginMode: 1=ISOLATED, 2=CROSS
 */
export async function updatePerpsLeverage(
  symbol: string,
  leverage: number,
  marginMode: 1 | 2 = 2,
): Promise<void> {
  const [accountState, symbolID] = await Promise.all([
    fetchPerpsAccountState(),
    fetchPerpsSymbolID(symbol),
  ]);
  if (symbolID == null) {
    throw new Error(`updatePerpsLeverage: symbolID not found for "${symbol}"`);
  }

  const payload = {
    accountID: accountState.accountID,
    symbolID,
    leverage,
    marginMode,
  };

  const res = await withRetry(() => perpsClient.post('/trade/leverage', payload));
  const data = (res as { data?: unknown } | null)?.data ?? res ?? {};
  assertNoBodyError(data);
}

export async function cancelOrder(orderId: string, symbol: string, market: 'spot' | 'perps' = 'perps') {
  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`cancelOrder: symbolID not found for "${symbol}"`);

    // PerpsCancelItem in Go struct field order: symbolID, orderID(omitempty), clOrdID(omitempty)
    const cancelItem: Record<string, unknown> = { symbolID };
    const numericOrderId = parseOrderIdNumeric(orderId);
    if (orderId && !isNaN(numericOrderId)) {
      cancelItem.orderID = numericOrderId;
    } else if (orderId) {
      cancelItem.clOrdID = orderId;
    }

    // PerpsCancelOrderRequest in Go struct field order: accountID, cancels
    const payload = {
      accountID: accountState.accountID,
      cancels: [cancelItem],
    };

    const res = await withRetry(() => perpsClient.delete('/trade/orders', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  } else {
    // Spot
    const [accountState, symbolID] = await Promise.all([
      fetchSpotAccountState(),
      fetchSpotSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`cancelOrder: symbolID not found for "${symbol}"`);

    // BatchCancelOrderItem in Go struct field order:
    // symbolID, clOrdID(required — new ID for this cancel request), orderID(omitempty), origClOrdID(omitempty)
    const cancelItem: Record<string, unknown> = {
      symbolID,
      clOrdID: generateClOrdID(), // unique ID for this cancellation request
    };
    const numericOrderId = parseOrderIdNumeric(orderId);
    if (orderId && !isNaN(numericOrderId)) {
      cancelItem.orderID = numericOrderId;
    } else if (orderId) {
      cancelItem.origClOrdID = orderId; // treat string as original client order ID
    }

    // BatchCancelOrderRequest in Go struct field order: accountID, cancels
    const payload = {
      accountID: accountState.accountID,
      cancels: [cancelItem],
    };

    const res = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  }
}

export async function cancelAllOrders(symbol?: string, market: 'spot' | 'perps' = 'perps') {
  const orders = await fetchOpenOrders(market);
  const results: unknown[] = [];
  const ordersArray = Array.isArray(orders) ? orders : [];
  const normalizedFilter = symbol ? normalizeSymbol(symbol, market) : undefined;
  for (const order of ordersArray) {
    if (normalizedFilter && order.symbol !== normalizedFilter) continue;
    // API returns orderID (uint64); fall back to orderId/id for backwards compat.
    const orderId = String(order.orderID ?? order.orderId ?? order.id ?? '');
    if (orderId === '') continue;
    try {
      const r = await cancelOrder(orderId, order.symbol, market);
      results.push(r);
    } catch (e) {
      results.push({ error: e, orderId });
    }
  }
  return results;
}

// ---------- Fee Rates ----------

/** Default Tier-1 fee rates used as fallback when API call fails */
const DEFAULT_FEE_RATES = {
  perps: { makerFee: 0.00012, takerFee: 0.0004 },
  spot:  { makerFee: 0.00035, takerFee: 0.00065 },
} as const;

export interface FeeRateInfo {
  makerFee: number;
  takerFee: number;
}

/**
 * Fetch the real maker/taker fee rates for the current account from the SoDEX API.
 * Falls back to default Tier-1 rates if the call fails (e.g. no wallet configured).
 */
export async function fetchFeeRate(market: 'spot' | 'perps' = 'perps'): Promise<FeeRateInfo> {
  const normalizeFeeRate = (raw: number): number => {
    const abs = Math.abs(raw);
    // Convert percent-like values (e.g. 0.04 meaning 0.04%) to ratio (0.0004).
    return abs > 0.01 ? raw / 100 : raw;
  };

  try {
    const address = getEvmAddress();
    if (!address) throw new Error('No wallet configured');
    const client = getClient(market);
    const res = await withRetry(() => client.get(`/accounts/${address}/fee-rate`));
    const envelope = res?.data ?? res ?? {};
    assertNoBodyError(envelope);
    const data = envelope?.data ?? envelope;
    const makerFee = normalizeFeeRate(parseFloat(data.makerFeeRate ?? data.makerFee ?? data.maker_fee ?? data.maker));
    const takerFee = normalizeFeeRate(parseFloat(data.takerFeeRate ?? data.takerFee ?? data.taker_fee ?? data.taker));
    // maker fee can be negative when rebate is active; taker fee cannot.
    if (!Number.isFinite(makerFee) || !Number.isFinite(takerFee) || takerFee < 0) {
      throw new Error('Invalid fee rate response');
    }
    return { makerFee, takerFee };
  } catch {
    // Fallback to default rates
    return market === 'spot' ? { ...DEFAULT_FEE_RATES.spot } : { ...DEFAULT_FEE_RATES.perps };
  }
}

// ---------- Utility ----------

export async function fetchAccountOrders(
  market: 'spot' | 'perps' = 'perps',
  address?: string,
) {
  const addr = address || getEvmAddress();
  if (!addr) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${addr}/orders`));
  // API returns { blockTime, blockHeight, orders: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.orders ?? []);
}

// ---------- Order Status & Fill Verification ----------

export interface OrderStatusResult {
  orderId: string;
  status: string;
  filledQty: number;
  avgFillPrice: number;
  filledValue: number;
  totalFee: number;
}

/**
 * Fetch fill information for a specific order using the trades endpoint.
 * GET /accounts/{addr}/trades?symbol={sym}&orderID={id}&limit=50
 *
 * Returns aggregated fill data if any trades were found for the order.
 * Returns a zero-fill result (status EXPIRED) when no trades exist — meaning
 * the IOC order expired unfilled. Returns null only when the endpoint itself
 * fails (treat as "unverifiable").
 */
export async function fetchOrderStatus(
  orderId: string,
  symbol: string,
  market: 'spot' | 'perps' = 'perps',
): Promise<OrderStatusResult | null> {
  const address = getEvmAddress();
  if (!address) return null;
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const numericOrderId = parseOrderIdNumeric(orderId);
  try {
    const res = await client.get(`/accounts/${address}/trades`, {
      params: {
        symbol: sym,
        ...(orderId && !isNaN(numericOrderId) ? { orderID: numericOrderId } : {}),
        limit: 50,
      },
    });
    const trades = res?.data ?? res ?? [];
    if (!Array.isArray(trades)) return null;

    // Filter to only trades that belong to this specific order.
    // The endpoint may return all recent trades when orderID filtering is not
    // supported server-side; without this filter every status check would
    // aggregate unrelated fills and inflate the volume/fee metrics.
    const matchingTrades = trades.filter((t: Record<string, unknown>) => {
      const tradeOrderId = t.orderID ?? t.orderId ?? t.order_id;
      if (tradeOrderId == null) return false; // exclude trades with no ID — cannot verify ownership
      const tradeIdStr = String(tradeOrderId);
      return tradeIdStr === orderId || (!isNaN(numericOrderId) && Number(tradeOrderId) === numericOrderId);
    });

    if (matchingTrades.length === 0) {
      // No fills found for this order. For IOC/GTX orders this typically means
      // the order expired unfilled.
      return { orderId, status: 'EXPIRED', filledQty: 0, avgFillPrice: 0, filledValue: 0, totalFee: 0 };
    }

    // Aggregate fills across all trade executions for this order
    let totalQty = 0;
    let totalValue = 0;
    let totalFee = 0;
    for (const t of matchingTrades) {
      const qty = parseFloat(t.quantity ?? '0') || 0;
      const price = parseFloat(t.price ?? '0') || 0;
      const fee = parseFloat(t.fee ?? t.commission ?? '0') || 0;
      totalQty += qty;
      totalValue += qty * price;
      totalFee += fee;
    }
    const avgFillPrice = totalQty > 0 ? totalValue / totalQty : 0;

    return {
      orderId,
      status: 'FILLED',
      filledQty: totalQty,
      avgFillPrice,
      filledValue: totalValue,
      totalFee,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch recent fills / trades for the current account.
 */
export async function fetchAccountFills(
  market: 'spot' | 'perps' = 'perps',
  limit = 20,
): Promise<unknown[]> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  try {
    const res = await client.get(`/accounts/${address}/trades`, {
      params: { limit },
    });
    const list = res?.data ?? res ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// ---------- Account B / Signer Override Support ----------

/**
 * Override credentials for signing requests with a different account (Account B).
 * When provided, the request bypasses the default interceptor signing and uses
 * these credentials instead.
 */
export interface SignerOverride {
  apiKeyName: string;
  privateKey: string;
  address: string;
}

/**
 * Resolve the EVM address from a private key string.
 */
export function deriveEvmAddress(privateKey: string): string {
  if (!privateKey) return '';
  try {
    let pk = privateKey;
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    return new ethers.Wallet(pk).address;
  } catch {
    return '';
  }
}

/**
 * Get the base URL for a specific market.
 */
function getBaseURL(market: 'spot' | 'perps'): string {
  const { isTestnet } = useSettingsStore.getState();
  if (market === 'spot') {
    return isTestnet ? 'https://testnet-gw.sodex.dev/api/v1/spot' : 'https://mainnet-gw.sodex.dev/api/v1/spot';
  }
  return isTestnet ? 'https://testnet-gw.sodex.dev/api/v1/perps' : 'https://mainnet-gw.sodex.dev/api/v1/perps';
}

/**
 * Make a signed POST request using custom signer credentials (Account B).
 * This bypasses the axios interceptor and signs the payload manually.
 */
async function signedPost(
  url: string,
  payload: Record<string, unknown>,
  market: 'spot' | 'perps',
  signer: SignerOverride,
): Promise<unknown> {
  const { isTestnet } = useSettingsStore.getState();
  const baseURL = getBaseURL(market);
  const domainType = market === 'spot' ? 'spot' : 'futures';
  const actionType = deriveActionType('POST', url);

  const { signature, nonce } = await signPayload(actionType, payload, signer.privateKey, domainType, isTestnet, signer.apiKeyName);

  const res = await axios.post(`${baseURL}${url}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': signer.apiKeyName,
      'X-API-Nonce': nonce,
      'X-API-Sign': signature,
    },
  });

  const data = res?.data ?? {};
  assertNoBodyError(data);
  return data;
}

/**
 * Make a signed DELETE request using custom signer credentials (Account B).
 */
async function signedDelete(
  url: string,
  payload: Record<string, unknown>,
  market: 'spot' | 'perps',
  signer: SignerOverride,
): Promise<unknown> {
  const { isTestnet } = useSettingsStore.getState();
  const baseURL = getBaseURL(market);
  const domainType = market === 'spot' ? 'spot' : 'futures';
  const actionType = deriveActionType('DELETE', url);

  const { signature, nonce } = await signPayload(actionType, payload, signer.privateKey, domainType, isTestnet, signer.apiKeyName);

  const res = await axios.delete(`${baseURL}${url}`, {
    data: payload,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': signer.apiKeyName,
      'X-API-Nonce': nonce,
      'X-API-Sign': signature,
    },
  });

  const data = res?.data ?? {};
  assertNoBodyError(data);
  return data;
}

/**
 * Fetch account state for a specific address (used for Account B).
 */
export async function fetchAccountStateForAddress(
  address: string,
  market: 'spot' | 'perps',
): Promise<{ accountID: number | string; [key: string]: unknown }> {
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}/state`));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);
  const accountID = data.aid ?? data.accountID ?? data.accountId ?? data.account_id ?? data.id;
  if (accountID == null) throw new Error(`fetchAccountStateForAddress: accountID not found for ${address}`);
  return { ...data, accountID };
}

/**
 * Place an order with a custom signer (Account B support).
 * This creates the order payload and signs it with the provided credentials
 * instead of the default account.
 */
export async function placeOrderWithSigner(
  params: PlaceOrderParams,
  market: 'spot' | 'perps',
  signer: SignerOverride,
): Promise<unknown> {
  const [accountState, symbolEntry] = await Promise.all([
    fetchAccountStateForAddress(signer.address, market),
    fetchSymbolEntry(params.symbol, market),
  ]);

  const symbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  if (symbolID == null) {
    throw new Error(`placeOrderWithSigner: symbolID not found for symbol "${params.symbol}"`);
  }

  const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);
  const timeInForce = params.timeInForce ?? (params.type === 2 ? 3 : 1);

  const rawQty = parseFloat(params.quantity);
  const quantity = roundToTick(rawQty, stepSize, quantityPrecision);
  const price = params.price !== undefined
    ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
    : undefined;

  if (market === 'spot') {
    const orderItem: Record<string, unknown> = {
      symbolID,
      clOrdID: generateClOrdID(),
      side: params.side,
      type: params.type,
      timeInForce,
    };
    if (price !== undefined) orderItem.price = price;
    orderItem.quantity = quantity;

    const payload = {
      accountID: accountState.accountID,
      orders: [orderItem],
    };

    const data = await withRetry(() => signedPost('/trade/orders/batch', payload as Record<string, unknown>, market, signer));
    const result = data as Record<string, unknown> | unknown[];
    const firstResult = Array.isArray(result) ? result[0] : result;
    return firstResult ?? data;
  } else {
    // Perps
    const order: Record<string, unknown> = {
      clOrdID: generateClOrdID(),
      modifier: 1,
      side: params.side,
      type: params.type,
      timeInForce,
    };
    if (price !== undefined) order.price = price;
    order.quantity = quantity;
    order.reduceOnly = false;
    order.positionSide = 1;

    const payload = {
      accountID: accountState.accountID,
      symbolID,
      orders: [order],
    };

    const data = await withRetry(() => signedPost('/trade/orders', payload as Record<string, unknown>, market, signer));
    const result = data as Record<string, unknown>;
    const firstOrder = Array.isArray(result) ? result[0] : (Array.isArray(result?.orders) ? (result.orders as unknown[])[0] : result);
    return firstOrder ?? data;
  }
}

/**
 * Build a cancel item for a given orderId, used by batch cancel.
 */
function buildCancelItem(orderId: string, symbolID: number | string | null, includeClOrdID = false): Record<string, unknown> {
  const cancelItem: Record<string, unknown> = { symbolID };
  if (includeClOrdID) cancelItem.clOrdID = generateClOrdID();
  const numericOrderId = parseOrderIdNumeric(orderId);
  if (orderId && !isNaN(numericOrderId)) {
    cancelItem.orderID = numericOrderId;
  } else if (orderId) {
    if (includeClOrdID) {
      cancelItem.origClOrdID = orderId;
    } else {
      cancelItem.clOrdID = orderId;
    }
  }
  return cancelItem;
}

/**
 * Batch cancel open orders for a specific account.
 * Cancels orders by their IDs. Works for both primary and Account B.
 */
export async function batchCancelOrders(
  orderIds: string[],
  symbol: string,
  market: 'spot' | 'perps',
  signer?: SignerOverride,
): Promise<unknown> {
  if (orderIds.length === 0) return {};

  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      signer
        ? fetchAccountStateForAddress(signer.address, 'perps')
        : fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, symbolID));

    const payload = {
      accountID: accountState.accountID,
      cancels,
    };

    if (signer) {
      return await withRetry(() => signedDelete('/trade/orders', payload as Record<string, unknown>, 'perps', signer));
    }
    const res = await withRetry(() => perpsClient.delete('/trade/orders', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  } else {
    // Spot
    const [accountState, symbolID] = await Promise.all([
      signer
        ? fetchAccountStateForAddress(signer.address, 'spot')
        : fetchSpotAccountState(),
      fetchSpotSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, symbolID, true));

    const payload = {
      accountID: accountState.accountID,
      cancels,
    };

    if (signer) {
      return await withRetry(() => signedDelete('/trade/orders/batch', payload as Record<string, unknown>, 'spot', signer));
    }
    const res = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  }
}

/**
 * Fetch order fill status for a specific address (used for Account B fill verification).
 */
export async function fetchOrderStatusForAddress(
  orderId: string,
  symbol: string,
  market: 'spot' | 'perps',
  address: string,
): Promise<OrderStatusResult | null> {
  if (!address) return null;
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const numericOrderId = parseOrderIdNumeric(orderId);
  try {
    const res = await client.get(`/accounts/${address}/trades`, {
      params: {
        symbol: sym,
        ...(orderId && !isNaN(numericOrderId) ? { orderID: numericOrderId } : {}),
        limit: 50,
      },
    });
    const trades = res?.data ?? res ?? [];
    if (!Array.isArray(trades)) return null;

    const matchingTrades = trades.filter((t: Record<string, unknown>) => {
      const tradeOrderId = t.orderID ?? t.orderId ?? t.order_id;
      if (tradeOrderId == null) return false;
      const tradeIdStr = String(tradeOrderId);
      return tradeIdStr === orderId || (!isNaN(numericOrderId) && Number(tradeOrderId) === numericOrderId);
    });

    if (matchingTrades.length === 0) {
      return { orderId, status: 'EXPIRED', filledQty: 0, avgFillPrice: 0, filledValue: 0, totalFee: 0 };
    }

    let totalQty = 0;
    let totalValue = 0;
    let totalFee = 0;
    for (const t of matchingTrades) {
      const qty = parseFloat(t.quantity ?? '0') || 0;
      const price = parseFloat(t.price ?? '0') || 0;
      const fee = parseFloat(t.fee ?? t.commission ?? '0') || 0;
      totalQty += qty;
      totalValue += qty * price;
      totalFee += fee;
    }
    const avgFillPrice = totalQty > 0 ? totalValue / totalQty : 0;

    return {
      orderId,
      status: 'FILLED',
      filledQty: totalQty,
      avgFillPrice,
      filledValue: totalValue,
      totalFee,
    };
  } catch {
    return null;
  }
}

/**
 * Update perps leverage for a specific account (Account B support).
 */
export async function updatePerpsLeverageForAddress(
  symbol: string,
  leverage: number,
  marginMode: 1 | 2,
  signer: SignerOverride,
): Promise<void> {
  const [accountState, symbolID] = await Promise.all([
    fetchAccountStateForAddress(signer.address, 'perps'),
    fetchPerpsSymbolID(symbol),
  ]);
  if (symbolID == null) {
    throw new Error(`updatePerpsLeverageForAddress: symbolID not found for "${symbol}"`);
  }

  const payload = {
    accountID: accountState.accountID,
    symbolID,
    leverage,
    marginMode,
  };

  await withRetry(() => signedPost('/trade/leverage', payload as Record<string, unknown>, 'perps', signer));
}
