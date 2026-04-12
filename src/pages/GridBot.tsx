import React from 'react';
import { useBotStore } from '../store/botStore';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';

export const GridBot: React.FC = () => {
  const { gridBot: state } = useBotStore();

  const startBot = () => {
    state.setField('status', 'RUNNING');
    state.setField('activeOrders', parseInt(state.gridCount));
    state.setField('totalInvestment', parseInt(state.gridCount) * parseFloat(state.amountPerGrid) * parseFloat(state.lowerPrice));
  };

  const stopBot = () => {
    state.setField('status', 'STOPPED');
    state.setField('activeOrders', 0);
  };

  return (
    <div className="flex h-[calc(100vh-48px)]">
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
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Üst Fiyat</label>
            <input 
              type="number" 
              value={state.upperPrice} 
              onChange={(e) => state.setField('upperPrice', e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
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
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Miktar/Grid</label>
            <input 
              type="number" 
              value={state.amountPerGrid} 
              onChange={(e) => state.setField('amountPerGrid', e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
        </div>

        <div>
           <label className="block text-xs text-text-secondary mb-1">Yön (Mod)</label>
           <select 
             value={state.mode} 
             onChange={(e) => state.setField('mode', e.target.value)}
             className="w-full bg-surface border border-border rounded px-3 py-2 text-sm outline-none"
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
            <div className="text-xs text-text-secondary mb-1">Gerçekleşen PnL</div>
            <div className="text-xl"><NumberDisplay value={state.realizedPnl} prefix="$" trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'} /></div>
          </div>
        </div>
        
        <div className="flex-1 border border-border rounded bg-surface mt-4 relative flex items-center justify-center p-8">
           <div className="text-text-secondary text-sm">Grid görselleştirme alanı (Canvas/SVG chart placeholder)</div>
        </div>
      </div>
    </div>
  );
};
