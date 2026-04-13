import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, BarChart3, Hash, DollarSign, Activity, TrendingUp, Percent, Target } from 'lucide-react';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  placeBatchOrders,
  fetchOrderbook,
  fetchFeeRate,
  normalizeSymbol,
  fetchOrderStatus,
  fetchSymbolTradingRules,
  updatePerpsLeverage,
  batchCancelOrders,
  fetchSymbols,
} from '../api/services';
import type { FeeRateInfo } from '../api/services';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';

const DEFAULT_INTERVAL_SEC = 3;
const PERPS_LEVERAGE = 10;
const MAX_QUANTITY_PRECISION = 12;
const MIN_FEE_RATE = 0.00000001;
/** Stop bot after this many consecutive attempts where no fill could be verified. */
const MAX_CONSECUTIVE_UNVERIFIED = 5;
/** Fixed fill wait time in ms — orders at bestBid/bestAsk are given this long to fill. */
const FILL_WAIT_MS = 3000;
const PAIR_BASE_OPTIONS = ['SOSO', 'SOL', 'BTC', 'ETH'] as const;
/** Minimum interval in seconds (dynamic interval floor). */
const MIN_INTERVAL_SEC = 2;
/** How many consecutive successful rounds before reducing interval by 1s. */
const INTERVAL_DECREASE_THRESHOLD = 10;
/** Seconds to add on rate limit (429) error. */
const RATE_LIMIT_PENALTY_SEC = 2;
/** Estimated 14-day maker volume share threshold for rebate. */
const REBATE_THRESHOLD_SHARE = 0.005; // 0.5%
/** Rough estimate of 14-day platform total volume used when no target is set. */
const ESTIMATED_PLATFORM_VOLUME = 1_000_000;
/** Maximum allowed spread (as a fraction of mid price) before skipping the round. */
const MAX_SPREAD_RATIO = 0.05;

function symbolFromBase(base: string, market: 'spot' | 'perps'): string {
  return market === 'spot' ? `${base}_USDC` : `${base}-USD`;
}

function parsePositiveLimit(value: string): number | null {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Classify an API error into a human-readable category so the log is actionable.
 */
function classifyError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: string; error?: string } }; message?: string };
  const status: number = e?.response?.status ?? 0;
  const body: string = (e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? '').toLowerCase();

  if (status === 401 || status === 403 || body.includes('signature') || body.includes('auth') || body.includes('nonce')) {
    return 'AUTH/SIGNATURE ERROR — check API key, private key, and nonce';
  }
  if (body.includes('insufficient') || body.includes('balance') || body.includes('margin')) {
    return 'INSUFFICIENT MARGIN — bütçe yetersiz, kullanılacak bütçeyi yükseltin veya perps/spot seçimini kontrol edin';
  }
  if (body.includes('quantity') || body.includes('lot size') || body.includes('step size')) {
    return 'QUANTITY INVALID — miktar adımı/symbol kuralı ile uyuşmuyor, bütçe artırılmalı';
  }
  if (body.includes('invalid symbol') || body.includes('unknown symbol') || status === 404) {
    return 'INVALID SYMBOL — check symbol format (spot: BTC-USDC, perps: BTC-USD)';
  }
  if (body.includes('accountid') || body.includes('symbolid') || body.includes('invalid request body')) {
    return 'PERPS PAYLOAD ERROR — accountID or symbolID could not be resolved; check symbol and API access';
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
  return e?.response?.data?.message ?? e?.message ?? 'Unknown error';
}

/**
 * Extract fill information from a placeOrder response (some exchanges embed it).
 * Returns undefined if the response does not contain reliable fill data.
 */
