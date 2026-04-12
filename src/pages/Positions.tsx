import React from 'react';
import { NumberDisplay } from '../components/common/NumberDisplay';

export const Positions: React.FC = () => {
  return (
    <div className="p-6 flex flex-col gap-6 h-[calc(100vh-48px)] overflow-hidden">
      {/* Top Cards */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Margin Balance</div>
          <div className="text-2xl"><NumberDisplay value={10450.00} prefix="$" /></div>
        </div>
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Unrealized PnL</div>
          <div className="text-2xl"><NumberDisplay value={245.50} prefix="+$" trend="up" /></div>
        </div>
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Pozisyon Değeri</div>
          <div className="text-2xl"><NumberDisplay value={56000.00} prefix="$" /></div>
        </div>
        <div className="bg-surface border border-border rounded p-4 flex flex-col justify-center gap-2">
          <div className="flex justify-between text-xs">
            <span className="text-text-secondary">Margin Kullanımı</span>
            <span>24%</span>
          </div>
          <div className="h-2 w-full bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary" style={{ width: '24%' }} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="text-xs text-text-secondary border-b border-border bg-black/20">
              <tr>
                <th className="px-4 py-3 font-medium">Sembol</th>
                <th className="px-4 py-3 font-medium">Yön</th>
                <th className="px-4 py-3 font-medium text-right">Boyut</th>
                <th className="px-4 py-3 font-medium text-right">Giriş Fiyatı</th>
                <th className="px-4 py-3 font-medium text-right">Mark Fiyat</th>
                <th className="px-4 py-3 font-medium text-right">Liq. Fiyatı</th>
                <th className="px-4 py-3 font-medium text-right">PnL</th>
                <th className="px-4 py-3 font-medium text-right">Margin / Kaldıraç</th>
                <th className="px-4 py-3 font-medium text-right">İşlemler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {/* Dummy row */}
              <tr className="hover:bg-border/30 transition-colors">
                <td className="px-4 py-3 font-medium">BTC-USDC</td>
                <td className="px-4 py-3 text-success font-medium">LONG</td>
                <td className="px-4 py-3 text-right tabular-nums">0.500</td>
                <td className="px-4 py-3 text-right tabular-nums">64,250.00</td>
                <td className="px-4 py-3 text-right tabular-nums text-success">64,800.00</td>
                <td className="px-4 py-3 text-right tabular-nums text-text-secondary">58,000.00</td>
                <td className="px-4 py-3 text-right tabular-nums text-success">+275.00 (5.4%)</td>
                <td className="px-4 py-3 text-right tabular-nums">3,240.00 (10x)</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button className="px-2 py-1 text-xs border border-border rounded hover:bg-border/50 transition-colors">
                      TP/SL Ekle
                    </button>
                    <button className="px-2 py-1 text-xs border border-border rounded hover:bg-border/50 transition-colors">
                      Margin Ekle
                    </button>
                    <button className="px-2 py-1 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 transition-colors">
                      Kapat
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
