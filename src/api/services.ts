import { perpsClient } from './perpsClient';
import { spotClient } from './spotClient';
import { useSettingsStore } from '../store/settingsStore';
import { deriveAddressFromPrivateKey } from './signer';
import {
  demoPlaceOrder,
  demoPlaceBatchOrders,
  demoCancelOrder,
  demoBatchCancelOrders,
  demoCancelAllOrders,
  demoReplaceOrders,
  demoScheduleCancelAll,
  demoUpdateLeverage,
  getDemoTickers,
  getDemoMiniTickers,
  getDemoBookTickers,
  getDemoMarkPrices,
  getDemoFundingRates,
  getDemoOrderbook,
  getDemoKlines,
  getDemoBalances,
  getDemoPositions,
  getDemoOpenOrders,
  getDemoOrderHistory,
  getDemoAccountFills,
  getDemoAccountState,
  getDemoFeeRate,
  getDemoOrderStatus,
  type DemoReplaceInput,
} from './demoEngine';

// ---------- internal helpers ----------

/** True when demo mode is active — every service function short-circuits to `demoEngine`. */
function isDemo(): boolean {
  return useSettingsStore.getState().isDemoMode;
}

/**
 * Throw if the exchange returned a body-level error even though HTTP was 200.
 *
 * SoDEX responses come in two shapes:
 *   1. Envelope:  `{ code: -1, error: "..." }` — a whole-request failure.
 *   2. Array-of-results (new order / cancel / replace):
 *         `[{ code: 0, clOrdID, orderID: 123 }, { code: -2011, clOrdID, error: "insufficient margin" }, ...]`
 *      Here the HTTP status is 200 even when individual orders were rejected.
 *
 * This helper throws a single combined error if ANY of the per-order
 * results has `code != 0`, so the UI never logs "placed" for an order
 * that the exchange actually rejected (e.g. margin check failure).
 *
 * @param data   The response body.
 * @param label  Optional label prepended to the thrown message for context.
 */
