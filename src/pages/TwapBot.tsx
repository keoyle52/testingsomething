import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Play, Square, Clock, Hash, DollarSign, BarChart3, Zap,
  ChevronDown, ChevronUp, ShieldAlert, AlertTriangle, Info,
} from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { RiskSummaryModal, type RiskSummaryRow } from '../components/common/RiskSummaryModal';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchBookTickers, fetchFeeRate, normalizeSymbol } from '../api/services';
import type { FeeRateInfo } from '../api/services';
import { recommendTwapBot } from '../api/aiAutoConfig';
import { AutoConfigureButton } from '../components/common/AutoConfigureButton';
import { cn, getErrorMessage } from '../lib/utils';
import { useBotPnlStore } from '../store/botPnlStore';

interface TwapLog {
  time: string;
  side?: string;
  message?: string;
  price?: number;
  amount?: number;
}

/**
 * Professional TWAP execution settings — mirrors the parameter surface
 * exposed by Binance / Bybit institutional TWAP front-ends:
 *
 *  - **Order type**: market (taker) or limit-with-offset (passive maker).
 *  - **Limit offset bps**: when in LIMIT mode, bid - X bps for buys / ask + X bps for sells
 *    so the order rests inside the spread; if untouched after `intervalSec`,
 *    the next slice replaces it (cancel-replace pattern).
 *  - **Slice size variance**: randomises each slice ±N% to break up
 *    detectable patterns. Disabled by default for predictable behaviour.
 *  - **Time variance**: jitters the inter-slice delay ±N% for the same
 *    reason — defeats simple time-pattern detection.
 *  - **Price guard**: skip a slice if mid price is outside the user's
 *    acceptable band (max for buys, min for sells). Avoids chasing a
 *    runaway market and re-arms automatically when price returns.
 */
type TwapOrderType = 'MARKET' | 'LIMIT';

