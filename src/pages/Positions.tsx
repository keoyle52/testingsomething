import React, { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { useSettingsStore } from '../store/settingsStore';
import {
  fetchPositions,
  fetchBalances,
  fetchMarkPrices,
  placeOrder,
  cancelAllOrders,
} from '../api/services';

interface PositionRow {
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  pnl: number;
  pnlPercent: number;
  margin: number;
  leverage: number;
}

export const Positions: React.FC = () => {
  const { confirmOrders } = useSettingsStore();

  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [marginBalance, setMarginBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmMessage, setConfirmMessage] = useState('');
  const confirmActionRef = useRef<() => void>(() => {});

  const loadData = useCallback(async () => {
    try {
      const [rawPositions, rawBalances, rawPrices] = await Promise.all([
        fetchPositions(),
        fetchBalances('perps'),
        fetchMarkPrices(),
      ]);

      const priceMap: Record<string, number> = {};
      const pricesArr = Array.isArray(rawPrices) ? rawPrices : [];
      for (const p of pricesArr) {
        priceMap[p.symbol] = parseFloat(p.markPrice ?? p.price ?? 0);
      }

      const balancesArr = Array.isArray(rawBalances) ? rawBalances : [];
      let totalBalance = 0;
      for (const b of balancesArr) {
        totalBalance += parseFloat(b.balance ?? b.available ?? b.totalBalance ?? 0);
      }
      setMarginBalance(totalBalance);

      const positionsArr = Array.isArray(rawPositions) ? rawPositions : [];
      const mapped: PositionRow[] = positionsArr.map((pos: any) => {
        const size = Math.abs(parseFloat(pos.size ?? pos.quantity ?? 0));
        const entryPrice = parseFloat(pos.entryPrice ?? pos.avgPrice ?? 0);
        const symbol = pos.symbol ?? '';
        const markPrice = priceMap[symbol] ?? parseFloat(pos.markPrice ?? 0);
        const liquidationPrice = parseFloat(pos.liquidationPrice ?? pos.liqPrice ?? 0);
        const margin = parseFloat(pos.margin ?? pos.initialMargin ?? 0);
        const leverage = parseFloat(pos.leverage ?? 0);

        const side = pos.side === 1 || pos.side === 'BUY' || pos.side === 'LONG'
          ? 'LONG' : 'SHORT';

        const direction = side === 'LONG' ? 1 : -1;
        const pnl = direction * size * (markPrice - entryPrice);
        const costBasis = size * entryPrice;
        const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

        return { symbol, side, size, entryPrice, markPrice, liquidationPrice, pnl, pnlPercent, margin, leverage };
      });

      setPositions(mapped);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Pozisyonlar yüklenemedi';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);
  const totalValue = positions.reduce((s, p) => s + p.size * p.markPrice, 0);
  const marginUsage = marginBalance > 0
    ? Math.min((positions.reduce((s, p) => s + p.margin, 0) / marginBalance) * 100, 100)
    : 0;

  const executeClose = useCallback(async (pos: PositionRow) => {
    try {
      const closeSide = pos.side === 'LONG' ? 2 : 1;
      await cancelAllOrders(pos.symbol, 'perps');
      await placeOrder(
        { symbol: pos.symbol, side: closeSide as 1 | 2, type: 2, quantity: String(pos.size) },
        'perps',
      );
      toast.success(`${pos.symbol} pozisyonu kapatıldı`);
      loadData();
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? err?.message ?? 'Pozisyon kapatılamadı');
    }
  }, [loadData]);

  const handleClose = useCallback((pos: PositionRow) => {
    if (confirmOrders) {
      setConfirmTitle('Pozisyonu Kapat');
      setConfirmMessage(`${pos.symbol} ${pos.side} ${pos.size} pozisyonunu kapatmak istediğinize emin misiniz?`);
      confirmActionRef.current = () => executeClose(pos);
      setConfirmOpen(true);
    } else {
      executeClose(pos);
    }
  }, [confirmOrders, executeClose]);

  const executeCloseAll = useCallback(async () => {
    const results = await Promise.allSettled(positions.map((pos) => executeClose(pos)));
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      toast.error(`${failures.length} pozisyon kapatılamadı`);
    }
  }, [positions, executeClose]);

  const handleCloseAll = useCallback(() => {
    if (positions.length === 0) return;
    if (confirmOrders) {
      setConfirmTitle('Tüm Pozisyonları Kapat');
      setConfirmMessage(`${positions.length} açık pozisyonun tamamını kapatmak istediğinize emin misiniz?`);
      confirmActionRef.current = () => executeCloseAll();
      setConfirmOpen(true);
    } else {
      executeCloseAll();
    }
  }, [confirmOrders, positions, executeCloseAll]);

  return (
    <div className="p-6 flex flex-col gap-6 h-[calc(100vh-48px)] overflow-hidden">
      {/* Top Cards */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Margin Balance</div>
          <div className="text-2xl"><NumberDisplay value={marginBalance} prefix="$" /></div>
        </div>
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Unrealized PnL</div>
          <div className="text-2xl">
            <NumberDisplay
              value={Math.abs(totalPnl)}
              prefix={totalPnl >= 0 ? '+$' : '-$'}
              trend={totalPnl >= 0 ? 'up' : 'down'}
            />
          </div>
        </div>
        <div className="bg-surface border border-border rounded p-4">
          <div className="text-xs text-text-secondary mb-1">Toplam Pozisyon Değeri</div>
          <div className="text-2xl"><NumberDisplay value={totalValue} prefix="$" /></div>
        </div>
        <div className="bg-surface border border-border rounded p-4 flex flex-col justify-center gap-2">
          <div className="flex justify-between text-xs">
            <span className="text-text-secondary">Margin Kullanımı</span>
            <span>{marginUsage.toFixed(0)}%</span>
          </div>
          <div className="h-2 w-full bg-border rounded-full overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${marginUsage.toFixed(0)}%` }} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-black/20">
          <span className="text-xs text-text-secondary">Açık Pozisyonlar ({positions.length})</span>
          {positions.length > 0 && (
            <button
              onClick={handleCloseAll}
              className="px-3 py-1 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 transition-colors"
            >
              Tümünü Kapat
            </button>
          )}
        </div>
        <div className="overflow-x-auto flex-1">
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
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-text-secondary">
                    Yükleniyor...
                  </td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-text-secondary">
                    Pozisyon bulunamadı
                  </td>
                </tr>
              ) : (
                positions.map((pos) => {
                  const pnlTrend = pos.pnl >= 0 ? 'up' : 'down';
                  const markVsEntry = pos.side === 'LONG'
                    ? (pos.markPrice >= pos.entryPrice ? 'text-success' : 'text-danger')
                    : (pos.markPrice <= pos.entryPrice ? 'text-success' : 'text-danger');

                  return (
                    <tr key={pos.symbol} className="hover:bg-border/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{pos.symbol}</td>
                      <td className={`px-4 py-3 font-medium ${pos.side === 'LONG' ? 'text-success' : 'text-danger'}`}>
                        {pos.side}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <NumberDisplay value={pos.size} decimals={4} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <NumberDisplay value={pos.entryPrice} />
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums ${markVsEntry}`}>
                        <NumberDisplay value={pos.markPrice} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                        <NumberDisplay value={pos.liquidationPrice} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <NumberDisplay
                          value={Math.abs(pos.pnl)}
                          prefix={pos.pnl >= 0 ? '+' : '-'}
                          trend={pnlTrend}
                        />
                        <span className={`ml-1 text-xs ${pnlTrend === 'up' ? 'text-success' : 'text-danger'}`}>
                          ({pos.pnlPercent.toFixed(1)}%)
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <NumberDisplay value={pos.margin} /> ({pos.leverage}x)
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleClose(pos)}
                            className="px-2 py-1 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 transition-colors"
                          >
                            Kapat
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmOpen}
        title={confirmTitle}
        message={confirmMessage}
        onConfirm={() => confirmActionRef.current()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