function assertNoBodyError(data: unknown, label?: string): void {
  const prefix = label ? `${label}: ` : '';

  // Shape 1: single-envelope failure (`{ code, error }`).
  if (data && typeof data === 'object' && !Array.isArray(data) && 'code' in data && (data as { code: unknown }).code !== 0) {
    const d = data as Record<string, unknown>;
    throw new Error(`${prefix}${d.error ?? d.message ?? `API error code ${d.code}`}`);
  }

  // Shape 2: array of per-order results — any item with code!=0 is a
  // rejection. Surface every distinct error so the user can see which
  // order(s) failed and why.
  if (Array.isArray(data)) {
    const failures: string[] = [];
    for (const item of data) {
      if (item && typeof item === 'object' && 'code' in item && (item as { code: unknown }).code !== 0) {
        const it = item as Record<string, unknown>;
        const msg = String(it.error ?? it.message ?? `code ${it.code}`);
        const cl = it.clOrdID ? ` (clOrdID=${it.clOrdID})` : '';
        failures.push(`${msg}${cl}`);
      }
    }
    if (failures.length > 0) {
      // De-dupe identical messages so batches rejected for the same reason
      // (e.g. 5× "insufficient margin") read cleanly.
      const unique = Array.from(new Set(failures));
      throw new Error(`${prefix}${unique.join('; ')}`);
    }
  }

  // Shape 3: `{ orders: [...] }` envelope where the list itself holds
  // per-order results. Recurse into the inner array.
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).orders)) {
    assertNoBodyError((data as Record<string, unknown>).orders, label);
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

// Symbol cache — 60 second TTL. Keyed by (network, market, symbol) so
// mainnet and testnet symbol IDs cannot be confused.
const _symbolCache = new Map<string, { entry: Record<string, unknown>; ts: number }>();
const SYMBOL_CACHE_TTL = 60_000;

// AccountState cache — 30 second TTL. Keyed by (network, market, address)
// because mainnet and testnet accountIDs are different for the same wallet.
const _accountStateCache = new Map<string, { state: { accountID: number | string; [key: string]: unknown }; ts: number }>();
const ACCOUNT_STATE_CACHE_TTL = 30_000;

// Public market-data caches — 30 second TTL. Predictor + sibling pages
// often fetch the same tickers / orderbook / klines payload within the
// same render tick (double effect mount, stop/start, parallel widgets).
// 30s is short enough that next prediction cycle always sees fresh
// data, but long enough to absorb back-to-back duplicates.
const _tickersCache   = new Map<string, { data: unknown; ts: number }>();
const _orderbookCache = new Map<string, { data: unknown; ts: number }>();
const _klinesCache    = new Map<string, { data: unknown; ts: number }>();
const QUOTE_CACHE_TTL = 30_000;

/** Short network tag used to namespace caches so testnet/mainnet do not share entries. */
function getNetworkTag(): 'test' | 'main' {
  return useSettingsStore.getState().isTestnet ? 'test' : 'main';
}

/**
 * Clear all in-memory caches. Call this when switching networks, wallets or
 * otherwise invalidating the current session so the next request fetches fresh
 * data instead of returning stale cross-network entries.
 */
export function clearServiceCaches(): void {
  _symbolCache.clear();
  _accountStateCache.clear();
  _tickersCache.clear();
  _orderbookCache.clear();
  _klinesCache.clear();
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

/**
 * Resolve the master EVM address used in REST URL paths
 * (`/accounts/{userAddress}/...`).
 *
 * Per SoDEX docs:
 *  - Testnet → the private key is the master wallet's key, so the derived
 *    address equals the master address.
 *  - Mainnet → the private key is the API key (agent) private key, which
 *    derives to the agent address, NOT the master. The user MUST provide
 *    the master `evmAddress` explicitly in Settings for URL paths to work.
 *
 * When both are available we prefer the explicit `evmAddress`, otherwise
 * we fall back to the derived one. Returned value is lower-cased to
 * ensure path matching is consistent.
 */
function getEvmAddress(): string {
  const { privateKey, evmAddress } = useSettingsStore.getState();
  const explicit = (evmAddress ?? '').trim();
  if (explicit) return explicit.toLowerCase();
  const derived = deriveAddressFromPrivateKey(privateKey);
  return derived ? derived.toLowerCase() : '';
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
  if (isDemo()) {
    // Derive a minimal symbol list from the demo ticker snapshot so callers
    // like `fetchSymbolEntry` still get a sensible record for any symbol.
    return getDemoTickers(market).map((t) => ({
      symbol: t.symbol,
      name: t.symbol,
      symbolID: Math.abs(hashCode(t.symbol)) % 10_000 + 1,
      pricePrecision: 2,
      tickSize: '0.01',
      quantityPrecision: 4,
      stepSize: '0.0001',
      minQuantity: '0.0001',
      maxQuantity: '1000000',
      marketMinQuantity: '0.0001',
      marketMaxQuantity: '1000000',
      minNotional: '1',
      maxNotional: '10000000',
      maxLeverage: 25,
      initLeverage: 5,
      lastTradePrice: String(t.lastPrice),
      status: 'TRADING',
    }));
  }
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/symbols'));
  return res?.data ?? res ?? [];
}

/** Deterministic 32-bit hash used to generate stable demo symbolIDs. */
function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h;
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

// Helper to extract error message from various error formats
export function extractApiErrorMessage(err: unknown): string {
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
 * Cache is namespaced per network so testnet/mainnet metadata never mix.
 */
async function fetchSymbolEntry(symbol: string, market: 'spot' | 'perps'): Promise<Record<string, unknown> | null> {
  const cacheKey = `${getNetworkTag()}:${market}:${symbol}`;
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
 * Symbol metadata exposed to UIs that need to clamp leverage against the
 * exchange's per-market cap (NewsBot's leverage slider, BtcPredictor's
 * auto-trader, manual order forms, ...).
 */
export interface PerpsSymbolMeta {
  /** Fully-qualified symbol that exists on SoDEX (e.g. "BTC-USD"). */
  symbol: string;
  /** Hard cap accepted by `updatePerpsLeverage` for this symbol. */
  maxLeverage: number;
  /** Exchange's default leverage if the user has never set one. */
  initLeverage: number;
}

/**
 * Resolve a bare ticker like "BTC" to the first matching SoDEX perps
 * symbol AND its leverage limits. Probes BTC-USD → BTC-USDC → BTC-USDT
 * in that order against the cached symbol list, so repeat calls within
 * SYMBOL_CACHE_TTL are free.
 *
 * Returns null when none of the candidate quote variants are listed.
 * The numeric fields fall back to conservative defaults (50 / 5) only
 * when the API entry exists but doesn't expose the field.
 */
export async function getPerpsSymbolMeta(ticker: string): Promise<PerpsSymbolMeta | null> {
  const upper = ticker.toUpperCase();
  const candidates = [`${upper}-USD`, `${upper}-USDC`, `${upper}-USDT`];
  for (const cand of candidates) {
    const entry = await fetchSymbolEntry(cand, 'perps');
    if (!entry) continue;
    const max  = Number(entry.maxLeverage  ?? entry.maxLev          ?? 0);
    const init = Number(entry.initLeverage ?? entry.defaultLeverage ?? 0);
    return {
      symbol:       String(entry.symbol ?? cand),
      maxLeverage:  Number.isFinite(max)  && max  > 0 ? max  : 25,
      initLeverage: Number.isFinite(init) && init > 0 ? init : 5,
    };
  }
  return null;
}

/**
 * Attempt to extract the numeric account ID from a raw API response.
 *
 * NOTE: `perpsClient` / `spotClient` response interceptors already unwrap
 * axios `response.data`, so the value we receive from `.get()`/`.post()`
 * IS the JSON body itself. The body may be:
 *   Shape A (envelope): { code: 0, data: { aid: 123, ... } }
 *   Shape B (flat):     { aid: 123, balances: [...] }
 *
 * We look for **explicit account-id keys only** — generic `id` is too
 * ambiguous (symbol IDs, order IDs, trade IDs etc. all use the same name).
 * Per schema, the canonical key is `aid` on `WsPerpsState` / `WsSpotState`.
 */
function extractAccountIDDeep(raw: unknown): number | null {
  if (raw == null || typeof raw !== 'object') return null;

  const ACCOUNT_ID_KEYS = ['aid', 'accountID', 'accountId', 'AccountID', 'account_id'];

  const tryExtract = (obj: Record<string, unknown>): number | null => {
    for (const key of ACCOUNT_ID_KEYS) {
      const v = obj[key];
      if (v == null || v === '') continue;
      const n = Number(v);
      // Go `required` tag on uint64 fields rejects 0. Require a positive
      // integer to ensure validation passes server-side.
      if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
    }
    return null;
  };

  const obj = raw as Record<string, unknown>;

  // Top-level (flat shape)
  const top = tryExtract(obj);
  if (top != null) return top;

  // Nested `data` envelope
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    const nested = tryExtract(obj.data as Record<string, unknown>);
    if (nested != null) return nested;
  }

  // Last-resort recursive search, but skip containers that typically hold
  // other entities with conflicting id fields.
  const SKIP_KEYS = new Set(['balances', 'positions', 'orders', 'trades', 'fundings']);
  for (const key of Object.keys(obj)) {
    if (SKIP_KEYS.has(key)) continue;
    const val = obj[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const deep = extractAccountIDDeep(val);
      if (deep != null) return deep;
    }
  }

  return null;
}

/**
 * Fetch the perps account state for the current wallet.
 * Primary: /state endpoint (returns WsPerpsState with `aid` = Account ID).
 * Fallback: /balances endpoint.
 * IMPORTANT: perpsClient response interceptor already unwraps response.data,
 * so the result of .get() IS the JSON body — do NOT access .data again.
 * Results are cached for ACCOUNT_STATE_CACHE_TTL ms.
 */
export async function fetchPerpsAccountState(): Promise<{ accountID: number; [key: string]: unknown }> {
  if (isDemo()) return getDemoAccountState('perps') as { accountID: number; [key: string]: unknown };
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  // Cache key namespaced by network — testnet/mainnet accountIDs differ for the same address.
  const cacheKey = `${getNetworkTag()}:perps:${address}`;
  const cached = _accountStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACCOUNT_STATE_CACHE_TTL) return cached.state as { accountID: number; [key: string]: unknown };

  let accountID: number | null = null;
  let parsed: Record<string, unknown> = {};

  // --- Attempt 1: /state ---
  try {
    // perpsClient interceptor returns response.data, so body IS the resolved value
    const body = await withRetry(() => perpsClient.get(`/accounts/${address}/state`));
    // Debug: API response received
    assertNoBodyError(body);
    accountID = extractAccountIDDeep(body);
    parsed = unwrapEnvelopeData(body);
  } catch {
    // Endpoint unavailable, try next
  }

  // --- Attempt 2: /balances ---
  if (accountID == null) {
    try {
      const body = await withRetry(() => perpsClient.get(`/accounts/${address}/balances`));
      // Debug: balances endpoint response
      accountID = extractAccountIDDeep(body);
      if (Object.keys(parsed).length === 0) parsed = unwrapEnvelopeData(body);
    } catch {
      // Endpoint unavailable, try next
    }
  }

  if (accountID == null) {
    throw new Error(
      'No perps account found for this wallet. '
      + 'Make sure the EVM Address in Settings points to a wallet that has a SoDEX '
      + 'perps account on this network (mainnet and testnet account IDs are separate).'
    );
  }

  // Account resolved successfully
  const state = { ...parsed, accountID };
  _accountStateCache.set(cacheKey, { state, ts: Date.now() });
  return state;
}

/**
 * Fetch the spot account state for the current wallet.
 * Same pattern as perps: interceptor already unwraps response.data.
 */
export async function fetchSpotAccountState(): Promise<{ accountID: number; [key: string]: unknown }> {
  if (isDemo()) return getDemoAccountState('spot') as { accountID: number; [key: string]: unknown };
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  // Cache key namespaced by network — testnet/mainnet accountIDs differ for the same address.
  const cacheKey = `${getNetworkTag()}:spot:${address}`;
  const cached = _accountStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ACCOUNT_STATE_CACHE_TTL) return cached.state as { accountID: number; [key: string]: unknown };

  let accountID: number | null = null;
  let parsed: Record<string, unknown> = {};

  try {
    const body = await withRetry(() => spotClient.get(`/accounts/${address}/state`));
    // Debug: spot state response
    assertNoBodyError(body);
    accountID = extractAccountIDDeep(body);
    parsed = unwrapEnvelopeData(body);
  } catch {
    // Endpoint unavailable, try next
  }

  if (accountID == null) {
    try {
      const body = await withRetry(() => spotClient.get(`/accounts/${address}/balances`));
      // Debug: spot balances response
      accountID = extractAccountIDDeep(body);
      if (Object.keys(parsed).length === 0) parsed = unwrapEnvelopeData(body);
    } catch {
      // Endpoint unavailable, try next
    }
  }

  if (accountID == null) {
    throw new Error('fetchSpotAccountState: accountID not found');
  }

  // Spot account resolved
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
  if (isDemo()) return getDemoTickers(market);
  const cacheKey = `${getNetworkTag()}:${market}`;
  const cached = _tickersCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) {
    return cached.data as Record<string, unknown>[];
  }
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/tickers'));
  const raw = res?.data ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  // Normalize SoDEX field names to common aliases expected by consumers.
  // API uses: lastPx, changePct, bidPx, askPx
  const data = arr.map((t: Record<string, unknown>) => ({
    ...t,
    lastPrice: t.lastPx ?? t.lastPrice,
    close: t.lastPx ?? t.close,
    priceChangePercent: t.changePct ?? t.priceChangePercent,
    bidPrice: t.bidPx ?? t.bidPrice,
    askPrice: t.askPx ?? t.askPrice,
  }));
  _tickersCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

