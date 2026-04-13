import React, { useState, useCallback } from 'react';
import { FlaskConical, Play, BarChart3, TrendingUp, TrendingDown, Activity } from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { Card, StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { fetchKlines } from '../api/services';
import { getErrorMessage } from '../lib/utils';
import toast from 'react-hot-toast';

interface BacktestResult {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: TradeEntry[];
}

interface TradeEntry {
  entryTime: string;
  exitTime: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
}

type StrategyType = 'SMA_CROSS' | 'RSI' | 'BREAKOUT';

function calculateSMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    return sum / period;
  });
}

function calculateRSI(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

export const Backtesting: React.FC = () => {
  const [symbol, setSymbol] = useState('BTC-USDC');
  const [strategy, setStrategy] = useState<StrategyType>('SMA_CROSS');
  const [timeframe, setTimeframe] = useState('1h');
  const [candles, setCandles] = useState('200');
  const [param1, setParam1] = useState('7');
  const [param2, setParam2] = useState('25');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const runBacktest = useCallback(async () => {
    setLoading(true);
    setResult(null);

    try {
      const rawKlines = await fetchKlines(symbol, timeframe, parseInt(candles) || 200, 'perps');
      const klines = Array.isArray(rawKlines) ? rawKlines : [];

      if (klines.length < 30) {
        toast.error('Yeterli veri yok. Daha fazla mum verisi deneyin.');
        setLoading(false);
        return;
      }

      const closes: number[] = klines.map((k: Record<string, unknown>) => parseFloat(String(k.close ?? (k as unknown as unknown[])[4])));
      const highs: number[] = klines.map((k: Record<string, unknown>) => parseFloat(String(k.high ?? (k as unknown as unknown[])[2])));
      const lows: number[] = klines.map((k: Record<string, unknown>) => parseFloat(String(k.low ?? (k as unknown as unknown[])[3])));
      const times: string[] = klines.map((k: Record<string, unknown>) => {
        const t = k.time ?? k.openTime ?? (k as unknown as unknown[])[0];
        return typeof t === 'number' ? new Date(t).toLocaleString('tr-TR') : String(t);
      });

      const trades: TradeEntry[] = [];
      let position: 'LONG' | 'SHORT' | null = null;
      let entryPrice = 0;
      let entryIdx = 0;

      const p1 = parseInt(param1) || 7;
      const p2 = parseInt(param2) || 25;

      if (strategy === 'SMA_CROSS') {
        const fastSMA = calculateSMA(closes, p1);
        const slowSMA = calculateSMA(closes, p2);

        for (let i = 1; i < closes.length; i++) {
          const prevFast = fastSMA[i - 1];
          const prevSlow = slowSMA[i - 1];
          const curFast = fastSMA[i];
          const curSlow = slowSMA[i];

          if (prevFast == null || prevSlow == null || curFast == null || curSlow == null) continue;

          // Golden cross - BUY
          if (prevFast <= prevSlow && curFast > curSlow) {
            if (position === 'SHORT') {
              const pnl = entryPrice - closes[i];
              const pnlPct = (pnl / entryPrice) * 100;
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'SHORT',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: pnlPct,
              });
            }
            position = 'LONG';
            entryPrice = closes[i];
            entryIdx = i;
          }
          // Death cross - SELL
          else if (prevFast >= prevSlow && curFast < curSlow) {
            if (position === 'LONG') {
              const pnl = closes[i] - entryPrice;
              const pnlPct = (pnl / entryPrice) * 100;
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'LONG',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: pnlPct,
              });
            }
            position = 'SHORT';
            entryPrice = closes[i];
            entryIdx = i;
          }
        }
      } else if (strategy === 'RSI') {
        const rsi = calculateRSI(closes, p1);
        const oversold = p2;
        const overbought = 100 - p2;

        for (let i = 1; i < closes.length; i++) {
          const prevRsi = rsi[i - 1];
          const curRsi = rsi[i];
          if (prevRsi == null || curRsi == null) continue;

          if (prevRsi <= oversold && curRsi > oversold && position !== 'LONG') {
            if (position === 'SHORT') {
              const pnl = entryPrice - closes[i];
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'SHORT',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: (pnl / entryPrice) * 100,
              });
            }
            position = 'LONG';
            entryPrice = closes[i];
            entryIdx = i;
          } else if (prevRsi >= overbought && curRsi < overbought && position !== 'SHORT') {
            if (position === 'LONG') {
              const pnl = closes[i] - entryPrice;
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'LONG',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: (pnl / entryPrice) * 100,
              });
            }
            position = 'SHORT';
            entryPrice = closes[i];
            entryIdx = i;
          }
        }
      } else if (strategy === 'BREAKOUT') {
        const period = p1;
        for (let i = period; i < closes.length; i++) {
          let highestHigh = 0;
          let lowestLow = Infinity;
          for (let j = i - period; j < i; j++) {
            if (highs[j] > highestHigh) highestHigh = highs[j];
            if (lows[j] < lowestLow) lowestLow = lows[j];
          }

          if (closes[i] > highestHigh && position !== 'LONG') {
            if (position === 'SHORT') {
              const pnl = entryPrice - closes[i];
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'SHORT',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: (pnl / entryPrice) * 100,
              });
            }
            position = 'LONG';
            entryPrice = closes[i];
            entryIdx = i;
          } else if (closes[i] < lowestLow && position !== 'SHORT') {
            if (position === 'LONG') {
              const pnl = closes[i] - entryPrice;
              trades.push({
                entryTime: times[entryIdx],
                exitTime: times[i],
                side: 'LONG',
                entryPrice,
                exitPrice: closes[i],
                pnl,
                pnlPercent: (pnl / entryPrice) * 100,
              });
            }
            position = 'SHORT';
            entryPrice = closes[i];
            entryIdx = i;
          }
        }
      }

      // Calculate stats
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const winTrades = trades.filter((t) => t.pnl > 0).length;
      const lossTrades = trades.filter((t) => t.pnl <= 0).length;
      const winRate = trades.length > 0 ? (winTrades / trades.length) * 100 : 0;

      // Max drawdown
      let peak = 0;
      let maxDD = 0;
      let equity = 0;
      for (const t of trades) {
        equity += t.pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
      }

      // Simple Sharpe-like ratio
      const pnls = trades.map((t) => t.pnlPercent);
      const avgReturn = pnls.length > 0 ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0;
      const stdDev = pnls.length > 1
        ? Math.sqrt(pnls.reduce((s, p) => s + (p - avgReturn) ** 2, 0) / (pnls.length - 1))
        : 0;
      const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

      setResult({
        totalTrades: trades.length,
        winTrades,
        lossTrades,
        winRate,
        totalPnl,
        maxDrawdown: maxDD,
        sharpeRatio,
        trades,
      });

      toast.success(`Backtest tamamlandi: ${trades.length} islem`);
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Backtest hatasi');
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [symbol, strategy, timeframe, candles, param1, param2]);

  const strategyLabels: Record<StrategyType, { name: string; p1: string; p2: string }> = {
    SMA_CROSS: { name: 'SMA Crossover', p1: 'Hizli SMA', p2: 'Yavas SMA' },
    RSI: { name: 'RSI', p1: 'RSI Periyot', p2: 'Seviye (30/70 gibi)' },
    BREAKOUT: { name: 'Breakout', p1: 'Bakis Periyot', p2: '(Kullanilmiyor)' },
  };

  return (
    <div className="p-4 md:p-6 h-[calc(100vh-52px)] flex flex-col gap-5 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
          <FlaskConical size={20} className="text-accent" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Backtesting</h2>
          <p className="text-[11px] text-text-muted">
            Gecmis veriler uzerinde strateji test edin
          </p>
        </div>
      </div>

      {/* Config */}
      <Card className="shrink-0">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <Input
            label="Sembol"
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
          <Select
            label="Strateji"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as StrategyType)}
            options={[
              { value: 'SMA_CROSS', label: 'SMA Crossover' },
              { value: 'RSI', label: 'RSI' },
              { value: 'BREAKOUT', label: 'Breakout' },
            ]}
          />
          <Select
            label="Zaman Dilimi"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            options={[
              { value: '5m', label: '5 Dakika' },
              { value: '15m', label: '15 Dakika' },
              { value: '1h', label: '1 Saat' },
              { value: '4h', label: '4 Saat' },
              { value: '1d', label: '1 Gun' },
            ]}
          />
          <Input
            label="Mum Sayisi"
            type="number"
            value={candles}
            onChange={(e) => setCandles(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-end">
          <Input
            label={strategyLabels[strategy].p1}
            type="number"
            value={param1}
            onChange={(e) => setParam1(e.target.value)}
          />
          <Input
            label={strategyLabels[strategy].p2}
            type="number"
            value={param2}
            onChange={(e) => setParam2(e.target.value)}
          />
          <div className="col-span-2">
            <Button
              variant="primary"
              fullWidth
              size="lg"
              icon={<Play size={16} />}
              onClick={runBacktest}
              loading={loading}
            >
              Backtest Calistir
            </Button>
          </div>
        </div>
      </Card>

      {/* Results */}
      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 shrink-0">
            <StatCard
              label="Toplam Islem"
              value={<NumberDisplay value={result.totalTrades} decimals={0} />}
              icon={<BarChart3 size={16} />}
            />
            <StatCard
              label="Kazanma Orani"
              value={<NumberDisplay value={result.winRate} suffix="%" trend={result.winRate >= 50 ? 'up' : 'down'} />}
              icon={<Activity size={16} />}
              trend={result.winRate >= 50 ? 'up' : 'down'}
            />
            <StatCard
              label="Toplam PnL"
              value={
                <NumberDisplay
                  value={Math.abs(result.totalPnl)}
                  prefix={result.totalPnl >= 0 ? '+$' : '-$'}
                  trend={result.totalPnl >= 0 ? 'up' : 'down'}
                />
              }
              icon={<TrendingUp size={16} />}
              trend={result.totalPnl >= 0 ? 'up' : 'down'}
            />
            <StatCard
              label="Max Drawdown"
              value={<NumberDisplay value={result.maxDrawdown} prefix="$" />}
              icon={<TrendingDown size={16} />}
            />
          </div>

          <div className="grid grid-cols-3 gap-4 shrink-0">
            <div className="stat-card text-center">
              <div className="text-[10px] text-text-muted uppercase mb-1">Kazanan</div>
              <div className="text-lg font-semibold text-success">{result.winTrades}</div>
            </div>
            <div className="stat-card text-center">
              <div className="text-[10px] text-text-muted uppercase mb-1">Kaybeden</div>
              <div className="text-lg font-semibold text-danger">{result.lossTrades}</div>
            </div>
            <div className="stat-card text-center">
              <div className="text-[10px] text-text-muted uppercase mb-1">Sharpe Orani</div>
              <div className="text-lg font-semibold">{result.sharpeRatio.toFixed(2)}</div>
            </div>
          </div>

          {/* Trades Table */}
          <div className="flex-1 min-h-0 glass-card flex flex-col overflow-hidden p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Islem Gecmisi
              </span>
              <span className="badge badge-primary">{result.trades.length} islem</span>
            </div>
            <div className="overflow-auto flex-1">
              <table className="data-table text-sm text-left whitespace-nowrap">
                <thead className="text-[11px] text-text-muted uppercase tracking-wider border-b border-border">
                  <tr>
                    <th className="px-5 py-3 font-medium">Giris</th>
                    <th className="px-5 py-3 font-medium">Cikis</th>
                    <th className="px-5 py-3 font-medium">Yon</th>
                    <th className="px-5 py-3 font-medium text-right">Giris Fiyati</th>
                    <th className="px-5 py-3 font-medium text-right">Cikis Fiyati</th>
                    <th className="px-5 py-3 font-medium text-right">PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {result.trades.map((t, i) => (
                    <tr key={i} className="hover:bg-surface-hover/30 transition-colors">
                      <td className="px-5 py-2.5 text-xs text-text-muted font-mono">{t.entryTime}</td>
                      <td className="px-5 py-2.5 text-xs text-text-muted font-mono">{t.exitTime}</td>
                      <td className="px-5 py-2.5">
                        <span className={`badge ${t.side === 'LONG' ? 'badge-success' : 'badge-danger'}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums font-mono">
                        <NumberDisplay value={t.entryPrice} />
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums font-mono">
                        <NumberDisplay value={t.exitPrice} />
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <NumberDisplay
                          value={Math.abs(t.pnl)}
                          prefix={t.pnl >= 0 ? '+$' : '-$'}
                          trend={t.pnl >= 0 ? 'up' : 'down'}
                        />
                        <span className={`text-[10px] ml-1 ${t.pnl >= 0 ? 'text-success' : 'text-danger'}`}>
                          ({t.pnlPercent.toFixed(2)}%)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* No result placeholder */}
      {!result && !loading && (
        <div className="flex-1 flex items-center justify-center text-text-muted">
          <div className="text-center">
            <FlaskConical size={48} className="mx-auto mb-4 opacity-20" />
            <p className="text-sm">Strateji parametrelerini ayarlayin ve backtest calistirin.</p>
            <p className="text-xs mt-1">Sonuclar burada gorunecektir.</p>
          </div>
        </div>
      )}
    </div>
  );
};
