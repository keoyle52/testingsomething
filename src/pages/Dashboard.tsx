import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet,
  TrendingUp,
  BarChart3,
  Activity,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  Zap,
} from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatCard, Card } from '../components/common/Card';
import { TradingChart } from '../components/TradingChart';
import { useSettingsStore } from '../store/settingsStore';
import { usePredictorStore } from '../store/predictorStore';
import {
  fetchBalances,
  fetchPositions,
  fetchTickers,
  fetchMarkPrices,
} from '../api/services';
import { useLiveTicker } from '../api/useLiveTicker';
import {
  classifyRegime,
  recommendBot,
  recommendationLink,
  regimeLabel,
  botLabel,
  type RegimeInputs,
} from '../api/aiOrchestrator';
import { cn } from '../lib/utils';

interface TickerRow {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
}

export const Dashboard: React.FC = () => {
  const { privateKey, defaultSymbol, isTestnet, isDemoMode } = useSettingsStore();
  // Pull current Predictor signals so the AI Orchestrator can use the
  // technical features (ATR, EMA, MACD) without re-fetching klines.
  // When the Predictor hasn't run yet (currentSignals === null) we
  // fall back to a "Run Predictor first" recommendation card.
  const predictorSignals = usePredictorStore((s) => s.currentSignals);
  const aiVerdict        = usePredictorStore((s) => s.aiVerdict);
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
    try {
      // In demo mode useLiveTicker already feeds Market Overview from the
      // demo engine subscription — skip fetchTickers to avoid flicker from
      // a competing state update.
      if (!isDemoMode) {
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
      }

      if (hasKeys || isDemoMode) {
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
    // Poll for fresh balance / position / PnL data. Demo engine updates
    // tick-by-tick, so we re-read more frequently when mocked so the UI feels
    // snappy without flooding a live API.
    const timer = globalThis.setInterval(loadData, isDemoMode ? 10_000 : 15_000);
    return () => clearInterval(timer);
  }, [loadData, isDemoMode]);

  function formatCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  }

  // ── AI Strategy Orchestrator recommendation ──────────────────────
  // Compose the regime inputs from already-fetched data: predictor
  // signals (ATR, EMA, MACD, news count) + ticker 24h change. No
  // additional API calls are made here — the recommendation is
  // computed synchronously per render and re-evaluated whenever the
  // dependent inputs change.
  const btcTicker = useMemo(
    () => tickers.find((t) => /^BTC[-_]/.test(t.symbol)),
    [tickers],
  );
  const recommendation = useMemo(() => {
    if (!btcTicker) return null;
    const inputs: RegimeInputs = {
      atrPct:        predictorSignals?.atrPct ?? 0.10,           // sane default if predictor idle
      change24hPct:  btcTicker.change24h,
      fundingRate:   predictorSignals?.fundingRate ?? 0,
      emaSignal:     predictorSignals?.emaSignal ?? 0,
      macdSignal:    predictorSignals?.macdSignal ?? 0,
      newsSentiment: predictorSignals?.newsSentiment ?? 0,
      // recentNewsCount unavailable here — fed only when AI Console
      // calls the orchestrator with fresh state.
      aiConfidence:  aiVerdict?.confidence,
    };
    const rec = recommendBot(inputs, btcTicker.lastPrice);
    return { rec, link: recommendationLink(rec), regime: classifyRegime(inputs) };
  }, [btcTicker, predictorSignals, aiVerdict]);

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

      {/* AI Strategy Orchestrator — "Today's Setup" recommendation */}
      {recommendation && (
        <Card className="p-4 border border-primary/20 bg-primary/5 shrink-0">
          <div className="flex items-start gap-4 flex-wrap">
            {/* Brand block */}
            <div className="flex items-center gap-3 min-w-[200px]">
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Sparkles size={16} className="text-primary" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest font-semibold text-primary">
                  AI Strategy Setup
                </div>
                <div className="text-xs text-text-muted mt-0.5">
                  Today's recommended bot
                </div>
              </div>
            </div>

            {/* Regime + bot pick */}
            <div className="flex-1 flex items-center gap-4 flex-wrap">
              <div className="flex flex-col items-start min-w-[120px]">
                <span className="text-[9px] text-text-muted uppercase tracking-widest">Regime</span>
                <span className="text-sm font-bold text-text-primary mt-0.5">
                  {regimeLabel(recommendation.regime)}
                </span>
              </div>
              <div className="flex flex-col items-start min-w-[140px]">
                <span className="text-[9px] text-text-muted uppercase tracking-widest">Best fit</span>
                <span className="text-sm font-bold text-primary mt-0.5">
                  {botLabel(recommendation.rec.bot)}
                </span>
              </div>
              <div className="flex flex-col items-start min-w-[80px]">
                <span className="text-[9px] text-text-muted uppercase tracking-widest">Confidence</span>
                <span className="text-sm font-bold font-mono text-text-primary mt-0.5">
                  {recommendation.rec.confidence}%
                </span>
              </div>
            </div>

            {/* Deploy CTA */}
            <Link
              to={recommendation.link}
              className={cn(
                'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold',
                'bg-primary text-white hover:opacity-90 transition-opacity',
              )}
            >
              <Zap size={14} />
              Deploy {botLabel(recommendation.rec.bot)}
            </Link>
          </div>

          {/* Rationale */}
          <p className="mt-3 pt-3 border-t border-border text-[12px] text-text-secondary leading-relaxed italic">
            &quot;{recommendation.rec.rationale}&quot;
          </p>

          {/* Alternative pick — soft suggestion in case the user prefers
              a different style */}
          {recommendation.rec.alternative && (
            <div className="mt-2 text-[11px] text-text-muted flex items-start gap-2">
              <span className="text-amber-400/70 shrink-0">↳ Alternative:</span>
              <span>
                <strong className="text-text-secondary">{botLabel(recommendation.rec.alternative.bot)}</strong>
                {' — '}
                {recommendation.rec.alternative.reason}
              </span>
            </div>
          )}
        </Card>
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
              {loading && tickers.length === 0 ? (
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
