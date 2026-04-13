import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  apiKeyName: string;
  privateKey: string;
  isTestnet: boolean;
  defaultSymbol: string;
  confirmOrders: boolean;
  toastsEnabled: boolean;
  // Account B (counter-party for volume bot dual-account mode)
  accountBApiKeyName: string;
  accountBPrivateKey: string;
  accountBAddress: string;
  setApiKeyName: (val: string) => void;
  setPrivateKey: (val: string) => void;
  setIsTestnet: (val: boolean) => void;
  setDefaultSymbol: (val: string) => void;
  setConfirmOrders: (val: boolean) => void;
  setToastsEnabled: (val: boolean) => void;
  setAccountBApiKeyName: (val: string) => void;
  setAccountBPrivateKey: (val: string) => void;
  setAccountBAddress: (val: string) => void;
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
      accountBApiKeyName: '',
      accountBPrivateKey: '',
      accountBAddress: '',
      setApiKeyName: (val) => set({ apiKeyName: val }),
      setPrivateKey: (val) => set({ privateKey: val }),
      setIsTestnet: (val) => set({ isTestnet: val }),
      setDefaultSymbol: (val) => set({ defaultSymbol: val }),
      setConfirmOrders: (val) => set({ confirmOrders: val }),
      setToastsEnabled: (val) => set({ toastsEnabled: val }),
      setAccountBApiKeyName: (val) => set({ accountBApiKeyName: val }),
      setAccountBPrivateKey: (val) => set({ accountBPrivateKey: val }),
      setAccountBAddress: (val) => set({ accountBAddress: val }),
      disconnect: () => set({ apiKeyName: '', privateKey: '', accountBApiKeyName: '', accountBPrivateKey: '', accountBAddress: '' }),
    }),
    {
      name: 'sodex-settings',
      partialize: (state) => ({
        apiKeyName: state.apiKeyName,
        isTestnet: state.isTestnet,
        defaultSymbol: state.defaultSymbol,
        confirmOrders: state.confirmOrders,
        toastsEnabled: state.toastsEnabled,
        accountBApiKeyName: state.accountBApiKeyName,
        accountBAddress: state.accountBAddress,
        // privateKey and accountBPrivateKey intentionally excluded — never stored in localStorage
      }),
    }
  )
);
