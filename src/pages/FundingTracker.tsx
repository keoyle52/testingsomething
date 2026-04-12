import React from 'react';

export const FundingTracker: React.FC = () => {
  return (
    <div className="p-6 flex flex-col gap-6 h-[calc(100vh-48px)] overflow-hidden">
      <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-medium flex justify-between items-center">
          <span>Global Funding Rates</span>
          <div className="flex gap-2">
            <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded border border-primary/30">En Yüksek APR: BTC-USDC</span>
            <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded border border-primary/30">En Düşük APR: ETH-USDC</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="text-xs text-text-secondary border-b border-border bg-black/20">
              <tr>
                <th className="px-4 py-3 font-medium">Sembol</th>
                <th className="px-4 py-3 font-medium text-right">Funding Rate (8h)</th>
                <th className="px-4 py-3 font-medium text-right">Yıllık APR</th>
                <th className="px-4 py-3 font-medium text-right">Sonraki Funding</th>
                <th className="px-4 py-3 font-medium text-right">Açık Faiz (OI)</th>
                <th className="px-4 py-3 font-medium text-right">24h Hacim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr className="hover:bg-border/30 transition-colors">
                <td className="px-4 py-3 font-medium">BTC-USDC</td>
                <td className="px-4 py-3 text-right tabular-nums text-primary">0.0100%</td>
                <td className="px-4 py-3 text-right tabular-nums text-primary">10.95%</td>
                <td className="px-4 py-3 text-right tabular-nums">03:45:12</td>
                <td className="px-4 py-3 text-right tabular-nums">1.2M USDC</td>
                <td className="px-4 py-3 text-right tabular-nums">4.5M USDC</td>
              </tr>
              <tr className="hover:bg-border/30 transition-colors">
                <td className="px-4 py-3 font-medium">ETH-USDC</td>
                <td className="px-4 py-3 text-right tabular-nums text-blue-500">-0.0050%</td>
                <td className="px-4 py-3 text-right tabular-nums text-blue-500">-5.47%</td>
                <td className="px-4 py-3 text-right tabular-nums">03:45:12</td>
                <td className="px-4 py-3 text-right tabular-nums">850K USDC</td>
                <td className="px-4 py-3 text-right tabular-nums">2.1M USDC</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="h-1/3 min-h-[300px] bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-medium flex justify-between items-center">
          <span>Kişisel Funding Geçmişi</span>
          <div className="text-xs text-text-secondary">Son 30 Gün Toplam: <span className="text-success font-medium">+$45.20</span></div>
        </div>
        <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">
          Bu veriyi görüntülemek için API anahtarınızı yapılandırın.
        </div>
      </div>
    </div>
  );
};
