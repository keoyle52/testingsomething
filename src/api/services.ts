import { perpsClient } from './perpsClient';
import { spotClient } from './spotClient';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

// ---------- internal helpers ----------

/**
 * Throw if the exchange returned a body-level error even though HTTP was 200.
 * SoDEX perps API returns `{ code: -1, error: "..." }` on bad requests.
 */
function assertNoBodyError(data: any): void {
  if (data && typeof data === 'object' && 'code' in data && data.code !== 0) {
    throw new Error(data.error ?? data.message ?? `API error code ${data.code}`);
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
  const res: any = await withRetry(() => client.get('/markets/symbols'));
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
async function fetchSymbolEntry(symbol: string, market: 'spot' | 'perps'): Promise<any | null> {
  try {
    const symbols = await fetchSymbols(market);
    const list: any[] = Array.isArray(symbols) ? symbols : (symbols?.symbols ?? symbols?.data ?? []);
    const normalised = normalizeSymbol(symbol, market);
    return list.find(
      (s: any) => s.symbol === normalised || s.name === normalised || s.ticker === normalised,
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract SymbolPrecision from a raw symbol entry object.
 * Falls back to safe defaults (8 decimal places, tick = 0.00000001) when fields are missing.
 */
function extractPrecision(entry: any): Omit<SymbolPrecision, 'symbolID'> {
  const pricePrecision = entry?.pricePrecision ?? DEFAULT_PRICE_PRECISION;
  const tickSize = parseFloat(entry?.tickSize ?? String(DEFAULT_TICK_SIZE)) || DEFAULT_TICK_SIZE;
  const quantityPrecision = entry?.quantityPrecision ?? DEFAULT_QUANTITY_PRECISION;
  const stepSize = parseFloat(entry?.stepSize ?? String(DEFAULT_STEP_SIZE)) || DEFAULT_STEP_SIZE;
  return { pricePrecision, tickSize, quantityPrecision, stepSize };
}

export async function fetchSymbolTradingRules(
  symbol: string,
  market: 'spot' | 'perps',
): Promise<SymbolTradingRules> {
  const entry = await fetchSymbolEntry(symbol, market);
  const { quantityPrecision, stepSize } = extractPrecision(entry);
  return { quantityPrecision, stepSize };
}

/**
 * Look up the numeric symbolID for a given symbol name on the perps market.
 * Returns null if the symbol cannot be found.
 */
export async function fetchPerpsSymbolID(symbol: string): Promise<number | null> {
  try {
    const entry = await fetchSymbolEntry(symbol, 'perps');
    return entry?.symbolID ?? entry?.id ?? entry?.symbolId ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the perps account state for the current wallet.
 * Uses /state endpoint which returns WsPerpsState (aid = Account ID).
 * Returns an object containing at minimum `accountID`.
 */
export async function fetchPerpsAccountState(): Promise<{ accountID: number | string; [key: string]: any }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res: any = await withRetry(() => perpsClient.get(`/accounts/${address}/state`));
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
export async function fetchSpotAccountState(): Promise<{ accountID: number | string; [key: string]: any }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res: any = await withRetry(() => spotClient.get(`/accounts/${address}/state`));
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
    return entry?.symbolID ?? entry?.id ?? entry?.symbolId ?? null;
  } catch {
    return null;
  }
}

export async function fetchTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await withRetry(() => client.get('/markets/tickers'));
  return res?.data ?? res ?? [];
}

export async function fetchMiniTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await withRetry(() => client.get('/markets/miniTickers'));
  return res?.data ?? res ?? [];
}

export async function fetchBookTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await withRetry(() => client.get('/markets/bookTickers'));
  return res?.data ?? res ?? [];
}

export async function fetchOrderbook(symbol: string, market: 'spot' | 'perps' = 'perps', limit = 20) {
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const res: any = await withRetry(() => client.get(`/markets/${sym}/orderbook`, { params: { limit } }));
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
  const res: any = await withRetry(() => client.get(`/markets/${sym}/klines`, { params: { interval, limit } }));
  return res?.data ?? res ?? [];
}

export async function fetchCoins(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await withRetry(() => client.get('/markets/coins'));
  return res?.data ?? res ?? [];
}

export async function fetchMarkPrices() {
  const res: any = await withRetry(() => perpsClient.get('/markets/mark-prices'));
  return res?.data ?? res ?? [];
}

export async function fetchFundingRates() {
  const res: any = await withRetry(() => perpsClient.get('/markets/funding-rates'));
  return res?.data ?? res ?? [];
}

// ---------- Account (Private) ----------

export async function fetchAccountInfo(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await withRetry(() => client.get(`/accounts/${address}`));
  return res?.data ?? res ?? {};
}

export async function fetchBalances(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await withRetry(() => client.get(`/accounts/${address}/balances`));
  return res?.data ?? res ?? [];
}

export async function fetchPositions() {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res: any = await withRetry(() => perpsClient.get(`/accounts/${address}/positions`));
  return res?.data ?? res ?? [];
}

export async function fetchOpenOrders(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await withRetry(() => client.get(`/accounts/${address}/orders`));
  return res?.data ?? res ?? [];
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
async function placeSpotOrder(params: PlaceOrderParams): Promise<any> {
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
  const orderItem: Record<string, any> = {
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

  const res: any = await withRetry(() => spotClient.post('/trade/orders/batch', payload));
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
async function placePerpsOrder(params: PlaceOrderParams): Promise<any> {
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
  const order: Record<string, any> = {
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

  const res: any = await withRetry(() => perpsClient.post('/trade/orders', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);

  // Unwrap the first order result from the response array
  const firstOrder = Array.isArray(data) ? data[0] : (Array.isArray(data?.orders) ? data.orders[0] : data);
  return firstOrder ?? data;
}

export async function placeOrder(params: PlaceOrderParams, market: 'spot' | 'perps' = 'perps') {
  return market === 'perps' ? placePerpsOrder(params) : placeSpotOrder(params);
}

export async function cancelOrder(orderId: string, symbol: string, market: 'spot' | 'perps' = 'perps') {
  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`cancelOrder: symbolID not found for "${symbol}"`);

    // PerpsCancelItem in Go struct field order: symbolID, orderID(omitempty), clOrdID(omitempty)
    const cancelItem: Record<string, any> = { symbolID };
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

    const res: any = await withRetry(() => perpsClient.delete('/trade/orders', { data: payload }));
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
    const cancelItem: Record<string, any> = {
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

    const res: any = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  }
}

export async function cancelAllOrders(symbol?: string, market: 'spot' | 'perps' = 'perps') {
  const orders = await fetchOpenOrders(market);
  const results: any[] = [];
  const ordersArray = Array.isArray(orders) ? orders : [];
  const normalizedFilter = symbol ? normalizeSymbol(symbol, market) : undefined;
  for (const order of ordersArray) {
    if (normalizedFilter && order.symbol !== normalizedFilter) continue;
    try {
      const r = await cancelOrder(order.orderId ?? order.id, order.symbol, market);
      results.push(r);
    } catch (e) {
      results.push({ error: e, orderId: order.orderId ?? order.id });
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
  try {
    const address = getEvmAddress();
    if (!address) throw new Error('No wallet configured');
    const client = getClient(market);
    const res: any = await withRetry(() => client.get(`/accounts/${address}/fee-rate`));
    const data = res?.data ?? res ?? {};
    const makerFee = parseFloat(data.makerFee ?? data.maker_fee ?? data.maker);
    const takerFee = parseFloat(data.takerFee ?? data.taker_fee ?? data.taker);
    if (isNaN(makerFee) || isNaN(takerFee) || makerFee < 0 || takerFee < 0) {
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
  const res: any = await withRetry(() => client.get(`/accounts/${addr}/orders`));
  return res?.data ?? res ?? [];
}

// ---------- Order Status & Fill Verification ----------

export interface OrderStatusResult {
  orderId: string;
  status: string;
  filledQty: number;
  avgFillPrice: number;
  filledValue: number;
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
    const res: any = await client.get(`/accounts/${address}/trades`, {
      params: {
        symbol: sym,
        ...(orderId && !isNaN(numericOrderId) ? { orderID: numericOrderId } : {}),
        limit: 50,
      },
    });
    const trades: any[] = res?.data ?? res ?? [];
    if (!Array.isArray(trades)) return null;

    if (trades.length === 0) {
      // No fills found. For IOC/GTX orders this typically means the order expired
      // unfilled. It may also mean the order is still in flight (unlikely after the
      // FILL_VERIFICATION_DELAY_MS wait). Using EXPIRED is a safe assumption here;
      // callers that see filledQty === 0 will not count volume.
      return { orderId, status: 'EXPIRED', filledQty: 0, avgFillPrice: 0, filledValue: 0 };
    }

    // Aggregate fills across all trade executions for this order
    let totalQty = 0;
    let totalValue = 0;
    for (const t of trades) {
      const qty = parseFloat(t.quantity ?? '0') || 0;
      const price = parseFloat(t.price ?? '0') || 0;
      totalQty += qty;
      totalValue += qty * price;
    }
    const avgFillPrice = totalQty > 0 ? totalValue / totalQty : 0;

    return {
      orderId,
      status: 'FILLED',
      filledQty: totalQty,
      avgFillPrice,
      filledValue: totalValue,
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
): Promise<any[]> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  try {
    const res: any = await client.get(`/accounts/${address}/trades`, {
      params: { limit },
    });
    const list = res?.data ?? res ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
