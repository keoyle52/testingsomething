import { sosoValueClient } from './sosoValueClient';

// ─── Types ────────────────────────────────────────────────────────────────────

// Docs: coin list returns { id, fullName, name } — but actual field names from API:
// { currencyId (integer), fullName (string), currencyName (string) }
// We normalise to a consistent internal shape.
export interface SosoCoin {
  id: string;      // currencyId stringified (used as currencyId param in news/currency endpoint)
  fullName: string;
  name: string;    // BTC, ETH, etc. (from currencyName)
}

export interface SosoNewsItem {
  id: string;
  sourceLink: string;
  releaseTime: number; // ms epoch
  author: string;
  authorDescription?: string;
  authorAvatarUrl?: string;
  category: number;
  featureImage?: string;
  matchedCurrencies: { id: string; fullName: string; name: string }[];
  tags: string[];
  multilanguageContent: { language: string; title: string; content: string }[];
  mediaInfo?: unknown[];
  nickName?: string;
  quoteInfo?: unknown;
}

export interface SosoNewsList {
  page: number;
  pageSize: number;
  total: number;
  list: SosoNewsItem[];
}

export interface EtfDayData {
  date: string;            // YYYY-MM-DD
  totalNetInflow: number;
  totalValueTraded: number;
  totalNetAssets: number;
  cumNetInflow: number;
}

export interface EtfMetricValue {
  value: number | null;
  lastUpdateDate: string;
  status?: string;
}

export interface EtfListItem {
  id: string;
  ticker: string;
  institute: string;
  netAssets: EtfMetricValue;
  netAssetsPercentage: EtfMetricValue;
  dailyNetInflow: EtfMetricValue;
  cumNetInflow: EtfMetricValue;
  dailyValueTraded: EtfMetricValue;
  fee: EtfMetricValue;
  discountPremiumRate: EtfMetricValue;
}

export interface EtfCurrentMetrics {
  totalNetAssets: EtfMetricValue;
  totalNetAssetsPercentage: EtfMetricValue;
  totalTokenHoldings: EtfMetricValue;
  dailyNetInflow: EtfMetricValue;
  cumNetInflow: EtfMetricValue;
  dailyTotalValueTraded: EtfMetricValue;
  list: EtfListItem[];
}

export type EtfType = 'us-btc-spot' | 'us-eth-spot';

// ─── Helper: build query string without encoding commas ────────────────────────
// URLSearchParams encodes commas as %2C — SosoValue API needs literal commas.
function buildQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMatchedCurrencies(raw: unknown): { id: string; fullName: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const item = (c ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? item.currencyId ?? ''),
      fullName: String(item.full_name ?? item.fullName ?? ''),
      name: String(item.name ?? item.currencyName ?? ''),
    };
  }).filter((c) => c.id !== '');
}

function normalizeNewsItem(raw: unknown): SosoNewsItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  const title = String(item.title ?? '');
  const content = String(item.content ?? '');
  return {
    id: String(item.id ?? ''),
    sourceLink: String(item.source_link ?? item.sourceLink ?? ''),
    releaseTime: toNumber(item.release_time ?? item.releaseTime, Date.now()),
    author: String(item.author ?? ''),
    authorDescription: item.author_description ? String(item.author_description) : (item.authorDescription ? String(item.authorDescription) : undefined),
    authorAvatarUrl: item.author_avatar_url ? String(item.author_avatar_url) : (item.authorAvatarUrl ? String(item.authorAvatarUrl) : undefined),
    category: toNumber(item.category, 0),
    featureImage: item.feature_image ? String(item.feature_image) : (item.featureImage ? String(item.featureImage) : undefined),
    matchedCurrencies: normalizeMatchedCurrencies(item.matched_currencies ?? item.matchedCurrencies),
    tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t)) : [],
    multilanguageContent: title || content
      ? [{ language: 'en', title, content }]
      : (Array.isArray(item.multilanguageContent)
        ? item.multilanguageContent as { language: string; title: string; content: string }[]
        : []),
    mediaInfo: Array.isArray(item.media_info) ? item.media_info : (Array.isArray(item.mediaInfo) ? item.mediaInfo : []),
    nickName: item.nick_name ? String(item.nick_name) : (item.nickName ? String(item.nickName) : undefined),
    quoteInfo: item.quote_info ?? item.quoteInfo,
  };
}

