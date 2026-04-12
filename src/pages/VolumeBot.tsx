import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, BarChart3, Hash, DollarSign, Activity, Wallet, ShieldAlert, TrendingUp } from 'lucide-react';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchOrderbook, fetchFeeRate, normalizeSymbol, fetchOrderStatus } from '../api/services';
import type { FeeRateInfo } from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { Button } from '../components/common/Button';

const DEFAULT_INTERVAL_SEC = 10;
/** Stop bot after this many consecutive attempts where no fill could be verified. */
const MAX_CONSECUTIVE_UNVERIFIED = 5;
/** How long to wait (ms) after placing an order before querying its fill status. */
const FILL_VERIFICATION_DELAY_MS = 800;

function getLeverage(isSpot: boolean, leverage: string): number {
  return isSpot ? 1 : (parseInt(leverage) || 1);
}

/**
 * Classify an API error into a human-readable category so the log is actionable.
 */
function classifyError(err: any): string {
  const status: number = err?.response?.status ?? 0;
  const body: string = (err?.response?.data?.message ?? err?.response?.data?.error ?? err?.message ?? '').toLowerCase();

  if (status === 401 || status === 403 || body.includes('signature') || body.includes('auth') || body.includes('nonce')) {
    return 'AUTH/SIGNATURE ERROR — check API key, private key, and nonce';
  }
  if (body.includes('insufficient') || body.includes('balance') || body.includes('margin')) {
    return 'INSUFFICIENT BALANCE — add funds or reduce quantity';
  }
  if (body.includes('invalid symbol') || body.includes('unknown symbol') || status === 404) {
    return 'INVALID SYMBOL — check symbol format (spot: BTC-USDC, perps: BTC-USD)';
  }
  if (status === 429 || body.includes('rate limit') || body.includes('too many')) {
    return 'RATE LIMIT — slow down interval or reduce frequency';
  }
  if (body.includes('self') || body.includes('wash') || body.includes('stp')) {
    return 'SELF-TRADE PREVENTION — exchange blocked self-match';
  }
  if (body.includes('not filled') || body.includes('ioc') || body.includes('cancelled')) {
    return 'ORDER NOT FILLED — IOC cancelled or no matching liquidity';
  }
  return err?.response?.data?.message ?? err?.message ?? 'Unknown error';
}

/**
 * Extract fill information from a placeOrder response (some exchanges embed it).
 * Returns undefined if the response does not contain reliable fill data.
 */
function extractInlineFill(res: any): { filledQty: number; avgFillPrice: number; status: string } | undefined {
  if (!res || typeof res !== 'object') return undefined;
  const status: string = res.status ?? res.orderStatus ?? '';
  const filledQty = parseFloat(res.filledQty ?? res.executedQty ?? res.filled_qty ?? res.cumQty ?? '0') || 0;
  const avgFillPrice = parseFloat(res.avgFillPrice ?? res.avgPrice ?? res.avg_price ?? '0') || 0;
  // Only trust inline fill if the status is explicit or we have both filled qty and price
  if ((status && !['OPEN', 'NEW', ''].includes(status.toUpperCase())) || (filledQty > 0 && avgFillPrice > 0)) {
    return { filledQty, avgFillPrice, status: status || (filledQty > 0 ? 'FILLED' : 'OPEN') };
  }
  return undefined;
}

