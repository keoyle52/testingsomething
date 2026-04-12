import React, { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { useSettingsStore } from '../store/settingsStore';
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

  // Funding every 8 hours at 00:00, 08:00, 16:00 UTC
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
        .filter((t: any) => t.fundingRate !== undefined && t.fundingRate !== null)
        .map((t: any) => {
          const fundingRate = parseFloat(t.fundingRate ?? 0);
          const apr = fundingRate * 3 * 365;
          const openInterest = t.openInterest != null ? parseFloat(t.openInterest) : null;
          const volume24h = parseFloat(t.quoteVolume ?? t.volume ?? 0);
          return {
            symbol: t.symbol ?? '',
            fundingRate,
            apr,
            openInterest,
            volume24h,
          };
        })
        .sort((a: FundingRow, b: FundingRow) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));

      setRows(mapped);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Funding verileri yüklenemedi';
      toast.error(msg);
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
      for (const t of tickers) {
        if (t.fundingRate != null) {
          rateMap[t.symbol] = parseFloat(t.fundingRate);
        }
      }

      const positions = Array.isArray(rawPositions) ? rawPositions : [];
      const mapped: PersonalFundingRow[] = positions.map((pos: any) => {
        const symbol = pos.symbol ?? '';
        const size = Math.abs(parseFloat(pos.size ?? pos.quantity ?? 0));
        const side = pos.side === 1 || pos.side === 'BUY' || pos.side === 'LONG' ? 'LONG' : 'SHORT';
        const fundingRate = rateMap[symbol] ?? 0;
        // Long positions pay funding when rate is positive, short positions receive
        const direction = side === 'LONG' ? -1 : 1;
        const markPrice = parseFloat(pos.markPrice ?? pos.entryPrice ?? 0);
        const estimatedPayment = direction * size * markPrice * fundingRate;
        return { symbol, side, size, fundingRate, estimatedPayment };
      });

      setPersonalRows(mapped);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Pozisyon verileri yüklenemedi';
      toast.error(msg);
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

  // Update countdown every second
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
    <div className="p-6 flex flex-col gap-6 h-[calc(100vh-48px)] overflow-hidden">
      <div className="flex-1 bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-medium flex justify-between items-center">
          <span>Global Funding Rates</span>
          <div className="flex gap-2">
            {highestApr && (
              <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded border border-primary/30">
                En Yüksek APR: {highestApr.symbol} ({(highestApr.apr * 100).toFixed(2)}%)
              </span>
            )}
            {lowestApr && (
              <span className="px-2 py-1 bg-primary/10 text-primary text-xs rounded border border-primary/30">
                En Düşük APR: {lowestApr.symbol} ({(lowestApr.apr * 100).toFixed(2)}%)
              </span>
            )}
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
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-text-secondary">
                    Yükleniyor...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-text-secondary">
                    Funding verisi bulunamadı
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const rateColor = row.fundingRate >= 0 ? 'text-primary' : 'text-blue-500';
                  return (
                    <tr key={row.symbol} className="hover:bg-border/30 transition-colors">
                      <td className="px-4 py-3 font-medium">{row.symbol}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${rateColor}`}>
                        {row.fundingRate >= 0 ? '' : '-'}{(Math.abs(row.fundingRate) * 100).toFixed(4)}%
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums ${rateColor}`}>
                        {row.apr >= 0 ? '' : '-'}{(Math.abs(row.apr) * 100).toFixed(2)}%
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{countdown}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.openInterest != null ? `${formatCompact(row.openInterest)} USDC` : '-'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCompact(row.volume24h)} USDC
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="h-1/3 min-h-[300px] bg-surface border border-border rounded flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-medium flex justify-between items-center">
          <span>Kişisel Funding Geçmişi</span>
          {hasKeys && personalRows.length > 0 && (
            <div className="text-xs text-text-secondary">
              Tahmini Sonraki Ödeme:{' '}
              <NumberDisplay
                value={Math.abs(totalEstimated)}
                prefix={totalEstimated >= 0 ? '+$' : '-$'}
                trend={totalEstimated >= 0 ? 'up' : 'down'}
                decimals={4}
              />
            </div>
          )}
        </div>
        {!hasKeys ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">
            Bu veriyi görüntülemek için API anahtarınızı yapılandırın.
          </div>
        ) : personalLoading ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">
            Yükleniyor...
          </div>
        ) : personalRows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">
            Açık pozisyon bulunamadı.
          </div>
        ) : (
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-sm text-left whitespace-nowrap">
              <thead className="text-xs text-text-secondary border-b border-border bg-black/20">
                <tr>
                  <th className="px-4 py-3 font-medium">Sembol</th>
                  <th className="px-4 py-3 font-medium">Yön</th>
                  <th className="px-4 py-3 font-medium text-right">Boyut</th>
                  <th className="px-4 py-3 font-medium text-right">Funding Rate</th>
                  <th className="px-4 py-3 font-medium text-right">Tahmini Ödeme</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {personalRows.map((row) => (
                  <tr key={row.symbol} className="hover:bg-border/30 transition-colors">
                    <td className="px-4 py-3 font-medium">{row.symbol}</td>
                    <td className={`px-4 py-3 font-medium ${row.side === 'LONG' ? 'text-success' : 'text-danger'}`}>
                      {row.side}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <NumberDisplay value={row.size} decimals={4} />
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums ${row.fundingRate >= 0 ? 'text-primary' : 'text-blue-500'}`}>
                      {(row.fundingRate * 100).toFixed(4)}%
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
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
