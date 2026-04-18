import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface SettingsState {
  /**
   * `API_KEY_NAME` — the name you chose when creating the API key on SoDEX.
   * Sent as `X-API-Key` header on every signed request. Mainnet only;
   * on testnet we fall back to the derived EVM address because registered
   * API keys do not exist on testnet.
   */
  apiKeyName: string;
  /**
   * `PRIVATE_KEY` — on mainnet this is the API key's private key (the
   * keypair you were given when registering the API key). On testnet this
   * is your master EVM wallet's private key. Used to sign POST requests.
   * Kept in memory only — never persisted to localStorage.
   */
  privateKey: string;
  /**
   * `EVM_ADDRESS` — your master wallet address (the one connected to SoDEX).
   * Used in REST URL paths like `/accounts/{evmAddress}/state`. On testnet
   * this equals the derived address of `privateKey`; on mainnet it MUST be
   * set explicitly because the private key belongs to the agent, not the
   * master wallet.
   */
  evmAddress: string;
  isTestnet: boolean;
  defaultSymbol: string;
  confirmOrders: boolean;
  toastsEnabled: boolean;
  sosoApiKey: string;
  geminiApiKey: string;
  isDemoMode: boolean;
  theme: Theme;
  setApiKeyName: (val: string) => void;
  setPrivateKey: (val: string) => void;
  setEvmAddress: (val: string) => void;
  setIsTestnet: (val: boolean) => void;
  setDefaultSymbol: (val: string) => void;
  setConfirmOrders: (val: boolean) => void;
  setToastsEnabled: (val: boolean) => void;
  setSosoApiKey: (val: string) => void;
  setGeminiApiKey: (val: string) => void;
  setIsDemoMode: (val: boolean) => void;
  setTheme: (val: Theme) => void;
  disconnect: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKeyName: '',
      privateKey: '',
      evmAddress: '',
      isTestnet: true,
      defaultSymbol: 'BTC-USD',
      confirmOrders: true,
      toastsEnabled: true,
      sosoApiKey: '',
      geminiApiKey: '',
      isDemoMode: false,
      theme: 'dark',
      setApiKeyName: (val) => set({ apiKeyName: val.trim() }),
      setPrivateKey: (val) => set({ privateKey: val.trim() }),
      setEvmAddress: (val) => set({ evmAddress: val.trim() }),
      setIsTestnet: (val) => set({ isTestnet: val }),
      setDefaultSymbol: (val) => set({ defaultSymbol: val }),
      setConfirmOrders: (val) => set({ confirmOrders: val }),
      setToastsEnabled: (val) => set({ toastsEnabled: val }),
      setSosoApiKey: (val) => set({ sosoApiKey: val }),
      setGeminiApiKey: (val) => set({ geminiApiKey: val }),
      setIsDemoMode: (val) => set({ isDemoMode: val }),
      setTheme: (val) => set({ theme: val }),
      disconnect: () => set({ apiKeyName: '', privateKey: '', evmAddress: '' }),
    }),
    {
      name: 'sodex-settings',
      partialize: (state) => ({
        apiKeyName: state.apiKeyName,
        evmAddress: state.evmAddress,
        isTestnet: state.isTestnet,
        defaultSymbol: state.defaultSymbol,
        confirmOrders: state.confirmOrders,
        toastsEnabled: state.toastsEnabled,
        sosoApiKey: state.sosoApiKey,
        geminiApiKey: state.geminiApiKey,
        isDemoMode: state.isDemoMode,
        theme: state.theme,
        // privateKey intentionally excluded — never stored in localStorage
      }),
    }
  )
);
