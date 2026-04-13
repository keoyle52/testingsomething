import { create } from 'zustand';

interface GridBotState {
  symbol: string;
  lowerPrice: string;
  upperPrice: string;
  gridCount: string;
  amountPerGrid: string;
  isSpot: boolean;
  mode: 'NEUTRAL' | 'LONG' | 'SHORT';
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  activeOrders: number;
  totalInvestment: number;
  completedGrids: number;
  realizedPnl: number;
  setField: <K extends keyof GridBotState>(field: K, value: GridBotState[K]) => void;
  resetStats: () => void;
}

interface BotStoreState {
  gridBot: GridBotState;
}

export const useBotStore = create<BotStoreState>((set) => ({
  gridBot: {
    symbol: 'BTC_USDC',
    lowerPrice: '60000',
    upperPrice: '70000',
    gridCount: '10',
    amountPerGrid: '0.01',
    isSpot: true,
    mode: 'NEUTRAL',
    status: 'STOPPED',
    activeOrders: 0,
    totalInvestment: 0,
    completedGrids: 0,
    realizedPnl: 0,
    setField: (field, value) =>
      set((state) => ({
        gridBot: { ...state.gridBot, [field]: value },
      })),
    resetStats: () =>
      set((state) => ({
        gridBot: {
          ...state.gridBot,
          activeOrders: 0,
          totalInvestment: 0,
          completedGrids: 0,
          realizedPnl: 0,
          status: 'STOPPED'
        },
      })),
  },
}));
