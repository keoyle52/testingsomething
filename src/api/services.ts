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
 * SoDEX perps API uses "BTC-USD" format, spot API uses "BTC-USDC" format.
 * This helper converts between the two so users don't get 404 errors
 * when using spot-style symbols on perps endpoints or vice versa.
 */
export function normalizeSymbol(symbol: string, market: 'spot' | 'perps'): string {
  if (!symbol) return symbol;
  if (market === 'perps') {
    // Convert spot-style "-USDC" to perps-style "-USD"
    return symbol.replace(/-USDC$/, '-USD');
  }
  // Convert perps-style "-USD" to spot-style "-USDC" (only if it ends with -USD, not -USDC)
  if (symbol.endsWith('-USD') && !symbol.endsWith('-USDC')) {
    return symbol + 'C';
  }
  return symbol;
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

// ---------- Market Data (Public) ----------

export async function fetchSymbols(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await withRetry(() => client.get('/markets/symbols'));
  return res?.data ?? res ?? [];
}

/**
 * Look up the numeric symbolID for a given symbol name on the perps market.
 * Returns null if the symbol cannot be found.
 */
export async function fetchPerpsSymbolID(symbol: string): Promise<number | null> {
  try {
    const symbols = await fetchSymbols('perps');
    const list: any[] = Array.isArray(symbols) ? symbols : (symbols?.symbols ?? symbols?.data ?? []);
    const normalised = normalizeSymbol(symbol, 'perps');
    const entry = list.find(
      (s: any) => s.symbol === normalised || s.name === normalised || s.ticker === normalised,
    );
    return entry?.symbolID ?? entry?.id ?? entry?.symbolId ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the perps account state for the current wallet.
 * Returns an object containing at minimum `accountID`.
 */
export async function fetchPerpsAccountState(): Promise<{ accountID: number | string; [key: string]: any }> {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res: any = await withRetry(() => perpsClient.get(`/accounts/${address}`));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);
  const accountID = data.accountID ?? data.accountId ?? data.account_id ?? data.id;
  if (accountID == null) throw new Error('fetchPerpsAccountState: accountID not found in response');
  return { ...data, accountID };
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
  const res: any = await withRetry(() => client.get(`/accounts/${address}/orders/open`));
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
 * Spot payload is the flat `{ symbol, side, type, quantity, ... }` shape.
 */
async function placeSpotOrder(params: PlaceOrderParams): Promise<any> {
  const normalizedParams = { ...params, symbol: normalizeSymbol(params.symbol, 'spot') };
  const res: any = await withRetry(() => spotClient.post('/trade/orders', normalizedParams));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);
  return data;
}

/**
 * Place a **perps** order.
 * Perps payload must be `{ accountID, symbolID, orders: [...] }`.
 * Derives `accountID` and `symbolID` from the exchange before posting.
 */
async function placePerpsOrder(params: PlaceOrderParams): Promise<any> {
  const [accountState, symbolID] = await Promise.all([
    fetchPerpsAccountState(),
    fetchPerpsSymbolID(params.symbol),
  ]);

  if (symbolID == null) {
    throw new Error(`placePerpsOrder: symbolID not found for symbol "${params.symbol}"`);
  }

  const order: Record<string, any> = {
    clOrdID: generateClOrdID(),
    side: params.side,
    type: params.type,
    quantity: params.quantity,
  };
  if (params.price !== undefined) order.price = params.price;
  if (params.timeInForce !== undefined) order.timeInForce = params.timeInForce;

  const payload = {
    accountID: accountState.accountID,
    symbolID,
    orders: [order],
  };

  const res: any = await withRetry(() => perpsClient.post('/trade/orders', payload));
  const data = res?.data ?? res ?? {};
  assertNoBodyError(data);

  // Normalise perps response: unwrap the first order result if orders array is returned
  const firstOrder = Array.isArray(data?.orders) ? data.orders[0] : data;
  return firstOrder ?? data;
}

export async function placeOrder(params: PlaceOrderParams, market: 'spot' | 'perps' = 'perps') {
  return market === 'perps' ? placePerpsOrder(params) : placeSpotOrder(params);
}

export async function cancelOrder(orderId: string, symbol: string, market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const sym = normalizeSymbol(symbol, market);
  const res: any = await withRetry(() => client.post('/trade/orders/cancel', { orderId, symbol: sym }));
  return res?.data ?? res ?? {};
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
 * Fetch the current status and fill information for a specific order.
 * The `symbol` parameter is forwarded as a query param for exchanges that
 * shard order storage by market; it is harmless for exchanges where `orderId`
 * is globally unique.
 * Returns null if the endpoint is unavailable or the response has an unexpected
 * format — callers must treat null as "unverifiable" and must NOT count volume.
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
  try {
    // Try the per-order endpoint first
    const res: any = await client.get(`/accounts/${address}/orders/${orderId}`, {
      params: { symbol: sym },
    });
    const data = res?.data ?? res ?? {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const status: string =
      data.status ?? data.orderStatus ?? data.order_status ?? 'UNKNOWN';
    const filledQty =
      parseFloat(
        data.filledQty ?? data.executedQty ?? data.filled_qty ?? data.cumQty ?? '0',
      ) || 0;
    const avgFillPrice =
      parseFloat(data.avgFillPrice ?? data.avgPrice ?? data.avg_price ?? '0') || 0;

    return { orderId, status, filledQty, avgFillPrice, filledValue: filledQty * avgFillPrice };
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
    const res: any = await client.get(`/accounts/${address}/fills`, {
      params: { limit },
    });
    const list = res?.data ?? res ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
