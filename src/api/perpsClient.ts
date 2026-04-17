import axios from 'axios';
import { signPayload, deriveActionType } from './signer';
import { useSettingsStore } from '../store/settingsStore';
import { ethers } from 'ethers';

const BASE_URL_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/perps';
const BASE_URL_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/perps';

export const perpsClient = axios.create({ timeout: 15_000 });

function resolveApiKeyAddress(apiKeyName: string, privateKey: string): string {
  try {
    if (privateKey) {
      const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      return new ethers.Wallet(pk).address;
    }
  } catch {}
  return (apiKeyName ?? '').trim();
}

perpsClient.interceptors.request.use(async (config) => {
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
      const { signature, nonce } = await signPayload(actionType, payload, privateKey, 'futures', isTestnet, apiKeyAddress);
      config.headers['X-API-Key'] = apiKeyAddress;
      config.headers['X-API-Nonce'] = nonce;
      config.headers['X-API-Sign'] = signature;
      
      console.log('--- NETWORK INTERCEPTOR ---');
      console.log('URL:', config.url);
      console.log('X-API-Key:', apiKeyAddress);
      console.log('Payload being sent:', JSON.stringify(payload));
      console.log('---------------------------');
      
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