export const TwapBot: React.FC = () => {
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const feeRateRef = useRef<FeeRateInfo>({ makerFee: 0.00035, takerFee: 0.00065 });

  // ── Core ────────────────────────────────────────────────────────
  const [symbol, setSymbol] = useState('BTC-USD');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [totalAmount, setTotalAmount] = useState('1');
  const [slices, setSlices] = useState('10');
  const [intervalSec, setIntervalSec] = useState('60');
  const [isSpot, setIsSpot] = useState(false);

  // ── Advanced ───────────────────────────────────────────────────
  const [orderType, setOrderType] = useState<TwapOrderType>('MARKET');
  const [limitOffsetBps, setLimitOffsetBps] = useState('5');         // 5 bps inside the spread
  const [sizeVariancePct, setSizeVariancePct] = useState('0');       // 0 = no randomisation
  const [timeVariancePct, setTimeVariancePct] = useState('0');
  const [maxBuyPrice, setMaxBuyPrice] = useState('');                // skip slice if mid > this (buys only)
  const [minSellPrice, setMinSellPrice] = useState('');              // skip slice if mid < this (sells only)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [guardOpen, setGuardOpen] = useState(false);

  const [status, setStatus] = useState<'STOPPED' | 'RUNNING' | 'ERROR'>('STOPPED');
  const [showConfirm, setShowConfirm] = useState(false);

  const [executedSlices, setExecutedSlices] = useState(0);
  const [executedVolume, setExecutedVolume] = useState(0);
  const [executedQty, setExecutedQty] = useState(0);
  const [skippedSlices, setSkippedSlices] = useState(0);
  const [avgPrice, setAvgPrice] = useState(0);
  const [totalFee, setTotalFee] = useState(0);
  const [logs, setLogs] = useState<TwapLog[]>([]);

  const addLog = useCallback((log: TwapLog) => {
    setLogs((prev) => [log, ...prev].slice(0, 50));
  }, []);

  /**
   * Multiply by a uniform random factor in [1 - p, 1 + p] when p > 0.
   * `p` is given as a percent (e.g. 10 → ±10%).
   */
  const jitter = useCallback((value: number, percent: number): number => {
    if (!Number.isFinite(percent) || percent <= 0) return value;
    const p = Math.min(Math.abs(percent), 50) / 100; // hard cap at ±50%
    const factor = 1 + (Math.random() * 2 - 1) * p;
    return Math.max(0, value * factor);
  }, []);

  const executeSlice = useCallback(async (
    sliceAmount: number,
    currentSlice: number,
    totalSlices: number,
  ): Promise<'OK' | 'SKIPPED' | 'ERROR'> => {
    if (!runningRef.current) return 'ERROR';

    const market: 'spot' | 'perps' = isSpot ? 'spot' : 'perps';
    const sideNum = side === 'BUY' ? 1 : 2;

    try {
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const normalizedSym = normalizeSymbol(symbol, market);
      const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normalizedSym) as Record<string, unknown> | undefined;

      const bidPrice = parseFloat(String(ticker?.bidPrice ?? ticker?.bid ?? '0'));
      const askPrice = parseFloat(String(ticker?.askPrice ?? ticker?.ask ?? '0'));
      const midPrice = (bidPrice + askPrice) / 2;
      if (bidPrice <= 0 || askPrice <= 0) {
        addLog({ time: new Date().toLocaleTimeString(), message: `No price data — slice ${currentSlice + 1} skipped.` });
        setSkippedSlices((p) => p + 1);
        return 'SKIPPED';
      }

      // Price-band guard
      const maxBuy  = parseFloat(maxBuyPrice);
      const minSell = parseFloat(minSellPrice);
      if (side === 'BUY' && Number.isFinite(maxBuy) && maxBuy > 0 && midPrice > maxBuy) {
        addLog({
          time: new Date().toLocaleTimeString(),
          side,
          price: midPrice,
          message: `Slice ${currentSlice + 1} skipped — mid ${midPrice.toFixed(2)} > max buy ${maxBuy}`,
        });
        setSkippedSlices((p) => p + 1);
        return 'SKIPPED';
      }
      if (side === 'SELL' && Number.isFinite(minSell) && minSell > 0 && midPrice < minSell) {
        addLog({
          time: new Date().toLocaleTimeString(),
          side,
          price: midPrice,
          message: `Slice ${currentSlice + 1} skipped — mid ${midPrice.toFixed(2)} < min sell ${minSell}`,
        });
        setSkippedSlices((p) => p + 1);
        return 'SKIPPED';
      }

      // Determine fill price + order params
      const fillPrice = side === 'BUY' ? askPrice : bidPrice;
      const orderParams: Record<string, unknown> = {
        symbol,
        side: sideNum as 1 | 2,
        type: orderType === 'LIMIT' ? 1 : 2,
        quantity: sliceAmount.toFixed(8),
      };
      if (orderType === 'LIMIT') {
        const offsetBps = parseFloat(limitOffsetBps) || 0;
        // Sit inside the spread: buys at bid + offset, sells at ask − offset.
        const offsetPx = (offsetBps / 10_000) * midPrice;
        const limitPx = side === 'BUY' ? bidPrice + offsetPx : askPrice - offsetPx;
        orderParams.price = limitPx.toFixed(8);
        orderParams.timeInForce = 1;     // GTC — replaced on next slice if unfilled
      }

      await placeOrder(orderParams as unknown as Parameters<typeof placeOrder>[0], market);

      const fillEstimate = orderType === 'MARKET' ? fillPrice : parseFloat(String(orderParams.price));
      const vol = sliceAmount * fillEstimate;
      const feeBps = orderType === 'LIMIT' ? feeRateRef.current.makerFee : feeRateRef.current.takerFee;
      const fee = vol * feeBps;

      setExecutedSlices((p) => p + 1);
      setExecutedVolume((p) => p + vol);
      setExecutedQty((p) => p + sliceAmount);
      setTotalFee((p) => p + fee);
      setAvgPrice((prev) => {
        const prevSlices = currentSlice;
        return prevSlices === 0 ? fillEstimate : prev + (fillEstimate - prev) / (prevSlices + 1);
      });
      // Note this for the per-bot PnL widget (treated as zero-PnL fills
      // since TWAP execution PnL only resolves against eventual close).
      useBotPnlStore.getState().recordTrade('twap', {
        pnlUsdt: 0,
        ts: Date.now(),
        note: `Slice ${currentSlice + 1}/${totalSlices} ${side} ${sliceAmount.toFixed(6)} @ ${fillEstimate.toFixed(2)}`,
      });

      addLog({
        time: new Date().toLocaleTimeString(),
        side,
        amount: sliceAmount,
        price: fillEstimate,
        message: `Slice ${currentSlice + 1}/${totalSlices} ${orderType === 'LIMIT' ? 'limit-placed' : 'filled'}`,
      });
      return 'OK';
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      addLog({ time: new Date().toLocaleTimeString(), message: `ERROR: ${msg}` });
      toast.error(`TWAP: ${msg}`);
      return 'ERROR';
    }
  }, [symbol, side, isSpot, orderType, limitOffsetBps, maxBuyPrice, minSellPrice, addLog]);

  const doStart = useCallback(() => {
    if (runningRef.current) return;

    const total = parseFloat(totalAmount);
    const numSlices = parseInt(slices);
    const interval = parseInt(intervalSec);

    if (isNaN(total) || isNaN(numSlices) || isNaN(interval) || total <= 0 || numSlices < 1 || interval < 1) {
      toast.error('Invalid parameters');
      return;
    }

    runningRef.current = true;
    setStatus('RUNNING');
    setExecutedSlices(0);
    setExecutedVolume(0);
    setExecutedQty(0);
    setSkippedSlices(0);
    setAvgPrice(0);
    setTotalFee(0);
    setLogs([]);

    const baseSlice = total / numSlices;
    const sizeVar = parseFloat(sizeVariancePct) || 0;
    const timeVar = parseFloat(timeVariancePct) || 0;

    let currentSlice = 0;
    let cumulativeQty = 0;
    const market: 'spot' | 'perps' = isSpot ? 'spot' : 'perps';

    const runSlice = async () => {
      if (!runningRef.current || currentSlice >= numSlices) {
        if (currentSlice >= numSlices) {
          runningRef.current = false;
          setStatus('STOPPED');
          addLog({ time: new Date().toLocaleTimeString(), message: 'All slices completed. Bot stopped.' });
        }
        return;
      }

      // Compute this slice's amount with optional variance, but always
      // honour the cumulative cap so the run finishes at exactly `total`.
      const remainingQty = Math.max(0, total - cumulativeQty);
      const targetSlice = currentSlice === numSlices - 1
        ? remainingQty                                  // last slice → drain remainder
        : Math.min(remainingQty, jitter(baseSlice, sizeVar));
      cumulativeQty += targetSlice;

      await executeSlice(targetSlice, currentSlice, numSlices);
      currentSlice++;

      if (runningRef.current && currentSlice < numSlices) {
        const nextDelay = jitter(interval, timeVar) * 1000;
        timerRef.current = setTimeout(runSlice, nextDelay);
      } else if (currentSlice >= numSlices) {
        runningRef.current = false;
        setStatus('STOPPED');
        addLog({ time: new Date().toLocaleTimeString(), message: 'All slices completed. Bot stopped.' });
      }
    };

    (async () => {
      const feeRate = await fetchFeeRate(market);
      feeRateRef.current = feeRate;
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `TWAP started: ${numSlices} slices × ${baseSlice.toFixed(6)}, ${interval}s interval, ${orderType} orders` +
          (sizeVar > 0 ? `, size ±${sizeVar}%` : '') +
          (timeVar > 0 ? `, time ±${timeVar}%` : ''),
      });
      runSlice();
    })();
  }, [
    totalAmount, slices, intervalSec, isSpot, sizeVariancePct, timeVariancePct,
    orderType, executeSlice, addLog, jitter,
  ]);

  const startBot = useCallback(() => {
    if (confirmOrders) setShowConfirm(true);
    else doStart();
  }, [confirmOrders, doStart]);

  const stopBot = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatus('STOPPED');
    addLog({ time: new Date().toLocaleTimeString(), message: 'Bot stopped by user' });
  }, [addLog]);

  useEffect(() => () => {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const isRunning = status === 'RUNNING';
  const totalSlicesNum = parseInt(slices) || 1;
  const progress = totalSlicesNum > 0 ? (executedSlices / totalSlicesNum) * 100 : 0;

  // Estimated total run-time + cost preview, recomputed on every keystroke
  // so the user sees instant feedback while configuring the bot.
  const totalNum = parseFloat(totalAmount) || 0;
  const intervalNum = parseInt(intervalSec) || 0;
  const totalDurationSec = intervalNum * Math.max(0, totalSlicesNum - 1);
  const durationLabel = useMemo(() => (
    totalDurationSec >= 3600
      ? `${(totalDurationSec / 3600).toFixed(1)} hours`
      : totalDurationSec >= 60 ? `${Math.round(totalDurationSec / 60)} minutes`
      : `${totalDurationSec} seconds`
  ), [totalDurationSec]);
  const sliceQty = totalSlicesNum > 0 ? totalNum / totalSlicesNum : 0;

  const buildTwapRiskRows = (): { rows: RiskSummaryRow[]; totalRisk: string; risk: 'Low' | 'Medium' | 'High' } => {
    const sizeVar = parseFloat(sizeVariancePct) || 0;
    const timeVar = parseFloat(timeVariancePct) || 0;
    const offsetBps = parseFloat(limitOffsetBps) || 0;
    const rows: RiskSummaryRow[] = [
      { label: 'Pair', value: symbol, hint: isSpot ? 'Spot market' : 'Perpetual futures' },
      { label: 'Direction', value: side, tone: side === 'BUY' ? 'positive' : 'warning' },
      { label: 'Total order size', value: `${totalNum} ${symbol.split(/[_-]/)[0]}` },
      { label: 'Slices', value: `${totalSlicesNum} × ${sliceQty.toFixed(6)}` },
      { label: 'Order type', value: orderType === 'LIMIT' ? `Limit (offset ${offsetBps} bps inside spread)` : 'Market (taker)' },
      { label: 'Interval', value: `${intervalNum}s between slices` },
      { label: 'Total run time', value: durationLabel || '—' },
    ];
    if (sizeVar > 0) rows.push({ label: 'Size variance', value: `±${sizeVar}%`, hint: 'Each slice randomised by this percent' });
    if (timeVar > 0) rows.push({ label: 'Time variance', value: `±${timeVar}%`, hint: 'Inter-slice delay randomised by this percent' });
    if (side === 'BUY' && parseFloat(maxBuyPrice) > 0) rows.push({ label: 'Max buy price', value: maxBuyPrice, tone: 'warning', hint: 'Slices skipped if mid exceeds this' });
    if (side === 'SELL' && parseFloat(minSellPrice) > 0) rows.push({ label: 'Min sell price', value: minSellPrice, tone: 'warning', hint: 'Slices skipped if mid drops below this' });
    const risk: 'Low' | 'Medium' | 'High' =
      totalSlicesNum < 5 || intervalNum < 5 ? 'Medium' : 'Low';
    const totalRisk = `${totalNum} ${symbol.split(/[_-]/)[0]} ${side === 'BUY' ? 'buy' : 'sell'} pressure spread over ${durationLabel || 'the run'}`;
    return { rows, totalRisk, risk };
  };
  const twapRiskSummary = buildTwapRiskRows();

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <RiskSummaryModal
        isOpen={showConfirm}
        title="TWAP Bot Summary"
        subtitle="Confirm the slice schedule and total capital before submitting orders to the book."
        rows={twapRiskSummary.rows}
        risk={twapRiskSummary.risk}
        totalRisk={twapRiskSummary.totalRisk}
        disclaimer={
          orderType === 'MARKET'
            ? 'Each slice is sent as a market order at the prevailing book price. Stopping the bot cancels remaining slices but does not unwind already-executed ones.'
            : 'Each slice is placed as a passive limit order inside the spread. Unfilled limits are replaced when the next slice fires; stopping the bot leaves the most recent unfilled limit on the book unless you cancel it manually.'
        }
        confirmLabel="Confirm & Start TWAP"
        onConfirm={() => { setShowConfirm(false); doStart(); }}
        onCancel={() => setShowConfirm(false)}
      />

      {/* ─────────────── Settings Panel ─────────────── */}
      <div className="w-96 border-r border-border bg-surface/30 backdrop-blur-sm flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm">TWAP Bot</h2>
          <StatusBadge status={status} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* ── AI Auto-Configure ── one-click smart defaults from current
               market context. We only apply slices / interval / order type
               here — total quantity is left to the user since it depends on
               the position they're trying to execute, not the market regime. */}
          <AutoConfigureButton
            symbol={symbol}
            market={isSpot ? 'spot' : 'perps'}
            recommender={recommendTwapBot}
            hidden={isRunning}
            onApply={(preset) => {
              if (preset.slices)      setSlices(String(preset.slices));
              if (preset.intervalSec) setIntervalSec(String(preset.intervalSec));
              if (preset.orderType === 'limit') setOrderType('LIMIT');
            }}
          />
          {/* ── Market & direction ── */}
          <Section icon={<Hash size={12} />} label="Market & direction">
            <Input
              label="Symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. BTC-USDC"
              disabled={isRunning}
            />
            <div>
              <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1.5">Market type</label>
              <div className="flex gap-2">
                <button onClick={() => !isRunning && setIsSpot(true)} className={cn('flex-1 py-2 text-xs rounded-lg border transition-all', isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover', isRunning && 'opacity-50 pointer-events-none')}>Spot</button>
                <button onClick={() => !isRunning && setIsSpot(false)} className={cn('flex-1 py-2 text-xs rounded-lg border transition-all', !isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover', isRunning && 'opacity-50 pointer-events-none')}>Perps</button>
              </div>
            </div>
            <Select
              label="Direction"
              value={side}
              onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
              disabled={isRunning}
              options={[
                { value: 'BUY', label: 'Buy' },
                { value: 'SELL', label: 'Sell' },
              ]}
            />
          </Section>

          {/* ── Schedule ── */}
          <Section icon={<Clock size={12} />} label="Schedule">
            <Input label="Total amount" type="number" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} disabled={isRunning} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Slice count" type="number" value={slices} onChange={(e) => setSlices(e.target.value)} disabled={isRunning} />
              <Input label="Interval (s)" type="number" value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} disabled={isRunning} />
            </div>
          </Section>

          {/* ── Advanced execution ── */}
          <Collapsible
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((p) => !p)}
            icon={<Zap size={12} />}
            label="Execution style"
            badge={
              [
                orderType === 'LIMIT' && `LIMIT ${limitOffsetBps}bps`,
                parseFloat(sizeVariancePct) > 0 && `±${sizeVariancePct}% size`,
                parseFloat(timeVariancePct) > 0 && `±${timeVariancePct}% time`,
              ].filter(Boolean).join(' · ') || undefined
            }
          >
            <div>
              <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1.5">Order type</label>
              <div className="flex gap-2">
                {(['MARKET','LIMIT'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => !isRunning && setOrderType(t)}
                    className={cn(
                      'flex-1 py-2 text-[11px] rounded-lg border transition-all flex flex-col items-center gap-0.5',
                      orderType === t ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover',
                      isRunning && 'opacity-50 pointer-events-none',
                    )}
                  >
                    <span className="font-semibold uppercase tracking-wider">{t}</span>
                    <span className="text-[9px] text-text-muted">{t === 'MARKET' ? 'Taker — instant fill' : 'Maker — passive in spread'}</span>
                  </button>
                ))}
              </div>
            </div>
            {orderType === 'LIMIT' && (
              <Input
                label="Limit offset (bps inside spread)"
                type="number"
                value={limitOffsetBps}
                onChange={(e) => setLimitOffsetBps(e.target.value)}
                disabled={isRunning}
                hint="Buys: bid + N bps · Sells: ask − N bps"
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Size variance %"
                type="number"
                value={sizeVariancePct}
                onChange={(e) => setSizeVariancePct(e.target.value)}
                disabled={isRunning}
                hint="0 = uniform"
              />
              <Input
                label="Time variance %"
                type="number"
                value={timeVariancePct}
                onChange={(e) => setTimeVariancePct(e.target.value)}
                disabled={isRunning}
                hint="0 = exact"
              />
            </div>
          </Collapsible>

          {/* ── Price-band guard ── */}
          <Collapsible
            open={guardOpen}
            onToggle={() => setGuardOpen((p) => !p)}
            icon={<ShieldAlert size={12} />}
            label="Price guard"
            badge={
              ((side === 'BUY' && parseFloat(maxBuyPrice) > 0) || (side === 'SELL' && parseFloat(minSellPrice) > 0))
                ? 'active' : undefined
            }
          >
            {side === 'BUY' ? (
              <Input
                label="Max buy price"
                type="number"
                value={maxBuyPrice}
                onChange={(e) => setMaxBuyPrice(e.target.value)}
                disabled={isRunning}
                hint="Slices are skipped if mid > this price"
              />
            ) : (
              <Input
                label="Min sell price"
                type="number"
                value={minSellPrice}
                onChange={(e) => setMinSellPrice(e.target.value)}
                disabled={isRunning}
                hint="Slices are skipped if mid < this price"
              />
            )}
            <div className="text-[10px] text-text-muted">
              Skipped slices count toward the total — once price returns to your band, the bot resumes immediately. The run finishes after `Slice count` iterations regardless of how many fired.
            </div>
          </Collapsible>

          {/* ── Live preview ── */}
          <div className="rounded-xl border border-border bg-background/40 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              <Info size={10} /> Estimated run
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <PreviewRow label="Slice qty"     value={sliceQty > 0 ? sliceQty.toFixed(6) : '—'} />
              <PreviewRow label="Total run"     value={durationLabel || '—'} />
              <PreviewRow label="Slices/min"    value={intervalNum > 0 ? (60 / intervalNum).toFixed(2) : '—'} />
              <PreviewRow label="Order type"    value={orderType === 'LIMIT' ? `Limit ${limitOffsetBps}bps` : 'Market'} />
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border bg-background/40">
          {!isRunning ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={startBot}>
              Start TWAP
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={stopBot}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* ─────────────── Live status ─────────────── */}
      <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
        <BotPnlStrip botKey="twap" />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Slices done" value={<span>{executedSlices}/{totalSlicesNum}</span>} icon={<Hash size={16} />} />
          <StatCard label="Volume" value={<NumberDisplay value={executedVolume} prefix="$" />} icon={<BarChart3 size={16} />} />
          <StatCard label="Avg. price" value={<NumberDisplay value={avgPrice} />} icon={<DollarSign size={16} />} />
          <StatCard label="Total fee" value={<NumberDisplay value={totalFee} prefix="$" />} icon={<Clock size={16} />} />
        </div>

        {skippedSlices > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-200 text-xs">
            <AlertTriangle size={14} />
            <span>{skippedSlices} slice{skippedSlices === 1 ? '' : 's'} skipped by the price guard so far.</span>
          </div>
        )}

        {/* Progress */}
        <div className="glass-card p-4">
          <div className="flex justify-between text-xs mb-2">
            <span className="text-text-secondary">TWAP Progress</span>
            <span className="text-text-primary font-mono tabular-nums">{progress.toFixed(1)}%</span>
          </div>
          <div className="h-2 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-primary-soft rounded-full transition-all duration-500"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 text-[11px]">
            <PreviewRow label="Filled qty" value={executedQty.toFixed(6)} />
            <PreviewRow label="Skipped"    value={`${skippedSlices}`} tone={skippedSlices > 0 ? 'warn' : 'mute'} />
            <PreviewRow label="Remaining"  value={`${Math.max(0, totalSlicesNum - executedSlices - skippedSlices)}`} />
          </div>
        </div>

        {/* Log */}
        <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Activity Log</span>
            <span className="text-[10px] text-text-muted">{logs.length} entries</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
            {logs.map((log, i) => (
              <div key={i} className="text-xs flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-hover/50 transition-colors font-mono animate-fade-in">
                <span className="text-text-muted w-16 shrink-0 tabular-nums">{log.time}</span>
                {log.side && (
                  <span className={`badge ${log.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{log.side}</span>
                )}
                {log.amount != null && (
                  <span className="tabular-nums text-text-secondary"><NumberDisplay value={log.amount} decimals={4} /></span>
                )}
                {log.price != null && (
                  <span className="tabular-nums text-text-muted">@ <NumberDisplay value={log.price} /></span>
                )}
                {log.message && <span className="text-text-secondary truncate">{log.message}</span>}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                <div className="text-center">
                  <Clock size={32} className="mx-auto mb-3 opacity-30" />
                  <p>TWAP activity logs will appear here.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Local presentational helpers (shared visual idiom with GridBot)
// ──────────────────────────────────────────────────────────────────────

interface SectionProps { icon: React.ReactNode; label: string; children: React.ReactNode; }
const Section: React.FC<SectionProps> = ({ icon, label, children }) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">{icon}<span>{label}</span></div>
    {children}
  </div>
);

interface CollapsibleProps { open: boolean; onToggle: () => void; icon: React.ReactNode; label: string; badge?: string; children: React.ReactNode; }
const Collapsible: React.FC<CollapsibleProps> = ({ open, onToggle, icon, label, badge, children }) => (
  <div className="rounded-xl border border-border bg-background/30">
    <button type="button" onClick={onToggle} className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors">
      <span className="flex items-center gap-1.5">{icon}{label}</span>
      <span className="flex items-center gap-2">
        {badge && <span className="text-[10px] font-mono normal-case tracking-normal text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-full px-2 py-0.5">{badge}</span>}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </span>
    </button>
    {open && <div className="border-t border-border p-3 flex flex-col gap-3">{children}</div>}
  </div>
);

const PreviewRow: React.FC<{ label: string; value: string; tone?: 'good' | 'warn' | 'mute' }> = ({ label, value, tone = 'mute' }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-text-muted">{label}</span>
    <span className={cn('font-mono font-semibold', tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : 'text-text-primary')}>
      {value}
    </span>
  </div>
);
