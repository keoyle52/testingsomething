import { create } from 'zustand';

export interface VolumeBotLog {
  time: string;
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
  fee?: number;
  orderId?: string;
  message?: string;
}

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
  mode: 'dual_account' | 'single_account';
  tickOffset: string;
  fillWaitMs: string;
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  totalVolume: number;
  tradesCount: number;
  totalFee: number;
  totalSpent: number;
  avgSpread: number;
  logs: VolumeBotLog[];
  setField: <K extends keyof VolumeBotState>(field: K, value: VolumeBotState[K]) => void;
  addLog: (log: VolumeBotLog) => void;
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
  setField: <K extends keyof GridBotState>(field: K, value: GridBotState[K]) => void;
  resetStats: () => void;
}

interface BotStoreState {
  volumeBot: VolumeBotState;
  gridBot: GridBotState;
}

export const useBotStore = create<BotStoreState>((set) => ({
  volumeBot: {
    symbol: 'BTC_USDC',
    minAmount: '0.001',
    maxAmount: '0.01',
    intervalSec: '10',
    maxVolumeTarget: '10000',
    spreadTolerance: '50', // %50
    isSpot: true,
    leverage: '1',
    budget: '0',
    maxSpend: '0',
    mode: 'single_account',
    tickOffset: '1',
    fillWaitMs: '30000',
    status: 'STOPPED',
    totalVolume: 0,
    tradesCount: 0,
    totalFee: 0,
    totalSpent: 0,
    avgSpread: 0,
    logs: [],
    setField: (field, value) =>
      set((state) => ({
        volumeBot: { ...state.volumeBot, [field]: value },
      })),
    addLog: (log) =>
      set((state) => {
        const newLogs = [log, ...state.volumeBot.logs].slice(0, 20);
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
          logs: [],
          status: 'STOPPED'
        },
      })),
  },
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