function normalizeNewsList(raw: unknown, fallbackPage: number, fallbackPageSize: number): SosoNewsList {
  const data = (raw ?? {}) as Record<string, unknown>;
  const page = toNumber(data.page ?? data.pageNum, fallbackPage);
  const pageSize = toNumber(data.page_size ?? data.pageSize, fallbackPageSize);
  const total = toNumber(data.total, 0);
  const listRaw = Array.isArray(data.list) ? data.list : [];
  return {
    page,
    pageSize,
    total,
    list: listRaw.map(normalizeNewsItem).filter((item) => item.id !== ''),
  };
}

// ─── Coin List ────────────────────────────────────────────────────────────────

export async function fetchSosoCoins(): Promise<SosoCoin[]> {
  // Response: { code:0, data: [ { currencyId, fullName, currencyName }, ... ] }
  const res = await sosoValueClient.post('/openapi/v1/data/default/coin/list', {}) as {
    data: { currencyId: string | number; fullName: string; currencyName: string }[];
  };
  const raw = Array.isArray(res?.data) ? res.data : [];
  return raw.map((c) => ({
    id: String(c.currencyId),
    fullName: c.fullName,
    name: (c.currencyName ?? '').toUpperCase(),
  }));
}

// ─── News ─────────────────────────────────────────────────────────────────────

export async function fetchSosoNews(
  page = 1,
  pageSize = 20,
  category?: number[],
  language = 'en',
): Promise<SosoNewsList> {
  // SoSoValue API expects camelCase params (pageNum / pageSize / categoryList)
  // and the documented endpoint is /api/v1/news/featured/currency for the
  // currency-scoped feed. The plain /featured route also accepts the same
  // camelCase parameter shape; using snake_case (page / page_size / category)
  // returns 400 Bad Request.
  const query = buildQuery({
    pageNum: page,
    pageSize,
    language,
    categoryList: category && category.length > 0 ? category.join(',') : undefined,
  });
  const res = await sosoValueClient.get(`/api/v1/news/featured?${query}`) as { data: unknown };
  return normalizeNewsList(res?.data, page, pageSize);
}

export async function fetchSosoNewsByCurrency(
  currencyId: string,
  page = 1,
  pageSize = 20,
  category?: number[],
  language = 'en',
): Promise<SosoNewsList> {
  const query = buildQuery({
    pageNum: page,
    pageSize,
    currencyId,
    language,
    categoryList: category && category.length > 0 ? category.join(',') : undefined,
  });
  // Per SoSoValue API docs, the currency-scoped feed lives at
  // /api/v1/news/featured/currency (not /api/v1/news).
  const res = await sosoValueClient.get(`/api/v1/news/featured/currency?${query}`) as { data: unknown };
  return normalizeNewsList(res?.data, page, pageSize);
}

// ─── ETF ──────────────────────────────────────────────────────────────────────

export async function fetchEtfHistoricalInflow(type: EtfType): Promise<EtfDayData[]> {
  // Response: { code:0, data: { list: [ { date, totalNetInflow, ... }, ... ] } }
  const res = await sosoValueClient.post('/openapi/v2/etf/historicalInflowChart', { type }) as {
    data: { list?: EtfDayData[] } | EtfDayData[];
  };
  const raw = res?.data;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;                           // direct array
  if (raw.list && Array.isArray(raw.list)) return raw.list;    // nested list
  return [];
}

export async function fetchEtfCurrentMetrics(type: EtfType): Promise<EtfCurrentMetrics | null> {
  // Response: { code:0, data: { totalNetAssets: {...}, ..., list: [...] } }
  const res = await sosoValueClient.post('/openapi/v2/etf/currentEtfDataMetrics', { type }) as {
    data: EtfCurrentMetrics;
  };
  return res?.data ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const NEWS_CATEGORIES: Record<number, { label: string; color: string }> = {
  1:  { label: 'News',        color: 'text-blue-400 bg-blue-400/10' },
  2:  { label: 'Research',    color: 'text-purple-400 bg-purple-400/10' },
  3:  { label: 'Institution', color: 'text-amber-400 bg-amber-400/10' },
  4:  { label: 'Insights',    color: 'text-emerald-400 bg-emerald-400/10' },
  5:  { label: 'Macro',       color: 'text-cyan-400 bg-cyan-400/10' },
  6:  { label: 'Macro Res.',  color: 'text-indigo-400 bg-indigo-400/10' },
  7:  { label: 'Tweets',      color: 'text-sky-400 bg-sky-400/10' },
  9:  { label: 'Price Alert', color: 'text-orange-400 bg-orange-400/10' },
  10: { label: 'On-Chain',    color: 'text-green-400 bg-green-400/10' },
};

export function getNewsTitle(item: SosoNewsItem): string {
  const en = item.multilanguageContent?.find((c) => c.language === 'en');
  return en?.title ?? item.author ?? '(no title)';
}
