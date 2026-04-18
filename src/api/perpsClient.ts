import axios from 'axios';
import { signPayload, deriveActionType } from './signer';
import { useSettingsStore } from '../store/settingsStore';

const BASE_URL_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/perps';
const BASE_URL_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/perps';

export const perpsClient = axios.create();

perpsClient.interceptors.request.use(async (config) => {
  const state = useSettingsStore.getState();
  const baseURL = state.isTestnet ? BASE_URL_TESTNET : BASE_URL_MAINNET;
  config.baseURL = baseURL;

  const { apiKeyName, privateKey, isTestnet } = state;
  const method = (config.method ?? 'GET').toUpperCase();

  // Only sign write (non-GET) requests
  if (method !== 'GET' && apiKeyName && privateKey) {
    const payload = config.data || {};
    const actionType = deriveActionType(method, config.url ?? '');
    try {
      const { signature, nonce } = await signPayload(actionType, payload, privateKey, 'futures', isTestnet, apiKeyName);
      config.headers['X-API-Key'] = apiKeyName;
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
  (error) => Promise.reject(error)
);
