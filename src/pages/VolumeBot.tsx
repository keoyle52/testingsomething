import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchOrderbook } from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';

const FEE_RATE = 0.001;
const DEFAULT_INTERVAL_SEC = 10;

export const VolumeBot: React.FC = () => {
  const { volumeBot: state } = useBotStore();
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const executeTrade = useCallback(async () => {
    if (!runningRef.current) return;
    const { volumeBot: s } = useBotStore.getState();

    const maxVol = parseFloat(s.maxVolumeTarget);
    if (maxVol > 0 && s.totalVolume >= maxVol) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: `Max volume target (${maxVol}) reached. Bot stopped.` });
      return;
    }

    const market = s.isSpot ? 'spot' : 'perps';

    try {
      const orderbook = await fetchOrderbook(s.symbol, market, 5);
      const bestBid = orderbook?.bids?.[0]?.[0] ?? orderbook?.bids?.[0]?.price;
      const bestAsk = orderbook?.asks?.[0]?.[0] ?? orderbook?.asks?.[0]?.price;

      if (!bestBid || !bestAsk) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `No orderbook data for ${s.symbol}` });
        return;
      }

      const bidPrice = parseFloat(bestBid);
      const askPrice = parseFloat(bestAsk);
      const midPrice = (bidPrice + askPrice) / 2;
      const spread = ((askPrice - bidPrice) / midPrice) * 100;

      const spreadTol = parseFloat(s.spreadTolerance);
      if (spreadTol > 0 && spread > spreadTol) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `Spread too wide (${spread.toFixed(2)}% > ${spreadTol}%). Skipping.` });
        return;
      }

      const min = parseFloat(s.minAmount);
      const max = parseFloat(s.maxAmount);
      const quantity = min + Math.random() * (max - min);
      const side: 1 | 2 = Math.random() > 0.5 ? 1 : 2;
      const sideLabel = side === 1 ? 'BUY' : 'SELL';
      const fillPrice = side === 1 ? askPrice : bidPrice;

      const result = await placeOrder(
        { symbol: s.symbol, side, type: 2, quantity: quantity.toFixed(8) },
        market,
      );

      const vol = quantity * fillPrice;
      const fee = vol * FEE_RATE;

      const freshState = useBotStore.getState().volumeBot;
      const prevCount = freshState.tradesCount;
      const prevSpread = freshState.avgSpread;

      freshState.setField('totalVolume', freshState.totalVolume + vol);
      freshState.setField('tradesCount', prevCount + 1);
      freshState.setField('totalFee', freshState.totalFee + fee);
      freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + 1));

      freshState.addLog({
        time: new Date().toLocaleTimeString(),
        symbol: s.symbol,
        side: sideLabel,
        amount: quantity,
        price: fillPrice,
        fee,
        orderId: result?.orderId ?? result?.id,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
      s.addLog({ time: new Date().toLocaleTimeString(), message: `ERROR: ${msg}` });
      toast.error(`Volume Bot: ${msg}`);
    }
  }, []);

  const scheduleNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    scheduleNextRef.current = () => {
      if (!runningRef.current) return;
      const { volumeBot: s } = useBotStore.getState();
      const interval = Math.max(1, parseInt(s.intervalSec) || DEFAULT_INTERVAL_SEC) * 1000;
      timerRef.current = setTimeout(async () => {
        await executeTrade();
        scheduleNextRef.current();
      }, interval);
    };
  }, [executeTrade]);

  const doStart = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    state.resetStats();
    state.setField('status', 'RUNNING');
    state.addLog({ time: new Date().toLocaleTimeString(), message: 'Bot started' });

    // Run first trade immediately, then schedule subsequent ones
    (async () => {
      await executeTrade();
      scheduleNextRef.current();
    })();
  }, [state, executeTrade]);

  const startBot = useCallback(() => {
    if (confirmOrders) {
      setShowConfirm(true);
    } else {
      doStart();
    }
  }, [confirmOrders, doStart]);

  const stopBot = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    state.setField('status', 'STOPPED');
    state.addLog({ time: new Date().toLocaleTimeString(), message: 'Bot stopped' });
  }, [state]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Volume Bot'u Başlat"
        message={`${state.symbol} için Volume Bot başlatılacak.\nPiyasa: ${state.isSpot ? 'Spot' : 'Perps'}\nMiktar aralığı: ${state.minAmount} – ${state.maxAmount}\nAralık: ${state.intervalSec}s`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface p-4 flex flex-col gap-4 overflow-y-auto">
        <h2 className="font-semibold mb-2">Volume Bot Ayarları</h2>
        
        <div>
          <label className="block text-xs text-text-secondary mb-1">Sembol</label>
          <input 
            type="text" 
            value={state.symbol} 
            onChange={(e) => state.setField('symbol', e.target.value)} 
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm" 
          />
        </div>
        
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-text-secondary mb-1">Min Miktar</label>
            <input 
              type="number" 
              value={state.minAmount} 
              onChange={(e) => state.setField('minAmount', e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-text-secondary mb-1">Max Miktar</label>
            <input 
              type="number" 
              value={state.maxAmount} 
              onChange={(e) => state.setField('maxAmount', e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-1">İşlem Aralığı (sn)</label>
          <input 
            type="number" 
            value={state.intervalSec} 
            onChange={(e) => state.setField('intervalSec', e.target.value)} 
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
          />
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
          <h2 className="text-xl font-semibold">Canlı Durum</h2>
          <StatusBadge status={state.status} />
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Üretilen Hacim</div>
            <div className="text-xl"><NumberDisplay value={state.totalVolume} suffix=" USDC" /></div>
          </div>
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">İşlem Sayısı</div>
            <div className="text-xl"><NumberDisplay value={state.tradesCount} decimals={0} /></div>
          </div>
          <div className="bg-surface border border-border rounded p-4">
            <div className="text-xs text-text-secondary mb-1">Ödenen Fee</div>
            <div className="text-xl"><NumberDisplay value={state.totalFee} prefix="$" /></div>
          </div>
        </div>

        <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
          <div className="px-4 py-2 border-b border-border text-sm font-medium">Log Kayıtları</div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {state.logs.map((log, i) => (
              <div key={i} className="text-xs flex items-center gap-4 py-1 border-b border-border/50 font-mono">
                <span className="text-text-secondary w-20">{log.time}</span>
                {log.symbol && <span className="w-20 font-medium">{log.symbol}</span>}
                {log.side && (
                  <span className={log.side === 'BUY' ? 'text-success w-10' : 'text-danger w-10'}>{log.side}</span>
                )}
                {log.amount && <span className="w-16"><NumberDisplay value={log.amount} decimals={4} /></span>}
                {log.message && <span className="text-text-secondary">{log.message}</span>}
              </div>
            ))}
            {state.logs.length === 0 && (
              <div className="text-center text-text-secondary pt-8 text-sm">Bot log kayıtları burada görünecektir.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
