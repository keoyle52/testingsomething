import React, { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Wallet, TrendingUp, BarChart3, Shield, X as XIcon } from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Button } from '../components/common/Button';
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
        totalBalance += parseFloat(b.total ?? b.balance ?? b.available ?? b.totalBalance ?? 0);
      }
      setMarginBalance(totalBalance);

      const positionsArr = Array.isArray(rawPositions) ? rawPositions : [];
      const mapped: PositionRow[] = positionsArr.map((pos: any) => {
        const rawSize = parseFloat(pos.size ?? pos.quantity ?? 0);
        const size = Math.abs(rawSize);
        const entryPrice = parseFloat(pos.avgEntryPrice ?? pos.entryPrice ?? pos.avgPrice ?? 0);
        const symbol = pos.symbol ?? '';
        const markPrice = priceMap[symbol] ?? parseFloat(pos.markPrice ?? 0);
        const liquidationPrice = parseFloat(pos.liquidationPrice ?? pos.liqPrice ?? 0);
        const margin = parseFloat(pos.initialMargin ?? pos.margin ?? 0);
        const leverage = parseFloat(pos.leverage ?? 0);

        // SoDEX: position side is always BOTH. Positive size = LONG, negative = SHORT.
        const side = (pos.side === 'LONG' || (pos.side !== 'SHORT' && rawSize >= 0))
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

  const marginColor = marginUsage > 80 ? 'danger' : marginUsage > 50 ? 'warning' : 'primary';

  return (
    <div className="p-6 flex flex-col gap-5 h-[calc(100vh-52px)] overflow-hidden">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 shrink-0">
        <StatCard
          label="Margin Balance"
          value={<NumberDisplay value={marginBalance} prefix="$" />}
          icon={<Wallet size={16} />}
        />
        <StatCard
          label="Unrealized PnL"
          value={
            <NumberDisplay
              value={Math.abs(totalPnl)}
              prefix={totalPnl >= 0 ? '+$' : '-$'}
              trend={totalPnl >= 0 ? 'up' : 'down'}
            />
          }
          icon={<TrendingUp size={16} />}
          trend={totalPnl >= 0 ? 'up' : 'down'}
        />
        <StatCard
          label="Pozisyon Değeri"
          value={<NumberDisplay value={totalValue} prefix="$" />}
          icon={<BarChart3 size={16} />}
        />
        <div className="stat-card">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-2">Margin Kullanımı</div>
              <div className="text-xl font-semibold font-mono tabular-nums">{marginUsage.toFixed(0)}%</div>
            </div>
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <Shield size={16} />
            </div>
          </div>
          <div className="mt-3 h-1.5 bg-background rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                marginColor === 'danger' ? 'bg-danger' :
                marginColor === 'warning' ? 'bg-warning' :
                'bg-gradient-to-r from-primary to-primary-soft'
              }`}
              style={{ width: `${marginUsage}%` }}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Açık Pozisyonlar
            </span>
            <span className="badge badge-primary">{positions.length}</span>
          </div>
          {positions.length > 0 && (
            <Button variant="danger" size="sm" icon={<XIcon size={12} />} onClick={handleCloseAll}>
              Tümünü Kapat
            </Button>
          )}
        </div>
        <div className="overflow-auto flex-1">
          <table className="data-table text-sm text-left whitespace-nowrap">
            <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
              <tr>
                <th className="px-5 py-3 font-medium">Sembol</th>
                <th className="px-5 py-3 font-medium">Yön</th>
                <th className="px-5 py-3 font-medium text-right">Boyut</th>
                <th className="px-5 py-3 font-medium text-right">Giriş</th>
                <th className="px-5 py-3 font-medium text-right">Mark</th>
                <th className="px-5 py-3 font-medium text-right">Liq.</th>
                <th className="px-5 py-3 font-medium text-right">PnL</th>
                <th className="px-5 py-3 font-medium text-right">Margin</th>
                <th className="px-5 py-3 font-medium text-right">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center gap-3 text-text-muted">
                      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Yükleniyor...</span>
                    </div>
                  </td>
                </tr>
              ) : positions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-5 py-16 text-center text-text-muted text-sm">
                    Açık pozisyon bulunamadı
                  </td>
                </tr>
              ) : (
                positions.map((pos) => {
                  const pnlTrend = pos.pnl >= 0 ? 'up' : 'down';
                  const markVsEntry = pos.side === 'LONG'
                    ? (pos.markPrice >= pos.entryPrice ? 'text-success' : 'text-danger')
                    : (pos.markPrice <= pos.entryPrice ? 'text-success' : 'text-danger');

                  return (
                    <tr key={pos.symbol} className="hover:bg-surface-hover/30 transition-colors group">
                      <td className="px-5 py-3.5 font-medium">{pos.symbol}</td>
                      <td className="px-5 py-3.5">
                        <span className={`badge ${pos.side === 'LONG' ? 'badge-success' : 'badge-danger'}`}>
                          {pos.side}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-mono text-text-secondary">
                        <NumberDisplay value={pos.size} decimals={4} />
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-mono">
                        <NumberDisplay value={pos.entryPrice} />
                      </td>
                      <td className={`px-5 py-3.5 text-right tabular-nums font-mono ${markVsEntry}`}>
                        <NumberDisplay value={pos.markPrice} />
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-mono text-text-muted">
                        <NumberDisplay value={pos.liquidationPrice} />
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <NumberDisplay
                            value={Math.abs(pos.pnl)}
                            prefix={pos.pnl >= 0 ? '+' : '-'}
                            trend={pnlTrend}
                          />
                          <span className={`text-[10px] ${pnlTrend === 'up' ? 'text-success' : 'text-danger'}`}>
                            ({pos.pnlPercent.toFixed(1)}%)
                          </span>
                        </div>
                        {/* PnL bar */}
                        <div className="mt-1 h-0.5 w-full bg-background rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pnlTrend === 'up' ? 'bg-success/50' : 'bg-danger/50'}`}
                            style={{ width: `${Math.min(Math.abs(pos.pnlPercent), 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right tabular-nums font-mono text-text-secondary">
                        <NumberDisplay value={pos.margin} />
                        <span className="text-text-muted text-[10px] ml-1">({pos.leverage}x)</span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleClose(pos)}
                          className="opacity-60 group-hover:opacity-100 transition-opacity"
                        >
                          Kapat
                        </Button>
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
