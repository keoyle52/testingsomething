import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Coins, Building2, RefreshCw, AlertTriangle, TrendingUp } from 'lucide-react';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import {
  fetchBtcTreasuries,
  fetchBtcPurchaseHistory,
  aggregateInstitutionalBtcFlow,
  type BtcTreasuryCompany,
  type BtcPurchaseRow,
} from '../api/sosoExtraServices';
import { useSettingsStore } from '../store/settingsStore';
import { cn } from '../lib/utils';

interface CompanyDetail {
  company: BtcTreasuryCompany;
  rows: BtcPurchaseRow[];
}

interface AggregateSummary {
  totalBtc: number;
  buyerCount: number;
  topBuyer: { ticker: string; btc: number } | null;
  signal: number;
}

export const BtcTreasuries: React.FC = () => {
  const { isDemoMode, sosoApiKey } = useSettingsStore();
  const [companies, setCompanies] = useState<BtcTreasuryCompany[]>([]);
  const [activeTicker, setActiveTicker] = useState<string | null>(null);
  const [activeRows, setActiveRows] = useState<BtcPurchaseRow[]>([]);
  const [allDetails, setAllDetails] = useState<CompanyDetail[]>([]);
  const [aggregate, setAggregate] = useState<AggregateSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Async load helper — wrapped in useCallback so the effect body has no
  // synchronous setState calls (React-Compiler purity rule).
  const refresh = useCallback(async () => {  
    try {
      const [list, agg] = await Promise.all([
        fetchBtcTreasuries(),
        aggregateInstitutionalBtcFlow(30),
      ]);
      setCompanies(list);
      setAggregate(agg);
      setActiveTicker((prev) => prev ?? list[0]?.ticker ?? null);
      // Pre-fetch a small sample of histories so the "all companies"
      // breakdown table can show recent activity per row without one
      // request-per-row when the user hovers them.
      // In demo mode skip prefetch — history is generated synchronously on demand.
      if (!isDemoMode) {
        const sample = list.slice(0, 4);
        const details = await Promise.all(sample.map(async (c) => ({
          company: c,
          rows: await fetchBtcPurchaseHistory(c.ticker, 10).catch(() => []),
        })));
        setAllDetails(details);
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Failed to load BTC treasuries');
    } finally {
      setLoading(false);
    }
   
  }, [isDemoMode]);

  // Initial company list + 30d aggregate — async work, no setState in body.
  useEffect(() => { void refresh(); }, [refresh, isDemoMode, sosoApiKey]);

  // Reload purchase history when active ticker changes.
  useEffect(() => {
    if (!activeTicker) return;
    let cancelled = false;
    fetchBtcPurchaseHistory(activeTicker, 50)
      .then((rows) => !cancelled && setActiveRows(rows))
      .catch(() => !cancelled && setActiveRows([]));
    return () => { cancelled = true; };
  }, [activeTicker, isDemoMode, sosoApiKey]);

  const activeCompany = useMemo(
    () => companies.find((c) => c.ticker === activeTicker) ?? null,
    [companies, activeTicker],
  );

  // Lazy-initialised cutoff — pure under React-Compiler because useState's
  // initializer fires exactly once at mount. Stale across week-long
  // sessions is acceptable here; refresh button reloads the page-level data.
  const [cutoff] = useState(() => Date.now() - 30 * 86_400_000);
  const last30Sorted = useMemo(() => {
    return [...allDetails]
      .map((d) => {
        const recent = d.rows.filter((r) => new Date(r.date).getTime() >= cutoff);
        return { ...d, recentBtc: recent.reduce((s, r) => s + r.btcAcq, 0) };
      })
      .sort((a, b) => b.recentBtc - a.recentBtc);
  }, [allDetails, cutoff]);

  return (
    <div className="flex flex-col gap-6 max-w-screen-xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center">
            <Coins size={16} className="text-warning" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text-primary">BTC Treasury Tracker</h1>
            <p className="text-xs text-text-muted">
              Public companies holding BTC on their balance sheet — purchases, holdings and trailing 30-day flow.
            </p>
          </div>
        </div>
        <Button
          variant="ghost" size="sm" icon={<RefreshCw size={14} />}
          onClick={() => { setLoading(true); void refresh(); }}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {errMsg && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
          <AlertTriangle size={13} /> {errMsg}
        </div>
      )}

      {/* 30d aggregate summary */}
      <Card className="p-5">
        <div className="flex items-center justify-between flex-wrap gap-6">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Last 30 days</div>
            <div className="text-2xl font-black font-mono text-amber-400 mt-1">
              {aggregate ? `+${Math.round(aggregate.totalBtc).toLocaleString()} BTC` : '—'}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {aggregate
                ? `${aggregate.buyerCount} corporate buyer${aggregate.buyerCount === 1 ? '' : 's'} accumulated BTC`
                : 'Aggregating…'}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Top accumulator</div>
            <div className="text-lg font-bold font-mono text-text-primary mt-1">
              {aggregate?.topBuyer ? aggregate.topBuyer.ticker : '—'}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {aggregate?.topBuyer ? `+${Math.round(aggregate.topBuyer.btc).toLocaleString()} BTC` : ''}
            </div>
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              Predictor signal contribution
            </div>
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-1 h-2 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full',
                    aggregate && aggregate.signal >= 0 ? 'bg-emerald-400' : 'bg-red-400',
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, Math.abs((aggregate?.signal ?? 0)) * 100))}%` }}
                />
              </div>
              <span className={cn(
                'text-xs font-bold font-mono w-12 text-right',
                aggregate && aggregate.signal >= 0 ? 'text-emerald-400' : 'text-red-400',
              )}>
                {aggregate ? `${aggregate.signal >= 0 ? '+' : ''}${aggregate.signal.toFixed(2)}` : '—'}
              </span>
            </div>
            <div className="text-[10px] text-text-muted mt-1">
              Feeds the BTC Predictor as the 9th composite signal (weight 0.05).
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Company list */}
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Building2 size={16} className="text-warning" />
            <h2 className="text-sm font-semibold text-text-primary">Companies</h2>
            <span className="ml-auto text-[10px] text-text-muted">{companies.length}</span>
          </div>
          <div className="max-h-[480px] overflow-y-auto divide-y divide-white/5">
            {companies.map((c) => {
              const detail = last30Sorted.find((d) => d.company.ticker === c.ticker);
              const recent = detail?.recentBtc ?? 0;
              return (
                <button
                  key={c.ticker}
                  onClick={() => setActiveTicker(c.ticker)}
                  className={cn(
                    'w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-white/[0.03] transition-colors',
                    activeTicker === c.ticker && 'bg-primary/5',
                  )}
                >
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="text-sm font-bold text-text-primary truncate">{c.ticker}</span>
                    <span className="text-[10px] text-text-muted truncate">{c.name}</span>
                  </div>
                  <span className="text-[10px] text-text-muted shrink-0">{c.listLocation}</span>
                  {recent > 0 && (
                    <span className="text-[10px] font-mono font-bold text-emerald-400 shrink-0">
                      +{Math.round(recent).toLocaleString()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        {/* Selected company purchase history */}
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
            <TrendingUp size={16} className="text-warning" />
            <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">
              {activeCompany ? `${activeCompany.ticker} purchase history` : 'Purchase history'}
            </h2>
            {activeCompany && (
              <span className="text-[10px] text-text-muted">{activeCompany.name}</span>
            )}
            <span className="ml-auto text-[10px] text-text-muted">
              {activeRows.length} purchases
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5 text-[11px] text-text-muted uppercase tracking-wider">
                  <th className="px-5 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-4 py-2.5 text-right font-semibold">BTC Acquired</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Avg Cost</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Spend (USD)</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Holdings</th>
                </tr>
              </thead>
              <tbody>
                {activeRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-text-muted text-sm">
                      {loading ? 'Loading…' : 'No purchase history available.'}
                    </td>
                  </tr>
                ) : (
                  activeRows.map((row, idx) => (
                    <tr key={`${row.date}-${idx}`} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="px-5 py-2.5 text-sm text-text-primary font-mono">{row.date}</td>
                      <td className="px-4 py-2.5 text-sm text-emerald-400 font-mono font-semibold text-right">
                        +{row.btcAcq.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-text-secondary font-mono text-right">
                        ${row.avgBtcCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-text-secondary font-mono text-right">
                        ${(row.acqCost / 1e6).toFixed(2)}M
                      </td>
                      <td className="px-5 py-2.5 text-sm text-text-primary font-mono text-right">
                        {row.btcHolding.toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
};
