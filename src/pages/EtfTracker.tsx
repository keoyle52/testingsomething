import React, { useEffect, useState, useCallback } from 'react';
import { BarChart3, TrendingUp, TrendingDown, DollarSign, RefreshCw, Activity } from 'lucide-react';
import {
  fetchEtfCurrentMetrics,
  fetchEtfHistoricalInflow,
} from '../api/sosoServices';
import { clearSosoCache } from '../api/sosoValueClient';
import type { EtfDayData, EtfType, EtfCurrentMetrics } from '../api/sosoServices';
import { useSettingsStore } from '../store/settingsStore';
import { Card, StatCard } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';
import { createChart, HistogramSeries, ColorType } from 'lightweight-charts';
import toast from 'react-hot-toast';

const fmt = (v: number | null | undefined, prefix = '$') => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '+';
  if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${prefix}${abs.toFixed(2)}`;
};

const fmtRaw = (v: number | null | undefined, prefix = '$') => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${prefix}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(abs / 1e6).toFixed(2)}M`;
  return `${prefix}${abs.toLocaleString()}`;
};

export const EtfTracker: React.FC = () => {
  const { sosoApiKey } = useSettingsStore();
  const [etfType, setEtfType] = useState<EtfType>('us-btc-spot');
  const [metrics, setMetrics] = useState<EtfCurrentMetrics | null>(null);
  const [history, setHistory] = useState<EtfDayData[]>([]);
  const [loading, setLoading] = useState(false);
  const chartRef = React.useRef<HTMLDivElement>(null);

  const loadData = useCallback(async (forceRefresh = false) => {
    if (!sosoApiKey) {
      toast.error('Set your SosoValue API key in Settings first.');
      return;
    }
    if (forceRefresh) clearSosoCache();
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        fetchEtfCurrentMetrics(etfType),
        fetchEtfHistoricalInflow(etfType),
      ]);
      
      if (results[0].status === 'fulfilled') setMetrics(results[0].value);
      if (results[1].status === 'fulfilled') setHistory(results[1].value);

      // If both failed, throw error to show a unified toast
      if (results[0].status === 'rejected' && results[1].status === 'rejected') {
        throw results[0].reason;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch ETF data';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [etfType, sosoApiKey]);

  useEffect(() => { loadData(); }, [loadData]);

  // Chart
  useEffect(() => {
    const el = chartRef.current;
    if (!el || history.length === 0) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
      },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      width: el.clientWidth,
      height: 200,
    });

    const series = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
    });

    const sorted = [...history]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        time: d.date as import('lightweight-charts').Time,
        value: d.totalNetInflow,
        color: d.totalNetInflow >= 0 ? '#22c55e' : '#ef4444',
      }));

    series.setData(sorted);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => { chart.remove(); ro.disconnect(); };
  }, [history]);

  const isNoKey = !sosoApiKey;
  const label = etfType === 'us-btc-spot' ? 'BTC' : 'ETH';

  return (
    <div className="p-6 h-[calc(100vh-52px)] overflow-y-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">ETF Tracker</h2>
          <p className="text-[11px] text-text-muted">US Spot ETF flows & metrics — powered by SosoValue</p>
        </div>
        <div className="flex items-center gap-3">
          {/* BTC / ETH toggle */}
          <div className="flex gap-1 p-1 bg-surface/50 border border-border rounded-xl">
            {(['us-btc-spot', 'us-eth-spot'] as EtfType[]).map((t) => (
              <button
                key={t}
                onClick={() => setEtfType(t)}
                className={cn(
                  'px-4 py-1.5 text-xs font-semibold rounded-lg transition-all',
                  etfType === t ? 'bg-primary/10 text-primary' : 'text-text-muted hover:text-text-secondary',
                )}
              >
                {t === 'us-btc-spot' ? 'BTC' : 'ETH'}
              </button>
            ))}
          </div>
          <Button variant="outline" icon={<RefreshCw size={13} />} onClick={() => loadData(true)} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {isNoKey && (
        <div className="glass-card p-4 border border-warning/30 bg-warning/5 text-warning text-sm">
          ⚠️ No SosoValue API key set. Go to <strong>Settings → API Connection</strong> to add it.
        </div>
      )}

      {/* Summary stats */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard
            label="Total AUM"
            value={fmtRaw(metrics.totalNetAssets?.value)}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Daily Inflow"
            value={fmt(metrics.dailyNetInflow?.value)}
            icon={((metrics.dailyNetInflow?.value) ?? 0) >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            trend={((metrics.dailyNetInflow?.value) ?? 0) >= 0 ? 'up' : 'down'}
          />
          <StatCard
            label="Cumulative Inflow"
            value={fmt(metrics.cumNetInflow?.value)}
            icon={<BarChart3 size={16} />}
            trend={((metrics.cumNetInflow?.value) ?? 0) >= 0 ? 'up' : 'down'}
          />
          <StatCard
            label="Daily Volume"
            value={fmtRaw(metrics.dailyTotalValueTraded?.value)}
            icon={<Activity size={16} />}
          />
          <StatCard
            label={`${label} Holdings`}
            value={metrics.totalTokenHoldings?.value != null
              ? `${(metrics.totalTokenHoldings.value / 1000).toFixed(1)}K ${label}`
              : '—'}
            icon={<BarChart3 size={16} />}
          />
          <StatCard
            label="AUM / Mkt Cap"
            value={metrics.totalNetAssetsPercentage?.value != null
              ? `${(metrics.totalNetAssetsPercentage.value * 100).toFixed(2)}%`
              : '—'}
            icon={<Activity size={16} />}
          />
        </div>
      )}

      {/* Inflow Chart */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={15} className="text-primary" />
          <h3 className="text-sm font-semibold">Daily Net Inflow — Last 300 Days</h3>
          <span className="ml-auto text-[10px] text-text-muted">Green = inflow · Red = outflow</span>
        </div>
        <div ref={chartRef} className="w-full" style={{ minHeight: 200 }} />
        {history.length === 0 && !loading && (
          <p className="text-center text-text-muted text-xs py-6">No chart data yet</p>
        )}
      </Card>

      {/* ETF List */}
      {metrics?.list && metrics.list.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Individual ETFs
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table text-sm whitespace-nowrap w-full">
              <thead>
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Ticker</th>
                  <th className="px-5 py-3 text-left font-medium">Issuer</th>
                  <th className="px-5 py-3 text-right font-medium">AUM</th>
                  <th className="px-5 py-3 text-right font-medium">Daily Inflow</th>
                  <th className="px-5 py-3 text-right font-medium">Cum. Inflow</th>
                  <th className="px-5 py-3 text-right font-medium">Daily Volume</th>
                  <th className="px-5 py-3 text-right font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {metrics.list.map((etf) => (
                  <tr key={etf.id} className="border-t border-border/50 hover:bg-surface-hover transition-colors">
                    <td className="px-5 py-3 font-semibold text-primary">{etf.ticker}</td>
                    <td className="px-5 py-3 text-text-secondary text-xs">{etf.institute}</td>
                    <td className="px-5 py-3 text-right">{fmtRaw(etf.netAssets?.value)}</td>
                    <td className={cn(
                      'px-5 py-3 text-right font-medium',
                      etf.dailyNetInflow?.status === '3' ? 'text-text-muted' :
                      (etf.dailyNetInflow?.value ?? 0) >= 0 ? 'text-success' : 'text-danger',
                    )}>
                      {etf.dailyNetInflow?.status === '3' ? '—' : fmt(etf.dailyNetInflow?.value)}
                    </td>
                    <td className={cn(
                      'px-5 py-3 text-right',
                      (etf.cumNetInflow?.value ?? 0) >= 0 ? 'text-success' : 'text-danger',
                    )}>
                      {fmt(etf.cumNetInflow?.value)}
                    </td>
                    <td className="px-5 py-3 text-right">{fmtRaw(etf.dailyValueTraded?.value)}</td>
                    <td className="px-5 py-3 text-right text-text-muted">
                      {etf.fee?.value != null ? `${(etf.fee.value * 100).toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
};
