import React, { useEffect, useRef } from 'react';
import { useBotStore } from '../store/botStore';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';


export const VolumeBot: React.FC = () => {
  const { volumeBot: state } = useBotStore();
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startBot = () => {
    state.setField('status', 'RUNNING');
    state.addLog({ time: new Date().toLocaleTimeString(), message: 'Bot started' });
    
    // Timer mock for actual logic execution
    timerRef.current = setInterval(async () => {
      // Simulate Bot execution
      try {
        const simVol = Math.random() * (parseFloat(state.maxAmount) - parseFloat(state.minAmount)) + parseFloat(state.minAmount);
        
        // This is a simulated log since actual SODEX API interactions would require valid keys
        state.addLog({
          time: new Date().toLocaleTimeString(),
          symbol: state.symbol,
          side: Math.random() > 0.5 ? 'BUY' : 'SELL',
          amount: simVol,
          price: 65000 + Math.random() * 100,
          fee: simVol * 0.001
        });
        
        state.setField('totalVolume', state.totalVolume + simVol * 65000);
        state.setField('tradesCount', state.tradesCount + 1);
        state.setField('totalFee', state.totalFee + simVol * 0.001);
      } catch (err) {
        console.error(err);
      }
    }, parseInt(state.intervalSec) * 1000);
  };

  const stopBot = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    state.setField('status', 'STOPPED');
    state.addLog({ time: new Date().toLocaleTimeString(), message: 'Bot stopped' });
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="flex h-[calc(100vh-48px)]">
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