export async function fetchMiniTickers(market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return getDemoMiniTickers(market);
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/miniTickers'));
  return res?.data ?? res ?? [];
}

export async function fetchBookTickers(market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return getDemoBookTickers(market);
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

/**
 * Coerce a single orderbook level into the canonical `[priceStr, qtyStr]`
 * tuple consumers expect. SoDEX's response shape is occasionally
 * inconsistent between venues — the level may arrive as:
 *   - `[price, qty]`               (array form, perps)
 *   - `[price, qty, ...]`          (array form with extra metadata)
 *   - `{ px, sz }`                 (object form, observed on spot)
 *   - `{ price, quantity }`        (older docs spelling)
 *   - `{ p, q }`                   (websocket diff style)
 * Returning `[null, null]` signals an unparseable row so callers can
 * skip it instead of silently treating `0` as a valid price.
 */
function normalizeOrderbookLevel(raw: unknown): [string, string] | [null, null] {
  if (Array.isArray(raw)) {
    const price = raw[0];
    const qty = raw[1];
    if (price == null || qty == null) return [null, null];
    return [String(price), String(qty)];
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const price = r.px ?? r.price ?? r.p ?? r.bidPx ?? r.askPx;
    const qty   = r.sz ?? r.quantity ?? r.qty ?? r.q ?? r.bidSz ?? r.askSz;
    if (price == null || qty == null) return [null, null];
    return [String(price), String(qty)];
  }
  return [null, null];
}

export async function fetchOrderbook(symbol: string, market: 'spot' | 'perps' = 'perps', limit = 20) {
  if (isDemo()) return getDemoOrderbook(symbol, market, limit);
  const sym = normalizeSymbol(symbol, market);
  const cacheKey = `${getNetworkTag()}:${market}:${sym}:${limit}`;
  const cached = _orderbookCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) {
    return cached.data as { bids: unknown[]; asks: unknown[] };
  }
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/markets/${sym}/orderbook`, { params: { limit } }));
  const raw = res?.data ?? res ?? {};
  // Some SoDEX endpoints wrap the snapshot under a top-level data /
  // payload key; flatten so consumers always see `{bids, asks}` at root.
  const inner = (raw && typeof raw === 'object' && (raw as Record<string, unknown>).bids === undefined
    ? ((raw as Record<string, unknown>).data ?? raw)
    : raw) as Record<string, unknown>;
  const rawBids = Array.isArray(inner?.bids) ? inner.bids as unknown[] : [];
  const rawAsks = Array.isArray(inner?.asks) ? inner.asks as unknown[] : [];
  // Normalise every level to the canonical [price, qty] tuple form so
  // downstream consumers (BtcPredictor, MarketMakerBot, AutoConfigure)
  // can read them uniformly without per-callsite shape-sniffing.
  const bids = rawBids.map(normalizeOrderbookLevel).filter(([p]) => p != null) as [string, string][];
  const asks = rawAsks.map(normalizeOrderbookLevel).filter(([p]) => p != null) as [string, string][];
  const data = { ...(inner as Record<string, unknown>), bids, asks };
  _orderbookCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

export async function fetchKlines(
  symbol: string,
  interval = '1h',
  limit = 100,
  market: 'spot' | 'perps' = 'perps',
  options?: { bypassCache?: boolean },
) {
  if (isDemo()) return getDemoKlines(symbol, interval, limit);
  const sym = normalizeSymbol(symbol, market);
  const cacheKey = `${getNetworkTag()}:${market}:${sym}:${interval}:${limit}`;
  // Bot loops pass `bypassCache: true` so every signal evaluation works on
  // the freshest kline data — the 30s shared cache is tuned for UI re-renders,
  // not for trading-decision inputs where a stale forming-candle close can
  // mask a just-formed crossover.
  if (!options?.bypassCache) {
    const cached = _klinesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) {
      return cached.data as Record<string, unknown>[];
    }
  }
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/markets/${sym}/klines`, { params: { interval, limit } }));
  const raw = res?.data ?? res ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  // SoDEX RPCKline uses single-char field names: t, o, h, l, c, v, q
  // Normalize to common aliases expected by consumers.
  const data = arr.map((k: Record<string, unknown>) => ({
    ...k,
    time: k.t ?? k.time ?? k.openTime,
    openTime: k.t ?? k.openTime ?? k.time,
    open: k.o ?? k.open,
    high: k.h ?? k.high,
    low: k.l ?? k.low,
    close: k.c ?? k.close,
    volume: k.v ?? k.volume,
  }));
  _klinesCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

