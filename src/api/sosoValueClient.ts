import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';

// SosoValue uses two distinct base URLs according to their docs
const DOMAIN_OPENAPI = 'https://openapi.sosovalue.com';
const DOMAIN_API_XYZ = 'https://api.sosovalue.xyz';

// ─── In-Memory TTL Cache & Circuit Breaker ─────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number; }
interface SosoRequestMeta {
  __cacheKey?: string;
  __ttl?: number;
  __endpointKey?: string;
}
interface SosoLikeError {
  message?: string;
  config?: { url?: string } & SosoRequestMeta;
  response?: {
    status?: number;
    headers?: Record<string, string | number | undefined>;
    data?: {
      msg?: string;
      message?: string;
      details?: { retry_after?: number };
    };
  };
}
const memoryCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<unknown>>();

const endpointRateLimitReset = new Map<string, number>();

const TTL: Record<string, number> = {
  '/openapi/v1/data/default/coin/list':      5 * 60_000, 
  '/openapi/v2/etf/historicalInflowChart':   5 * 60_000, 
  '/openapi/v2/etf/currentEtfDataMetrics':   3 * 60_000, 
  '/api/v1/news/featured':                   2 * 60_000, 
  '/api/v1/news/featured/currency':          2 * 60_000, 
};

function getCacheTtl(url: string): number {
  for (const [key, ttl] of Object.entries(TTL)) {
    if (url.includes(key)) return ttl;
  }
  return 0;
}

function cacheKey(url: string, body?: unknown): string {
  return `${url}::${body ? typeof body === 'string' ? body : JSON.stringify(body) : ''}`;
}

function endpointKey(url: string): string {
  const clean = url.split('?')[0];
  if (clean.includes('/api/v1/news')) return '/api/v1/news';
  if (clean.includes('/openapi/v2/etf')) return '/openapi/v2/etf';
  if (clean.includes('/openapi/v1/data/default/coin/list')) return '/openapi/v1/data/default/coin/list';
  return clean;
}

function readRateLimitResetAt(error: SosoLikeError): number {
  const now = Date.now();
  const resetHeader = Number(error?.response?.headers?.['x-ratelimit-reset']);
  if (Number.isFinite(resetHeader) && resetHeader > now) return resetHeader;

  const retryAfterSeconds = Number(error?.response?.data?.details?.retry_after);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return now + retryAfterSeconds * 1000;
  }

  return now + 60_000;
}

// Helper to gracefully fallback to localStorage stale data
function getStaleFallback(key: string): unknown {
  try {
    const raw = localStorage.getItem(`soso_fallback_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStaleFallback(key: string, data: unknown) {
  try {
    localStorage.setItem(`soso_fallback_${key}`, JSON.stringify(data));
  } catch {
    // Ignore quota errors
  }
}

// ─── Axios Client ─────────────────────────────────────────────────────────────

function makeClient() {
  const client = axios.create();

  // Request interceptor
  client.interceptors.request.use(async (config) => {
    const url = config.url ?? '';
    const isEtf = url.includes('/openapi/v2/etf');
    config.baseURL = isEtf ? DOMAIN_API_XYZ : DOMAIN_OPENAPI;

    const { sosoApiKey } = useSettingsStore.getState();
    if (sosoApiKey) config.headers['x-soso-api-key'] = sosoApiKey;

    const ttl = getCacheTtl(url);
    const key = cacheKey(url, config.data);
    
    // Attach exactly computed key to ensure response matches it
    const meta = config as typeof config & SosoRequestMeta;
    meta.__cacheKey = key;
    meta.__ttl = ttl;
    meta.__endpointKey = endpointKey(url);

    // ── Circuit Breaker: Try Stale Fallback ──
    const endpoint = meta.__endpointKey ?? endpointKey(url);
    const resetAt = endpointRateLimitReset.get(endpoint) ?? 0;
    if (Date.now() < resetAt) {
      const fallback = getStaleFallback(key);
      if (fallback) {
        // Silently serve stale data instead of crashing the UI
        config.adapter = () => Promise.resolve({ data: fallback, status: 200, statusText: 'OK', headers: {}, config });
        return config;
      }
      const waitSec = Math.ceil((resetAt - Date.now()) / 1000);
      return Promise.reject(new Error(`[429] Rate limit exceeded. Retry in ${waitSec}s`));
    }

    // ── Fresh Memory Cache ──
    if (ttl > 0) {
      const entry = memoryCache.get(key);
      if (entry && Date.now() < entry.expiresAt) {
        config.adapter = () => Promise.resolve({ data: entry.data, status: 200, statusText: 'OK (cached)', headers: {}, config });
      }
    }

    return config;
  });

  // Response interceptor: validate SosoValue body codes + store in cache
  client.interceptors.response.use(
    (response) => {
      const body = response.data;

      // Store in memory cache + offline fallback if request succeeded
      const config = response.config as typeof response.config & SosoRequestMeta;
      const key = config.__cacheKey;
      const ttl = config.__ttl;
      if (key && ttl && ttl > 0) {
        memoryCache.set(key, { data: body, expiresAt: Date.now() + ttl });
        setStaleFallback(key, body); // Always keep a stale copy just in case!
      }

      // SosoValue: code=0 → success, anything else → error
      if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
        const msg = body.msg ?? body.message ?? `SosoValue error (code=${body.code})`;
        throw new Error(String(msg));
      }

      return body; // unwrap: services receive full body { code, data, ... }
    },
    (rawError) => {
      const error = rawError as SosoLikeError;
      const status = error?.response?.status;
      
      // If we hit 429, engage endpoint-scoped circuit breaker
      if (status === 429) {
        const endpoint = error.config?.__endpointKey ?? endpointKey(error?.config?.url ?? '');
        const resetAt = readRateLimitResetAt(error);
        endpointRateLimitReset.set(endpoint, resetAt);
        
        // Let's try to RESCUE this failed request using our offline fallback!
        const key = error.config?.__cacheKey;
        if (key) {
          const fallback = getStaleFallback(key);
          if (fallback) {
            console.warn(`[429 Rescued] Served stale data for ${error.config?.url}`);
            // Return unresolved promise with fallback data to masquerade as a success
            return Promise.resolve(fallback);
          }
        }
      }

      const apiMsg =
        error?.response?.data?.msg ??
        error?.response?.data?.message ??
        error?.message ??
        'Network error';
      return Promise.reject(new Error(`[${status ?? 'ERR'}] ${apiMsg}`));
    },
  );

  return client;
}

const _client = makeClient();

async function requestWithDedupe<T>(method: 'get' | 'post', url: string, data?: unknown): Promise<T> {
  const key = cacheKey(`${method}:${url}`, data);
  const existing = inflightRequests.get(key);
  if (existing) return existing as Promise<T>;

  const request = (method === 'get'
    ? _client.get(url)
    : _client.post(url, data)) as Promise<T>;

  inflightRequests.set(key, request as Promise<unknown>);
  try {
    return await request;
  } finally {
    inflightRequests.delete(key);
  }
}

export const sosoValueClient = {
  get<T = unknown>(url: string) {
    return requestWithDedupe<T>('get', url);
  },
  post<T = unknown>(url: string, data?: unknown) {
    return requestWithDedupe<T>('post', url, data);
  },
};

/** Manually clear all cached SosoValue responses (e.g. on Refresh button press). */
export function clearSosoCache() {
  memoryCache.clear();
  endpointRateLimitReset.clear();
  inflightRequests.clear();
}
