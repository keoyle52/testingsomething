import axios from 'axios';
import { signPayload, deriveActionType, resolveApiKey } from './signer';
import { useSettingsStore } from '../store/settingsStore';

/**
 * SoDEX Perps (Bolt engine) REST client.
 *
 * Endpoints: see `sodexdocument/sodex-rest-perps-api.md`.
 *  - Mainnet: https://mainnet-gw.sodex.dev/api/v1/perps
 *  - Testnet: https://testnet-gw.sodex.dev/api/v1/perps
 *
 * - Public GET endpoints are unsigned.
 * - Signed writes (POST/DELETE) attach `X-API-Key`, `X-API-Sign`,
 *   `X-API-Nonce` headers via EIP-712 (`signer.ts → signPayload`).
 */
const BASE_URL_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/perps';
const BASE_URL_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/perps';

export const perpsClient = axios.create({
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

perpsClient.interceptors.request.use(async (config) => {
  const state = useSettingsStore.getState();
  config.baseURL = state.isTestnet ? BASE_URL_TESTNET : BASE_URL_MAINNET;

  const { apiKeyName, privateKey, isTestnet } = state;
  const method = (config.method ?? 'GET').toUpperCase();

  // Only sign write (non-GET) requests — requires a private key
  if (method !== 'GET' && privateKey) {
    const effectiveApiKey = resolveApiKey({ apiKeyName, privateKey, isTestnet });
    if (!effectiveApiKey) {
      return Promise.reject(new Error('Invalid private key: could not derive wallet address'));
    }

    const payload = (config.data ?? {}) as Record<string, unknown>;
    const actionType = deriveActionType(method, config.url ?? '');
    try {
      const { signature, nonce } = await signPayload(
        actionType,
        payload,
        privateKey,
        'futures',
        isTestnet,
        effectiveApiKey,
      );
      config.headers['X-API-Key'] = effectiveApiKey;
      config.headers['X-API-Nonce'] = nonce;
      config.headers['X-API-Sign'] = signature;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return config;
});

// Unwrap axios → the value we return to callers IS the JSON body.
// Keeps the rest of the codebase simple: `const body = await perpsClient.get(...)`.
perpsClient.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(error),
);
