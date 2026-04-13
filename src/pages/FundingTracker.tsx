import React, { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Clock, TrendingUp, TrendingDown } from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { useSettingsStore } from '../store/settingsStore';
import { getErrorMessage } from '../lib/utils';
import { fetchTickers, fetchPositions } from '../api/services';

interface FundingRow {
  symbol: string;
  fundingRate: number;
  apr: number;
  openInterest: number | null;
  volume24h: number;
}

interface PersonalFundingRow {
  symbol: string;
  side: string;
  size: number;
  fundingRate: number;
  estimatedPayment: number;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

function getTimeToNextFunding(): string {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const utcS = now.getUTCSeconds();
  const totalSeconds = utcH * 3600 + utcM * 60 + utcS;

  const intervals = [0, 8 * 3600, 16 * 3600, 24 * 3600];
  let remaining = 0;
  for (const boundary of intervals) {
    if (boundary > totalSeconds) {
      remaining = boundary - totalSeconds;
      break;
    }
  }
  if (remaining === 0) remaining = 24 * 3600 - totalSeconds;

  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getFundingHeatColor(rate: number): string {
  const absRate = Math.abs(rate) * 100;
  if (absRate > 0.1) return rate > 0 ? 'bg-success/20' : 'bg-info/20';
  if (absRate > 0.05) return rate > 0 ? 'bg-success/10' : 'bg-info/10';
  return '';
}

export const FundingTracker: React.FC = () => {
  const { apiKeyName, privateKey } = useSettingsStore();
  const hasKeys = !!(apiKeyName && privateKey);

  const [rows, setRows] = useState<FundingRow[]>([]);
  const [personalRows, setPersonalRows] = useState<PersonalFundingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [countdown, setCountdown] = useState(getTimeToNextFunding());

  const loadTickers = useCallback(async () => {
    try {
      const rawTickers = await fetchTickers('perps');
      const tickers = Array.isArray(rawTickers) ? rawTickers : [];

      const mapped: FundingRow[] = tickers
        .filter((t: Record<string, unknown>) => t.fundingRate !== undefined && t.fundingRate !== null)
        .map((t: Record<string, unknown>) => {
          const fundingRate = parseFloat(String(t.fundingRate ?? 0));
          const apr = fundingRate * 3 * 365;
          const openInterest = t.openInterest != null ? parseFloat(String(t.openInterest)) : null;
          const volume24h = parseFloat(String(t.quoteVolume ?? t.volume ?? 0));
          return {
            symbol: String(t.symbol ?? ''),
            fundingRate,
            apr,
            openInterest,
            volume24h,
          };
        })
        .sort((a: FundingRow, b: FundingRow) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));

      setRows(mapped);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Funding verileri yüklenemedi'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPersonalData = useCallback(async () => {
    if (!hasKeys) return;
    setPersonalLoading(true);
    try {
      const [rawPositions, rawTickers] = await Promise.all([
        fetchPositions(),
        fetchTickers('perps'),
      ]);

      const tickers = Array.isArray(rawTickers) ? rawTickers : [];
      const rateMap: Record<string, number> = {};
      for (const item of tickers) {
        const t = item as Record<string, unknown>;
        if (t.fundingRate != null) {
          rateMap[String(t.symbol)] = parseFloat(String(t.fundingRate));
        }
      }

      const positions = Array.isArray(rawPositions) ? rawPositions : [];
      const mapped: PersonalFundingRow[] = positions.map((pos: Record<string, unknown>) => {
        const symbol = String(pos.symbol ?? '');
        const size = Math.abs(parseFloat(String(pos.size ?? pos.quantity ?? 0)));
        const side = pos.side === 1 || pos.side === 'BUY' || pos.side === 'LONG' ? 'LONG' : 'SHORT';
        const fundingRate = rateMap[symbol] ?? 0;
        const direction = side === 'LONG' ? -1 : 1;
        const markPrice = parseFloat(String(pos.markPrice ?? pos.entryPrice ?? 0));
        const estimatedPayment = direction * size * markPrice * fundingRate;
        return { symbol, side, size, fundingRate, estimatedPayment };
      });

      setPersonalRows(mapped);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Pozisyon verileri yüklenemedi'));
    } finally {
      setPersonalLoading(false);
    }
  }, [hasKeys]);

  useEffect(() => {
    loadTickers();
    if (hasKeys) loadPersonalData();
    const interval = setInterval(() => {
      loadTickers();
      if (hasKeys) loadPersonalData();
    }, 30_000);
    return () => clearInterval(interval);
  }, [loadTickers, loadPersonalData, hasKeys]);

  useEffect(() => {
    const timer = setInterval(() => setCountdown(getTimeToNextFunding()), 1000);
    return () => clearInterval(timer);
  }, []);

  const highestApr = rows.length > 0
    ? rows.reduce((best, r) => (r.apr > best.apr ? r : best), rows[0])
    : null;
  const lowestApr = rows.length > 0
    ? rows.reduce((worst, r) => (r.apr < worst.apr ? r : worst), rows[0])
    : null;

  const totalEstimated = personalRows.reduce((sum, r) => sum + r.estimatedPayment, 0);

  return (
    <div className="p-6 flex flex-col gap-5 h-[calc(100vh-52px)] overflow-hidden">
      {/* Top Info Bar */}
      <div className="flex items-center gap-4 shrink-0">
        <div className="stat-card flex-1 !p-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Clock size={16} className="text-primary" />
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase">Sonraki Funding</div>
              <div className="text-lg font-mono tabular-nums font-semibold text-primary">{countdown}</div>
            </div>
          </div>
        </div>
        {highestApr && (
          <div className="stat-card flex-1 !p-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-success/10 flex items-center justify-center">
                <TrendingUp size={16} className="text-success" />
              </div>
              <div>
                <div className="text-[10px] text-text-muted uppercase">En Yüksek APR</div>
                <div className="text-sm font-semibold">
                  <span className="text-success">{highestApr.symbol}</span>
                  <span className="text-text-secondary ml-2">{(highestApr.apr * 100).toFixed(2)}%</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {lowestApr && (
          <div className="stat-card flex-1 !p-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-info/10 flex items-center justify-center">
                <TrendingDown size={16} className="text-info" />
              </div>
              <div>
                <div className="text-[10px] text-text-muted uppercase">En Düşük APR</div>
                <div className="text-sm font-semibold">
                  <span className="text-info">{lowestApr.symbol}</span>
                  <span className="text-text-secondary ml-2">{(lowestApr.apr * 100).toFixed(2)}%</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Global Funding Rates Table */}
      <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Global Funding Rates</span>
          <span className="badge badge-primary">{rows.length} pairs</span>
        </div>
        <div className="overflow-auto flex-1">
          <table className="data-table text-sm text-left whitespace-nowrap">
            <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
              <tr>
                <th className="px-5 py-3 font-medium">Sembol</th>
                <th className="px-5 py-3 font-medium text-right">Funding Rate (8h)</th>
                <th className="px-5 py-3 font-medium text-right">Yıllık APR</th>
                <th className="px-5 py-3 font-medium text-right">Açık Faiz (OI)</th>
                <th className="px-5 py-3 font-medium text-right">24h Hacim</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center gap-3 text-text-muted">
                      <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">Yükleniyor...</span>
                    </div>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center text-text-muted text-sm">
                    Funding verisi bulunamadı
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const isPositive = row.fundingRate >= 0;
                  const rateColor = isPositive ? 'text-success' : 'text-info';
                  const heatClass = getFundingHeatColor(row.fundingRate);

                  return (
                    <tr key={row.symbol} className={`hover:bg-surface-hover/30 transition-colors ${heatClass}`}>
                      <td className="px-5 py-3 font-medium">{row.symbol}</td>
                      <td className={`px-5 py-3 text-right tabular-nums font-mono ${rateColor}`}>
                        {isPositive ? '+' : ''}{(row.fundingRate * 100).toFixed(4)}%
                      </td>
                      <td className={`px-5 py-3 text-right tabular-nums font-mono ${rateColor}`}>
                        {isPositive ? '+' : ''}{(row.apr * 100).toFixed(2)}%
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-mono text-text-secondary">
                        {row.openInterest != null ? `${formatCompact(row.openInterest)}` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums font-mono text-text-secondary">
                        {formatCompact(row.volume24h)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Personal Funding */}
      <div className="h-1/3 min-h-[250px] glass-card flex flex-col overflow-hidden p-0">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Kişisel Funding</span>
          {hasKeys && personalRows.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-muted">Tahmini Ödeme:</span>
              <NumberDisplay
                value={Math.abs(totalEstimated)}
                prefix={totalEstimated >= 0 ? '+$' : '-$'}
                trend={totalEstimated >= 0 ? 'up' : 'down'}
                decimals={4}
                className="text-xs"
              />
            </div>
          )}
        </div>
        {!hasKeys ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            <div className="text-center">
              <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mx-auto mb-3">
                <Clock size={20} className="text-text-muted" />
              </div>
              <p>API anahtarınızı yapılandırarak kişisel funding verilerinizi görün.</p>
            </div>
          </div>
        ) : personalLoading ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : personalRows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
            Açık pozisyon bulunamadı.
          </div>
        ) : (
          <div className="overflow-auto flex-1">
            <table className="data-table text-sm text-left whitespace-nowrap">
              <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
                <tr>
                  <th className="px-5 py-3 font-medium">Sembol</th>
                  <th className="px-5 py-3 font-medium">Yön</th>
                  <th className="px-5 py-3 font-medium text-right">Boyut</th>
                  <th className="px-5 py-3 font-medium text-right">Funding Rate</th>
                  <th className="px-5 py-3 font-medium text-right">Tahmini Ödeme</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {personalRows.map((row) => (
                  <tr key={row.symbol} className="hover:bg-surface-hover/30 transition-colors">
                    <td className="px-5 py-3 font-medium">{row.symbol}</td>
                    <td className="px-5 py-3">
                      <span className={`badge ${row.side === 'LONG' ? 'badge-success' : 'badge-danger'}`}>
                        {row.side}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-mono text-text-secondary">
                      <NumberDisplay value={row.size} decimals={4} />
                    </td>
                    <td className={`px-5 py-3 text-right tabular-nums font-mono ${row.fundingRate >= 0 ? 'text-success' : 'text-info'}`}>
                      {(row.fundingRate * 100).toFixed(4)}%
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-mono">
                      <NumberDisplay
                        value={Math.abs(row.estimatedPayment)}
                        prefix={row.estimatedPayment >= 0 ? '+$' : '-$'}
                        trend={row.estimatedPayment >= 0 ? 'up' : 'down'}
                        decimals={4}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
