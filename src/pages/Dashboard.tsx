import React, { useEffect, useState, useCallback } from 'react';
import {
  Wallet,
  TrendingUp,
  BarChart3,
  Activity,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatCard } from '../components/common/Card';
import { TradingChart } from '../components/TradingChart';
import { useSettingsStore } from '../store/settingsStore';
import {
  fetchBalances,
  fetchPositions,
  fetchTickers,
  fetchMarkPrices,
} from '../api/services';

interface TickerRow {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
}

export const Dashboard: React.FC = () => {
  const { apiKeyName, privateKey, defaultSymbol, isTestnet } = useSettingsStore();
  const hasKeys = !!(apiKeyName && privateKey);

  const [balance, setBalance] = useState(0);
  const [positionsCount, setPositionsCount] = useState(0);
  const [totalPnl, setTotalPnl] = useState(0);
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const rawTickers = await fetchTickers('perps');
      const tickersArr = Array.isArray(rawTickers) ? rawTickers : [];
      const mapped: TickerRow[] = tickersArr
        .filter((t: Record<string, unknown>) => t.symbol)
        .map((t: Record<string, unknown>) => ({
          symbol: String(t.symbol),
          lastPrice: parseFloat(String(t.lastPrice ?? t.close ?? 0)),
          change24h: parseFloat(String(t.priceChangePercent ?? t.change ?? 0)),
          volume24h: parseFloat(String(t.quoteVolume ?? t.volume ?? 0)),
        }))
        .sort((a: TickerRow, b: TickerRow) => b.volume24h - a.volume24h)
        .slice(0, 20);
      setTickers(mapped);

      if (hasKeys) {
        const [rawBalances, rawPositions, rawPrices] = await Promise.all([
          fetchBalances('perps'),
          fetchPositions(),
          fetchMarkPrices(),
        ]);

        const balancesArr = Array.isArray(rawBalances) ? rawBalances : [];
        let total = 0;
        for (const b of balancesArr) {
          total += parseFloat(b.total ?? b.balance ?? b.available ?? b.totalBalance ?? 0);
        }
        setBalance(total);

        const positionsArr = Array.isArray(rawPositions) ? rawPositions : [];
        setPositionsCount(positionsArr.length);

        const priceMap: Record<string, number> = {};
        const pricesArr = Array.isArray(rawPrices) ? rawPrices : [];
        for (const p of pricesArr) {
          priceMap[p.symbol] = parseFloat(p.markPrice ?? p.price ?? 0);
        }

        let pnl = 0;
        for (const pos of positionsArr) {
          const rawSize = parseFloat(pos.size ?? pos.quantity ?? 0);
          const size = Math.abs(rawSize);
          const entryPrice = parseFloat(pos.avgEntryPrice ?? pos.entryPrice ?? pos.avgPrice ?? 0);
          const markPrice = priceMap[pos.symbol] ?? parseFloat(pos.markPrice ?? 0);
          // SoDEX position side is always BOTH: positive size = long, negative = short
          const side = (pos.side === 1 || pos.side === 'BUY' || pos.side === 'LONG' || (pos.side !== 'SHORT' && rawSize >= 0)) ? 1 : -1;
          pnl += side * size * (markPrice - entryPrice);
        }
        setTotalPnl(pnl);
      }
    } catch {
      // Dashboard data load failed
    } finally {
      setLoading(false);
    }
  }, [hasKeys]);

  useEffect(() => {
    loadData();
    const timer = globalThis.setInterval(loadData, 15_000);
    return () => clearInterval(timer);
  }, [loadData]);

  function formatCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 md:gap-5 h-[calc(100vh-52px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="text-xs text-text-muted mt-0.5">
            {isTestnet ? 'Testnet' : 'Mainnet'} - Genel Bakis
          </p>
        </div>
        <div className="badge badge-primary">
          <Activity size={11} />
          {loading ? 'Yikleniyor...' : 'Canli'}
        </div>
      </div>

      {/* Stats Grid */}
      {hasKeys && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 shrink-0">
          <StatCard
            label="Bakiye"
            value={<NumberDisplay value={balance} prefix="$" />}
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
            trend={totalPnl >= 0 ? (totalPnl > 0 ? 'up' : 'neutral') : 'down'}
          />
          <StatCard
            label="Acik Pozisyon"
            value={<NumberDisplay value={positionsCount} decimals={0} />}
            icon={<Layers size={16} />}
          />
          <StatCard
            label="Izlenen Piyasa"
            value={<NumberDisplay value={tickers.length} decimals={0} />}
            icon={<BarChart3 size={16} />}
          />
        </div>
      )}

      {/* Chart */}
      <div className="shrink-0">
        <TradingChart
          symbol={defaultSymbol || 'BTC-USDC'}
          market="perps"
          height={300}
        />
      </div>

      {/* Tickers Table */}
      <div className="flex-1 min-h-0 glass-card flex flex-col overflow-hidden p-0">
        <div className="px-4 md:px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Piyasa Ozeti
          </span>
          <span className="badge badge-neutral">{tickers.length} pair</span>
        </div>
        <div className="overflow-auto flex-1">
          <table className="data-table text-sm text-left whitespace-nowrap">
            <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
              <tr>
                <th className="px-4 md:px-5 py-3 font-medium">Sembol</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right">Fiyat</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right">24h Degisim</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right hidden md:table-cell">24h Hacim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center">
                    <div className="flex flex-col items-center gap-3 text-text-muted">
                      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Yikleniyor...</span>
                    </div>
                  </td>
                </tr>
              ) : tickers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-text-muted text-sm">
                    Piyasa verisi bulunamadi
                  </td>
                </tr>
              ) : (
                tickers.map((t) => {
                  const isUp = t.change24h >= 0;
                  return (
                    <tr key={t.symbol} className="hover:bg-surface-hover/30 transition-colors">
                      <td className="px-4 md:px-5 py-3 font-medium">{t.symbol}</td>
                      <td className="px-4 md:px-5 py-3 text-right tabular-nums font-mono">
                        <NumberDisplay value={t.lastPrice} />
                      </td>
                      <td className="px-4 md:px-5 py-3 text-right">
                        <span className={`inline-flex items-center gap-1 text-xs font-mono tabular-nums ${isUp ? 'text-success' : 'text-danger'}`}>
                          {isUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                          {isUp ? '+' : ''}{t.change24h.toFixed(2)}%
                        </span>
                      </td>
                      <td className="px-4 md:px-5 py-3 text-right tabular-nums font-mono text-text-secondary hidden md:table-cell">
                        {formatCompact(t.volume24h)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
