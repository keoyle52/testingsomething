import { perpsClient } from './perpsClient';
import { spotClient } from './spotClient';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

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

// Symbol cache — 60 second TTL
const _symbolCache = new Map<string, { entry: Record<string, unknown>; ts: number }>();
const SYMBOL_CACHE_TTL = 60_000;

// AccountState cache — 30 second TTL
const _accountStateCache = new Map<string, { state: { accountID: number | string; [key: string]: unknown }; ts: number }>();
const ACCOUNT_STATE_CACHE_TTL = 30_000;

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
  const isRetryableError = (err: unknown): boolean => {
    const e = err as {
      code?: string;
      response?: { status?: number };
    };
    const status = e?.response?.status;
    if (status != null) return status === 429 || status >= 500;
    return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(String(e?.code ?? ''));
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries - 1) throw err;
      if (!isRetryableError(err)) throw err;
      const backoff = Math.pow(2, attempt) * 1000;
      const jitter = Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, backoff + jitter));
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

function unwrapEnvelopeData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const nested = v.data;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
    return v;
  }
  return {};
}

function extractAccountIDFromPayload(value: unknown): number | string | null {
  const root = unwrapEnvelopeData(value);
  const id = root.aid ?? root.accountID ?? root.accountId ?? root.account_id ?? root.id;
  if (id == null) return null;
  if (typeof id === 'string' && id.trim() === '') return null;
  return id as number | string;
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
  // Use string-based integer arithmetic to avoid floating-point drift.
  // e.g. tickSize=0.001, precision=3 → factor=1000, tickUnits=1
  const safePrec = Math.max(0, Math.min(precision, 10));
  const factor = Math.pow(10, safePrec);
  const tickUnits = Math.max(1, Math.round(tickSize * factor));
  const valueUnits = Math.floor(value * factor + Number.EPSILON);
  const aligned = Math.floor(valueUnits / tickUnits) * tickUnits;
  if (aligned <= 0) {
    // Value was smaller than one tick — floor to exactly one tick so the order
    // doesn't fail with quantity=0.
    return (tickUnits / factor).toFixed(safePrec);
  }
  return (aligned / factor).toFixed(safePrec);
}

/**
 * Normalize quantity against symbol lot-size rules:
 * - Align to stepSize
 * - Enforce min/max quantity bounds
 * - Use marketMinQuantity/marketMaxQuantity for market orders when present
 */
function normalizeOrderQuantity(
  rawQuantity: number,
  orderType: 1 | 2,
  symbolEntry: Record<string, unknown> | null,
  quantityPrecision: number,
  stepSize: number,
  referencePrice?: number,
): string {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    throw new Error(`Invalid quantity: "${rawQuantity}"`);
  }

  const safePrecision = Math.max(0, Math.min(quantityPrecision, 10));
  const factor = Math.pow(10, safePrecision);
  const step = stepSize > 0 ? stepSize : DEFAULT_STEP_SIZE;
  const stepUnits = Math.max(1, Math.round(step * factor));

  const minQtyRaw = parseFloat(String(
    orderType === 2
      ? (symbolEntry?.marketMinQuantity ?? symbolEntry?.minQuantity ?? 0)
      : (symbolEntry?.minQuantity ?? 0),
  ));
  const maxQtyRaw = parseFloat(String(
    orderType === 2
      ? (symbolEntry?.marketMaxQuantity ?? symbolEntry?.maxQuantity ?? 0)
      : (symbolEntry?.maxQuantity ?? 0),
  ));

  const minQtyUnits = Number.isFinite(minQtyRaw) && minQtyRaw > 0
    ? Math.ceil((minQtyRaw * factor) / stepUnits) * stepUnits
    : 0;
  const maxQtyUnits = Number.isFinite(maxQtyRaw) && maxQtyRaw > 0
    ? Math.floor((maxQtyRaw * factor) / stepUnits) * stepUnits
    : 0;

  const minNotionalRaw = parseFloat(String(symbolEntry?.minNotional ?? 0));
  const refPriceRaw = Number.isFinite(referencePrice) && (referencePrice as number) > 0
    ? (referencePrice as number)
    : parseFloat(String(
      symbolEntry?.lastTradePrice
        ?? symbolEntry?.lastPx
        ?? symbolEntry?.markPrice
        ?? symbolEntry?.indexPrice
        ?? symbolEntry?.oraclePrice
        ?? 0,
    ));
  const notionalQtyUnits = (orderType === 2 && Number.isFinite(minNotionalRaw) && minNotionalRaw > 0 && Number.isFinite(refPriceRaw) && refPriceRaw > 0)
    ? Math.ceil(((minNotionalRaw / refPriceRaw) * factor) / stepUnits) * stepUnits
    : 0;

  let qtyUnits = Math.floor((rawQuantity * factor) / stepUnits) * stepUnits;
  if (qtyUnits <= 0) qtyUnits = stepUnits;
  if (minQtyUnits > 0 && qtyUnits < minQtyUnits) qtyUnits = minQtyUnits;
  if (notionalQtyUnits > 0 && qtyUnits < notionalQtyUnits) qtyUnits = notionalQtyUnits;
  if (maxQtyUnits > 0 && qtyUnits > maxQtyUnits) {
    throw new Error(
      `Quantity exceeds max allowed (${(maxQtyUnits / factor).toFixed(safePrecision)}) for this symbol/order type`,
    );
  }

  const fixed = (qtyUnits / factor).toFixed(safePrecision);
  return fixed.replace(/\.?0+$/, '');
}

