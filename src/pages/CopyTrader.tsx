import React, { useState } from 'react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';

export const CopyTrader: React.FC = () => {
  const [targetAddress, setTargetAddress] = useState('');
  const [copyRatio, setCopyRatio] = useState('100');
  const [maxSize, setMaxSize] = useState('5000');
  const [marketType, setMarketType] = useState('BOTH');
  const [delay, setDelay] = useState('0');
  const [status, setStatus] = useState<'STOPPED'|'RUNNING'|'ERROR'>('STOPPED');

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface p-4 flex flex-col gap-4 overflow-y-auto">
        <h2 className="font-semibold mb-2">Copy Trader Ayarları</h2>
        
        <div>
          <label className="block text-xs text-text-secondary mb-1">Hedef Cüzdan (Adres)</label>
          <input 
            type="text" 
            value={targetAddress} 
            onChange={(e) => setTargetAddress(e.target.value)} 
            placeholder="0x..."
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm" 
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Kopya Oranı (%)</label>
            <input 
              type="number" 
              value={copyRatio} 
              onChange={(e) => setCopyRatio(e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Max Boyut (USDC)</label>
            <input 
              type="number" 
              value={maxSize} 
              onChange={(e) => setMaxSize(e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Market</label>
            <select 
              value={marketType} 
              onChange={(e) => setMarketType(e.target.value)}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm outline-none"
            >
              <option value="BOTH">Her İkisi</option>
              <option value="SPOT">Sadece Spot</option>
              <option value="PERPS">Sadece Perps</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Gecikme (ms)</label>
            <input 
              type="number" 
              value={delay} 
              onChange={(e) => setDelay(e.target.value)} 
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums" 
            />
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-2">
          {status !== 'RUNNING' ? (
            <button 
              onClick={() => setStatus('RUNNING')} 
              className="w-full py-2 bg-primary text-black font-medium rounded hover:bg-primary/90 transition-colors"
            >
              Başlat
            </button>
          ) : (
            <button 
              onClick={() => setStatus('STOPPED')} 
              className="w-full py-2 bg-danger/10 text-danger border border-danger/30 font-medium rounded hover:bg-danger/20 transition-colors"
            >
              Durdur
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Hedef Cüzdan Panel */}
        <div className="w-1/2 border-r border-border p-6 overflow-y-auto">
          <h3 className="font-medium text-text-secondary mb-4">Hedef Cüzdan Analizi</h3>
          {targetAddress ? (
            <div className="space-y-4">
               <div className="p-4 bg-surface border border-border rounded flex gap-4">
                  <div className="flex-1">
                     <span className="text-xs text-text-secondary block">Tahmini 24h PnL</span>
                     <NumberDisplay value={120.45} prefix="+$" trend="up" className="text-xl" />
                  </div>
               </div>
               <div className="border border-border rounded bg-surface">
                 <div className="px-4 py-2 border-b border-border text-sm font-medium">Son İşlemleri</div>
                 <div className="p-4 text-xs text-text-secondary text-center">API verisi bekleniyor...</div>
               </div>
            </div>
          ) : (
            <div className="text-center text-text-secondary text-sm pt-10">
              İzlemek için bir hedef cüzdan adresi giriniz.
            </div>
          )}
        </div>

        {/* Kendi İşlemlerim Panel */}
        <div className="w-1/2 p-6 overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-text-secondary">Kopyalanan İşlemler</h3>
            <StatusBadge status={status} />
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
             <div className="p-4 bg-surface border border-border rounded">
               <div className="text-xs text-text-secondary mb-1">Kendi PnL'im</div>
               <NumberDisplay value={0.00} prefix="$" trend="neutral" className="text-xl" />
             </div>
             <div className="p-4 bg-surface border border-border rounded">
               <div className="text-xs text-text-secondary mb-1">Başarı Oranı</div>
               <NumberDisplay value={100} suffix="%" className="text-xl" />
             </div>
          </div>
          <div className="flex-1 border border-border rounded bg-surface">
            <div className="px-4 py-2 border-b border-border text-sm font-medium">Log Kayıtları</div>
            <div className="p-4 text-xs text-text-secondary text-center">Henüz bir işlem kopyalanmadı.</div>
          </div>
        </div>
      </div>
    </div>
  );
};
