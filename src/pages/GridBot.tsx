import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Layers, DollarSign, CheckCircle2, TrendingUp, Grid2X2 } from 'lucide-react';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  placeOrder,
  cancelAllOrders,
  fetchBookTickers,
  fetchOpenOrders,
  normalizeSymbol,
} from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';

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

        const orderId: string | null = String(result?.orderID ?? result?.orderId ?? result?.id ?? '') || null;
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
      const normalizedSym = normalizeSymbol(s.symbol, market);
      const ticker = arr.find((t: any) => t.symbol === normalizedSym);

      if (!ticker) {
        addLog({ message: `No ticker data found for ${normalizedSym}` });
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

  const pollOrders = useCallback(async () => {
    if (!runningRef.current) return;
    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    try {
      const openOrders = await fetchOpenOrders(market);
      const openOrderIds = new Set(
        (Array.isArray(openOrders) ? openOrders : []).map(
          (o: any) => String(o.orderID ?? o.orderId ?? o.id ?? ''),
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

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const isRunning = state.status === 'RUNNING';

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Grid Bot'u Başlat"
        message={`${state.symbol} için Grid Bot başlatılacak.\nPiyasa: ${state.isSpot ? 'Spot' : 'Perps'}\nAralık: ${state.lowerPrice} – ${state.upperPrice}\nGrid Sayısı: ${state.gridCount}\nMiktar/Grid: ${state.amountPerGrid}\nMod: ${state.mode}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Ayarlar</h2>
          <StatusBadge status={state.status} />
        </div>

        <Input
          label="Sembol"
          type="text"
          value={state.symbol}
          onChange={(e) => state.setField('symbol', e.target.value)}
          disabled={isRunning}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Alt Fiyat"
            type="number"
            value={state.lowerPrice}
            onChange={(e) => state.setField('lowerPrice', e.target.value)}
            disabled={isRunning}
          />
          <Input
            label="Üst Fiyat"
            type="number"
            value={state.upperPrice}
            onChange={(e) => state.setField('upperPrice', e.target.value)}
            disabled={isRunning}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Grid Sayısı"
            type="number"
            value={state.gridCount}
            onChange={(e) => state.setField('gridCount', e.target.value)}
            disabled={isRunning}
          />
          <Input
            label="Miktar/Grid"
            type="number"
            value={state.amountPerGrid}
            onChange={(e) => state.setField('amountPerGrid', e.target.value)}
            disabled={isRunning}
          />
        </div>

        <Select
          label="Yön (Mod)"
          value={state.mode}
          onChange={(e) => state.setField('mode', e.target.value)}
          disabled={isRunning}
          options={[
            { value: 'NEUTRAL', label: 'Neutral' },
            { value: 'LONG', label: 'Long' },
            { value: 'SHORT', label: 'Short' },
          ]}
        />

        {/* Market Toggle */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">Piyasa</label>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!isRunning) {
                  state.setField('isSpot', true);
                  state.setField('symbol', normalizeSymbol(state.symbol, 'spot'));
                }
              }}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'} ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}
            >
              Spot
            </button>
            <button
              onClick={() => {
                if (!isRunning) {
                  state.setField('isSpot', false);
                  state.setField('symbol', normalizeSymbol(state.symbol, 'perps'));
                }
              }}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${!state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'} ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}
            >
              Perps
            </button>
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-border">
          {!isRunning ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={startBot}>
              {"Bot'u Başlat"}
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={stopBot}>
              Durdur
            </Button>
          )}
        </div>
      </div>

      {/* Live Status Panel */}
      <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="Aktif Emirler"
            value={<NumberDisplay value={state.activeOrders} decimals={0} />}
            icon={<Layers size={16} />}
          />
          <StatCard
            label="Kullanılan Bakiye"
            value={<NumberDisplay value={state.totalInvestment} prefix="$" />}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Tamamlanan Gridler"
            value={<NumberDisplay value={state.completedGrids} decimals={0} />}
            icon={<CheckCircle2 size={16} />}
          />
          <StatCard
            label="Gerçekleşen PnL"
            value={<NumberDisplay value={state.realizedPnl} prefix="$" trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'} />}
            icon={<TrendingUp size={16} />}
            trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'}
          />
        </div>

        {/* Grid Levels */}
        <div className="glass-card flex flex-col overflow-hidden p-0" style={{ maxHeight: '260px' }}>
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Grid Seviyeleri</span>
            <span className="badge badge-primary">
              <Grid2X2 size={10} />
              {gridLevels.filter((l) => l.status === 'ACTIVE').length} aktif
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {gridLevels.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {[...gridLevels].reverse().map((level, i) => {
                  const pct = gridLevels.length > 1
                    ? ((level.price - gridLevels[0].price) / (gridLevels[gridLevels.length - 1].price - gridLevels[0].price)) * 100
                    : 50;

                  return (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono rounded-lg hover:bg-surface-hover/50 transition-colors group">
                      <span className="w-24 tabular-nums text-text-primary">{level.price.toFixed(2)}</span>
                      {level.side ? (
                        <span className={`badge ${level.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>
                          {level.side}
                        </span>
                      ) : (
                        <span className="w-12 text-text-muted">—</span>
                      )}
                      <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            level.status === 'ACTIVE' ? 'bg-primary/60' :
                            level.status === 'FILLED' ? 'bg-success/60' :
                            'bg-border'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={`text-[10px] font-sans ${
                        level.status === 'ACTIVE' ? 'text-primary' :
                        level.status === 'FILLED' ? 'text-success' :
                        'text-text-muted'
                      }`}>
                        {level.status === 'ACTIVE' ? '● Active' :
                         level.status === 'FILLED' ? '✓ Filled' :
                         '○ Empty'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center text-text-muted pt-6 text-sm">
                Bot başlatıldığında grid seviyeleri burada görünecektir.
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Log Kayıtları</span>
            <span className="text-[10px] text-text-muted">{logs.length} kayıt</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
            {logs.map((log, i) => (
              <div key={i} className="text-xs flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-hover/50 transition-colors font-mono animate-fade-in">
                <span className="text-text-muted w-16 shrink-0 tabular-nums">{log.time}</span>
                {log.side && (
                  <span className={`badge ${log.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{log.side}</span>
                )}
                {log.message && <span className="text-text-secondary truncate">{log.message}</span>}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                Bot log kayıtları burada görünecektir.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