async function fetchReferencePrice(
  symbol: string,
  market: 'spot' | 'perps',
  side: 1 | 2,
): Promise<number> {
  const tickers = await fetchBookTickers(market);
  const arr = Array.isArray(tickers) ? tickers : [];
  const normalizedSym = normalizeSymbol(symbol, market);
  const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normalizedSym) as Record<string, unknown> | undefined;
  const bid = parseFloat(String(ticker?.bidPrice ?? ticker?.bid ?? '0'));
  const ask = parseFloat(String(ticker?.askPrice ?? ticker?.ask ?? '0'));
  if (side === 1 && Number.isFinite(ask) && ask > 0) return ask;
  if (side === 2 && Number.isFinite(bid) && bid > 0) return bid;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  throw new Error(`No valid reference price found for ${normalizedSym}`);
}

function extractApiErrorMessage(err: unknown): string {
  const e = err as {
    message?: unknown;
    response?: { data?: { error?: unknown; message?: unknown; code?: unknown } };
  };
  return String(
    e?.response?.data?.error
      ?? e?.response?.data?.message
      ?? e?.message
      ?? '',
  ).toLowerCase();
}

/**
 * Look up the full symbol entry (including precision metadata) for a given
 * symbol on the specified market.  Returns null when not found.
 * Results are cached for SYMBOL_CACHE_TTL ms to avoid redundant API calls.
 */
async function fetchSymbolEntry(symbol: string, market: 'spot' | 'perps'): Promise<Record<string, unknown> | null> {
  const cacheKey = `${market}:${symbol}`;
  const cached = _symbolCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SYMBOL_CACHE_TTL) return cached.entry;
  try {
    const symbols = await fetchSymbols(market);
    const list = Array.isArray(symbols) ? symbols : (symbols?.symbols ?? symbols?.data ?? []);
    const normalised = normalizeSymbol(symbol, market);
    const entry = list.find(
      (s: Record<string, unknown>) => s.symbol === normalised || s.name === normalised || s.ticker === normalised,
    ) ?? null;
    if (entry) _symbolCache.set(cacheKey, { entry, ts: Date.now() });
    return entry;
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
 * Results are cached for ACCOUNT_STATE_CACHE_TTL ms.
 */
export async function fetchPerpsAccountState(): Promise<{ accountID: number | string; [key: string]: unknown }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const cacheKey = `perps:${address}`;
  const cached = _accountStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACCOUNT_STATE_CACHE_TTL) return cached.state;
  const stateRes = await withRetry(() => perpsClient.get(`/accounts/${address}/state`));
  const stateData = stateRes?.data ?? stateRes ?? {};
  assertNoBodyError(stateData);
  let accountID = extractAccountIDFromPayload(stateData);
  let parsed = unwrapEnvelopeData(stateData);

  if (accountID == null) throw new Error('fetchPerpsAccountState: accountID not found in response');
  const state = { ...parsed, accountID };
  _accountStateCache.set(cacheKey, { state, ts: Date.now() });
  return state;
}

