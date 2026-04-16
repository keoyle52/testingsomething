import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';

// SosoValue uses two distinct base URLs according to their docs
const DOMAIN_OPENAPI = 'https://openapi.sosovalue.com';
const DOMAIN_API_XYZ = 'https://api.sosovalue.xyz';

// ─── In-Memory TTL Cache & Circuit Breaker ─────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

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

// ─── Axios Client ─────────────────────────────────────────────────────────────

function makeClient() {
  const client = axios.create();

  // Request interceptor
  client.interceptors.request.use(async (config) => {
    // 1. Route to correct Domain based on endpoint
    const url = config.url ?? '';
    const isEtf = url.includes('/openapi/v2/etf');
    config.baseURL = isEtf ? DOMAIN_API_XYZ : DOMAIN_OPENAPI;

    // 2. Inject API key
    const { sosoApiKey } = useSettingsStore.getState();
    if (sosoApiKey) {
      config.headers['x-soso-api-key'] = sosoApiKey;
    }

    // 3. Circuit Breaker for 429 Too Many Requests
    if (Date.now() < rateLimitResetTime) {
      return Promise.reject(new Error('[429] Rate limit exceeded. Pausing requests to cool down.'));
    }

    // 4. Cache Check
    const ttl = getCacheTtl(url);
    if (ttl > 0) {
      const key = cacheKey(url, config.data);
      const entry = cache.get(key);
      if (entry && Date.now() < entry.expiresAt) {
        config.adapter = () =>
          Promise.resolve({
            data: entry.data,
            status: 200,
            statusText: 'OK (cached)',
            headers: {},
            config,
          });
      }
    }

    return config;
  });

  // Response interceptor: validate SosoValue body codes + store in cache
  client.interceptors.response.use(
    (response) => {
      const body = response.data;

      // Store in cache if the request succeeded
      const url = response.config?.url ?? '';
      const ttl = getCacheTtl(url);
      if (ttl > 0) {
        const key = cacheKey(url, response.config?.data ? JSON.parse(response.config.data) : undefined);
        cache.set(key, { data: body, expiresAt: Date.now() + ttl });
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
      // so we stop spamming the API and let the limit reset.
      if (status === 429) {
        rateLimitResetTime = Date.now() + 60_000;
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
  cache.clear();
  rateLimitResetTime = 0; // also reset the 429 lock
}
