import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';

// SosoValue uses two distinct base URLs according to their docs
const DOMAIN_OPENAPI = 'https://openapi.sosovalue.com';
const DOMAIN_API_XYZ = 'https://api.sosovalue.xyz';

// ─── In-Memory TTL Cache & Circuit Breaker ─────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number; }
const memoryCache = new Map<string, CacheEntry>();

let rateLimitResetTime = 0; // Timestamp when the 429 lock expires

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

// Helper to gracefully fallback to localStorage stale data
function getStaleFallback(key: string): any {
  try {
    const raw = localStorage.getItem(`soso_fallback_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStaleFallback(key: string, data: any) {
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
    (config as any).__cacheKey = key;
    (config as any).__ttl = ttl;

    // ── Circuit Breaker: Try Stale Fallback ──
    if (Date.now() < rateLimitResetTime) {
      const fallback = getStaleFallback(key);
      if (fallback) {
        // Silently serve stale data instead of crashing the UI
        config.adapter = () => Promise.resolve({ data: fallback, status: 200, statusText: 'OK', headers: {}, config });
        return config;
      }
      return Promise.reject(new Error('[429] Rate limit exceeded. Pausing requests...'));
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
      const key = (response.config as any).__cacheKey;
      const ttl = (response.config as any).__ttl;
      if (key && ttl > 0) {
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
    (error) => {
      const status = error?.response?.status;
      
      // If we hit 429, engage the circuit breaker for 60 seconds
      if (status === 429) {
        rateLimitResetTime = Date.now() + 60_000;
        
        // Let's try to RESCUE this failed request using our offline fallback!
        const key = (error.config as any)?.__cacheKey;
        if (key) {
          const fallback = getStaleFallback(key);
          if (fallback) {
            console.warn(`[429 Rescued] Served stale data for ${error.config.url}`);
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

export const sosoValueClient = makeClient();

/** Manually clear all cached SosoValue responses (e.g. on Refresh button press). */
export function clearSosoCache() {
  memoryCache.clear();
  rateLimitResetTime = 0; // also reset the 429 lock
}
