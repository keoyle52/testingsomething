import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  apiKeyName: string;
  privateKey: string;
  isTestnet: boolean;
  defaultSymbol: string;
  confirmOrders: boolean;
  toastsEnabled: boolean;
  setApiKeyName: (val: string) => void;
  setPrivateKey: (val: string) => void;
  setIsTestnet: (val: boolean) => void;
  setDefaultSymbol: (val: string) => void;
  setConfirmOrders: (val: boolean) => void;
  setToastsEnabled: (val: boolean) => void;
  disconnect: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKeyName: '',
      privateKey: '',
      isTestnet: true,
      defaultSymbol: 'BTC-USDC',
      confirmOrders: true,
      toastsEnabled: true,
      setApiKeyName: (val) => set({ apiKeyName: val }),
      setPrivateKey: (val) => set({ privateKey: val }),
      setIsTestnet: (val) => set({ isTestnet: val }),
      setDefaultSymbol: (val) => set({ defaultSymbol: val }),
      setConfirmOrders: (val) => set({ confirmOrders: val }),
      setToastsEnabled: (val) => set({ toastsEnabled: val }),
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
        // privateKey bilerek hariç tutuldu - asla localStorage'da saklanmaz
      }),
    }
  )
);