/**
 * Fetch the spot account state for the current wallet.
 * Uses /state endpoint which returns WsSpotState (aid = Account ID).
 * Returns an object containing at minimum `accountID`.
 * Results are cached for ACCOUNT_STATE_CACHE_TTL ms.
 */
export async function fetchSpotAccountState(): Promise<{ accountID: number | string; [key: string]: unknown }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const cacheKey = `spot:${address}`;
  const cached = _accountStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACCOUNT_STATE_CACHE_TTL) return cached.state;
  const stateRes = await withRetry(() => spotClient.get(`/accounts/${address}/state`));
  const stateData = stateRes?.data ?? stateRes ?? {};
  assertNoBodyError(stateData);
  let accountID = extractAccountIDFromPayload(stateData);
  let parsed = unwrapEnvelopeData(stateData);

  if (accountID == null) throw new Error('fetchSpotAccountState: accountID not found in response');
  const state = { ...parsed, accountID };
  _accountStateCache.set(cacheKey, { state, ts: Date.now() });
  return state;
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
  // TP/SL fields (Perps only)
  stopPrice?: string;
  stopType?: 1 | 2;      // 1=STOP_LOSS, 2=TAKE_PROFIT
  triggerType?: 2;       // 2=MARK_PRICE
  reduceOnly?: boolean;  // defaults to false if omitted
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
  if (isNaN(rawQty) || rawQty <= 0) throw new Error(`placeSpotOrder: invalid quantity "${params.quantity}"`);
  const quantity = normalizeOrderQuantity(rawQty, params.type, symbolEntry, quantityPrecision, stepSize);
  const price = params.price !== undefined
    ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
    : undefined;
  const useFundsForMarketBuy = params.type === 2 && params.side === 1;
  let funds: string | undefined;
  if (useFundsForMarketBuy) {
    const refPrice = await fetchReferencePrice(params.symbol, 'spot', params.side);
    const notional = parseFloat(quantity) * refPrice;
    funds = notional.toFixed(Math.max(2, Math.min(pricePrecision, 8)));
  }

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
  if (useFundsForMarketBuy) {
    orderItem.funds = funds;
  } else {
    orderItem.quantity = quantity;
  }

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
  if (isNaN(rawQty) || rawQty <= 0) throw new Error(`placePerpsOrder: invalid quantity "${params.quantity}"`);
  const refPrice = params.type === 2 ? await fetchReferencePrice(params.symbol, 'perps', params.side) : undefined;
  const quantity = normalizeOrderQuantity(rawQty, params.type, symbolEntry, quantityPrecision, stepSize, refPrice);
  const price = params.price !== undefined
    ? roundToTick(parseFloat(params.price), tickSize, pricePrecision)
    : undefined;

  // Build PerpsOrderItem in Go struct field order (omitempty fields excluded when absent):
  // clOrdID, modifier, side, type, timeInForce, price?, quantity?, funds?, stopPrice?,
  // stopType?, triggerType?, reduceOnly, positionSide
  const isStop = params.stopType === 1 || params.stopType === 2;
  const modifier = isStop ? 2 : 1;

  const order: Record<string, unknown> = {
    clOrdID: generateClOrdID(),
    modifier,
    side: params.side,
    type: params.type,
    timeInForce,
  };
  if (price !== undefined) order.price = price;
  order.quantity = quantity;

  if (isStop && params.stopPrice) {
    order.stopPrice = roundToTick(parseFloat(params.stopPrice), tickSize, pricePrecision);
    order.stopType = params.stopType;
    order.triggerType = params.triggerType ?? 2; // Default MARK_PRICE
  }

  order.reduceOnly = params.reduceOnly ?? false;
  order.positionSide = 1; // BOTH = 1

  // Build PerpsNewOrderRequest in Go struct field order: accountID, symbolID, orders
  const payload = {
    accountID: accountState.accountID,
    symbolID,
    orders: [order],
  };

  let data: unknown;
  try {
    const res = await withRetry(() => perpsClient.post('/trade/orders', payload));
    data = res?.data ?? res ?? {};
    assertNoBodyError(data);
  } catch (err) {
    // Some environments reject market BUY quantity while accepting funds.
    // Retry once with `funds` if we hit the known server-side quantity validation error.
    const isMarketBuy = params.type === 2 && params.side === 1;
    const isQuantityInvalid = extractApiErrorMessage(err).includes('quantity is invalid');
    if (!isMarketBuy || !isQuantityInvalid) throw err;

    const refPrice = await fetchReferencePrice(params.symbol, 'perps', params.side);
    const quantityAsNumber = parseFloat(quantity);
    const funds = (quantityAsNumber * refPrice).toFixed(Math.max(2, Math.min(pricePrecision, 8))).replace(/\.?0+$/, '');

    // Retry #1: quantity again but forced plain-trim format.
    const fallbackQtyOrder: Record<string, unknown> = {
      clOrdID: generateClOrdID(),
      modifier: 1,
      side: params.side,
      type: params.type,
      timeInForce,
      quantity: String(quantityAsNumber),
      reduceOnly: false,
      positionSide: 1,
    };
    const fallbackQtyPayload = {
      accountID: accountState.accountID,
      symbolID,
      orders: [fallbackQtyOrder],
    };
    try {
      const retryRes = await withRetry(() => perpsClient.post('/trade/orders', fallbackQtyPayload));
      data = retryRes?.data ?? retryRes ?? {};
      assertNoBodyError(data);
    } catch (retryErr) {
      // Retry #2: use funds for market BUY only.
      const retryIsQuantityInvalid = extractApiErrorMessage(retryErr).includes('quantity is invalid');
      if (!retryIsQuantityInvalid) throw retryErr;
      const fallbackOrder: Record<string, unknown> = {
        clOrdID: generateClOrdID(),
        modifier: 1,
        side: params.side,
        type: params.type,
        timeInForce,
        funds,
        reduceOnly: false,
        positionSide: 1,
      };
      const fallbackPayload = {
        accountID: accountState.accountID,
        symbolID,
        orders: [fallbackOrder],
      };
      const fallbackRes = await withRetry(() => perpsClient.post('/trade/orders', fallbackPayload));
      data = fallbackRes?.data ?? fallbackRes ?? {};
      assertNoBodyError(data);
    }
  }

  // Unwrap the first order result from the response array
  const resultData = data as Record<string, unknown> | unknown[];
  const firstOrder = Array.isArray(resultData)
    ? resultData[0]
    : (Array.isArray((resultData as Record<string, unknown>)?.orders)
      ? ((resultData as Record<string, unknown>).orders as unknown[])[0]
      : resultData);
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
      const quantity = normalizeOrderQuantity(rawQty, params.type, symbolEntry, quantityPrecision, stepSize);
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
      const quantity = normalizeOrderQuantity(rawQty, params.type, symbolEntry, quantityPrecision, stepSize);
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
      const fee = parseFloat(String(t.feeAmt ?? t.fee ?? t.commission ?? t.totalFee ?? '0')) || 0;
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
  return fetchTargetAccountFills(market, address, limit);
}

/**
 * Fetch recent fills / trades for ANY target account (used by Copy Trader).
 */
export async function fetchTargetAccountFills(
  market: 'spot' | 'perps',
  targetAddress: string,
  limit = 50,
): Promise<unknown[]> {
  const client = getClient(market);
  try {
    const res = await client.get(`/accounts/${targetAddress}/trades`, {
      params: { limit },
    });
    const list = res?.data ?? res ?? [];
    return Array.isArray(list) ? list : (list.trades ?? []);
  } catch {
    return [];
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
 * Batch cancel open orders for the current account.
 * Cancels orders by their IDs.
 */
export async function batchCancelOrders(
  orderIds: string[],
  symbol: string,
  market: 'spot' | 'perps',
): Promise<unknown> {
  if (orderIds.length === 0) return {};

  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, symbolID));
    const payload = { accountID: accountState.accountID, cancels };
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
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, symbolID, true));
    const payload = { accountID: accountState.accountID, cancels };
    const res = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data);
    return data;
  }
}
