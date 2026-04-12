import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, BarChart3, Hash, DollarSign, Activity, Wallet, ShieldAlert, TrendingUp } from 'lucide-react';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchOrderbook, fetchFeeRate, normalizeSymbol } from '../api/services';
import type { FeeRateInfo } from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { Button } from '../components/common/Button';

const DEFAULT_INTERVAL_SEC = 10;

function getLeverage(isSpot: boolean, leverage: string): number {
  return isSpot ? 1 : (parseInt(leverage) || 1);
}

export const VolumeBot: React.FC = () => {
  const { volumeBot: state } = useBotStore();
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const feeRateRef = useRef<FeeRateInfo>({ makerFee: 0.00012, takerFee: 0.0004 });
  const [showConfirm, setShowConfirm] = useState(false);

  const executeTrade = useCallback(async () => {
    if (!runningRef.current) return;
    const { volumeBot: s } = useBotStore.getState();

    const maxVol = parseFloat(s.maxVolumeTarget);
    if (maxVol > 0 && s.totalVolume >= maxVol) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: `Hedef hacme (${maxVol}) ulaşıldı. Bot durdu.` });
      return;
    }

    // Budget guard: stop if max spend limit reached
    const maxSpendLimit = parseFloat(s.maxSpend);
    if (maxSpendLimit > 0 && s.totalSpent >= maxSpendLimit) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) aşıldı. Bot durdu.` });
      return;
    }

    const market = s.isSpot ? 'spot' : 'perps';
    const budgetVal = parseFloat(s.budget);
    const leverageVal = getLeverage(s.isSpot, s.leverage);
    const effectiveBudget = budgetVal * leverageVal;
    const hasBudget = budgetVal > 0;

    try {
      const orderbook = await fetchOrderbook(s.symbol, market, 5);
      const bestBid = orderbook?.bids?.[0]?.[0] ?? orderbook?.bids?.[0]?.price;
      const bestAsk = orderbook?.asks?.[0]?.[0] ?? orderbook?.asks?.[0]?.price;

      if (!bestBid || !bestAsk) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `${s.symbol} için emir defteri verisi bulunamadı` });
        return;
      }

      const bidPrice = parseFloat(bestBid);
      const askPrice = parseFloat(bestAsk);
      const midPrice = (bidPrice + askPrice) / 2;

      if (midPrice <= 0) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `${s.symbol} için geçersiz fiyat. Atlanıyor.` });
        return;
      }

      const spread = ((askPrice - bidPrice) / midPrice) * 100;

      const spreadTol = parseFloat(s.spreadTolerance);
      if (spreadTol > 0 && spread > spreadTol) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `Spread çok geniş (${spread.toFixed(2)}% > ${spreadTol}%). Atlanıyor.` });
        return;
      }

      let min = parseFloat(s.minAmount);
      let max = parseFloat(s.maxAmount);

      // Budget mode: cap quantity so each trade's notional value doesn't exceed effective budget
      // With leverage: effectiveBudget = budget × leverage (e.g., $200 × 10x = $2000 position)
      if (hasBudget) {
        const maxQtyByBudget = effectiveBudget / midPrice;
        max = Math.min(max, maxQtyByBudget);
        min = Math.min(min, max);
      }

      // Budget mode with maxSpend: cap quantity so fee doesn't push us over max spend
      if (maxSpendLimit > 0) {
        const spendRemaining = maxSpendLimit - s.totalSpent;
        if (spendRemaining <= 0) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) doldu. Bot durdu.` });
          return;
        }
        // Each trade costs maker+taker fee (buy+sell), cap quantity so fees stay within limit
        const { makerFee, takerFee } = feeRateRef.current;
        const combinedFeeRate = makerFee + takerFee;
        const maxQtyBySpend = spendRemaining / (midPrice * combinedFeeRate);
        max = Math.min(max, maxQtyBySpend);
        min = Math.min(min, max);
      }

      if (max <= 0 || min <= 0) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: 'Kalan bütçe/limit yetersiz. Atlanıyor.' });
        return;
      }

      const quantity = min + Math.random() * (max - min);

      // Helper: parse fill info from an order response
      function parseFill(result: any, price: number) {
        const filledQty = parseFloat(
          result?.filledQty ?? result?.filled_qty ?? result?.executedQty ?? result?.executed_qty ?? '0'
        );
        const filledNotional = parseFloat(
          result?.filledNotional ?? result?.filled_notional ?? result?.executedNotional ?? '0'
        );
        const status = result?.status ?? result?.orderStatus ?? '';
        const isFilled = status === 'FILLED' || status === 'PARTIALLY_FILLED' || filledQty > 0;
        const actualVolume = filledNotional > 0 ? filledNotional : filledQty * price;
        return { filledQty, filledNotional, actualVolume, isFilled, status };
      }

      // Smart strategy: Post-Only LIMIT (GTX) — maker fee, real exchange volume
      if (hasBudget) {
        const qty = quantity.toFixed(8);

        // BUY LIMIT Post-Only @ bestAsk — hits lowest ask, enters as maker
        const buyResult = await placeOrder(
          { symbol: s.symbol, side: 1, type: 1, quantity: qty, price: askPrice.toString(), timeInForce: 4 }, // side:1=BUY, type:1=LIMIT, timeInForce:4=GTX(Post-Only)
          market,
        );

        // 500ms delay — give exchange time to process BUY before SELL
        await new Promise(r => setTimeout(r, 500));

        // SELL LIMIT Post-Only @ bestBid — hits highest bid, enters as maker
        const sellResult = await placeOrder(
          { symbol: s.symbol, side: 2, type: 1, quantity: qty, price: bidPrice.toString(), timeInForce: 4 }, // side:2=SELL, type:1=LIMIT, timeInForce:4=GTX(Post-Only)
          market,
        );

        const buyFill = parseFill(buyResult, askPrice);
        const sellFill = parseFill(sellResult, bidPrice);
        const totalFilled = (buyFill.isFilled ? buyFill.actualVolume : 0) + (sellFill.isFilled ? sellFill.actualVolume : 0);

        const freshState = useBotStore.getState().volumeBot;
        const prevCount = freshState.tradesCount;
        const prevSpread = freshState.avgSpread;

        if (totalFilled > 0) {
          // Fee: maker fee only (Post-Only orders)
          const fee = totalFilled * feeRateRef.current.makerFee;
          freshState.setField('totalVolume', freshState.totalVolume + totalFilled);
          freshState.setField('tradesCount', prevCount + (buyFill.isFilled ? 1 : 0) + (sellFill.isFilled ? 1 : 0));
          freshState.setField('totalFee', freshState.totalFee + fee);
          freshState.setField('totalSpent', freshState.totalSpent + fee);
          freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + 2));
          freshState.addLog({
            time: new Date().toLocaleTimeString(),
            message: `✓ BUY ${buyFill.isFilled ? buyFill.actualVolume.toFixed(2) + ' USDC' : '⚠️ CANCEL'} | SELL ${sellFill.isFilled ? sellFill.actualVolume.toFixed(2) + ' USDC' : '⚠️ CANCEL'}`,
          });
        } else {
          freshState.setField('skippedCount', freshState.skippedCount + 1);
          freshState.addLog({
            time: new Date().toLocaleTimeString(),
            message: `⚠️ Emir execute olmadı (BUY: ${buyFill.status || 'N/A'}, SELL: ${sellFill.status || 'N/A'})`,
          });
        }
      } else {
        // Classic mode: single market order (taker, fast execution)
        const side: 1 | 2 = Math.random() > 0.5 ? 1 : 2;
        const sideLabel = side === 1 ? 'BUY' : 'SELL';
        const fillPrice = side === 1 ? askPrice : bidPrice;

        const result = await placeOrder(
          { symbol: s.symbol, side, type: 2, quantity: quantity.toFixed(8) },
          market,
        );

        const fill = parseFill(result, fillPrice);
        const freshState = useBotStore.getState().volumeBot;
        const prevCount = freshState.tradesCount;
        const prevSpread = freshState.avgSpread;

        if (fill.isFilled) {
          const vol = fill.actualVolume > 0 ? fill.actualVolume : quantity * fillPrice;
          const fee = vol * feeRateRef.current.takerFee; // Market order = taker
          freshState.setField('totalVolume', freshState.totalVolume + vol);
          freshState.setField('tradesCount', prevCount + 1);
          freshState.setField('totalFee', freshState.totalFee + fee);
          freshState.setField('totalSpent', freshState.totalSpent + fee);
          freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + 1));
          freshState.addLog({
            time: new Date().toLocaleTimeString(),
            symbol: s.symbol,
            side: sideLabel,
            amount: quantity,
            price: fillPrice,
            fee,
            orderId: result?.orderId ?? result?.id,
          });
        } else {
          freshState.setField('skippedCount', freshState.skippedCount + 1);
          freshState.addLog({
            time: new Date().toLocaleTimeString(),
            message: `⚠️ ${sideLabel} MARKET execute olmadı (status: ${fill.status || 'N/A'})`,
          });
        }
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Unknown error';
      s.addLog({ time: new Date().toLocaleTimeString(), message: `HATA: ${msg}` });
      toast.error(`Volume Bot: ${msg}`);
    }
  }, []);

  const scheduleNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    scheduleNextRef.current = () => {
      if (!runningRef.current) return;
      const { volumeBot: s } = useBotStore.getState();
      const interval = Math.max(1, parseInt(s.intervalSec) || DEFAULT_INTERVAL_SEC) * 1000;
      timerRef.current = setTimeout(async () => {
        await executeTrade();
        scheduleNextRef.current();
      }, interval);
    };
  }, [executeTrade]);

  const doStart = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    state.resetStats();
    state.setField('status', 'RUNNING');

    const market = state.isSpot ? 'spot' : 'perps';

    (async () => {
      // Fetch real fee rates from the API before trading
      const feeRate = await fetchFeeRate(market);
      feeRateRef.current = feeRate;
      state.addLog({
        time: new Date().toLocaleTimeString(),
        message: `Bot başlatıldı — Fee oranları (${market}): maker ${(feeRate.makerFee * 100).toFixed(4)}%, taker ${(feeRate.takerFee * 100).toFixed(4)}%`,
      });

      await executeTrade();
      scheduleNextRef.current();
    })();
  }, [state, executeTrade]);

  const startBot = useCallback(() => {
    if (confirmOrders) {
      setShowConfirm(true);
    } else {
      doStart();
    }
  }, [confirmOrders, doStart]);

  const stopBot = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    state.setField('status', 'STOPPED');
    state.addLog({ time: new Date().toLocaleTimeString(), message: 'Bot stopped' });
  }, [state]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Volume Bot'u Başlat"
        message={`${state.symbol} için Volume Bot başlatılacak.\nPiyasa: ${state.isSpot ? 'Spot' : 'Perps'}${getLeverage(state.isSpot, state.leverage) > 1 ? `\nKaldıraç: ${state.leverage}x` : ''}\nMiktar aralığı: ${state.minAmount} – ${state.maxAmount}\nAralık: ${state.intervalSec}s${parseFloat(state.budget) > 0 ? `\nBütçe: $${state.budget}${getLeverage(state.isSpot, state.leverage) > 1 ? ` × ${state.leverage}x = $${(parseFloat(state.budget) * getLeverage(state.isSpot, state.leverage)).toFixed(0)} efektif` : ''}` : ''}${parseFloat(state.maxSpend) > 0 ? `\nMax Harcama: $${state.maxSpend}` : ''}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Ayarlar</h2>
          <StatusBadge status={state.status} />
        </div>

        <Input
          label="Sembol"
          type="text"
          value={state.symbol}
          onChange={(e) => state.setField('symbol', e.target.value)}
          placeholder={state.isSpot ? 'BTC-USDC' : 'BTC-USD'}
          hint={state.isSpot ? 'Spot format: BTC-USDC' : 'Perps format: BTC-USD'}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Min Miktar"
            type="number"
            value={state.minAmount}
            onChange={(e) => state.setField('minAmount', e.target.value)}
          />
          <Input
            label="Max Miktar"
            type="number"
            value={state.maxAmount}
            onChange={(e) => state.setField('maxAmount', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Aralık (sn)"
            type="number"
            value={state.intervalSec}
            onChange={(e) => state.setField('intervalSec', e.target.value)}
          />
          <Input
            label="Max Hacim"
            type="number"
            value={state.maxVolumeTarget}
            onChange={(e) => state.setField('maxVolumeTarget', e.target.value)}
            hint="0 = limitsiz"
          />
        </div>

        <Input
          label="Spread Toleransı (%)"
          type="number"
          value={state.spreadTolerance}
          onChange={(e) => state.setField('spreadTolerance', e.target.value)}
          hint="0 = sınırsız"
        />

        {/* Budget Section */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
            💰 Bütçe Yönetimi
          </label>
          <div className="p-3 bg-background/40 border border-border rounded-lg space-y-3">
            <Input
              label="Toplam Bütçe ($)"
              type="number"
              value={state.budget}
              onChange={(e) => state.setField('budget', e.target.value)}
              placeholder="200"
              hint="0 = limitsiz. İşlem başına kullanılacak max sermaye"
              icon={<Wallet size={14} />}
            />
            <Input
              label="Max Harcama ($)"
              type="number"
              value={state.maxSpend}
              onChange={(e) => state.setField('maxSpend', e.target.value)}
              placeholder="20"
              hint="0 = limitsiz. Fee + zarar toplamı bu limiti aşamaz"
              icon={<ShieldAlert size={14} />}
            />
            {parseFloat(state.budget) > 0 && parseFloat(state.maxSpend) > 0 && (
              <div className="text-[10px] text-text-muted bg-primary/5 border border-primary/20 rounded-lg px-2.5 py-2">
                <span className="text-primary font-medium">Akıllı Mod:</span> Bot, hesabınızdan en fazla ${state.budget} sermaye kullanarak{!state.isSpot && getLeverage(state.isSpot, state.leverage) > 1 ? ` ${state.leverage}x kaldıraçla ($${(parseFloat(state.budget) * getLeverage(state.isSpot, state.leverage)).toFixed(0)} efektif)` : ''} hacim üretir.
                Toplam fee harcaması ${state.maxSpend} ile sınırlıdır. LIMIT emirleri (BUY+SELL çifti) ile spread kaybı sıfırlanır, sadece fee ödenir.
              </div>
            )}
          </div>
        </div>

        {/* Market Toggle */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">Piyasa</label>
          <div className="flex gap-2">
            <button
              onClick={() => {
                state.setField('isSpot', true);
                state.setField('symbol', normalizeSymbol(state.symbol, 'spot'));
              }}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'}`}
            >
              Spot
            </button>
            <button
              onClick={() => {
                state.setField('isSpot', false);
                state.setField('symbol', normalizeSymbol(state.symbol, 'perps'));
              }}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${!state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'}`}
            >
              Perps
            </button>
          </div>
        </div>

        {/* Leverage (only for Perps) */}
        {!state.isSpot && (
          <Input
            label="Kaldıraç (x)"
            type="number"
            value={state.leverage}
            onChange={(e) => state.setField('leverage', e.target.value)}
            placeholder="10"
            hint={`$${parseFloat(state.budget) > 0 ? (parseFloat(state.budget) * getLeverage(state.isSpot, state.leverage)).toFixed(0) : '0'} efektif pozisyon`}
            icon={<TrendingUp size={14} />}
          />
        )}

        <div className="mt-auto pt-4 border-t border-border">
          {state.status !== 'RUNNING' ? (
            <Button
              variant="primary"
              fullWidth
              size="lg"
              icon={<Play size={16} />}
              onClick={startBot}
            >
              {"Bot'u Başlat"}
            </Button>
          ) : (
            <Button
              variant="danger"
              fullWidth
              size="lg"
              icon={<Square size={16} />}
              onClick={stopBot}
            >
              Durdur
            </Button>
          )}
        </div>
      </div>

      {/* Live Status Panel */}
      <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Üretilen Hacim"
            value={<NumberDisplay value={state.totalVolume} suffix=" USDC" />}
            icon={<BarChart3 size={16} />}
          />
          <StatCard
            label="İşlem Sayısı"
            value={<NumberDisplay value={state.tradesCount} decimals={0} />}
            icon={<Hash size={16} />}
          />
          <StatCard
            label="Ödenen Fee"
            value={<NumberDisplay value={state.totalFee} prefix="$" />}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Ort. Spread"
            value={<NumberDisplay value={state.avgSpread} suffix="%" />}
            icon={<Activity size={16} />}
          />
        </div>

        {/* Budget Stats */}
        {(parseFloat(state.budget) > 0 || parseFloat(state.maxSpend) > 0) && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {parseFloat(state.budget) > 0 && (
              <StatCard
                label="İşlem Başına Max"
                value={<NumberDisplay value={parseFloat(state.budget)} prefix="$" />}
                icon={<Wallet size={16} />}
              />
            )}
            <StatCard
              label="Toplam Harcama"
              value={<NumberDisplay value={state.totalSpent} prefix="$" />}
              icon={<DollarSign size={16} />}
              trend={parseFloat(state.maxSpend) > 0 && state.totalSpent > parseFloat(state.maxSpend) * 0.8 ? 'down' : 'neutral'}
            />
            {parseFloat(state.maxSpend) > 0 && (
              <StatCard
                label="Harcama Limiti"
                value={<NumberDisplay value={Math.max(0, parseFloat(state.maxSpend) - state.totalSpent)} prefix="$" suffix=" kaldı" />}
                icon={<ShieldAlert size={16} />}
                trend={state.totalSpent > parseFloat(state.maxSpend) * 0.8 ? 'down' : 'up'}
              />
            )}
          </div>
        )}

        {/* Volume Progress */}
        {parseFloat(state.maxVolumeTarget) > 0 && (
          <div className="glass-card p-4">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-text-secondary">Hacim İlerlemesi</span>
              <span className="text-text-primary font-mono tabular-nums">
                {((state.totalVolume / parseFloat(state.maxVolumeTarget)) * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-2 bg-background rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-primary-soft rounded-full transition-all duration-500"
                style={{ width: `${Math.min((state.totalVolume / parseFloat(state.maxVolumeTarget)) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Spend Limit Progress */}
        {parseFloat(state.maxSpend) > 0 && (
          <div className="glass-card p-4">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-text-secondary">Harcama Limiti</span>
              <span className={`font-mono tabular-nums ${state.totalSpent > parseFloat(state.maxSpend) * 0.8 ? 'text-danger' : 'text-text-primary'}`}>
                ${state.totalSpent.toFixed(2)} / ${state.maxSpend}
              </span>
            </div>
            <div className="h-2 bg-background rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  state.totalSpent > parseFloat(state.maxSpend) * 0.8
                    ? 'bg-gradient-to-r from-warning to-danger'
                    : 'bg-gradient-to-r from-success to-primary'
                }`}
                style={{ width: `${Math.min((state.totalSpent / parseFloat(state.maxSpend)) * 100, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Log Panel */}
        <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Log Kayıtları</span>
            <span className="text-[10px] text-text-muted">{state.logs.length} kayıt</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
            {state.logs.map((log, i) => (
              <div
                key={i}
                className="text-xs flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-hover/50 transition-colors font-mono animate-fade-in"
              >
                <span className="text-text-muted w-16 shrink-0 tabular-nums">{log.time}</span>
                {log.symbol && <span className="w-20 font-medium text-text-primary">{log.symbol}</span>}
                {log.side && (
                  <span className={`badge ${log.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{log.side}</span>
                )}
                {log.amount && (
                  <span className="tabular-nums text-text-secondary">
                    <NumberDisplay value={log.amount} decimals={4} />
                  </span>
                )}
                {log.price && (
                  <span className="tabular-nums text-text-muted">
                    @ <NumberDisplay value={log.price} />
                  </span>
                )}
                {log.message && <span className="text-text-secondary truncate">{log.message}</span>}
              </div>
            ))}
            {state.logs.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                <div className="text-center">
                  <Activity size={32} className="mx-auto mb-3 opacity-30" />
                  <p>Bot log kayıtları burada görünecektir.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
