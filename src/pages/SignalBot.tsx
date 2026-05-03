import React, { useEffect, useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Radio, Settings2, Target, Zap, Activity } from 'lucide-react';
import { useBotStore, type SignalPosition, type ConflictResolution } from '../store/botStore';
import { useBotPnlStore } from '../store/botPnlStore';
import { useSettingsStore } from '../store/settingsStore';
import { fetchKlines, placeOrder, updatePerpsLeverage, fetchBookTickers, normalizeSymbol, fetchOrderStatus, cancelOrder } from '../api/services';
import { evaluateSignals, resolveSignals, PARAM_LABELS, type CandleData, type SignalResult, type CombineMode } from '../api/signalEngine';
import { recommendSignalBot } from '../api/aiAutoConfig';
import { cn, getErrorMessage } from '../lib/utils';
import { TradingChart } from '../components/TradingChart';
import { SymbolSelector } from '../components/common/SymbolSelector';
import { StatusBadge } from '../components/common/StatusBadge';
import { AutoConfigureButton } from '../components/common/AutoConfigureButton';
import { Input, Select, Toggle } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { type SeriesMarker, type Time } from 'lightweight-charts';

// Polling intervals
const LOOP_INTERVAL = 10_000; // Check state, orders

export const SignalBot: React.FC = () => {
  const { signalBot: state } = useBotStore();
  const { isDemoMode } = useSettingsStore();

  const [logs, setLogs] = useState<{ time: string; msg: string; type?: 'info' | 'success' | 'warn' | 'error' }[]>([]);
  const [activeSignals, setActiveSignals] = useState<SignalResult[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [chartMarkers, setChartMarkers] = useState<SeriesMarker<Time>[]>([]);

  const runningRef = useRef(false);
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastProcessTimeRef = useRef<number>(0);

  const addLog = useCallback((msg: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    setLogs((prev) => [{ time: new Date().toLocaleTimeString(), msg, type }, ...prev].slice(0, 100));
  }, []);

  const stopBot = useCallback(async (reason?: string) => {
    runningRef.current = false;
    if (loopRef.current) { clearInterval(loopRef.current); loopRef.current = null; }
    // Cancel every server-side TP/SL stop we placed. If we don't, the
    // exchange will keep them resting (they're reduceOnly so they can
    // only close existing positions, but they still clutter the open-
    // orders view and could accidentally close a position the user
    // opens manually afterwards).
    const fresh = useBotStore.getState().signalBot;
    const market = fresh.isSpot ? 'spot' : 'perps';
    const stopIds: string[] = [];
    fresh.activePositions.forEach((p) => {
      if (p.tpOrderId) stopIds.push(p.tpOrderId);
      if (p.slOrderId) stopIds.push(p.slOrderId);
    });
    if (!isDemoMode && stopIds.length > 0) {
      await Promise.all(stopIds.map((id) =>
        cancelOrder(id, fresh.symbol, market).catch(() => { /* stop may already be gone */ }),
      ));
      addLog(`Cancelled ${stopIds.length} pending stop order(s)`, 'info');
    }
    state.setField('status', 'STOPPED');
    addLog(`Bot stopped${reason ? `: ${reason}` : ''}`, 'warn');
  }, [addLog, state, isDemoMode]);

  // Execute a trade based on signal decision.
  //
  // Pipeline:
  //   1. Read the freshest bot state (the closure copy can be stale by the
  //      time this async fn runs inside setInterval).
  //   2. Guard: max-open-positions + leverage bounds.
  //   3. Place a MARKET (IOC) entry order.
  //   4. Resolve the REAL fill price via `fetchOrderStatus` — retrying for
  //      up to ~2.4s because the `/trades` endpoint sometimes lags the
  //      order-placement response. This avoids computing TP/SL + unrealized
  //      PnL off the pre-trade mid-price, which can drift by a few bps on
  //      the entry and make every position read as slightly-losing from
  //      tick 1.
  //   5. For PERPS only, place server-side TP and SL stop orders with
  //      `reduceOnly: true` so TP/SL still fires if the browser is closed.
  //      Spot has no stop-order primitive on SoDEX — we fall back to the
  //      existing client-side checks in `evaluationLoop`.
  const executeTrade = useCallback(async (decision: 'LONG' | 'SHORT', currentPrice: number, signals: SignalResult[]) => {
    // Always read fresh: the setInterval closure can otherwise see a stale
    // snapshot of activePositions / leverage after several in-flight ticks.
    const fresh = useBotStore.getState().signalBot;
    const market = fresh.isSpot ? 'spot' : 'perps';
    const amountUsdt = parseFloat(fresh.amountUsdt);
    if (isNaN(amountUsdt) || amountUsdt <= 0) {
      addLog('Invalid Amount USDT, cannot trade', 'error');
      return;
    }

    try {
      // 1. Check max open positions (against the live store, not the closure)
      if (fresh.activePositions.length >= parseInt(fresh.maxOpenPositions || '1')) {
        addLog('Max open positions reached, skipping signal', 'warn');
        return;
      }

      // 2. Set leverage if perps
      let lev = parseInt(fresh.leverage);
      if (!fresh.isSpot) {
        if (!Number.isFinite(lev) || lev < 1) lev = 1;
        if (!isDemoMode) {
          await updatePerpsLeverage(fresh.symbol, lev, 2).catch((e) => {
            addLog(`Leverage update skipped: ${getErrorMessage(e)}`, 'warn');
          });
        }
      } else {
        lev = 1; // spot is always 1×
      }

      // 3. Calculate quantity
      const qty = (amountUsdt * lev) / currentPrice;

      // 4. Place market order (let placeOrder default timeInForce to IOC for
      //    MARKET — GTC on a market order is nonsensical and was a vestigial
      //    copy-paste from the old implementation).
      const side = decision === 'LONG' ? 1 : 2; // BUY = 1, SELL = 2
      let orderId = `demo-${Date.now()}`;
      let actualEntryPrice = currentPrice;
      let actualQty = qty;

      if (!isDemoMode) {
        const res = await placeOrder({
          symbol: fresh.symbol,
          side,
          type: 2, // MARKET
          quantity: String(qty),
        }, market);
        const r = res as Record<string, unknown>;
        orderId = String(r?.orderID ?? r?.orderId ?? r?.id ?? orderId);

        // 4a. Resolve REAL fill price. Retry because `/trades` can lag the
        //     order response by ~300-1500ms on testnet. Three tries spaced
        //     600ms apart covers ~2.4s which is enough for well over 99%
        //     of fills; if we still have nothing we fall back to the
        //     pre-trade mid-price and log a warning so the user knows
        //     PnL may be off by a small amount for this position.
        let resolved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            const status = await fetchOrderStatus(orderId, fresh.symbol, market);
            if (status && status.filledQty > 0) {
              actualEntryPrice = status.avgFillPrice;
              actualQty = status.filledQty;
              resolved = true;
              break;
            }
            if (status && status.status === 'EXPIRED' && attempt === 2) {
              addLog(`Order ${orderId} expired unfilled (IOC) — no position opened`, 'warn');
              return;
            }
          } catch {
            // swallow; retry loop handles it
          }
        }
        if (!resolved) {
          addLog(`Fill verification timed out — PnL will use mid-price ${currentPrice.toFixed(2)}`, 'warn');
        }
      }

      // 5. Compute TP/SL from the ACTUAL entry price (post-slippage).
      const tpPct = parseFloat(fresh.takeProfitPct);
      const slPct = parseFloat(fresh.stopLossPct);
      const tpPrice = !isNaN(tpPct) && tpPct > 0
        ? (decision === 'LONG' ? actualEntryPrice * (1 + tpPct / 100) : actualEntryPrice * (1 - tpPct / 100))
        : null;
      const slPrice = !isNaN(slPct) && slPct > 0
        ? (decision === 'LONG' ? actualEntryPrice * (1 - slPct / 100) : actualEntryPrice * (1 + slPct / 100))
        : null;

      // 6. Server-side TP/SL stops (PERPS only — spot has no stop-order
      //    primitive on SoDEX). These are the "browser-closed failsafe":
      //    if the tab dies the exchange will still close the position at
      //    TP or SL. The client-side checks in evaluationLoop remain as
      //    the *primary* path because they're more responsive for logs
      //    and stats, and they race-win in practice on well-connected
      //    sessions.
      let tpOrderId: string | undefined;
      let slOrderId: string | undefined;
      if (!isDemoMode && !fresh.isSpot) {
        const closeSide: 1 | 2 = decision === 'LONG' ? 2 : 1;
        if (tpPrice) {
          try {
            const res = await placeOrder({
              symbol: fresh.symbol,
              side: closeSide,
              type: 2,              // MARKET trigger fill
              quantity: String(actualQty),
              stopPrice: String(tpPrice),
              stopType: 2,          // TAKE_PROFIT
              triggerType: 2,       // MARK_PRICE
              reduceOnly: true,
            }, 'perps');
            tpOrderId = String((res as Record<string, unknown>)?.orderID ?? '');
            addLog(`Server-side TP stop placed @ ${tpPrice.toFixed(2)} (${tpOrderId})`, 'success');
          } catch (e) {
            addLog(`Server-side TP stop failed (client-side failsafe will handle it): ${getErrorMessage(e)}`, 'warn');
          }
        }
        if (slPrice) {
          try {
            const res = await placeOrder({
              symbol: fresh.symbol,
              side: closeSide,
              type: 2,              // MARKET trigger fill
              quantity: String(actualQty),
              stopPrice: String(slPrice),
              stopType: 1,          // STOP_LOSS
              triggerType: 2,       // MARK_PRICE
              reduceOnly: true,
            }, 'perps');
            slOrderId = String((res as Record<string, unknown>)?.orderID ?? '');
            addLog(`Server-side SL stop placed @ ${slPrice.toFixed(2)} (${slOrderId})`, 'success');
          } catch (e) {
            addLog(`Server-side SL stop failed (client-side failsafe will handle it): ${getErrorMessage(e)}`, 'warn');
          }
        }
      }

      // 7. Record position. Use functional setState so concurrent additions
      //    (e.g. when maxOpenPositions > 1 and two signals fire within one
      //    tick on different symbols) never overwrite each other.
      const newPos: SignalPosition = {
        id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: fresh.symbol,
        side: decision,
        entryPrice: actualEntryPrice,
        quantity: actualQty,
        leverage: lev,
        tpPrice,
        slPrice,
        tpOrderId,
        slOrderId,
        openTime: Date.now(),
        triggeredBy: signals.map((s) => s.label),
        orderId,
        unrealizedPnl: 0,
        status: 'OPEN',
      };
      useBotStore.setState((s) => ({
        signalBot: {
          ...s.signalBot,
          activePositions: [...s.signalBot.activePositions, newPos],
          lastSignalTime: Date.now(),
          lastSignalDirection: decision,
        },
      }));

      addLog(
        `${isDemoMode ? '[DEMO] ' : ''}Opened ${decision} @ ${actualEntryPrice.toFixed(2)} × ${actualQty.toFixed(6)} (${orderId})`,
        'success',
      );
    } catch (err) {
      addLog(`Failed to execute ${decision}: ${getErrorMessage(err)}`, 'error');
      useBotStore.setState((s) => ({ signalBot: { ...s.signalBot, status: 'ERROR' } }));
    }
  }, [addLog, isDemoMode]);

  // Main evaluation loop.
  //
  // Runs every LOOP_INTERVAL (10s). Two concerns, separated by a timing gate:
  //   A. HIGH-FREQ (every tick): refresh mid-price, update open-position
  //      unrealized PnL, fire client-side TP/SL.
  //   B. LOW-FREQ (every `checkInterval` seconds): fetch klines, evaluate
  //      signals, resolve combined decision, possibly open / close /
  //      reverse positions.
  //
  // We always read the FRESH bot state via `useBotStore.getState()` because
  // the setInterval captures only the first render's closure — by iteration N
  // the `state` snapshot in that closure is stale and would leak old
  // `activePositions`, `lastSignalTime`, etc., into trading decisions.
  const evaluationLoop = useCallback(async () => {
    if (!runningRef.current) return;
    // Pull the latest store state at the top of every tick.
    const fresh = useBotStore.getState().signalBot;
    const market = fresh.isSpot ? 'spot' : 'perps';

    try {
      // ── A. HIGH-FREQ: price + TP/SL + PnL ─────────────────────────────
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const normSym = normalizeSymbol(fresh.symbol, market);
      const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normSym) as Record<string, unknown> | undefined;

      let currentPrice = 0;
      if (ticker) {
        const bid = parseFloat(String(ticker.bidPrice ?? ticker.bid ?? '0'));
        const ask = parseFloat(String(ticker.askPrice ?? ticker.ask ?? '0'));
        currentPrice = (bid + ask) / 2;
      }

      if (currentPrice > 0 && fresh.activePositions.length > 0) {
        // Build a brand-new list — NEVER mutate existing position objects in
        // place. The previous implementation assigned to `p.unrealizedPnl`
        // and `p.status` directly, which (a) bypasses Zustand's change
        // detection so UI does not re-render, and (b) leaks mutations
        // across ticks because the closure and the store both point at the
        // same objects.
        const nextPositions: SignalPosition[] = [];
        let pnlChanged = false;
        let realizedDelta = 0;
        let totalTradesDelta = 0;
        let winTradesDelta = 0;
        const trades: { pnl: number; note: string }[] = [];
        const closeSideOrders: { side: 1 | 2; qty: number }[] = [];
        const cancelStopIds: string[] = [];

        for (const p of fresh.activePositions) {
          if (p.status !== 'OPEN') {
            nextPositions.push(p);
            continue;
          }

          // Simplified PnL: notional P&L of the base qty. Leverage does NOT
          // multiply the dollar PnL — it multiplies the RETURN on margin,
          // not the dollar P&L itself. The previous formula had leverage
          // on both sides which cancelled arithmetically but obscured intent.
          const directional = p.side === 'LONG'
            ? (currentPrice - p.entryPrice)
            : (p.entryPrice - currentPrice);
          const newPnl = p.quantity * directional;

          // TP hit?
          const tpHit = p.tpPrice != null && (
            (p.side === 'LONG' && currentPrice >= p.tpPrice) ||
            (p.side === 'SHORT' && currentPrice <= p.tpPrice)
          );
          // SL hit?
          const slHit = !tpHit && p.slPrice != null && (
            (p.side === 'LONG' && currentPrice <= p.slPrice) ||
            (p.side === 'SHORT' && currentPrice >= p.slPrice)
          );

          if (tpHit || slHit) {
            const status: SignalPosition['status'] = tpHit ? 'TP_HIT' : 'SL_HIT';
            addLog(
              `${tpHit ? 'Take Profit' : 'Stop Loss'} hit for ${p.side} @ ${currentPrice.toFixed(2)} (PnL ${newPnl >= 0 ? '+' : ''}${newPnl.toFixed(2)})`,
              tpHit ? 'success' : 'warn',
            );
            // Queue a closing market order. reduceOnly=true so the
            // server rejects if the position has already been closed
            // by the sibling server-side stop firing first — preventing
            // accidental flips.
            closeSideOrders.push({ side: p.side === 'LONG' ? 2 : 1, qty: p.quantity });
            // Cancel the sibling stop (the one that did NOT fire) so we
            // don't leave a hanging reduce-only on the book that could
            // open an unwanted counter-position on the next tick.
            if (tpHit && p.slOrderId) cancelStopIds.push(p.slOrderId);
            if (slHit && p.tpOrderId) cancelStopIds.push(p.tpOrderId);
            // Also cancel the fired one defensively — if server-side
            // stop already closed the position, this is a no-op; if it
            // did not fire server-side for some reason, we clean it up.
            if (tpHit && p.tpOrderId) cancelStopIds.push(p.tpOrderId);
            if (slHit && p.slOrderId) cancelStopIds.push(p.slOrderId);

            realizedDelta += newPnl;
            totalTradesDelta += 1;
            if (newPnl > 0) winTradesDelta += 1;
            trades.push({ pnl: newPnl, note: `${p.side} ${tpHit ? 'TP' : 'SL'} Hit` });

            nextPositions.push({ ...p, unrealizedPnl: newPnl, status });
            pnlChanged = true;
          } else if (newPnl !== p.unrealizedPnl) {
            nextPositions.push({ ...p, unrealizedPnl: newPnl });
            pnlChanged = true;
          } else {
            nextPositions.push(p);
          }
        }

        // Fire the closing orders + stop cancellations concurrently. Each
        // is individually try/caught so one bad call does not break the
        // whole batch.
        if (!isDemoMode && closeSideOrders.length > 0) {
          await Promise.all(closeSideOrders.map((o) =>
            placeOrder({
              symbol: fresh.symbol, side: o.side, type: 2,
              quantity: String(o.qty), reduceOnly: fresh.isSpot ? undefined : true,
            }, market).catch((e) => {
              addLog(`Close fill error: ${getErrorMessage(e)}`, 'warn');
            }),
          ));
        }
        if (!isDemoMode && cancelStopIds.length > 0) {
          await Promise.all(cancelStopIds.map((id) =>
            cancelOrder(id, fresh.symbol, market).catch(() => { /* stop may already be gone */ }),
          ));
        }

        if (pnlChanged) {
          // Single functional setState so counter updates accumulate
          // atomically regardless of how many TP/SL fired this tick.
          useBotStore.setState((s) => ({
            signalBot: {
              ...s.signalBot,
              activePositions: nextPositions.filter((pos) => pos.status === 'OPEN'),
              realizedPnl: s.signalBot.realizedPnl + realizedDelta,
              totalTrades: s.signalBot.totalTrades + totalTradesDelta,
              winTrades: s.signalBot.winTrades + winTradesDelta,
            },
          }));
          trades.forEach((t) => {
            useBotPnlStore.getState().recordTrade('signal', {
              pnlUsdt: t.pnl, ts: Date.now(), note: t.note,
            });
          });
        }
      }

      // ── B. LOW-FREQ: signal evaluation ────────────────────────────────
      const checkIntervalMs = parseInt(fresh.checkInterval) * 1000 || 60000;
      const now = Date.now();
      if (now - lastProcessTimeRef.current < checkIntervalMs) return;
      lastProcessTimeRef.current = now;

      // Bypass the 30s shared kline cache so the signal engine always sees
      // the freshest forming-candle data.
      const rawKlines = await fetchKlines(fresh.symbol, fresh.klineInterval, 100, market, { bypassCache: true });
      const klines: CandleData[] = (Array.isArray(rawKlines) ? rawKlines : []).map((raw) => {
        const k = raw as Record<string, unknown>;
        const pNum = (v: unknown) => parseFloat(String(v ?? 0));
        return {
          time: typeof k.t === 'number' ? k.t : pNum(k.t),
          open: pNum(k.o),
          high: pNum(k.h),
          low: pNum(k.l),
          close: pNum(k.c),
          volume: pNum(k.v),
        };
      }).filter((k) => k.time > 0);

      if (klines.length < 30) return;

      const currentPriceEval = klines[klines.length - 1].close;

      // Re-read positions after the awaited network calls above so we work
      // against the post-TP/SL snapshot, not the pre-tick one.
      const afterTPSL = useBotStore.getState().signalBot;

      // Run signals
      const results = evaluateSignals(klines, afterTPSL.signals);
      setActiveSignals(results);

      // Add markers to chart
      const newMarkers: SeriesMarker<Time>[] = [];
      results.forEach((r) => {
        if (r.direction !== 'NEUTRAL') {
          newMarkers.push({
            time: klines[klines.length - 1].time as Time,
            position: r.direction === 'LONG' ? 'belowBar' : 'aboveBar',
            color: r.direction === 'LONG' ? '#3fb950' : '#f85149',
            shape: r.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
            text: r.label,
          });
        }
      });
      if (newMarkers.length > 0) {
        setChartMarkers((prev) => {
          const timeMap = new Map<number, SeriesMarker<Time>>();
          const addMarker = (m: SeriesMarker<Time>) => {
            const t = m.time as number;
            if (timeMap.has(t)) {
              const existing = timeMap.get(t)!;
              if (!(existing.text ?? '').includes(m.text ?? '')) {
                existing.text = `${existing.text ?? ''}, ${m.text ?? ''}`;
              }
            } else {
              timeMap.set(t, { ...m });
            }
          };
          prev.forEach(addMarker);
          newMarkers.forEach(addMarker);
          return Array.from(timeMap.values())
            .sort((a, b) => (a.time as number) - (b.time as number))
            .slice(-50);
        });
      }

      // Combine decisions
      const decision = resolveSignals(results, afterTPSL.combineMode);
      if (decision.action === 'NONE') return;

      // Cooldown check (global, not per-position)
      const cooldownMs = parseInt(afterTPSL.cooldownSeconds) * 1000 || 120000;
      if (afterTPSL.lastSignalTime && now - afterTPSL.lastSignalTime < cooldownMs) return;

      // Conflict resolution — check ALL open positions, not just the first.
      // Previously `activePositions[0]` was the only one considered, which
      // meant maxOpenPositions>1 setups would silently skip the check for
      // the later positions and could end up holding both directions at
      // once when conflicting signals fired.
      const openSame = afterTPSL.activePositions.filter((p) => p.status === 'OPEN' && p.side === decision.action);
      const openOpposite = afterTPSL.activePositions.filter((p) => p.status === 'OPEN' && p.side !== decision.action);

      if (openOpposite.length > 0) {
        addLog(`Conflicting signal: ${decision.action} vs ${openOpposite.length} open ${openOpposite[0].side} position(s)`, 'warn');

        if (afterTPSL.onConflictingSignal === 'IGNORE') return;

        // CLOSE_ONLY or CLOSE_AND_REVERSE: close every opposite-side position.
        let realized = 0;
        let tradesCount = 0;
        let wins = 0;
        const closedIds = new Set<string>();
        const cancelIds: string[] = [];
        const closeOrders: { side: 1 | 2; qty: number }[] = [];
        const pnlEntries: { pnl: number; note: string }[] = [];

        for (const p of openOpposite) {
          // Use the just-refreshed unrealized PnL; if for any reason it's
          // zero (very first tick of a new pos), compute on the fly.
          const currentPnl = p.unrealizedPnl !== 0
            ? p.unrealizedPnl
            : p.quantity * (p.side === 'LONG' ? currentPriceEval - p.entryPrice : p.entryPrice - currentPriceEval);
          closeOrders.push({ side: p.side === 'LONG' ? 2 : 1, qty: p.quantity });
          if (p.tpOrderId) cancelIds.push(p.tpOrderId);
          if (p.slOrderId) cancelIds.push(p.slOrderId);
          realized += currentPnl;
          tradesCount += 1;
          if (currentPnl > 0) wins += 1;
          closedIds.add(p.id);
          pnlEntries.push({ pnl: currentPnl, note: 'Closed by Signal' });
        }

        if (!isDemoMode) {
          await Promise.all(closeOrders.map((o) =>
            placeOrder({
              symbol: fresh.symbol, side: o.side, type: 2,
              quantity: String(o.qty), reduceOnly: fresh.isSpot ? undefined : true,
            }, market).catch((e) => addLog(`Close fill error: ${getErrorMessage(e)}`, 'warn')),
          ));
          await Promise.all(cancelIds.map((id) =>
            cancelOrder(id, fresh.symbol, market).catch(() => {}),
          ));
        }

        useBotStore.setState((s) => ({
          signalBot: {
            ...s.signalBot,
            activePositions: s.signalBot.activePositions.filter((p) => !closedIds.has(p.id)),
            realizedPnl: s.signalBot.realizedPnl + realized,
            totalTrades: s.signalBot.totalTrades + tradesCount,
            winTrades: s.signalBot.winTrades + wins,
          },
        }));
        pnlEntries.forEach((t) =>
          useBotPnlStore.getState().recordTrade('signal', { pnlUsdt: t.pnl, ts: Date.now(), note: t.note }),
        );
        addLog(`Closed ${tradesCount} opposite-side position(s) (realized ${realized >= 0 ? '+' : ''}${realized.toFixed(2)})`, 'info');

        if (afterTPSL.onConflictingSignal === 'CLOSE_ONLY') return;
        // else CLOSE_AND_REVERSE: fall through and open fresh position.
      } else if (openSame.length > 0) {
        // Already holding same direction — nothing to do.
        return;
      }

      // Execute new trade.
      addLog(`Signal Engine triggered: ${decision.action} — ${decision.reasoning}`, 'info');
      await executeTrade(decision.action, currentPriceEval, decision.signals);
    } catch (err) {
      addLog(`Loop error: ${getErrorMessage(err)}`, 'error');
      // Non-fatal: the loop keeps running. Hard errors in executeTrade
      // (e.g. auth failure) already flip status to ERROR from there.
    }
  }, [addLog, executeTrade, isDemoMode]);

  // Start Bot
  const startBot = useCallback(async () => {
    if (runningRef.current) return;
    
    // Validation
    const amount = parseFloat(state.amountUsdt);
    if (isNaN(amount) || amount <= 0) return toast.error('Invalid amount USDT');
    if (!state.signals.some(s => s.enabled)) return toast.error('Enable at least one signal');

    state.resetStats();
    setLogs([]);
    setChartMarkers([]);
    addLog('Signal Bot starting...', 'info');
    runningRef.current = true;
    state.setField('status', 'RUNNING');
    lastProcessTimeRef.current = 0; // force immediate evaluation

    loopRef.current = setInterval(() => { void evaluationLoop(); }, LOOP_INTERVAL);
    void evaluationLoop();
  }, [addLog, evaluationLoop, state]);

  useEffect(() => {
    // Stop the loop on unmount. We intentionally do NOT auto-cancel the
    // server-side TP/SL stops here — that's the whole point of server-side
    // stops: they must survive the tab closing. The user stopping the bot
    // explicitly via the Stop button (handled by `stopBot`) *will* clean
    // them up; nav-away / reload leaves them live on purpose.
    return () => {
      runningRef.current = false;
      if (loopRef.current) clearInterval(loopRef.current);
    };
  }, []);

  const isLocked = state.status === 'RUNNING';

  const closePosition = useCallback(async (posId: string) => {
    // Always resolve from the freshest store snapshot so closing a position
    // that has just had its PnL updated mid-click uses the new PnL value.
    const fresh = useBotStore.getState().signalBot;
    const pos = fresh.activePositions.find((p) => p.id === posId);
    if (!pos) return;

    const market = pos.symbol.includes('-') ? 'perps' : 'spot';
    const closedAt = Date.now();
    try {
      if (!isDemoMode) {
        // Close the position first, then cancel any lingering stops. We
        // intentionally close BEFORE cancelling so a network blip
        // cancelling the stops won't leave the position open unhedged.
        await placeOrder({
          symbol: pos.symbol,
          side: pos.side === 'LONG' ? 2 : 1,
          type: 2,
          quantity: String(pos.quantity),
          reduceOnly: market === 'perps' ? true : undefined,
        }, market);
        const stopIds = [pos.tpOrderId, pos.slOrderId].filter(Boolean) as string[];
        if (stopIds.length > 0) {
          await Promise.all(stopIds.map((id) =>
            cancelOrder(id, pos.symbol, market).catch(() => {}),
          ));
        }
      }
      // Atomic counter updates via functional setState.
      useBotStore.setState((s) => {
        const wasWin = pos.unrealizedPnl > 0;
        return {
          signalBot: {
            ...s.signalBot,
            realizedPnl: s.signalBot.realizedPnl + pos.unrealizedPnl,
            totalTrades: s.signalBot.totalTrades + 1,
            winTrades: s.signalBot.winTrades + (wasWin ? 1 : 0),
            activePositions: s.signalBot.activePositions.filter((p) => p.id !== posId),
          },
        };
      });
      useBotPnlStore.getState().recordTrade('signal', {
        pnlUsdt: pos.unrealizedPnl, ts: closedAt, note: 'Manual Close',
      });
      addLog(`Position manually closed (PnL ${pos.unrealizedPnl >= 0 ? '+' : ''}${pos.unrealizedPnl.toFixed(2)})`, 'success');
      toast.success('Position closed');
    } catch (e) {
      toast.error(`Close failed: ${getErrorMessage(e)}`);
      addLog(`Close failed: ${getErrorMessage(e)}`, 'error');
    }
  }, [addLog, isDemoMode]);

  const toggleSignal = (id: string, enabled: boolean) => {
    if (isLocked) return;
    const updated = state.signals.map(s => s.id === id ? { ...s, enabled } : s);
    state.setField('signals', updated);
  };

  const updateSignalParam = (id: string, key: string, val: string) => {
    if (isLocked) return;
    const updated = state.signals.map(s => {
      if (s.id === id) {
        return { ...s, params: { ...s.params, [key]: parseFloat(val) || 0 } };
      }
      return s;
    });
    state.setField('signals', updated);
  };

  return (
    <div className="flex h-full">
      {/* ─────────────── Settings Panel ─────────────── */}
      <div className="w-96 border-r border-border bg-surface/30 backdrop-blur-sm flex flex-col overflow-hidden shrink-0">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <Radio size={16} className="text-primary" />
            Signal Bot
          </h2>
          <StatusBadge status={state.status} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
          {/* ── AI Auto-Configure ── one-click smart defaults for beginners.
               Analyzes current market (ATR, trend, volatility) and picks the
               best signal strategy, parameters, TP/SL, and timing. */}
          <AutoConfigureButton
            symbol={state.symbol}
            market={state.isSpot ? 'spot' : 'perps'}
            recommender={recommendSignalBot}
            hidden={isLocked}
            onApply={(preset) => {
              // Apply simple string/number fields
              if (preset.leverage)           state.setField('leverage', String(preset.leverage));
              if (preset.amountUsdt)         state.setField('amountUsdt', String(preset.amountUsdt));
              if (preset.takeProfitPct)      state.setField('takeProfitPct', String(preset.takeProfitPct));
              if (preset.stopLossPct)        state.setField('stopLossPct', String(preset.stopLossPct));
              if (preset.combineMode)        state.setField('combineMode', preset.combineMode as CombineMode);
              if (preset.checkInterval)      state.setField('checkInterval', String(preset.checkInterval));
              if (preset.klineInterval)      state.setField('klineInterval', String(preset.klineInterval));
              if (preset.cooldownSeconds)    state.setField('cooldownSeconds', String(preset.cooldownSeconds));
              if (preset.maxOpenPositions)   state.setField('maxOpenPositions', String(preset.maxOpenPositions));
              if (preset.onConflictingSignal) state.setField('onConflictingSignal', preset.onConflictingSignal as ConflictResolution);
              if (preset.isSpot !== undefined) state.setField('isSpot', preset.isSpot === 'true');
              // Deserialise and apply signal configs
              if (preset.signalsJson) {
                try {
                  const parsed = JSON.parse(String(preset.signalsJson));
                  if (Array.isArray(parsed)) state.setField('signals', parsed);
                } catch { /* ignore malformed JSON */ }
              }
            }}
          />

          <div className="flex flex-col gap-3">
            <SymbolSelector
              market={state.isSpot ? 'spot' : 'perps'}
              value={state.symbol}
              onChange={(val) => state.setField('symbol', val)}
              disabled={isLocked}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { if (!isLocked) state.setField('isSpot', true); }}
                className={cn('flex-1 py-2 text-xs rounded-lg border transition-all', state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover', isLocked && 'opacity-50')}
              >Spot</button>
              <button
                onClick={() => { if (!isLocked) state.setField('isSpot', false); }}
                className={cn('flex-1 py-2 text-xs rounded-lg border transition-all', !state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover', isLocked && 'opacity-50')}
              >Perps</button>
            </div>
            {!state.isSpot && (
              <Input
                label="Leverage (x)"
                type="number"
                value={state.leverage}
                onChange={(e) => state.setField('leverage', e.target.value)}
                disabled={isLocked}
              />
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              <Target size={12} /><span>Position Settings</span>
            </div>
            <Input
              label="Order Size (USDT)"
              type="number"
              value={state.amountUsdt}
              onChange={(e) => state.setField('amountUsdt', e.target.value)}
              disabled={isLocked}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Take Profit (%)"
                type="number"
                value={state.takeProfitPct}
                onChange={(e) => state.setField('takeProfitPct', e.target.value)}
                disabled={isLocked}
                hint="0 = disabled"
              />
              <Input
                label="Stop Loss (%)"
                type="number"
                value={state.stopLossPct}
                onChange={(e) => state.setField('stopLossPct', e.target.value)}
                disabled={isLocked}
                hint="0 = disabled"
              />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              <Zap size={12} /><span>Signal Configuration</span>
            </div>
            
            <div className="flex flex-col gap-2">
              <Select
                label="Combination Mode"
                value={state.combineMode}
                onChange={(e) => state.setField('combineMode', e.target.value as CombineMode)}
                disabled={isLocked}
                options={[
                  { value: 'ANY', label: 'ANY - If any signal triggers' },
                  { value: 'ALL', label: 'ALL - All enabled must agree' },
                  { value: 'MAJORITY', label: 'MAJORITY - >50% must agree' }
                ]}
              />
            </div>

            <div className="flex items-center justify-between mt-2">
              <span className="text-xs font-semibold">Active Signals</span>
            </div>

            <div className="flex flex-col gap-3">
              {state.signals.map(sig => (
                <div key={sig.id} className={cn("border border-border rounded-xl p-3 transition-colors", sig.enabled ? "bg-primary/5 border-primary/30" : "bg-background/40 opacity-70")}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">{sig.label}</span>
                    <Toggle label="" checked={sig.enabled} onChange={(v) => toggleSignal(sig.id, v)} />
                  </div>
                  {sig.enabled && (
                    <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/50">
                      {Object.entries(sig.params).map(([key, val]) => (
                        <div key={key}>
                          <label className="block text-[9px] text-text-muted uppercase mb-1">{PARAM_LABELS[key] || key}</label>
                          <input 
                            type="number" 
                            className="w-full bg-background border border-border rounded px-2 py-1 text-xs focus:border-primary outline-none"
                            value={val}
                            onChange={(e) => updateSignalParam(sig.id, key, e.target.value)}
                            disabled={isLocked}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background/30">
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
            >
              <span className="flex items-center gap-1.5"><Settings2 size={12} />Advanced</span>
            </button>
            {advancedOpen && (
              <div className="border-t border-border p-3 flex flex-col gap-3">
                 <Select
                  label="Kline Interval"
                  value={state.klineInterval}
                  onChange={(e) => state.setField('klineInterval', e.target.value)}
                  disabled={isLocked}
                  options={[
                    { value: '1m', label: '1 Minute' },
                    { value: '5m', label: '5 Minutes' },
                    { value: '15m', label: '15 Minutes' },
                    { value: '1h', label: '1 Hour' },
                    { value: '4h', label: '4 Hours' },
                  ]}
                />
                <Input
                  label="Check Interval (sec)"
                  type="number"
                  value={state.checkInterval}
                  onChange={(e) => state.setField('checkInterval', e.target.value)}
                  disabled={isLocked}
                />
                <Select
                  label="On Conflict"
                  value={state.onConflictingSignal}
                  onChange={(e) => state.setField('onConflictingSignal', e.target.value as ConflictResolution)}
                  disabled={isLocked}
                  options={[
                    { value: 'CLOSE_AND_REVERSE', label: 'Close & Reverse' },
                    { value: 'CLOSE_ONLY', label: 'Close Only' },
                    { value: 'IGNORE', label: 'Ignore Signal' },
                  ]}
                />
                <Input
                  label="Max Open Positions"
                  type="number"
                  value={state.maxOpenPositions}
                  onChange={(e) => state.setField('maxOpenPositions', e.target.value)}
                  disabled={isLocked}
                />
              </div>
            )}
          </div>

        </div>

        <div className="px-5 py-4 border-t border-border bg-background/40 shrink-0">
          {!isLocked ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={startBot}>
              Start Bot
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={() => stopBot()}>
              Stop Bot
            </Button>
          )}
        </div>
      </div>

      {/* ─────────────── Dashboard ─────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        
        {/* Chart Area */}
        <div className="h-[400px] border-b border-border bg-background flex flex-col shrink-0">
           <TradingChart symbol={state.symbol} market={state.isSpot ? 'spot' : 'perps'} height={400} markers={chartMarkers} className="border-none rounded-none" />
        </div>

        {/* Status Area */}
        <div className="flex-1 p-5 overflow-y-auto flex flex-col gap-5">
          <BotPnlStrip botKey="signal" />

          {/* Active Signals Mini Dashboard */}
          {isLocked && activeSignals.length > 0 && (
            <div className="glass-card p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3 flex items-center gap-2">
                <Activity size={14} /> Live Signal Status
              </h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {activeSignals.map((sig, i) => (
                  <div key={i} className="border border-border/50 rounded-lg p-2.5 bg-background/50">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-medium">{sig.label}</span>
                      <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded", 
                        sig.direction === 'LONG' ? "bg-success/20 text-success" : 
                        sig.direction === 'SHORT' ? "bg-danger/20 text-danger" : "bg-text-muted/20 text-text-muted"
                      )}>{sig.direction}</span>
                    </div>
                    <div className="text-[10px] text-text-muted truncate" title={sig.description}>{sig.description}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Active Positions */}
            <div className="glass-card p-0 flex flex-col h-64">
              <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-background/30">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Open Positions</span>
                <span className="badge badge-primary">{state.activePositions.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {state.activePositions.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-text-muted">No open positions</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {state.activePositions.map(pos => (
                      <div key={pos.id} className="border border-border rounded-lg p-3 bg-surface hover:bg-surface-hover transition-colors">
                        <div className="flex justify-between items-center mb-2">
                          <div className="flex items-center gap-2">
                            <span className={cn("badge", pos.side === 'LONG' ? "badge-success" : "badge-danger")}>{pos.side} {pos.leverage}x</span>
                            <span className="font-semibold text-sm">{pos.symbol}</span>
                          </div>
                          <button onClick={() => closePosition(pos.id)} className="text-[10px] px-2 py-1 bg-danger/10 text-danger hover:bg-danger/20 rounded">Close</button>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-[10px] mt-2">
                          <div><div className="text-text-muted mb-0.5">Entry</div><div className="font-mono">{pos.entryPrice.toFixed(2)}</div></div>
                          <div><div className="text-text-muted mb-0.5">Size</div><div className="font-mono">{pos.quantity.toFixed(4)}</div></div>
                          <div><div className="text-text-muted mb-0.5">TP/SL</div><div className="font-mono">{pos.tpPrice ? pos.tpPrice.toFixed(1) : '-'} / {pos.slPrice ? pos.slPrice.toFixed(1) : '-'}</div></div>
                          <div>
                            <div className="text-text-muted mb-0.5">PnL</div>
                            <div className={cn("font-mono font-medium", pos.unrealizedPnl >= 0 ? "text-success" : "text-danger")}>
                              {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2 text-[9px] text-text-muted flex gap-1 items-center">
                           <Activity size={10} /> Triggered by: {pos.triggeredBy.join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Logs */}
            <div className="glass-card p-0 flex flex-col h-64">
              <div className="px-4 py-3 border-b border-border bg-background/30">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Activity Log</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {logs.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-sm text-text-muted">Logs will appear here</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-3 text-[11px] p-2 rounded hover:bg-white/5">
                        <span className="text-text-muted shrink-0 tabular-nums">{log.time}</span>
                        <span className={cn(
                          log.type === 'error' ? 'text-danger' : 
                          log.type === 'warn' ? 'text-amber-400' :
                          log.type === 'success' ? 'text-success' : 'text-text-primary'
                        )}>
                          {log.msg}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
};
