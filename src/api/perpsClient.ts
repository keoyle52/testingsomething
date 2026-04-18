import axios from 'axios';
import { signPayload, deriveActionType } from './signer';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

const BASE_URL_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/perps';
const BASE_URL_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/perps';

export const perpsClient = axios.create({ timeout: 15_000 });

function resolveApiKeyAddress(apiKeyName: string, privateKey: string): string {
  const raw = (apiKeyName ?? '').trim().toLowerCase();
  if (raw && /^0x[a-f0-9]{40}$/.test(raw)) return raw;
  try {
    if (!privateKey) return raw;
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return new ethers.Wallet(pk).address.toLowerCase();
  } catch {
    return raw;
  }
}

perpsClient.interceptors.request.use(async (config) => {
  const state = useSettingsStore.getState();
  const baseURL = state.isTestnet ? BASE_URL_TESTNET : BASE_URL_MAINNET;
  config.baseURL = baseURL;

  const { apiKeyName, privateKey, isTestnet } = state;
  const method = (config.method ?? 'GET').toUpperCase();
  const apiKeyAddress = resolveApiKeyAddress(apiKeyName, privateKey);

  // Only sign write (non-GET) requests
  if (method !== 'GET' && privateKey) {
    const payload = config.data || {};
    const actionType = deriveActionType(method, config.url ?? '');

    // Testnet: API keys are NOT registered — sign with private key directly,
    // use wallet address as X-API-Key.
    // Mainnet: use the registered apiKeyName address as X-API-Key.
    let signingKey = apiKeyAddress;
    if (isTestnet) {
      try {
        const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        signingKey = new ethers.Wallet(pk).address.toLowerCase();
      } catch {
        signingKey = apiKeyAddress;
      }
    }

    if (!signingKey) return config;

    try {
      const { signature, nonce } = await signPayload(actionType, payload, privateKey, 'futures', isTestnet, signingKey);
      config.headers['X-API-Key'] = signingKey;
      config.headers['X-API-Nonce'] = nonce;
      config.headers['X-API-Sign'] = signature;
    } catch (error) {
      console.error('Signing failed:', error);
      return Promise.reject(error);
    }
  }

  return config;
});

perpsClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error?.response) {
      console.error('[perpsClient] API Error:', error.response.status, JSON.stringify(error.response.data));
      console.error('[perpsClient] Request URL:', error.config?.baseURL, error.config?.url);
      console.error('[perpsClient] Request Body:', JSON.stringify(error.config?.data)?.slice(0, 500));
    }
    return Promise.reject(error);
  }
);
