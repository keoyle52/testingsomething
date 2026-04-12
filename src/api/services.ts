import { perpsClient } from './perpsClient';
import { spotClient } from './spotClient';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

// ---------- helpers ----------

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
  const res: any = await client.get('/markets/symbols');
  return res?.data ?? res ?? [];
}

export async function fetchTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.get('/markets/tickers');
  return res?.data ?? res ?? [];
}

export async function fetchMiniTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.get('/markets/miniTickers');
  return res?.data ?? res ?? [];
}

export async function fetchBookTickers(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.get('/markets/bookTickers');
  return res?.data ?? res ?? [];
}

export async function fetchOrderbook(symbol: string, market: 'spot' | 'perps' = 'perps', limit = 20) {
  const client = getClient(market);
  const res: any = await client.get(`/markets/${symbol}/orderbook`, { params: { limit } });
  return res?.data ?? res ?? { bids: [], asks: [] };
}

export async function fetchKlines(
  symbol: string,
  interval = '1h',
  limit = 100,
  market: 'spot' | 'perps' = 'perps',
) {
  const client = getClient(market);
  const res: any = await client.get(`/markets/${symbol}/klines`, { params: { interval, limit } });
  return res?.data ?? res ?? [];
}

export async function fetchCoins(market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.get('/markets/coins');
  return res?.data ?? res ?? [];
}

export async function fetchMarkPrices() {
  const res: any = await perpsClient.get('/markets/mark-prices');
  return res?.data ?? res ?? [];
}

export async function fetchFundingRates() {
  const res: any = await perpsClient.get('/markets/funding-rates');
  return res?.data ?? res ?? [];
}

// ---------- Account (Private) ----------

export async function fetchAccountInfo(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await client.get(`/accounts/${address}`);
  return res?.data ?? res ?? {};
}

export async function fetchBalances(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await client.get(`/accounts/${address}/balances`);
  return res?.data ?? res ?? [];
}

export async function fetchPositions() {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const res: any = await perpsClient.get(`/accounts/${address}/positions`);
  return res?.data ?? res ?? [];
}

export async function fetchOpenOrders(market: 'spot' | 'perps' = 'perps') {
  const address = getEvmAddress();
  if (!address) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await client.get(`/accounts/${address}/orders/open`);
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

export async function placeOrder(params: PlaceOrderParams, market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.post('/trade/orders', params);
  return res?.data ?? res ?? {};
}

export async function cancelOrder(orderId: string, symbol: string, market: 'spot' | 'perps' = 'perps') {
  const client = getClient(market);
  const res: any = await client.post('/trade/orders/cancel', { orderId, symbol });
  return res?.data ?? res ?? {};
}

export async function cancelAllOrders(symbol?: string, market: 'spot' | 'perps' = 'perps') {
  const orders = await fetchOpenOrders(market);
  const results: any[] = [];
  const ordersArray = Array.isArray(orders) ? orders : [];
  for (const order of ordersArray) {
    if (symbol && order.symbol !== symbol) continue;
    try {
      const r = await cancelOrder(order.orderId ?? order.id, order.symbol, market);
      results.push(r);
    } catch (e) {
      results.push({ error: e, orderId: order.orderId ?? order.id });
    }
  }
  return results;
}

// ---------- Utility ----------

export async function fetchAccountOrders(
  market: 'spot' | 'perps' = 'perps',
  address?: string,
) {
  const addr = address || getEvmAddress();
  if (!addr) throw new Error('No wallet configured');
  const client = getClient(market);
  const res: any = await client.get(`/accounts/${addr}/orders`);
  return res?.data ?? res ?? [];
}