function extractInlineFill(res: unknown): { filledQty: number; avgFillPrice: number; status: string; totalFee: number } | undefined {
  const payload = res as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return undefined;
  const status = String(payload.status ?? payload.orderStatus ?? '');
  const filledQty = parseFloat(String(payload.filledQty ?? payload.executedQty ?? payload.filled_qty ?? payload.cumQty ?? '0')) || 0;
  const avgFillPrice = parseFloat(String(payload.avgFillPrice ?? payload.avgPrice ?? payload.avg_price ?? '0')) || 0;
  const totalFee = parseFloat(String(payload.fee ?? payload.filledFee ?? payload.commission ?? payload.totalFee ?? '0')) || 0;
  // Only trust inline fill if the status is explicit or we have both filled qty and price
  if ((status && !['OPEN', 'NEW', ''].includes(status.toUpperCase())) || (filledQty > 0 && avgFillPrice > 0)) {
    return { filledQty, avgFillPrice, status: status || (filledQty > 0 ? 'FILLED' : 'OPEN'), totalFee };
  }
  return undefined;
}

export const VolumeBot: React.FC = () => {
  const { volumeBot: state } = useBotStore();
  const settings = useSettingsStore();
  const { confirmOrders } = settings;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const feeRateRef = useRef<FeeRateInfo>({ makerFee: 0.00012, takerFee: 0.0004 });
  const consecutiveUnverifiedRef = useRef(0);
  const consecutiveSuccessRef = useRef(0);
  const dynamicIntervalRef = useRef(DEFAULT_INTERVAL_SEC);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pairOptions, setPairOptions] = useState<{ value: string; label: string }[]>(
    PAIR_BASE_OPTIONS.map((base) => ({
      value: symbolFromBase(base, state.isSpot ? 'spot' : 'perps'),
      label: `${base}/${state.isSpot ? 'USDC' : 'USD'}`,
    })),
  );

  // Load available trading pairs from the exchange whenever the market type changes.
  useEffect(() => {
    const market = state.isSpot ? 'spot' : 'perps';
    fetchSymbols(market)
      .then((symbols) => {
        const symbolsObj = symbols as Record<string, unknown> | unknown[];
        const list: Record<string, unknown>[] = Array.isArray(symbolsObj)
          ? symbolsObj as Record<string, unknown>[]
          : ((symbolsObj as Record<string, unknown>)?.symbols ?? (symbolsObj as Record<string, unknown>)?.data ?? []) as Record<string, unknown>[];
        const opts = list
          .filter((s: Record<string, unknown>) => s.symbol || s.name || s.ticker)
          .map((s: Record<string, unknown>) => {
            const sym = String(s.symbol ?? s.name ?? s.ticker);
            return { value: sym, label: sym };
          });
        if (opts.length > 0) {
          setPairOptions(opts);
          const currentSymbol = useBotStore.getState().volumeBot.symbol;
          if (!opts.find((o) => o.value === currentSymbol)) {
            useBotStore.getState().volumeBot.setField('symbol', opts[0].value);
          }
        }
      })
      .catch(() => {
        // Keep the current (or fallback hardcoded) options on failure
      });
  }, [state.isSpot]);

  const executeTrade = useCallback(async () => {
    if (!runningRef.current) return;
    const { volumeBot: s } = useBotStore.getState();

    const maxVolLimit = parsePositiveLimit(s.maxVolumeTarget);
    if (maxVolLimit !== null && s.totalVolume >= maxVolLimit) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: `Hedef hacme (${maxVolLimit}) ulaşıldı. Bot durdu.` });
      return;
    }

    const maxSpendLimit = parsePositiveLimit(s.maxSpend);
    if (maxSpendLimit !== null && s.totalSpent >= maxSpendLimit) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) aşıldı. Bot durdu.` });
      return;
    }

    const market = s.isSpot ? 'spot' : 'perps';
    const budgetVal = parseFloat(s.budget) || 0;
    const leverageVal = s.isSpot ? 1 : PERPS_LEVERAGE;
    const effectiveBudget = budgetVal * leverageVal;
    const hasBudget = budgetVal > 0;
    const normalizedSym = normalizeSymbol(s.symbol, market);

    if (!hasBudget) {
      runningRef.current = false;
      s.setField('status', 'STOPPED');
      s.addLog({ time: new Date().toLocaleTimeString(), message: 'Kullanılacak bütçe sıfır olamaz. Bot durdu.' });
      return;
    }

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

      // Skip if spread is zero/negative or abnormally wide (> 5%)
      const spreadRaw = askPrice - bidPrice;
      if (spreadRaw <= 0) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] ${normalizedSym}: Spread sıfır veya negatif. Atlanıyor.` });
        return;
      }
      if (spreadRaw / midPrice > MAX_SPREAD_RATIO) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] ${normalizedSym}: Spread çok geniş (${((spreadRaw / midPrice) * 100).toFixed(2)}%). Atlanıyor.` });
        return;
      }

      const spread = (spreadRaw / midPrice) * 100;

      const rules = await fetchSymbolTradingRules(s.symbol, market);
      const quantityPrecision = Math.max(0, Math.min(MAX_QUANTITY_PRECISION, rules.quantityPrecision || 8));
      const stepSize = rules.stepSize > 0 ? rules.stepSize : Number(`1e-${quantityPrecision}`);
      const quantityStepEpsilon = Math.max(stepSize * 1e-9, Number.EPSILON);
      const pricePrecision = Math.max(0, Math.min(8, rules.pricePrecision || 2));

      // Use absolute maker fee for cost calculation since we use GTX (post-only).
      // Math.abs is intentional: when rebate is active (negative fee), the exchange
      // credits us, but we still need a positive rate for budget/spend limit math.
      const makerFeeRate = Math.max(Math.abs(feeRateRef.current.makerFee), MIN_FEE_RATE);

      // Divide budget by 2 since we place both a BUY and a SELL side each round
      let maxQtyPerSide = effectiveBudget / (midPrice * 2);

      if (maxSpendLimit !== null) {
        const spendRemaining = maxSpendLimit - s.totalSpent;
        if (spendRemaining <= 0) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) doldu. Bot durdu.` });
          return;
        }
        const roundTripFeeRate = Math.max(makerFeeRate * 2, MIN_FEE_RATE);
        const maxQtyBySpend = spendRemaining / (midPrice * roundTripFeeRate);
        maxQtyPerSide = Math.min(maxQtyPerSide, maxQtyBySpend);
      }

      const quantity = Math.floor((maxQtyPerSide + quantityStepEpsilon) / stepSize) * stepSize;
      if (quantity <= 0) {
        s.addLog({ time: new Date().toLocaleTimeString(), message: 'Kalan bütçe/limit yetersiz. Atlanıyor.' });
        return;
      }

      const qty = quantity.toFixed(quantityPrecision);

      // ========== SINGLE ACCOUNT — MAKER PING-PONG ==========
      // Place BUY GTC at best bid and SELL GTC at best ask.
      // Orders rest in the book as makers; other participants fill them.
      // No STP risk since buy price (bid) < sell price (ask).
      const buyPrice = bidPrice.toFixed(pricePrecision);
      const sellPrice = askPrice.toFixed(pricePrecision);

      // Safety: skip if prices cross (shouldn't happen given spread check above)
      if (parseFloat(buyPrice) >= parseFloat(sellPrice)) {
        consecutiveUnverifiedRef.current += 1;
        consecutiveSuccessRef.current = 0;
        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: buyPrice(${buyPrice}) >= sellPrice(${sellPrice}) — spread çok dar, atlanıyor. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
        });
        if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık spread sorunu — bot durduruldu.` });
        }
        return;
      }

      s.addLog({
        time: new Date().toLocaleTimeString(),
        message: `[${market.toUpperCase()}] ${normalizedSym}: BUY GTC @ ${buyPrice} + SELL GTC @ ${sellPrice} qty=${qty}`,
      });

      // Send both orders in a single batch for atomicity and rate-limit efficiency
      const batchResults = await placeBatchOrders(
        [
          { symbol: s.symbol, side: 1, type: 1, quantity: qty, price: buyPrice, timeInForce: 1 /* GTC */ },
          { symbol: s.symbol, side: 2, type: 1, quantity: qty, price: sellPrice, timeInForce: 1 /* GTC */ },
        ],
        market,
      );

      const buyRes = (batchResults[0] ?? {}) as Record<string, unknown>;
      const sellRes = (batchResults[1] ?? {}) as Record<string, unknown>;
      const buyOrderId: string = String(buyRes?.orderID ?? buyRes?.orderId ?? buyRes?.id ?? '');
      const sellOrderId: string = String(sellRes?.orderID ?? sellRes?.orderId ?? sellRes?.id ?? '');

      s.addLog({
        time: new Date().toLocaleTimeString(),
        message: `[${market.toUpperCase()}] BUY orderId=${buyOrderId || 'N/A'} SELL orderId=${sellOrderId || 'N/A'} — ${FILL_WAIT_MS}ms fill bekleniyor…`,
      });

      // Wait for fills (GTC orders at bestBid/bestAsk need time for other users to fill)
      await new Promise((r) => setTimeout(r, FILL_WAIT_MS));

      if (!runningRef.current) return; // bot may have been stopped while waiting

      // Check fill status
      let buyFill = extractInlineFill(batchResults[0]);
      if (!buyFill && buyOrderId) {
        const st = await fetchOrderStatus(buyOrderId, s.symbol, market);
        if (st) buyFill = { filledQty: st.filledQty, avgFillPrice: st.avgFillPrice, status: st.status, totalFee: st.totalFee };
      }

      let sellFill = extractInlineFill(batchResults[1]);
      if (!sellFill && sellOrderId) {
        const st = await fetchOrderStatus(sellOrderId, s.symbol, market);
        if (st) sellFill = { filledQty: st.filledQty, avgFillPrice: st.avgFillPrice, status: st.status, totalFee: st.totalFee };
      }

      // Cancel unfilled orders (they've waited long enough)
      const ordersToCancelA: string[] = [];
      if ((buyFill?.filledQty ?? 0) === 0 && buyOrderId) ordersToCancelA.push(buyOrderId);
      if ((sellFill?.filledQty ?? 0) === 0 && sellOrderId) ordersToCancelA.push(sellOrderId);
      if (ordersToCancelA.length > 0) {
        await batchCancelOrders(ordersToCancelA, s.symbol, market).catch(() => {});
      }

      if (!buyFill && !sellFill) {
        // No fills — not an STP error, just no liquidity took our orders
        consecutiveUnverifiedRef.current += 1;
        consecutiveSuccessRef.current = 0;
        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: Fill doğrulanamadı — emirler dolmadı (${FILL_WAIT_MS}ms). (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
        });
        if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık fill'siz — bot durduruldu. Daha likit bir sembol deneyin.` });
        }
        return;
      }

      const buyVol = (buyFill?.filledQty ?? 0) * (buyFill?.avgFillPrice ?? parseFloat(buyPrice));
      const sellVol = (sellFill?.filledQty ?? 0) * (sellFill?.avgFillPrice ?? parseFloat(sellPrice));
      const totalFillVol = buyVol + sellVol;

      if (totalFillVol <= 0) {
        consecutiveUnverifiedRef.current += 1;
        consecutiveSuccessRef.current = 0;
        s.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[${market.toUpperCase()}] ${normalizedSym}: Fill yok. (${consecutiveUnverifiedRef.current}/${MAX_CONSECUTIVE_UNVERIFIED})`,
        });
        if (consecutiveUnverifiedRef.current >= MAX_CONSECUTIVE_UNVERIFIED) {
          runningRef.current = false;
          s.setField('status', 'STOPPED');
          s.addLog({ time: new Date().toLocaleTimeString(), message: `${MAX_CONSECUTIVE_UNVERIFIED} ardışık fill'siz — bot durduruldu.` });
        }
        return;
      }

      consecutiveUnverifiedRef.current = 0;
      consecutiveSuccessRef.current += 1;

      if (consecutiveSuccessRef.current >= INTERVAL_DECREASE_THRESHOLD) {
        dynamicIntervalRef.current = Math.max(MIN_INTERVAL_SEC, dynamicIntervalRef.current - 1);
        consecutiveSuccessRef.current = 0;
      }

      const filledQtyBuy = buyFill?.filledQty ?? 0;
      const filledQtySell = sellFill?.filledQty ?? 0;
      const filledSides = (filledQtyBuy > 0 ? 1 : 0) + (filledQtySell > 0 ? 1 : 0);
      const filledQtyAvg = filledSides > 0 ? (filledQtyBuy + filledQtySell) / filledSides : 0;
      // Use maker fee fallback if API returns zero fee
      const buyFee = (buyFill?.totalFee ?? 0) > 0 ? buyFill!.totalFee : buyVol * makerFeeRate;
      const sellFee = (sellFill?.totalFee ?? 0) > 0 ? sellFill!.totalFee : sellVol * makerFeeRate;
      const fee = buyFee + sellFee;

      const freshState = useBotStore.getState().volumeBot;
      const prevCount = freshState.tradesCount;
      const prevSpread = freshState.avgSpread;
      const nextTotalVolume = freshState.totalVolume + totalFillVol;
      const nextTotalFee = freshState.totalFee + fee;
      const nextTotalSpent = freshState.totalSpent + fee;

      freshState.setField('totalVolume', nextTotalVolume);
      freshState.setField('tradesCount', prevCount + filledSides);
      freshState.setField('totalFee', nextTotalFee);
      freshState.setField('totalSpent', nextTotalSpent);
      freshState.setField('avgSpread', prevSpread + (spread - prevSpread) / (prevCount + filledSides));

      freshState.addLog({
        time: new Date().toLocaleTimeString(),
        symbol: normalizedSym,
        side: 'BUY+SELL',
        amount: filledQtyAvg,
        price: midPrice,
        fee,
        orderId: `${buyOrderId || 'N/A'} / ${sellOrderId || 'N/A'}`,
        message: `[${market.toUpperCase()}] Fill: BUY ${filledQtyBuy.toFixed(8)}@${buyPrice} SELL ${filledQtySell.toFixed(8)}@${sellPrice} → $${totalFillVol.toFixed(4)}`,
      });

      if (maxVolLimit !== null && nextTotalVolume >= maxVolLimit) {
        runningRef.current = false;
        freshState.setField('status', 'STOPPED');
        freshState.addLog({ time: new Date().toLocaleTimeString(), message: `Hedef hacme (${maxVolLimit}) ulaşıldı. Bot durdu.` });
        return;
      }
      if (maxSpendLimit !== null && nextTotalSpent >= maxSpendLimit) {
        runningRef.current = false;
        freshState.setField('status', 'STOPPED');
        freshState.addLog({ time: new Date().toLocaleTimeString(), message: `Max harcama limiti ($${maxSpendLimit.toFixed(2)}) doldu. Bot durdu.` });
        return;
      }
    } catch (err: unknown) {
      const category = classifyError(err);
      const { volumeBot: s2 } = useBotStore.getState();

      // Dynamic interval: increase on rate limit errors
      if (category.includes('RATE LIMIT')) {
        dynamicIntervalRef.current += RATE_LIMIT_PENALTY_SEC;
        s2.addLog({
          time: new Date().toLocaleTimeString(),
          message: `[RATE LIMIT] Interval ${dynamicIntervalRef.current}s'ye yükseltildi`,
        });
        consecutiveSuccessRef.current = 0;
      }

      // STP errors should NOT increment the unverified counter — they are expected
      // in certain configurations and are not connection/verification failures.
      if (category.includes('SELF-TRADE PREVENTION')) {
        s2.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] STP engeli — bu beklenen bir durum, sayaç sıfırlanmadı.` });
      } else {
        s2.addLog({ time: new Date().toLocaleTimeString(), message: `[${market.toUpperCase()}] HATA: ${category}` });
      }

      toast.error(`Volume Bot: ${category}`);
    }
  }, []);

  const scheduleNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    scheduleNextRef.current = () => {
      if (!runningRef.current) return;
      const interval = Math.max(MIN_INTERVAL_SEC, dynamicIntervalRef.current) * 1000;
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
    consecutiveSuccessRef.current = 0;
    dynamicIntervalRef.current = DEFAULT_INTERVAL_SEC;
    state.resetStats();
    state.setField('leverage', state.isSpot ? '1' : String(PERPS_LEVERAGE));
    state.setField('status', 'RUNNING');

    const market = state.isSpot ? 'spot' : 'perps';

    (async () => {
      if (market === 'perps') {
        try {
          await updatePerpsLeverage(state.symbol, PERPS_LEVERAGE);
          state.addLog({
            time: new Date().toLocaleTimeString(),
            message: `[PERPS] Kaldıraç ${PERPS_LEVERAGE}x (CROSS) ayarlandı`,
          });
        } catch (err: unknown) {
          const category = classifyError(err);
          state.addLog({
            time: new Date().toLocaleTimeString(),
            message: `[PERPS] Kaldıraç güncellenemedi: ${category}`,
          });
        }
      }

      // Fetch real fee rates
      const feeRate = await fetchFeeRate(market);
      feeRateRef.current = feeRate;

      const isRebate = feeRate.makerFee < 0;
      state.addLog({
        time: new Date().toLocaleTimeString(),
        message: `Bot başlatıldı — Mod: TEK HESAP (Maker Ping-Pong) | Fee (${market}): maker ${(feeRate.makerFee * 100).toFixed(4)}%, taker ${(feeRate.takerFee * 100).toFixed(4)}%${isRebate ? ' 🎉 REBATE AKTİF!' : ''}`,
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

  const spendLimitValue = parsePositiveLimit(state.maxSpend);
  const volumeTargetValue = parsePositiveLimit(state.maxVolumeTarget);
  const spendUsageRatio = spendLimitValue !== null ? Math.min((state.totalSpent / spendLimitValue) * 100, 100) : 0;
  const volumeProgressRatio = volumeTargetValue !== null ? Math.min((state.totalVolume / volumeTargetValue) * 100, 100) : 0;
  const efficiency = state.totalFee > 0 ? Math.min(Math.round(state.totalVolume / state.totalFee), 999_999) : 0;
  const estimatedMakerShare = volumeTargetValue !== null && volumeTargetValue > 0
    ? Math.min((state.totalVolume / volumeTargetValue) * REBATE_THRESHOLD_SHARE * 100, 100)
    : (state.totalVolume > 0 ? (state.totalVolume / ESTIMATED_PLATFORM_VOLUME) * 100 : 0);
  const rebateRemaining = Math.max(0, REBATE_THRESHOLD_SHARE * 100 - estimatedMakerShare);
  return (
    <div className="flex h-[calc(100vh-52px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Volume Bot'u Başlat"
        message={`Volume Bot başlatılacak.\nMod: Tek Hesap (Maker Ping-Pong)\nPiyasa: ${state.isSpot ? 'Spot' : 'Perps'}${!state.isSpot ? `\nKaldıraç: ${PERPS_LEVERAGE}x (otomatik)` : ''}\nKullanılacak bütçe: $${state.budget || '0'}\nHarcanacak bütçe limiti: $${state.maxSpend || '0'}\nHedef hacim: $${state.maxVolumeTarget || '0'}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Ayarlar</h2>
          <StatusBadge status={state.status} />
        </div>

        <Select
          label="Piyasa"
          value={state.isSpot ? 'spot' : 'perps'}
          options={[
            { value: 'spot', label: 'Spot' },
              { value: 'perps', label: 'Perps (otomatik 10x)' },
            ]}
          onChange={(e) => {
            const nextMarket = e.target.value === 'spot' ? 'spot' : 'perps';
            state.setField('isSpot', nextMarket === 'spot');
            state.setField('leverage', nextMarket === 'spot' ? '1' : String(PERPS_LEVERAGE));
            state.setField('symbol', normalizeSymbol(state.symbol, nextMarket));
          }}
        />

        <Select
          label="İşlem Çifti"
          value={state.symbol}
          options={pairOptions}
          onChange={(e) => state.setField('symbol', e.target.value)}
        />

        <Input
          label="Kullanılacak Bütçe ($)"
          type="number"
          value={state.budget}
          onChange={(e) => state.setField('budget', e.target.value)}
          placeholder="200"
          hint={!state.isSpot ? `Perps'te otomatik ${PERPS_LEVERAGE}x kullanılır` : undefined}
        />

        <Input
          label="Harcanacak Bütçe ($)"
          type="number"
          value={state.maxSpend}
          onChange={(e) => state.setField('maxSpend', e.target.value)}
          placeholder="20"
          hint="Fee limiti (0 = limitsiz)"
        />

        <Input
          label="Hedef Hacim ($)"
          type="number"
          value={state.maxVolumeTarget}
          onChange={(e) => state.setField('maxVolumeTarget', e.target.value)}
          placeholder="10000"
          hint="0 = limitsiz"
        />

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
            label="Piyasa / Kaldıraç"
            value={`${state.isSpot ? 'Spot 1x' : `Perps ${PERPS_LEVERAGE}x`}`}
            icon={<Activity size={16} />}
          />
        </div>

        {/* New Stats: Efficiency, Maker Share, Rebate */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            label="Verimlilik (Hacim/Fee)"
            value={efficiency > 0 ? `${efficiency.toLocaleString()}x` : '—'}
            icon={<TrendingUp size={16} />}
            trend={efficiency > 1000 ? 'up' : 'neutral'}
          />
          <StatCard
            label="Maker Share %"
            value={`${estimatedMakerShare.toFixed(3)}%`}
            icon={<Percent size={16} />}
            trend={estimatedMakerShare >= REBATE_THRESHOLD_SHARE * 100 ? 'up' : 'neutral'}
          />
          <StatCard
            label="Kalan Rebate"
            value={rebateRemaining > 0 ? `${rebateRemaining.toFixed(3)}%` : '🎉 Rebate!'}
            icon={<Target size={16} />}
            trend={rebateRemaining <= 0 ? 'up' : 'neutral'}
          />
        </div>

        {/* Budget Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            label="Kullanılan Bütçe"
            value={<NumberDisplay value={parseFloat(state.budget) || 0} prefix="$" />}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Harcanan Bütçe"
            value={<NumberDisplay value={state.totalSpent} prefix="$" />}
            icon={<DollarSign size={16} />}
            trend={spendLimitValue !== null && state.totalSpent > spendLimitValue * 0.8 ? 'down' : 'neutral'}
          />
          <StatCard
            label="Kalan Harcama"
            value={<NumberDisplay value={Math.max(0, (spendLimitValue ?? 0) - state.totalSpent)} prefix="$" />}
            icon={<Activity size={16} />}
            trend={spendLimitValue !== null && state.totalSpent > spendLimitValue * 0.8 ? 'down' : 'up'}
          />
        </div>

        {/* Volume Progress */}
        {volumeTargetValue !== null && (
          <div className="glass-card p-4">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-text-secondary">Hacim İlerlemesi</span>
              <span className="text-text-primary font-mono tabular-nums">
                {volumeProgressRatio.toFixed(1)}%
              </span>
            </div>
            <div className="h-2 bg-background rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-primary-soft rounded-full transition-all duration-500"
                style={{ width: `${volumeProgressRatio}%` }}
              />
            </div>
          </div>
        )}

        {/* Spend Limit Progress */}
        {spendLimitValue !== null && (
          <div className="glass-card p-4">
            <div className="flex justify-between text-xs mb-2">
              <span className="text-text-secondary">Harcama Limiti</span>
              <span className={`font-mono tabular-nums ${state.totalSpent > spendLimitValue * 0.8 ? 'text-danger' : 'text-text-primary'}`}>
                ${state.totalSpent.toFixed(2)} / ${state.maxSpend}
              </span>
            </div>
            <div className="h-2 bg-background rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  state.totalSpent > spendLimitValue * 0.8
                    ? 'bg-gradient-to-r from-warning to-danger'
                    : 'bg-gradient-to-r from-success to-primary'
                }`}
                style={{ width: `${spendUsageRatio}%` }}
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
