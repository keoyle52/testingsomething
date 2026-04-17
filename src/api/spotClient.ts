import axios from 'axios';
import { signPayload, deriveActionType } from './signer';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

const BASE_URL_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/spot';
const BASE_URL_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/spot';

export const spotClient = axios.create({ timeout: 15_000 });

function resolveApiKeyAddress(apiKeyName: string, privateKey: string): string {
  const raw = (apiKeyName ?? '').trim();
  if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) return raw;
  try {
    if (!privateKey) return raw;
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return new ethers.Wallet(pk).address;
  } catch {
    return raw;
  }
}

spotClient.interceptors.request.use(async (config) => {
  const state = useSettingsStore.getState();
  const baseURL = state.isTestnet ? BASE_URL_TESTNET : BASE_URL_MAINNET;
  config.baseURL = baseURL;

  const { apiKeyName, privateKey, isTestnet } = state;
  const method = (config.method ?? 'GET').toUpperCase();
  const apiKeyAddress = resolveApiKeyAddress(apiKeyName, privateKey);

  // Only sign write (non-GET) requests
  if (method !== 'GET' && apiKeyAddress && privateKey) {
    const payload = config.data || {};
    const actionType = deriveActionType(method, config.url ?? '');
    try {
      const { signature, nonce } = await signPayload(actionType, payload, privateKey, 'spot', isTestnet, apiKeyAddress);
      config.headers['X-API-Key'] = apiKeyAddress;
      config.headers['X-API-Nonce'] = nonce;
      config.headers['X-API-Sign'] = signature;
    } catch (error) {
      console.error('Signing failed:', error);
      return Promise.reject(error);
    }
  }

  return config;
});

spotClient.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(error)
);
