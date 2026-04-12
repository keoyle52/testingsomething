import { create } from 'zustand';

interface VolumeBotState {
  symbol: string;
  minAmount: string;
  maxAmount: string;
  intervalSec: string;
  maxVolumeTarget: string;
  spreadTolerance: string;
  isSpot: boolean;
  leverage: string;
  budget: string;
  maxSpend: string;
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  totalVolume: number;
  tradesCount: number;
  totalFee: number;
  totalSpent: number;
  avgSpread: number;
  skippedCount: number;
  logs: any[];
  setField: (field: keyof VolumeBotState, value: any) => void;
  addLog: (log: any) => void;
  resetStats: () => void;
}

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
  setField: (field: keyof GridBotState, value: any) => void;
  resetStats: () => void;
}

interface BotStoreState {
  volumeBot: VolumeBotState;
  gridBot: GridBotState;
}

export const useBotStore = create<BotStoreState>((set) => ({
  volumeBot: {
    symbol: 'BTC-USDC',
    minAmount: '0.001',
    maxAmount: '0.01',
    intervalSec: '10',
    maxVolumeTarget: '10000',
    spreadTolerance: '50', // %50
    isSpot: true,
    leverage: '1',
    budget: '0',
    maxSpend: '0',
    status: 'STOPPED',
    totalVolume: 0,
    tradesCount: 0,
    totalFee: 0,
    totalSpent: 0,
    avgSpread: 0,
    skippedCount: 0,
    logs: [],
    setField: (field, value) =>
      set((state) => ({
        volumeBot: { ...state.volumeBot, [field]: value },
      })),
    addLog: (log) =>
      set((state) => {
        const newLogs = [log, ...state.volumeBot.logs].slice(0, 50);
        return { volumeBot: { ...state.volumeBot, logs: newLogs } };
      }),
    resetStats: () =>
      set((state) => ({
        volumeBot: {
          ...state.volumeBot,
          totalVolume: 0,
          tradesCount: 0,
          totalFee: 0,
          totalSpent: 0,
          avgSpread: 0,
          skippedCount: 0,
          logs: [],
          status: 'STOPPED'
        },
      })),
  },
  gridBot: {
    symbol: 'BTC-USDC',
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