export async function fetchCoins(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res = await withRetry(() => client.get('/markets/coins'));
  return res?.data ?? res ?? [];
}

export async function fetchMarkPrices() {
  if (isDemo()) return getDemoMarkPrices();
  const res = await withRetry(() => perpsClient.get('/markets/mark-prices'));
  return res?.data ?? res ?? [];
}

export async function fetchFundingRates() {
  if (isDemo()) return getDemoFundingRates();
  // SoDEX exposes funding rate as part of the tickers payload (fundingRate +
  // nextFundingTime per symbol). There is no reliable standalone
  // `/markets/funding-rates` endpoint, so derive from tickers — the same
  // source FundingTracker uses.
  const tickers = await fetchTickers('perps') as Record<string, unknown>[];
  const arr = Array.isArray(tickers) ? tickers : [];
  return arr
    .filter((t) => t.fundingRate != null)
    .map((t) => ({
      symbol: t.symbol,
      fundingRate: t.fundingRate,
      nextFundingTime: t.nextFundingTime,
      markPrice: t.markPrice ?? t.lastPrice,
    }));
}

// ---------- Account (Private) ----------

export async function fetchAccountInfo(market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return getDemoAccountState(market);
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}`));
  return res?.data ?? res ?? {};
}

export async function fetchBalances(market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return getDemoBalances(market);
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res = await withRetry(() => client.get(`/accounts/${address}/balances`));
  // API returns { blockTime, blockHeight, balances: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.balances ?? []);
}

export async function fetchPositions() {
  if (isDemo()) return getDemoPositions();
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res = await withRetry(() => perpsClient.get(`/accounts/${address}/positions`));
  // API returns { blockTime, blockHeight, positions: [...] } — unwrap the inner array.
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.positions ?? []);
}

/**
 * Fetch all open orders for the current wallet.
 *
 * Endpoint:
 *  - Spot : `GET /accounts/{address}/orders[?symbol=...]`
 *  - Perps: `GET /accounts/{address}/orders[?symbol=...]`
 *
 * `symbol` is optional per the REST docs; when supplied it filters the list
 * server-side. We pass it through when non-empty to avoid pulling the full
 * open-order book for accounts with lots of open orders.
 */
export async function fetchOpenOrders(market: 'spot' | 'perps' = 'perps', symbol?: string) {
  if (isDemo()) return getDemoOpenOrders(market, symbol);
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const query = symbol ? { symbol: normalizeSymbol(symbol, market) } : undefined;
  const res = await withRetry(() => client.get(`/accounts/${address}/orders`, { params: query }));
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
  /**
   * Optional caller-provided client order ID. When supplied it is sent
   * verbatim instead of the auto-generated one — used by the Market
   * Maker bot to tag its own orders so it can recognise them in the
   * open-orders snapshot via a known prefix (`mm_…`).
   */
  clOrdID?: string;
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

  const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
  if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
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
    clOrdID: params.clOrdID ?? generateClOrdID(),
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
    accountID: Number(accountState.accountID),
    orders: [orderItem],
  };

  const res = await withRetry(() => spotClient.post('/trade/orders/batch', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data, 'placeSpotOrder');

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

  const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
  if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
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
    clOrdID: params.clOrdID ?? generateClOrdID(),
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
  // CRITICAL: accountID MUST be a number (Go expects uint64), never a string
  const numericAccountID = Number(accountState.accountID);
  if (!Number.isFinite(numericAccountID)) {
    throw new Error(`placePerpsOrder: invalid accountID "${accountState.accountID}" (type: ${typeof accountState.accountID})`);
  }

  const payload = {
    accountID: numericAccountID,
    symbolID: Number(symbolID),
    orders: [order],
  };

  // Order payload prepared

  const res = await withRetry(() => perpsClient.post('/trade/orders', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data, 'placePerpsOrder');

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
  if (isDemo()) return demoPlaceOrder(params, market);
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
  if (isDemo()) return demoPlaceBatchOrders(ordersList, market);

  // All orders in a batch must share the same symbol
  const symbol = ordersList[0].symbol;

  if (market === 'spot') {
    const [accountState, symbolEntry] = await Promise.all([
      fetchSpotAccountState(),
      fetchSymbolEntry(symbol, 'spot'),
    ]);

    const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
    const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
    if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
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
        clOrdID: params.clOrdID ?? generateClOrdID(),
        side: params.side,
        type: params.type,
        timeInForce,
      };
      if (price !== undefined) orderItem.price = price;
      orderItem.quantity = quantity;
      return orderItem;
    });

    const payload = {
      accountID: Number(accountState.accountID),
      orders,
    };

    const res = await withRetry(() => spotClient.post('/trade/orders/batch', payload));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'placeBatchOrders');
    return Array.isArray(data) ? data : [data];
  } else {
    // Perps
    const [accountState, symbolEntry] = await Promise.all([
      fetchPerpsAccountState(),
      fetchSymbolEntry(symbol, 'perps'),
    ]);

    const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
    const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
    if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
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
        clOrdID: params.clOrdID ?? generateClOrdID(),
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
      accountID: Number(accountState.accountID),
      symbolID,
      orders,
    };

    const res = await withRetry(() => perpsClient.post('/trade/orders', payload));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'placeBatchOrders');
    const resultArray = Array.isArray(data) ? data : (Array.isArray(data?.orders) ? data.orders : [data]);
    return resultArray;
  }
}

/**
 * Update perps leverage & margin mode for a symbol.
 *
 * Endpoint: `POST /trade/leverage` (see `sodex-rest-perps-api.md`).
 * Field order follows `UpdateLeverageRequest` Go struct:
 *   accountID, symbolID, leverage, marginMode.
 * `marginMode`: 1 = ISOLATED, 2 = CROSS.
 * Server rejects the request when the account has open orders or positions
 * on the symbol.
 */
export async function updatePerpsLeverage(
  symbol: string,
  leverage: number,
  marginMode: 1 | 2 = 2,
): Promise<void> {
  if (isDemo()) {
    demoUpdateLeverage(symbol, leverage, marginMode);
    return;
  }
  const [accountState, symbolID] = await Promise.all([
    fetchPerpsAccountState(),
    fetchPerpsSymbolID(symbol),
  ]);
  if (symbolID == null) {
    throw new Error(`updatePerpsLeverage: symbolID not found for "${symbol}"`);
  }

  const payload = {
    accountID: Number(accountState.accountID),
    symbolID: Number(symbolID),
    leverage: Number(leverage),
    marginMode,
  };

  const res = await withRetry(() => perpsClient.post('/trade/leverage', payload));
  const data = (res as { data?: unknown } | null)?.data ?? res ?? {};
  assertNoBodyError(data, 'updatePerpsLeverage');
}

/**
 * Add or remove margin from an isolated perps position.
 *
 * Endpoint: `POST /trade/margin` (see `sodex-rest-perps-api.md`).
 * Positive `amount` adds margin, negative removes margin.
 * Field order follows `UpdateMarginRequest` Go struct:
 *   accountID, symbolID, amount.
 */
export async function updatePerpsMargin(
  symbol: string,
  amount: string | number,
): Promise<void> {
  if (isDemo()) {
    // Demo margin adjustment is a no-op; the engine sizes margin off leverage.
    return;
  }
  const [accountState, symbolID] = await Promise.all([
    fetchPerpsAccountState(),
    fetchPerpsSymbolID(symbol),
  ]);
  if (symbolID == null) {
    throw new Error(`updatePerpsMargin: symbolID not found for "${symbol}"`);
  }
  const amountStr = typeof amount === 'number' ? amount.toString() : String(amount).trim();
  if (!amountStr || amountStr === '0' || parseFloat(amountStr) === 0) {
    throw new Error('updatePerpsMargin: amount must be non-zero');
  }

  const payload = {
    accountID: Number(accountState.accountID),
    symbolID: Number(symbolID),
    amount: amountStr,
  };

  const res = await withRetry(() => perpsClient.post('/trade/margin', payload));
  const data = (res as { data?: unknown } | null)?.data ?? res ?? {};
  assertNoBodyError(data, 'updatePerpsMargin');
}

export async function cancelOrder(orderId: string, symbol: string, market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return demoCancelOrder(orderId, symbol, market);
  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`cancelOrder: symbolID not found for "${symbol}"`);

    // PerpsCancelItem in Go struct field order: symbolID, orderID(omitempty), clOrdID(omitempty)
    // Per docs: provide EITHER orderID or clOrdID, not both.
    const cancelItem: Record<string, unknown> = { symbolID: Number(symbolID) };
    const numericOrderId = parseOrderIdNumeric(orderId);
    if (orderId && !isNaN(numericOrderId)) {
      cancelItem.orderID = numericOrderId;
    } else if (orderId) {
      cancelItem.clOrdID = orderId;
    } else {
      throw new Error('cancelOrder: orderId or clOrdID is required');
    }

    // PerpsCancelOrderRequest in Go struct field order: accountID, cancels
    const payload = {
      accountID: Number(accountState.accountID),
      cancels: [cancelItem],
    };

    const res = await withRetry(() => perpsClient.delete('/trade/orders', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'cancelOrder');
    return data;
  } else {
    // Spot
    const [accountState, symbolID] = await Promise.all([
      fetchSpotAccountState(),
      fetchSpotSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`cancelOrder: symbolID not found for "${symbol}"`);

    // BatchCancelOrderItem in Go struct field order:
    // symbolID, clOrdID(required — new unique ID for this cancel request),
    // orderID(omitempty), origClOrdID(omitempty)
    const cancelItem: Record<string, unknown> = {
      symbolID: Number(symbolID),
      clOrdID: generateClOrdID(), // unique ID for this cancellation request
    };
    const numericOrderId = parseOrderIdNumeric(orderId);
    if (orderId && !isNaN(numericOrderId)) {
      cancelItem.orderID = numericOrderId;
    } else if (orderId) {
      cancelItem.origClOrdID = orderId; // treat string as original client order ID
    } else {
      throw new Error('cancelOrder: orderId or origClOrdID is required');
    }

    // BatchCancelOrderRequest in Go struct field order: accountID, cancels
    const payload = {
      accountID: Number(accountState.accountID),
      cancels: [cancelItem],
    };

    const res = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'cancelOrder');
    return data;
  }
}

/**
 * Cancel every open order for the current account.
 *
 * - `symbol` optional: when provided, only orders for that symbol are cancelled.
 *   We also pass the filter to the server-side `/accounts/{address}/orders` GET
 *   endpoint to avoid paging through unrelated markets.
 * - Cancellations are dispatched per-symbol through `batchCancelOrders` so each
 *   symbol's orders go in a single signed request (lower rate-limit cost than
 *   N round-trips).
 */
export async function cancelAllOrders(symbol?: string, market: 'spot' | 'perps' = 'perps') {
  if (isDemo()) return demoCancelAllOrders(symbol, market);
  const orders = await fetchOpenOrders(market, symbol);
  const ordersArray = Array.isArray(orders) ? orders : [];
  if (ordersArray.length === 0) return [];

  // Group by symbol so we can batch-cancel per-symbol.
  const bySymbol = new Map<string, string[]>();
  for (const order of ordersArray) {
    const sym = String(order.symbol ?? '');
    if (!sym) continue;
    const orderId = String(order.orderID ?? order.orderId ?? order.id ?? '');
    if (!orderId) continue;
    const bucket = bySymbol.get(sym) ?? [];
    bucket.push(orderId);
    bySymbol.set(sym, bucket);
  }

  const results: unknown[] = [];
  for (const [sym, ids] of bySymbol.entries()) {
    try {
      const r = await batchCancelOrders(ids, sym, market);
      results.push(r);
    } catch (e) {
      results.push({ error: e, symbol: sym, orderIds: ids });
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
  if (isDemo()) return getDemoFeeRate();
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
  if (isDemo()) return getDemoOpenOrders(market);
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
  if (isDemo()) return getDemoOrderStatus(orderId, symbol) as OrderStatusResult | null;
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
  if (isDemo()) return getDemoAccountFills(market, limit);
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
  // In demo mode all trade data comes from the engine regardless of target
  // — CopyTrader still gets a lively feed to work with.
  if (isDemo()) return getDemoAccountFills(market, limit);
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
 * Build a single cancel item for the batch cancel endpoints.
 *
 * Field order mirrors the Go structs:
 *  - `PerpsCancelItem`       : symbolID, orderID(omitempty), clOrdID(omitempty)
 *  - `BatchCancelOrderItem`  : symbolID, clOrdID(required), orderID(omitempty),
 *                              origClOrdID(omitempty)
 *
 * The spot flavour requires a unique `clOrdID` for each cancellation request;
 * the perps flavour does not. `includeClOrdID=true` switches to the spot form.
 */
function buildCancelItem(
  orderId: string,
  symbolID: number,
  includeClOrdID = false,
): Record<string, unknown> {
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
  if (isDemo()) return demoBatchCancelOrders(orderIds, symbol, market);

  if (market === 'perps') {
    const [accountState, symbolID] = await Promise.all([
      fetchPerpsAccountState(),
      fetchPerpsSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const numericSymbolID = Number(symbolID);
    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, numericSymbolID));
    const payload = { accountID: Number(accountState.accountID), cancels };
    const res = await withRetry(() => perpsClient.delete('/trade/orders', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'batchCancelOrders');
    return data;
  } else {
    // Spot
    const [accountState, symbolID] = await Promise.all([
      fetchSpotAccountState(),
      fetchSpotSymbolID(symbol),
    ]);
    if (symbolID == null) throw new Error(`batchCancelOrders: symbolID not found for "${symbol}"`);

    const numericSymbolID = Number(symbolID);
    const cancels = orderIds.map((orderId) => buildCancelItem(orderId, numericSymbolID, true));
    const payload = { accountID: Number(accountState.accountID), cancels };
    const res = await withRetry(() => spotClient.delete('/trade/orders/batch', { data: payload }));
    const data = res?.data ?? res ?? {};
    assertNoBodyError(data, 'batchCancelOrders');
    return data;
  }
}

// ---------- Replace / Modify / Schedule-Cancel ----------

/**
 * Request-side parameters for a single order replacement.
 * Either `origOrderID` or `origClOrdID` must be supplied (but not both),
 * and at least one of `price` / `quantity` must be provided.
 */
export interface ReplaceOrderParams {
  symbol: string;
  /** Decimal price as string or number. Omit to keep the original price. */
  price?: string | number;
  /** Decimal quantity as string or number. Omit to keep the original quantity. */
  quantity?: string | number;
  /** Numeric server-assigned order ID to replace. */
  origOrderID?: string | number;
  /** Client order ID of the order to replace. */
  origClOrdID?: string;
}

/**
 * Replace / amend one or more open limit GTC / GTX orders atomically.
 *
 * Endpoint:
 *  - Spot : `POST /trade/orders/replace`
 *  - Perps: `POST /trade/orders/replace`
 *
 * Field order follows `ReplaceOrderRequest` / `ReplaceParams` in the Go SDK:
 *   ReplaceOrderRequest{ accountID, orders[] }
 *   ReplaceParams{ symbolID, clOrdID, origOrderID?, origClOrdID?, price?, quantity? }
 */
export async function replaceOrders(
  replacements: ReplaceOrderParams[],
  market: 'spot' | 'perps',
): Promise<unknown> {
  if (replacements.length === 0) return {};
  if (isDemo()) {
    return demoReplaceOrders(replacements as DemoReplaceInput[], market);
  }

  const [accountState] = await Promise.all([
    market === 'perps' ? fetchPerpsAccountState() : fetchSpotAccountState(),
  ]);

  const orders: Record<string, unknown>[] = [];
  for (const r of replacements) {
    const symbolEntry = await fetchSymbolEntry(r.symbol, market);
    const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
    const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
    if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
      throw new Error(`replaceOrders: symbolID not found for "${r.symbol}"`);
    }
    if (!r.origOrderID && !r.origClOrdID) {
      throw new Error('replaceOrders: origOrderID or origClOrdID is required');
    }
    if (r.origOrderID != null && r.origClOrdID) {
      throw new Error('replaceOrders: provide either origOrderID or origClOrdID, not both');
    }
    if (r.price === undefined && r.quantity === undefined) {
      throw new Error('replaceOrders: at least one of price or quantity must be provided');
    }

    const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

    const item: Record<string, unknown> = {
      symbolID,
      clOrdID: generateClOrdID(),
    };
    if (r.origOrderID != null) {
      const n = Number(r.origOrderID);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`replaceOrders: invalid origOrderID "${r.origOrderID}"`);
      }
      item.origOrderID = n;
    } else if (r.origClOrdID) {
      item.origClOrdID = r.origClOrdID;
    }
    if (r.price !== undefined) {
      const priceNum = typeof r.price === 'number' ? r.price : parseFloat(r.price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        throw new Error(`replaceOrders: invalid price "${r.price}"`);
      }
      item.price = roundToTick(priceNum, tickSize, pricePrecision);
    }
    if (r.quantity !== undefined) {
      const qtyNum = typeof r.quantity === 'number' ? r.quantity : parseFloat(r.quantity);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        throw new Error(`replaceOrders: invalid quantity "${r.quantity}"`);
      }
      // Treat replacement as a LIMIT order (only LIMIT GTC / GTX can be replaced).
      item.quantity = normalizeOrderQuantity(qtyNum, 1, symbolEntry, quantityPrecision, stepSize);
    }
    orders.push(item);
  }

  const payload = {
    accountID: Number(accountState.accountID),
    orders,
  };

  const client = getClient(market);
  const res = await withRetry(() => client.post('/trade/orders/replace', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data, 'replaceOrders');
  return data;
}

/**
 * Modify an existing perps TP/SL order in place.
 *
 * Endpoint: `POST /trade/orders/modify` (perps only).
 * Field order follows `ModifyOrderRequest`:
 *   accountID, symbolID, orderID?, clOrdID?, price?, quantity?, stopPrice?
 *
 * Provide either `orderID` OR `clOrdID`, and at least one of
 * `price` / `quantity` / `stopPrice`.
 */
export async function modifyPerpsOrder(params: {
  symbol: string;
  orderID?: string | number;
  clOrdID?: string;
  price?: string | number;
  quantity?: string | number;
  stopPrice?: string | number;
}): Promise<unknown> {
  if (isDemo()) {
    // Demo engine treats TP/SL modify as a regular replacement.
    return demoReplaceOrders([{
      symbol: params.symbol,
      origOrderID: params.orderID,
      origClOrdID: params.clOrdID,
      price: params.price,
      quantity: params.quantity,
    }], 'perps');
  }
  const [accountState, symbolEntry] = await Promise.all([
    fetchPerpsAccountState(),
    fetchSymbolEntry(params.symbol, 'perps'),
  ]);
  const rawSymbolID = symbolEntry?.symbolID ?? symbolEntry?.id ?? symbolEntry?.symbolId ?? null;
  const symbolID = rawSymbolID != null ? Number(rawSymbolID) : null;
  if (symbolID == null || !Number.isFinite(symbolID) || symbolID <= 0) {
    throw new Error(`modifyPerpsOrder: symbolID not found for "${params.symbol}"`);
  }
  if (params.orderID == null && !params.clOrdID) {
    throw new Error('modifyPerpsOrder: orderID or clOrdID is required');
  }
  if (params.orderID != null && params.clOrdID) {
    throw new Error('modifyPerpsOrder: provide either orderID or clOrdID, not both');
  }
  if (params.price === undefined && params.quantity === undefined && params.stopPrice === undefined) {
    throw new Error('modifyPerpsOrder: at least one of price, quantity, or stopPrice must be provided');
  }

  const { pricePrecision, tickSize, quantityPrecision, stepSize } = extractPrecision(symbolEntry);

  // Build ModifyOrderRequest in Go struct field order
  const payload: Record<string, unknown> = {
    accountID: Number(accountState.accountID),
    symbolID,
  };
  if (params.orderID != null) {
    const n = Number(params.orderID);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`modifyPerpsOrder: invalid orderID "${params.orderID}"`);
    }
    payload.orderID = n;
  } else if (params.clOrdID) {
    payload.clOrdID = params.clOrdID;
  }
  if (params.price !== undefined) {
    const priceNum = typeof params.price === 'number' ? params.price : parseFloat(params.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      throw new Error(`modifyPerpsOrder: invalid price "${params.price}"`);
    }
    payload.price = roundToTick(priceNum, tickSize, pricePrecision);
  }
  if (params.quantity !== undefined) {
    const qtyNum = typeof params.quantity === 'number' ? params.quantity : parseFloat(params.quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      throw new Error(`modifyPerpsOrder: invalid quantity "${params.quantity}"`);
    }
    payload.quantity = normalizeOrderQuantity(qtyNum, 1, symbolEntry, quantityPrecision, stepSize);
  }
  if (params.stopPrice !== undefined) {
    const stopNum = typeof params.stopPrice === 'number' ? params.stopPrice : parseFloat(params.stopPrice);
    if (!Number.isFinite(stopNum) || stopNum <= 0) {
      throw new Error(`modifyPerpsOrder: invalid stopPrice "${params.stopPrice}"`);
    }
    payload.stopPrice = roundToTick(stopNum, tickSize, pricePrecision);
  }

  const res = await withRetry(() => perpsClient.post('/trade/orders/modify', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data, 'modifyPerpsOrder');
  return data;
}

/**
 * Schedule (or clear) a "Dead Man's Switch" auto-cancel-all for the current
 * account.
 *
 * Endpoint:
 *  - Spot : `POST /trade/orders/schedule-cancel`
 *  - Perps: `POST /trade/orders/schedule-cancel`
 *
 * Field order follows `ScheduleCancelRequest`:
 *   accountID, scheduledTimestamp(omitempty).
 *
 * - Pass `scheduledTimestamp` as a Unix millisecond timestamp at least
 *   5 seconds in the future to arm the switch.
 * - Omit `scheduledTimestamp` (leave `undefined`) to clear any scheduled
 *   cancellation.
 */
export async function scheduleCancelAll(
  market: 'spot' | 'perps',
  scheduledTimestamp?: number,
): Promise<unknown> {
  if (isDemo()) {
    demoScheduleCancelAll(market, scheduledTimestamp);
    return { code: 0 };
  }
  const accountState = market === 'perps'
    ? await fetchPerpsAccountState()
    : await fetchSpotAccountState();

  const payload: Record<string, unknown> = {
    accountID: Number(accountState.accountID),
  };
  if (scheduledTimestamp != null) {
    if (!Number.isFinite(scheduledTimestamp) || scheduledTimestamp <= 0) {
      throw new Error(`scheduleCancelAll: invalid scheduledTimestamp "${scheduledTimestamp}"`);
    }
    const now = Date.now();
    if (scheduledTimestamp < now + 5_000) {
      throw new Error('scheduleCancelAll: scheduledTimestamp must be at least 5 seconds in the future');
    }
    payload.scheduledTimestamp = Math.floor(scheduledTimestamp);
  }

  const client = getClient(market);
  const res = await withRetry(() => client.post('/trade/orders/schedule-cancel', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data, 'scheduleCancelAll');
  return data;
}

// ---------- Historical Orders / Positions ----------

/**
 * Fetch historical orders (filled / canceled / expired) for the current
 * account. Endpoint: `GET /accounts/{address}/orders/history`.
 */
export async function fetchOrderHistory(
  market: 'spot' | 'perps' = 'perps',
  params: {
    symbol?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  } = {},
): Promise<unknown[]> {
  if (isDemo()) return getDemoOrderHistory(market, params);
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const query: Record<string, unknown> = {};
  if (params.symbol) query.symbol = normalizeSymbol(params.symbol, market);
  if (params.startTime) query.startTime = params.startTime;
  if (params.endTime) query.endTime = params.endTime;
  if (params.limit) query.limit = params.limit;
  const res = await withRetry(() => client.get(`/accounts/${address}/orders/history`, { params: query }));
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.orders ?? []);
}

/**
 * Fetch closed / historical positions for the current perps account.
 * Endpoint: `GET /accounts/{address}/positions/history`.
 */
export async function fetchPositionHistory(
  params: {
    symbol?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  } = {},
): Promise<unknown[]> {
  // Closed position history is intentionally empty in demo mode — there is
  // no historical backfill, only live positions that exist right now.
  if (isDemo()) {
    const sym = params.symbol;
    const open = getDemoPositions() as Array<{ symbol: string }>;
    return sym ? open.filter((p) => p.symbol === sym) : open;
  }
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const query: Record<string, unknown> = {};
  if (params.symbol) query.symbol = normalizeSymbol(params.symbol, 'perps');
  if (params.startTime) query.startTime = params.startTime;
  if (params.endTime) query.endTime = params.endTime;
  if (params.limit) query.limit = params.limit;
  const res = await withRetry(() => perpsClient.get(`/accounts/${address}/positions/history`, { params: query }));
  const data = res?.data ?? res ?? {};
  return Array.isArray(data) ? data : (data.positions ?? []);
}