export const VolumeBot: React.FC = () => {
  const { volumeBot: state } = useBotStore();
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const feeRateRef = useRef<FeeRateInfo>({ makerFee: 0.00012, takerFee: 0.0004 });
  const consecutiveUnverifiedRef = useRef(0);
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
    const normalizedSym = normalizeSymbol(s.symbol, market);

    try {
      const orderbook = await fetchOrderbook(s.symbol, market, 5);
      const bestBid = orderbook?.bids?.[0]?.[0] ?? orderbook?.bids?.[0]?.price;
      const bestAsk = orderbook?.asks?.[0]?.[0] ?? orderbook?.asks?.[0]?.price;

      if (!bestBid || !bestAsk) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] ${normalizedSym}: emir defteri verisi bulunamadı` });
        return;
      }

      const bidPrice = parseFloat(bestBid);
      const askPrice = parseFloat(bestAsk);
      const midPrice = (bidPrice + askPrice) / 2;

      if (midPrice <= 0) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] ${normalizedSym}: geçersiz fiyat. Atlanıyor.` });
        return;
      }

      const spread = ((askPrice - bidPrice) / midPrice) * 100;

      const spreadTol = parseFloat(s.spreadTolerance);
      if (spreadTol > 0 && spread > spreadTol) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] ${normalizedSym}: spread çok geniş (${spread.toFixed(2)}% > ${spreadTol}%). Atlanıyor.` });
        return;
      }

      let min = parseFloat(s.minAmount);
      let max = parseFloat(s.maxAmount);

      if (hasBudget) {
        const maxQtyByBudget = effectiveBudget / midPrice;
        max = Math.min(max, maxQtyByBudget);
        min = Math.min(min, max);
      }

      if (maxSpendLimit > 0) {
        const spendRemaining = maxSpendLimit - s.totalSpent;
        if (spendRemaining <= 0) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) doldu. Bot durdu.` });
          return;
        }
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

      if (hasBudget) {
        // Budget mode: place BUY and SELL LIMIT IOC at mid-price
        const limitPrice = midPrice.toString();
        const qty = quantity.toFixed(8);

        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: BUY+SELL IOC @ ${midPrice} qty=${qty} — emir gönderiliyor…`,
        });

        const buyResult = await placeOrder(
          { symbol: s.symbol, side: 1, type: 1, quantity: qty, price: limitPrice, timeInForce: 3 },
          market,
        );
        const sellResult = await placeOrder(
          { symbol: s.symbol, side: 2, type: 1, quantity: qty, price: limitPrice, timeInForce: 3 },
          market,
        );

        const buyOrderId: string = buyResult?.orderId ?? buyResult?.id ?? '';
        const sellOrderId: string = sellResult?.orderId ?? sellResult?.id ?? '';

        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: BUY orderId=${buyOrderId || 'N/A'} SELL orderId=${sellOrderId || 'N/A'} — fill doğrulanıyor…`,
        });

        // Allow the exchange a moment to process IOC orders before querying status
        await new Promise((r) => setTimeout(r, FILL_VERIFICATION_DELAY_MS));

        // Resolve fill data: prefer inline response, fall back to API status query
        let buyFill = extractInlineFill(buyResult);
        if (!buyFill && buyOrderId) {
          const st = await fetchOrderStatus(buyOrderId, s.symbol, market);
          if (st) buyFill = { filledQty: st.filledQty, avgFillPrice: st.avgFillPrice, status: st.status };
        }

        let sellFill = extractInlineFill(sellResult);
        if (!sellFill && sellOrderId) {
          const st = await fetchOrderStatus(sellOrderId, s.symbol, market);
          if (st) sellFill = { filledQty: st.filledQty, avgFillPrice: st.avgFillPrice, status: st.status };
        }

        // If we couldn't verify either order, increment failure counter
        if (!buyFill && !sellFill) {
          consecutiveUnverifiedRef.current += 1;
          const msg = `[${market.toUpperCase()}] ${normalizedSym}: Fill doğrulanamadı (orderId=${buyOrderId || 'N/A'}/${sellOrderId || 'N/A'}). Hacim sayılmadı. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`;
          s.addLog({ time: new Date().toLocaleTimeString(), message: msg });
          if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
            runningRef.current = false;
            s.setField('status', 'STOPPED');
            s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık doğrulanamaz işlem — bot durduruldu. Loglara bakın.` });
          }
          return;
        }

        // Count only what was actually filled on each side
        const buyVol = (buyFill?.filledQty ?? 0) * (buyFill?.avgFillPrice ?? midPrice);
        const sellVol = (sellFill?.filledQty ?? 0) * (sellFill?.avgFillPrice ?? midPrice);
        const totalFillVol = buyVol + sellVol;

        if (totalFillVol <= 0) {
          consecutiveUnverifiedRef.current += 1;
          const bStatus = buyFill?.status ?? 'N/A';
          const sStatus = sellFill?.status ?? 'N/A';
          s.addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${market.toUpperCase()}] ${normalizedSym}: Hiç fill yok — BUY=${bStatus} SELL=${sStatus}. Olası nedenler: STP, likidite yok, IOC iptal. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
          });
          if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
            runningRef.current = false;
            s.setField('status', 'STOPPED');
            s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık fill'siz işlem — bot durduruldu.` });
          }
          return;
        }

        // Successful fill — reset failure counter and record stats
        consecutiveUnverifiedRef.current = 0;

        const filledQtyBuy = buyFill?.filledQty ?? 0;
        const filledQtySell = sellFill?.filledQty ?? 0;
        const filledSides = (filledQtyBuy > 0 ? 1 : 0) + (filledQtySell > 0 ? 1 : 0);
        const filledQtyAvg = filledSides > 0 ? (filledQtyBuy + filledQtySell) / filledSides : 0;
        const fee = filledQtyAvg * midPrice * (feeRateRef.current.makerFee + feeRateRef.current.takerFee);

        const freshState = useBotStore.getState().volumeBot;
        const prevCount = freshState.tradesCount;
        const prevSpread = freshState.avgSpread;

        freshState.setField('totalVolume', freshState.totalVolume + totalFillVol);
        freshState.setField('tradesCount', prevCount + filledSides);
        freshState.setField('totalFee', freshState.totalFee + fee);
        freshState.setField('totalSpent', freshState.totalSpent + fee);
        freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + filledSides));

        freshState.addLog({
          time: new Date().toLocaleTimeString(),
          symbol: normalizedSym,
          side: 'BUY+SELL',
          amount: filledQtyAvg,
          price: midPrice,
          fee,
          orderId: `${buyOrderId || 'N/A'} / ${sellOrderId || 'N/A'}`,
          message: `[${market.toUpperCase()}] Fill doğrulandı: BUY ${filledQtyBuy.toFixed(8)}@${buyFill?.avgFillPrice?.toFixed(4) ?? midPrice} SELL ${filledQtySell.toFixed(8)}@${sellFill?.avgFillPrice?.toFixed(4) ?? midPrice} → hacim $${totalFillVol.toFixed(4)}`,
        });
      } else {
        // Classic mode: single market order
        const side: 1 | 2 = Math.random() > 0.5 ? 1 : 2;
        const sideLabel = side === 1 ? 'BUY' : 'SELL';
        const fillPrice = side === 1 ? askPrice : bidPrice;

        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: ${sideLabel} MARKET qty=${quantity.toFixed(8)} @ ~${fillPrice} — emir gönderiliyor…`,
        });

        const result = await placeOrder(
          { symbol: s.symbol, side, type: 2, quantity: quantity.toFixed(8) },
          market,
        );

        const orderId: string = result?.orderId ?? result?.id ?? '';

        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: orderId=${orderId || 'N/A'} — fill doğrulanıyor…`,
        });

        // Wait briefly for market order to settle
        await new Promise((r) => setTimeout(r, FILL_VERIFICATION_DELAY_MS));

        // Try inline fill first, then query API
        let fill = extractInlineFill(result);
        if (!fill && orderId) {
          const st = await fetchOrderStatus(orderId, s.symbol, market);
          if (st) fill = { filledQty: st.filledQty, avgFillPrice: st.avgFillPrice, status: st.status };
        }

        if (!fill) {
          consecutiveUnverifiedRef.current += 1;
          s.addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${market.toUpperCase()}] ${normalizedSym}: Fill doğrulanamadı (orderId=${orderId || 'N/A'}). Hacim sayılmadı. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
          });
          if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
            runningRef.current = false;
            s.setField('status', 'STOPPED');
            s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık doğrulanamaz işlem — bot durduruldu.` });
          }
          return;
        }

        if (fill.filledQty <= 0) {
          consecutiveUnverifiedRef.current += 1;
          s.addLog({
            time: new Date().toLocaleTimeString(),
            message: `[${market.toUpperCase()}] ${normalizedSym}: ${sideLabel} orderId=${orderId || 'N/A'} fill yok — status=${fill.status}. Hacim sayılmadı. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
          });
          if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
            runningRef.current = false;
            s.setField('status', 'STOPPED');
            s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık fill'siz işlem — bot durduruldu.` });
          }
          return;
        }

        // Confirmed fill
        consecutiveUnverifiedRef.current = 0;

        const vol = fill.filledQty * fill.avgFillPrice;
        const fee = vol * feeRateRef.current.takerFee;

        const freshState = useBotStore.getState().volumeBot;
        const prevCount = freshState.tradesCount;
        const prevSpread = freshState.avgSpread;

        freshState.setField('totalVolume', freshState.totalVolume + vol);
        freshState.setField('tradesCount', prevCount + 1);
        freshState.setField('totalFee', freshState.totalFee + fee);
        freshState.setField('totalSpent', freshState.totalSpent + fee);
        freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + 1));

        freshState.addLog({
          time: new Date().toLocaleTimeString(),
          symbol: normalizedSym,
          side: sideLabel,
          amount: fill.filledQty,
          price: fill.avgFillPrice,
          fee,
          orderId,
          message: `[${market.toUpperCase()}] Fill doğrulandı: ${sideLabel} ${fill.filledQty.toFixed(8)}@${fill.avgFillPrice.toFixed(4)} → hacim $${vol.toFixed(4)} status=${fill.status}`,
        });
      }
    } catch (err: any) {
      const category = classifyError(err);
      const { volumeBot: s2 } = useBotStore.getState();
      s2.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] HATA: ${category}` });
      toast.error(`Volume Bot: ${category}`);
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
    consecutiveUnverifiedRef.current = 0;
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
