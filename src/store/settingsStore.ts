import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface SettingsState {
  apiKeyName: string;
  privateKey: string;
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
      isTestnet: true,
      defaultSymbol: 'BTC-USD',
      confirmOrders: true,
      toastsEnabled: true,
      sosoApiKey: '',
      geminiApiKey: '',
      isDemoMode: false,
      theme: 'dark',
      setApiKeyName: (val) => set({ apiKeyName: val }),
      setPrivateKey: (val) => set({ privateKey: val }),
      setIsTestnet: (val) => set({ isTestnet: val }),
      setDefaultSymbol: (val) => set({ defaultSymbol: val }),
      setConfirmOrders: (val) => set({ confirmOrders: val }),
      setToastsEnabled: (val) => set({ toastsEnabled: val }),
      setSosoApiKey: (val) => set({ sosoApiKey: val }),
      setGeminiApiKey: (val) => set({ geminiApiKey: val }),
      setIsDemoMode: (val) => set({ isDemoMode: val }),
      setTheme: (val) => set({ theme: val }),
      disconnect: () => set({ apiKeyName: '', privateKey: '' }),
    }),
    {
      name: 'sodex-settings',
      partialize: (state) => ({
        apiKeyName: state.apiKeyName,
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
