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
import { DEMO_TICKERS, DEMO_BALANCE, DEMO_TOTAL_PNL, DEMO_POSITIONS } from '../api/demoData';
import { useLiveTicker } from '../api/useLiveTicker';

interface TickerRow {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
}

export const Dashboard: React.FC = () => {
  const { privateKey, defaultSymbol, isTestnet, isDemoMode } = useSettingsStore();
  // A private key is sufficient to authenticate account endpoints:
  //  - Testnet: the key IS the master wallet.
  //  - Mainnet: the key is the API-key private key; the master EVM address
  //    is supplied separately through the Settings form.
  const hasKeys = !!privateKey;

  const [balance, setBalance] = useState(0);
  const [positionsCount, setPositionsCount] = useState(0);
  const [totalPnl, setTotalPnl] = useState(0);
  const [rawTickers, setRawTickers] = useState<TickerRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Live WS tickers layered on top of REST-fetched base data
  const liveTickers = useLiveTicker(rawTickers, rawTickers.map((t) => t.symbol));
  const tickers = liveTickers.length > 0 ? liveTickers : rawTickers;

  const loadData = useCallback(async () => {
    if (isDemoMode) {
      setRawTickers(DEMO_TICKERS);
      setBalance(DEMO_BALANCE);
      setPositionsCount(DEMO_POSITIONS.length);
      setTotalPnl(DEMO_TOTAL_PNL);
      setLoading(false);
      return;
    }

    try {
      const rawTickersRes = await fetchTickers('perps');
      const tickersArr = Array.isArray(rawTickersRes) ? rawTickersRes : [];
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
      setRawTickers(mapped);

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
  }, [hasKeys, isDemoMode]);

  useEffect(() => {
    loadData();
    if (isDemoMode) return;
    const timer = globalThis.setInterval(loadData, 15_000);
    return () => clearInterval(timer);
  }, [loadData, isDemoMode]);

  function formatCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 md:gap-5 h-[calc(100vh-52px)] overflow-y-auto">
      {/* Demo Mode Banner */}
      {isDemoMode && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium">
          <Activity size={13} className="shrink-0" />
          <span>
            <strong>Demo Mode</strong> — Simulated data with live price fluctuations. Connect your API key in Settings to trade live.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <p className="text-xs text-text-muted mt-0.5">
            {isDemoMode ? 'Demo Mode' : (isTestnet ? 'Testnet' : 'Mainnet')} — Overview
          </p>
        </div>
        <div className={`badge ${isDemoMode ? 'badge-neutral' : 'badge-primary'}`}>
          <Activity size={11} />
          {loading ? 'Loading...' : isDemoMode ? 'Demo' : 'Live'}
        </div>
      </div>

      {/* Stats Grid */}
      {(hasKeys || isDemoMode) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 shrink-0">
          <StatCard
            label="Balance"
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
            label="Open Positions"
            value={<NumberDisplay value={positionsCount} decimals={0} />}
            icon={<Layers size={16} />}
          />
          <StatCard
            label="Markets Tracked"
            value={<NumberDisplay value={tickers.length} decimals={0} />}
            icon={<BarChart3 size={16} />}
          />
        </div>
      )}

      {/* Chart */}
      <div className="shrink-0">
        <TradingChart
          symbol={defaultSymbol || 'BTC-USD'}
          market="perps"
          height={300}
        />
      </div>

      {/* Tickers Table */}
      <div className="flex-1 min-h-0 glass-card flex flex-col overflow-hidden p-0">
        <div className="px-4 md:px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Market Overview
          </span>
          <span className="badge badge-neutral">{tickers.length} pairs</span>
        </div>
        <div className="overflow-auto flex-1">
          <table className="data-table text-sm text-left whitespace-nowrap">
            <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
              <tr>
                <th className="px-4 md:px-5 py-3 font-medium">Symbol</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right">Price</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right">24h Change</th>
                <th className="px-4 md:px-5 py-3 font-medium text-right hidden md:table-cell">24h Volume</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center">
                    <div className="flex flex-col items-center gap-3 text-text-muted">
                      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Loading...</span>
                    </div>
                  </td>
                </tr>
              ) : tickers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-text-muted text-sm">
                    No market data available
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
