import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  placeOrder,
  cancelAllOrders,
  fetchBookTickers,
  fetchOpenOrders,
} from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';

interface GridLevel {
  price: number;
  orderId?: string;
  side?: 'BUY' | 'SELL';
  status: 'EMPTY' | 'ACTIVE' | 'FILLED';
}

interface LogEntry {
  time: string;
  side?: 'BUY' | 'SELL';
  message?: string;
}

const POLL_INTERVAL = 10_000;

export const GridBot: React.FC = () => {
  const { gridBot: state } = useBotStore();
  const { confirmOrders } = useSettingsStore();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const gridLevelsRef = useRef<GridLevel[]>([]);
  const [gridLevels, setGridLevels] = useState<GridLevel[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);

  const addLog = useCallback((entry: Omit<LogEntry, 'time'>) => {
    setLogs((prev) =>
      [{ time: new Date().toLocaleTimeString(), ...entry }, ...prev].slice(0, 50),
    );
  }, []);

  /* ---- helpers ---- */

  const calculateGridLevels = useCallback(
    (lower: number, upper: number, count: number): number[] => {
      const levels: number[] = [];
      const step = (upper - lower) / count;
      for (let i = 0; i <= count; i++) levels.push(lower + step * i);
      return levels;
    },
    [],
  );

  const placeGridOrder = useCallback(
    async (price: number, side: 'BUY' | 'SELL'): Promise<string | null> => {
      const { gridBot: s } = useBotStore.getState();
      const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

      try {
        const result = await placeOrder(
          {
            symbol: s.symbol,
            side: side === 'BUY' ? 1 : 2,
            type: 1,
            quantity: s.amountPerGrid,
            price: price.toString(),
            timeInForce: 1,
          },
          market,
        );

        const orderId: string | null = result?.orderId ?? result?.id ?? null;
        if (orderId) {
          addLog({ message: `${side} LIMIT @ ${price.toFixed(2)} placed (${orderId})`, side });
        }
        return orderId;
      } catch (err: any) {
        const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
        addLog({ message: `ERROR placing ${side} @ ${price.toFixed(2)}: ${msg}` });
        toast.error(`Grid Bot: ${msg}`);
        return null;
      }
    },
    [addLog],
  );

  const getCurrentPrice = useCallback(async (): Promise<number | null> => {
    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    try {
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const ticker = arr.find((t: any) => t.symbol === s.symbol);

      if (!ticker) {
        addLog({ message: `No ticker data found for ${s.symbol}` });
        return null;
      }

      const bid = parseFloat(ticker.bidPrice ?? ticker.bid ?? '0');
      const ask = parseFloat(ticker.askPrice ?? ticker.ask ?? '0');
      return (bid + ask) / 2;
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
      addLog({ message: `ERROR fetching price: ${msg}` });
      toast.error(`Grid Bot: ${msg}`);
      return null;
    }
  }, [addLog]);

  /* ---- poll for filled orders ---- */

  const pollOrders = useCallback(async () => {
    if (!runningRef.current) return;
    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    try {
      const openOrders = await fetchOpenOrders(market);
      const openOrderIds = new Set(
        (Array.isArray(openOrders) ? openOrders : []).map(
          (o: any) => o.orderId ?? o.id,
        ),
      );

      const levels = gridLevelsRef.current;
      const gridStep =
        levels.length > 1
          ? (levels[levels.length - 1].price - levels[0].price) / (levels.length - 1)
          : 0;

      for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        if (
          level.status === 'ACTIVE' &&
          level.orderId &&
          !openOrderIds.has(level.orderId)
        ) {
          const filledSide = level.side!;
          level.status = 'FILLED';
          level.orderId = undefined;

          addLog({
            message: `${filledSide} LIMIT @ ${level.price.toFixed(2)} FILLED ✓`,
            side: filledSide,
          });

          const pnlPerGrid = gridStep * parseFloat(s.amountPerGrid);
          const fresh = useBotStore.getState().gridBot;
          fresh.setField('completedGrids', fresh.completedGrids + 1);
          fresh.setField('realizedPnl', fresh.realizedPnl + pnlPerGrid);

          // Place counter-order at adjacent grid level
          if (filledSide === 'BUY' && i + 1 < levels.length) {
            const orderId = await placeGridOrder(levels[i + 1].price, 'SELL');
            if (orderId) {
              levels[i + 1] = {
                ...levels[i + 1],
                orderId,
                side: 'SELL',
                status: 'ACTIVE',
              };
            }
          } else if (filledSide === 'SELL' && i - 1 >= 0) {
            const orderId = await placeGridOrder(levels[i - 1].price, 'BUY');
            if (orderId) {
              levels[i - 1] = {
                ...levels[i - 1],
                orderId,
                side: 'BUY',
                status: 'ACTIVE',
              };
            }
          }
        }
      }

      const activeCount = levels.filter((l) => l.status === 'ACTIVE').length;
      useBotStore.getState().gridBot.setField('activeOrders', activeCount);

      gridLevelsRef.current = [...levels];
      setGridLevels([...levels]);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
      addLog({ message: `ERROR polling orders: ${msg}` });
    }
  }, [addLog, placeGridOrder]);

  /* ---- start / stop ---- */

  const doStart = useCallback(async () => {
    if (runningRef.current) return;

    const { gridBot: s } = useBotStore.getState();
    const lower = parseFloat(s.lowerPrice);
    const upper = parseFloat(s.upperPrice);
    const count = parseInt(s.gridCount);
    const amount = parseFloat(s.amountPerGrid);

    if (
      isNaN(lower) ||
      isNaN(upper) ||
      isNaN(count) ||
      isNaN(amount) ||
      lower >= upper ||
      count < 2 ||
      amount <= 0
    ) {
      toast.error('Invalid grid parameters');
      return;
    }

    runningRef.current = true;
    s.resetStats();
    s.setField('status', 'RUNNING');
    setLogs([]);
    addLog({ message: 'Grid Bot starting...' });

    const currentPrice = await getCurrentPrice();
    if (!currentPrice) {
      runningRef.current = false;
      s.setField('status', 'ERROR');
      addLog({ message: 'Failed to fetch current price. Bot stopped.' });
      return;
    }

    addLog({ message: `Current price: ${currentPrice.toFixed(2)}` });

    const priceLevels = calculateGridLevels(lower, upper, count);
    const levels: GridLevel[] = priceLevels.map((price) => ({
      price,
      status: 'EMPTY' as const,
    }));

    let totalInvested = 0;
    let activeCount = 0;

    for (let i = 0; i < levels.length; i++) {
      if (!runningRef.current) break;

      let side: 'BUY' | 'SELL' | null = null;

      if (s.mode === 'NEUTRAL') {
        if (levels[i].price < currentPrice) side = 'BUY';
        else if (levels[i].price > currentPrice) side = 'SELL';
      } else if (s.mode === 'LONG') {
        if (levels[i].price < currentPrice) side = 'BUY';
      } else if (s.mode === 'SHORT') {
        if (levels[i].price > currentPrice) side = 'SELL';
      }

      if (side) {
        const orderId = await placeGridOrder(levels[i].price, side);
        if (orderId) {
          levels[i] = { ...levels[i], orderId, side, status: 'ACTIVE' };
          activeCount++;
          if (side === 'BUY') totalInvested += levels[i].price * amount;
        }
      }
    }

    gridLevelsRef.current = levels;
    setGridLevels([...levels]);

    s.setField('activeOrders', activeCount);
    s.setField('totalInvestment', totalInvested);
    addLog({
      message: `Placed ${activeCount} initial orders across ${count} grid levels`,
    });

    pollRef.current = setInterval(pollOrders, POLL_INTERVAL);
  }, [addLog, getCurrentPrice, calculateGridLevels, placeGridOrder, pollOrders]);

  const startBot = useCallback(() => {
    if (confirmOrders) {
      setShowConfirm(true);
    } else {
      doStart();
    }
  }, [confirmOrders, doStart]);

  const stopBot = useCallback(async () => {
    runningRef.current = false;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    addLog({ message: 'Cancelling all grid orders...' });

    try {
      await cancelAllOrders(s.symbol, market);
      addLog({ message: 'All orders cancelled successfully' });
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
      addLog({ message: `ERROR cancelling orders: ${msg}` });
      toast.error(`Grid Bot: ${msg}`);
    }

    s.setField('status', 'STOPPED');
    s.setField('activeOrders', 0);

    gridLevelsRef.current = gridLevelsRef.current.map((l) => ({
      ...l,
      status: 'EMPTY' as const,
      orderId: undefined,
      side: undefined,
    }));
    setGridLevels([...gridLevelsRef.current]);
    addLog({ message: 'Grid Bot stopped' });
  }, [addLog]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Grid Bot'u Başlat"
        message={`${state.symbol} için Grid Bot başlatılacak.\nPiyasa: ${state.isSpot ? 'Spot' : 'Perps'}\nAralık: ${state.lowerPrice} – ${state.upperPrice}\nGrid Sayısı: ${state.gridCount}\nMiktar/Grid: ${state.amountPerGrid}\nMod: ${state.mode}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface p-4 flex flex-col gap-4 overflow-y-auto">
        <h2 className="font-semibold mb-2">Grid Bot Ayarları</h2>

        <div>
          <label className="block text-xs text-text-secondary mb-1">Sembol</label>
          <input
            type="text"
            value={state.symbol}
            onChange={(e) => state.setField('symbol', e.target.value)}
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm"
            disabled={state.status === 'RUNNING'}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Alt Fiyat</label>
            <input
              type="number"
              value={state.lowerPrice}
              onChange={(e) => state.setField('lowerPrice', e.target.value)}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums"
              disabled={state.status === 'RUNNING'}
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Üst Fiyat</label>
            <input
              type="number"
              value={state.upperPrice}
              onChange={(e) => state.setField('upperPrice', e.target.value)}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums"
              disabled={state.status === 'RUNNING'}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Grid Sayısı</label>
            <input
              type="number"
              value={state.gridCount}
              onChange={(e) => state.setField('gridCount', e.target.value)}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums"
              disabled={state.status === 'RUNNING'}
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Miktar/Grid</label>
            <input
              type="number"
              value={state.amountPerGrid}
              onChange={(e) => state.setField('amountPerGrid', e.target.value)}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums"
              disabled={state.status === 'RUNNING'}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-1">Yön (Mod)</label>
          <select
            value={state.mode}
            onChange={(e) => state.setField('mode', e.target.value)}
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm outline-none"
            disabled={state.status === 'RUNNING'}
          >
            <option value="NEUTRAL">Neutral</option>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
        </div>

        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-2">
          {state.status !== 'RUNNING' ? (
            <button
              onClick={startBot}
              className="w-full py-2 bg-primary text-black font-medium rounded hover:bg-primary/90 transition-colors"
            >
              Başlat
            </button>
          ) : (
            <button
              onClick={stopBot}
              className="w-full py-2 bg-danger/10 text-danger border border-danger/30 font-medium rounded hover:bg-danger/20 transition-colors"
            >
              Durdur
            </button>
          )}
        </div>
      </div>

      {/* Live Status Panel */}
      <div className="flex-1 p-6 flex flex-col gap-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Grid Durumu</h2>
          <StatusBadge status={state.status} />
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Aktif Emirler</div>
            <div className="text-xl"><NumberDisplay value={state.activeOrders} decimals={0} /></div>
          </div>
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Kullanılan Bakiye</div>
            <div className="text-xl"><NumberDisplay value={state.totalInvestment} prefix="$" /></div>
          </div>
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Tamamlanan Gridler</div>
            <div className="text-xl"><NumberDisplay value={state.completedGrids} decimals={0} /></div>
          </div>
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Gerçekleşen PnL</div>
            <div className="text-xl"><NumberDisplay value={state.realizedPnl} prefix="$" trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'} /></div>
          </div>
        </div>

        {/* Grid Levels Display */}
        <div className="bg-surface border border-border rounded flex flex-col overflow-hidden" style={{ maxHeight: '240px' }}>
          <div className="px-4 py-2 border-b border-border text-sm font-medium">Grid Seviyeleri</div>
          <div className="flex-1 overflow-y-auto p-2">
            {gridLevels.length > 0 ? (
              <div className="flex flex-col gap-1">
                {[...gridLevels].reverse().map((level, i) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-1 text-xs font-mono rounded hover:bg-border/20">
                    <span className="w-24 tabular-nums">{level.price.toFixed(2)}</span>
                    {level.side ? (
                      <span className={`w-10 font-medium ${level.side === 'BUY' ? 'text-success' : 'text-danger'}`}>
                        {level.side}
                      </span>
                    ) : (
                      <span className="w-10 text-text-secondary">—</span>
                    )}
                    <span className={`text-xs ${
                      level.status === 'ACTIVE' ? 'text-primary' :
                      level.status === 'FILLED' ? 'text-success' :
                      'text-text-secondary'
                    }`}>
                      {level.status === 'ACTIVE' ? '● Active' :
                       level.status === 'FILLED' ? '✓ Filled' :
                       '○ Empty'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center text-text-secondary pt-4 text-sm">
                Bot başlatıldığında grid seviyeleri burada görünecektir.
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
          <div className="px-4 py-2 border-b border-border text-sm font-medium">Log Kayıtları</div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {logs.map((log, i) => (
              <div key={i} className="text-xs flex items-center gap-4 py-1 border-b border-border/50 font-mono">
                <span className="text-text-secondary w-20">{log.time}</span>
                {log.side && (
                  <span className={log.side === 'BUY' ? 'text-success w-10' : 'text-danger w-10'}>{log.side}</span>
                )}
                {log.message && <span className="text-text-secondary">{log.message}</span>}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="text-center text-text-secondary pt-8 text-sm">
                Bot log kayıtları burada görünecektir.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
