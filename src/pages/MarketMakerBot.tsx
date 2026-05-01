import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Square, RefreshCw, Layers, AlertTriangle, AlertCircle,
  Activity, TrendingUp, Zap, Target, Wallet, BookOpen, CheckCircle2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, StatCard } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { SymbolSelector } from '../components/common/SymbolSelector';
import { cn, getErrorMessage } from '../lib/utils';
import {
  fetchOrderbook,
  fetchOpenOrders,
  fetchSymbolTradingRules,
  fetchBookTickers,
  placeOrder,
  batchCancelOrders,
} from '../api/services';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import { useBotPnlStore } from '../store/botPnlStore';
import { recommendMarketMakerBot } from '../api/aiAutoConfig';
import { AutoConfigureButton } from '../components/common/AutoConfigureButton';

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Market Maker Bot                                                    │
 * │ High-volume, low-fee maker farming for SoDEX airdrop eligibility.   │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * The mechanic, in plain English:
 *   1. We post a small ladder of paired buy + sell limit orders at
 *      (or just outside) the inside of the book, with `timeInForce =
 *      GTX` (post-only). The exchange GUARANTEES every fill is a
 *      MAKER fill — no taker fees, ever.
 *   2. As price wiggles, the book takes our orders one side at a time.
 *      We immediately re-quote so the ladder stays full.
 *   3. If price drifts more than `requoteBps` away from one of our
 *      resting orders, we cancel + replace at the new BBO so we don't
 *      sit too far back from the queue.
 *   4. Cumulative volume, estimated fees, and inventory drift are
 *      tracked live in the right-hand stats panel. Hard caps stop the
 *      bot when budget / volume / fee limits are hit.
 *
 * Key fee math (workshop tweet evidence): a real account showed
 *  $3.20 fee on $15k volume → ~2.1 bps avg → consistent with ~50%
 *  maker fills + 30 SOSO stake giving 5% fee discount. Our bot
 *  pushes that to ~100% maker fills, so 1bp default is a fair upper
 *  bound on fee cost relative to volume.
 *
 * Order identification: every order we place gets a clOrdID prefixed
 * with `mm_<sessionId>_<seq>`. We rely on this prefix on the
 * reconciliation loop to recognise our own orders vs the user's other
 * activity on the same pair.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const RECONCILE_INTERVAL_MS = 5_000;     // poll cadence
const MAX_LOG_ENTRIES = 80;
const CLOID_PREFIX = 'mm_';
// Bps → fraction multiplier. 1 bp = 0.0001 = 0.01%.
const BPS = 1 / 10_000;

interface LogEntry {
  ts: number;
  type: 'info' | 'order' | 'fill' | 'cancel' | 'error';
  message: string;
}

interface ManagedOrder {
  /** Client order ID assigned at placement — used to identify our orders. */
  clOrdID: string;
  /** Server-side orderID returned (or echoed) by SoDEX. May be empty until first poll. */
  orderID?: string;
  side: 'BUY' | 'SELL';
  /** Limit price posted. */
  price: number;
  /** Order quantity in base asset units. */
  quantity: number;
  /** Wall-clock at placement — used for staleness checks. */
  postedAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowMs(): number { return Date.now(); }

/** Lightweight client order ID generator. Sufficient uniqueness for an
 *  in-session ladder; the exchange enforces global uniqueness anyway. */
function makeCloid(sessionId: string, seq: number): string {
  return `${CLOID_PREFIX}${sessionId}_${seq.toString(36)}`;
}

// ─── The page ─────────────────────────────────────────────────────────────────

export const MarketMakerBot: React.FC = () => {
  const { privateKey, isDemoMode } = useSettingsStore();
  const mm = useBotStore((s) => s.marketMakerBot);
  const setField = useBotStore((s) => s.marketMakerBot.setField);
  const bumpField = useBotStore((s) => s.marketMakerBot.bumpField);
  const resetStats = useBotStore((s) => s.marketMakerBot.resetStats);
  const recordTrade = useBotPnlStore((s) => s.recordTrade);

  // ── Local state for things we don't want to persist in the global
  // bot store (logs, live BBO, open-orders snapshot, etc.). All of
  // these are session-local and discarded on a remount. */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bestBid, setBestBid] = useState<number>(0);
  const [bestAsk, setBestAsk] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  // Decimal precision for the symbol currently selected — pulled from
  // exchange metadata at start so we round prices/quantities to valid
  // multiples. Falls back to safe defaults until resolved.
  const [tickSize, setTickSize] = useState(0.01);
  const [stepSize, setStepSize] = useState(0.0001);
  const [pricePrec, setPricePrec] = useState(2);
  const [qtyPrec, setQtyPrec] = useState(4);

  // Refs so the polling closure always reads the latest config without
  // re-creating itself (which would reset the interval).
  const sessionIdRef = useRef<string>('');
  const seqRef = useRef(0);
  const managedRef = useRef<Map<string, ManagedOrder>>(new Map());
  const isRunningRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Re-entrancy guard for the reconcile loop. The polling timer fires
  // every 5s but a reconcile can take longer than that (multiple
  // network round-trips for orderbook → openOrders → placeOrder × N).
  // Without this guard a slow tick gets overlapped by the next one,
  // and both observe the same "missing slot" snapshot — double-placing
  // BUYs against the same budget and tripping insufficient-balance.
  const reconcileBusyRef = useRef(false);
  // Wall-clock of the last successful cancel — used to give the
  // exchange a tick to propagate the cancellation before we re-place
  // into the same slot. Avoids the race where managedRef has dropped
  // an order but the exchange still has it locked against our balance.
  const lastCancelAtRef = useRef(0);
  // Forward ref to stopBotInternal so reconcile can invoke it without
  // a circular dependency between the two useCallbacks.
  const stopBotInternalRef = useRef<() => Promise<void>>(async () => {});

  // ── Logging helper. Bounded to MAX_LOG_ENTRIES. Newest first. ─────
  const pushLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [{ ts: nowMs(), type, message }, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  // ── Whenever the user picks a different pair, refresh the metadata
  //    so subsequent orders use the right tick / step sizes. */
  useEffect(() => {
    if (!mm.symbol) return;
    let cancelled = false;
    void (async () => {
      try {
        const rules = await fetchSymbolTradingRules(mm.symbol, 'spot');
        if (cancelled) return;
        setTickSize(rules.tickSize || 0.01);
        setStepSize(rules.stepSize || 0.0001);
        setPricePrec(rules.pricePrecision ?? 2);
        setQtyPrec(rules.quantityPrecision ?? 4);
      } catch {
        // metadata fetch optional — bot still works with defaults
      }
    })();
    return () => { cancelled = true; };
  }, [mm.symbol]);

  // ── Derived values for display + sanity prompts ───────────────────
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spreadAbs = bestBid && bestAsk ? bestAsk - bestBid : 0;
  const spreadBps = mid > 0 ? (spreadAbs / mid) * 10_000 : 0;

  const budget = parseFloat(mm.budgetUsdt) || 0;
  const orderSize = parseFloat(mm.orderSizeUsdt) || 0;
  const layers = Math.max(1, Math.min(5, parseInt(mm.layers || '1', 10) || 1));
  const totalCommitment = orderSize * layers * 2;     // buy + sell ladder
  const overBudget = totalCommitment > budget;

  // Estimated fee per filled $1 of volume given the user's maker rate.
  const feeRate = parseFloat(mm.makerFeeRate) || 0.0001;
  const feeRatioPct = feeRate * 100;

  // Rough volume/hour estimate: at typical BBO turnover, a busy pair
  // sees ~ladder * 4-8 fills per hour. We display 6 as a midpoint so
  // users have an order-of-magnitude expectation.
  const estVolumePerHour = orderSize * layers * 12;   // 6 fills × 2 sides

  // Fee / volume target progress
  const volTarget = parseFloat(mm.volumeTargetUsdt) || 0;
  const feeBudget = parseFloat(mm.feeBudgetUsdt) || 0;
  const volProgress = volTarget > 0 ? Math.min(100, (mm.volumeUsdt / volTarget) * 100) : 0;
  const feeProgress = feeBudget > 0 ? Math.min(100, (mm.feesUsdt / feeBudget) * 100) : 0;

  // ── Order placement helper. Wraps placeOrder + side → numeric +
  //    GTX time-in-force so callers don't have to think about it. */
  const placeMakerOrder = useCallback(async (side: 'BUY' | 'SELL', price: number, qtyBase: number): Promise<ManagedOrder | null> => {
    seqRef.current += 1;
    const cloid = makeCloid(sessionIdRef.current, seqRef.current);
    try {
      const res = await placeOrder({
        symbol: mm.symbol,
        side: side === 'BUY' ? 1 : 2,
        type: 1,                       // LIMIT
        quantity: qtyBase.toFixed(qtyPrec),
        price: price.toFixed(pricePrec),
        timeInForce: 4,                // GTX = post-only — guarantees maker
        // Tag the order with our session-prefixed cloid so the
        // reconcile loop can recognise our own orders in the open-
        // orders snapshot and avoid double-placing into a slot the
        // exchange already has on the book.
        clOrdID: cloid,
      }, 'spot') as Record<string, unknown>;
      const orderID = String(res?.orderID ?? res?.orderId ?? cloid);
      const order: ManagedOrder = {
        clOrdID: cloid,
        orderID,
        side,
        price,
        quantity: qtyBase,
        postedAt: nowMs(),
      };
      managedRef.current.set(cloid, order);
      bumpField('ordersPlaced', 1);
      pushLog('order', `${side === 'BUY' ? '↗' : '↘'} ${side} ${qtyBase.toFixed(qtyPrec)} @ ${price.toFixed(pricePrec)} (${cloid.slice(-8)})`);
      return order;
    } catch (err) {
      // GTX rejections are EXPECTED when the spread tightens — log
      // quietly and let the next poll requote. Other errors are louder.
      const msg = getErrorMessage(err);
      const isPostOnlyReject = /post.?only|would.?cross|GTX|takeR|liquidity/i.test(msg);
      if (isPostOnlyReject) {
        pushLog('info', `Post-only ${side} skipped (would cross spread) — will retry next cycle`);
      } else {
        pushLog('error', `Place ${side} failed: ${msg}`);
      }
      return null;
    }
  }, [mm.symbol, qtyPrec, pricePrec, bumpField, pushLog]);

  // ── Reconciliation tick. Runs every RECONCILE_INTERVAL_MS while
  //    the bot is RUNNING. Pulls a snapshot of the order book + open
  //    orders and reconciles against the desired ladder shape. */
  const reconcile = useCallback(async () => {
    if (!isRunningRef.current) return;
    // Re-entrancy guard: skip the tick entirely if the previous one
    // is still in flight. The next scheduled tick will run normally.
    if (reconcileBusyRef.current) return;
    reconcileBusyRef.current = true;
    setBusy(true);
    try {
      // 1. Order book snapshot — drives target prices.
      // fetchOrderbook now normalises every venue's row shape to
      // [priceStr, qtyStr] so we can read the top-of-book directly.
      const ob = await fetchOrderbook(mm.symbol, 'spot', 5) as {
        bids?: [string, string][]; asks?: [string, string][];
      };
      let topBid = parseFloat(String(ob?.bids?.[0]?.[0] ?? 0));
      let topAsk = parseFloat(String(ob?.asks?.[0]?.[0] ?? 0));
      // Fallback for venues / tokens where the orderbook endpoint is
      // empty even though the pair trades — use the bookTickers feed
      // (top-of-book ticker) which usually has BBO when orderbook is
      // sparse on testnet.
      if (!Number.isFinite(topBid) || !Number.isFinite(topAsk) || topBid <= 0 || topAsk <= topBid) {
        try {
          const bts = await fetchBookTickers('spot') as Array<Record<string, unknown>>;
          const row = bts.find((t) => String(t.symbol) === mm.symbol);
          const fbBid = parseFloat(String(row?.bidPrice ?? row?.bid ?? row?.bidPx ?? 0));
          const fbAsk = parseFloat(String(row?.askPrice ?? row?.ask ?? row?.askPx ?? 0));
          if (Number.isFinite(fbBid) && Number.isFinite(fbAsk) && fbBid > 0 && fbAsk > fbBid) {
            topBid = fbBid;
            topAsk = fbAsk;
            pushLog('info', `Orderbook empty — using bookTicker BBO ${fbBid.toFixed(2)}/${fbAsk.toFixed(2)}`);
          }
        } catch { /* fall through to error log below */ }
      }
      if (!Number.isFinite(topBid) || !Number.isFinite(topAsk) || topBid <= 0 || topAsk <= topBid) {
        pushLog('error',
          `Order book unavailable for ${mm.symbol} — skipping cycle. ` +
          `(bids=${ob?.bids?.length ?? 0}, asks=${ob?.asks?.length ?? 0})`,
        );
        return;
      }
      setBestBid(topBid);
      setBestAsk(topAsk);

      // 2. Open orders for this symbol — drives the "is our order still
      //    live?" check.
      const openOrders = await fetchOpenOrders('spot', mm.symbol) as Array<Record<string, unknown>>;
      const openByCloid = new Map<string, Record<string, unknown>>();
      for (const o of openOrders ?? []) {
        const cl = String(o.clOrdID ?? o.clientOrderId ?? '');
        if (cl.startsWith(CLOID_PREFIX)) openByCloid.set(cl, o);
      }

      // 3. Reconcile filled / cancelled orders. Anything we tracked
      //    that is no longer open MUST have either filled (the common
      //    case) or been cancelled by the exchange (rare).
      const stillOpen = new Map<string, ManagedOrder>();
      for (const [cloid, mo] of managedRef.current.entries()) {
        if (openByCloid.has(cloid)) {
          stillOpen.set(cloid, mo);
        } else {
          // Determine whether it filled or was cancelled by inspecting
          // the persisted order log if available. SoDEX's
          // /accounts/{address}/orders/history could disambiguate, but
          // for now we treat "missing" as filled — the optimistic
          // assumption that matches GTX semantics (orders only leave
          // the book via fill or explicit cancel).
          const filledNotional = mo.price * mo.quantity;
          const fee = filledNotional * feeRate;
          // NOTE: maker fees on buy side debit base asset on a real
          // exchange; we lump everything into USDT-equivalent for the
          // UI. The fee figure is an estimate — the real number depends
          // on stake-tier discounts.
          // Use bumpField (functional update) so multiple fills in the
          // same reconcile pass accumulate correctly instead of each
          // call overwriting the previous with a stale-closure base.
          bumpField('ordersFilled', 1);
          bumpField('volumeUsdt', filledNotional);
          bumpField('feesUsdt', fee);
          // Inventory drifts opposite to the side that just filled —
          // a BUY fill increases inventory by quantity, a SELL fill
          // reduces it.
          bumpField('inventoryBase', mo.side === 'BUY' ? mo.quantity : -mo.quantity);
          // Aggregate the fee as a "negative PnL" on the bot strip so
          // the user can see fee burn at a glance. Real PnL would
          // include inventory revaluation but that is noisy at sub-
          // bp scales — the fee figure dominates over short windows.
          recordTrade('marketmaker', {
            pnlUsdt: -fee,
            ts: nowMs(),
            note: `${mo.side} fill ${mo.quantity.toFixed(qtyPrec)} ${mm.symbol} @ ${mo.price.toFixed(pricePrec)}`,
          });
          pushLog('fill', `✓ ${mo.side} ${mo.quantity.toFixed(qtyPrec)} @ ${mo.price.toFixed(pricePrec)} filled — vol +$${filledNotional.toFixed(2)}, fee est $${fee.toFixed(4)}`);
        }
      }
      managedRef.current = stillOpen;

      // 4. Stop conditions check — bail before placing more orders.
      // Read from the store directly so we see the fresh totals after
      // the bumpField calls in step 3 above (closure `mm` is stale by
      // this point in the tick).
      const postFillMm = useBotStore.getState().marketMakerBot;
      if (volTarget > 0 && postFillMm.volumeUsdt >= volTarget) {
        pushLog('info', `Volume target reached: $${postFillMm.volumeUsdt.toFixed(2)} ≥ $${volTarget.toFixed(2)}. Stopping.`);
        await stopBotInternalRef.current();
        return;
      }
      if (feeBudget > 0 && postFillMm.feesUsdt >= feeBudget) {
        pushLog('info', `Fee budget reached: $${postFillMm.feesUsdt.toFixed(4)} ≥ $${feeBudget.toFixed(4)}. Stopping.`);
        await stopBotInternalRef.current();
        return;
      }

      // 5. Stale order detection — anything more than `requoteBps`
      //    away from current BBO gets cancelled so the requote step
      //    below can re-post at the new mid.
      const requoteThreshold = (parseFloat(mm.requoteBps) || 5) * BPS;
      const toCancel: { id: string; cloid: string }[] = [];
      for (const [cloid, mo] of managedRef.current.entries()) {
        const ref = mo.side === 'BUY' ? topBid : topAsk;
        if (Math.abs(mo.price - ref) / ref > requoteThreshold) {
          const orderID = mo.orderID ?? cloid;
          toCancel.push({ id: orderID, cloid });
        }
      }
      if (toCancel.length > 0) {
        try {
          await batchCancelOrders(toCancel.map((c) => c.id), mm.symbol, 'spot');
          for (const { cloid } of toCancel) managedRef.current.delete(cloid);
          bumpField('ordersCancelled', toCancel.length);
          // Stamp the cancel time so the placement block below can
          // skip this tick — exchange takes a moment to release the
          // balance lock on the cancelled orders, and re-placing into
          // the same slot too fast trips insufficient-balance.
          lastCancelAtRef.current = nowMs();
          pushLog('cancel', `Re-quote: cancelled ${toCancel.length} stale order(s) — settling`);
        } catch (err) {
          pushLog('error', `Cancel failed: ${getErrorMessage(err)}`);
        }
      }

      // Cancel-settle cooldown. If we cancelled within the last tick
      // interval, the exchange may still be holding the budget locked
      // against the cancelled orders. Re-placing now would either
      // double-commit (if our managed map dropped the order) or hit
      // insufficient-balance. Skip placement for one tick.
      const cancelCooldownMs = RECONCILE_INTERVAL_MS;
      if (nowMs() - lastCancelAtRef.current < cancelCooldownMs) {
        return; // ladder gets refilled on the next clean tick
      }

      // 6. Re-fill the ladder. We aim for `layers` open orders on
      //    each side. Anything missing gets posted at a price stepped
      //    away from the BBO by spreadBps (0 = join the queue).
      //
      //    INVENTORY-AWARE SEQUENTIAL MODE (spot):
      //    On a spot venue we can only SELL what we actually own — the
      //    base asset has to be in the wallet. Posting a SELL before
      //    the matching BUY has filled is just rejected with
      //    "insufficient balance" (which is what the user was hitting).
      //    It's also a self-match / wash-trading risk on a thin testnet
      //    book: paired BUY+SELL from the same wallet can match each
      //    other, which SoDEX's anti-bot filter penalises.
      //
      //    Strategy: open the BUY ladder first to seed inventory, then
      //    open SELL slots only up to whatever inventory has actually
      //    accumulated from filled BUYs. Each open SELL "reserves" its
      //    quantity so we don't double-commit the same coins.
      //
      //    AUTHORITATIVE COUNT: we use the exchange's openOrders snapshot
      //    (openByCloid) rather than our in-memory managedRef when counting
      //    how many of our orders are *actually* on the book. The
      //    in-memory map can lag if a cancel hasn't propagated, which
      //    would make us double-place into a slot the exchange still
      //    has reserved against our balance.
      const ourOpen = [...openByCloid.values()];
      const sideOf = (o: Record<string, unknown>): 'BUY' | 'SELL' | null => {
        const s = o.side;
        if (s === 1 || s === '1') return 'BUY';
        if (s === 2 || s === '2') return 'SELL';
        const str = String(s ?? '').toUpperCase();
        if (str === 'BUY' || str === 'SELL') return str;
        return null;
      };
      const liveBuys  = ourOpen.filter((o) => sideOf(o) === 'BUY');
      const liveSells = ourOpen.filter((o) => sideOf(o) === 'SELL');
      const targetLayers = layers;
      const offsetMul = (parseFloat(mm.spreadBps) || 0) * BPS;

      const qtyPerOrder = orderSize / topBid;       // base-asset qty for ~$orderSize notional

      // Budget cap for new BUYs. Sum the notional already committed
      // to open BUY orders (price × qty) and only open new BUYs while
      // the remaining budget covers another full slot. This prevents
      // the bot from racing past its configured budget across cycles.
      const committedBuyUsdt = liveBuys.reduce((acc, o) => {
        const px = parseFloat(String(o.price ?? o.px ?? 0));
        const qty = parseFloat(String(o.quantity ?? o.qty ?? o.sz ?? 0));
        return Number.isFinite(px) && Number.isFinite(qty) ? acc + px * qty : acc;
      }, 0);
      const remainingBuyBudget = Math.max(0, budget - committedBuyUsdt);
      const maxNewBuySlots = orderSize > 0
        ? Math.floor(remainingBuyBudget / orderSize)
        : 0;
      const buyTargetLayers = Math.min(targetLayers, liveBuys.length + maxNewBuySlots);

      // Place missing buys. Fail-fast on the first error: if one BUY
      // hits insufficient-balance / rate-limit, every subsequent BUY
      // in this tick will hit the same wall, so don't burn placements
      // and don't spam the log.
      for (let i = liveBuys.length; i < buyTargetLayers; i++) {
        // Layered prices step further outside the BBO by `i * tickSize`
        // so we don't stack multiple orders at the exact same price
        // (which would just make us our own queue priority competitor).
        const px = topBid * (1 - offsetMul) - i * tickSize;
        if (px <= 0) break;
        const placed = await placeMakerOrder('BUY', px, qtyPerOrder);
        if (!placed) break;
      }

      if (buyTargetLayers < targetLayers && liveBuys.length < targetLayers) {
        // Inform user that the budget is fully committed, so they
        // understand why the BUY ladder is short of `layers`.
        pushLog('info',
          `BUY budget at cap — $${committedBuyUsdt.toFixed(2)} of $${budget.toFixed(2)} committed`,
        );
      }

      // Compute how many SELL slots we can safely open right now.
      // reservedSellQty = base asset already committed to open SELLs.
      const reservedSellQty = liveSells.reduce((acc, o) => {
        const qty = parseFloat(String(o.quantity ?? o.qty ?? o.sz ?? 0));
        return Number.isFinite(qty) ? acc + qty : acc;
      }, 0);
      // Read live inventory from the store directly rather than the
      // closure — bumpField calls earlier in this same tick (fill
      // detection) have already run, and we need their effect here.
      const liveInventoryBase = useBotStore.getState().marketMakerBot.inventoryBase;
      const availableInventory = Math.max(0, liveInventoryBase - reservedSellQty);
      const maxNewSellSlots = qtyPerOrder > 0
        ? Math.floor(availableInventory / qtyPerOrder)
        : 0;
      const sellTargetLayers = Math.min(targetLayers, liveSells.length + maxNewSellSlots);

      for (let i = liveSells.length; i < sellTargetLayers; i++) {
        const px = topAsk * (1 + offsetMul) + i * tickSize;
        const placed = await placeMakerOrder('SELL', px, qtyPerOrder);
        if (!placed) break;
      }

      // If we're holding back SELL slots because inventory hasn't
      // accumulated yet, surface that to the user once per cycle so
      // they don't think the bot is broken. We only log when the BUY
      // ladder is full — otherwise the missing SELLs are obviously
      // because BUYs haven't been placed yet either.
      const skippedSells = targetLayers - sellTargetLayers;
      if (skippedSells > 0 && liveBuys.length >= targetLayers) {
        pushLog('info',
          `${skippedSells} SELL slot(s) waiting on inventory ` +
          `(have ${availableInventory.toFixed(qtyPrec)}, need ${qtyPerOrder.toFixed(qtyPrec)} per slot)`,
        );
      }
    } catch (err) {
      pushLog('error', `Reconcile error: ${getErrorMessage(err)}`);
    } finally {
      setBusy(false);
      reconcileBusyRef.current = false;
    }
    // The dependency list is intentionally narrow — the rest is read
    // through refs so the polling timer doesn't churn every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Dependencies are only the values actually read as plain (non-
    // ref, non-store-functional) inputs. Counters that we only ever
    // increment via bumpField are intentionally NOT in this list —
    // including them would churn the callback identity and re-break
    // the reconcileRef pattern below.
  }, [mm.symbol, mm.requoteBps, mm.spreadBps,
      tickSize, qtyPrec, pricePrec, layers, orderSize, feeRate, budget,
      volTarget, feeBudget, placeMakerOrder, pushLog, bumpField, recordTrade]);

  // ── Stale-closure guard ───────────────────────────────────────────
  // `reconcile` is wrapped in useCallback with `mm.inventoryBase` (and
  // other zustand-derived values) in its dependency list, which means
  // a fresh reconcile reference is created every time the bot's state
  // changes. The polling timer below was capturing the *first* reconcile
  // reference at start-time and calling that forever — so it kept
  // reading mm.inventoryBase = 0, never noticed the BUY fills, and
  // therefore never opened any SELLs.
  //
  // Pattern: keep a ref pointing at the most recent reconcile, and
  // have the timer dispatch through the ref rather than a closed-over
  // variable. The timer itself is set up only once (in startBot).
  const reconcileRef = useRef(reconcile);
  useEffect(() => { reconcileRef.current = reconcile; }, [reconcile]);

  // Stop helper used by both manual button + auto-stop conditions.
  const stopBotInternal = useCallback(async (): Promise<void> => {
    isRunningRef.current = false;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setField('status', 'STOPPED');
    // Cancel anything we still have open so the user isn't left with
    // dangling resting orders after a stop.
    const open = [...managedRef.current.values()];
    if (open.length > 0) {
      try {
        await batchCancelOrders(open.map((o) => o.orderID ?? o.clOrdID), mm.symbol, 'spot');
        bumpField('ordersCancelled', open.length);
        pushLog('cancel', `Stopped — cancelled ${open.length} resting order(s)`);
      } catch (err) {
        pushLog('error', `Stop cancel failed: ${getErrorMessage(err)}`);
      }
      managedRef.current.clear();
    } else {
      pushLog('info', 'Bot stopped');
    }
  }, [mm.symbol, setField, bumpField, pushLog]);

  // Keep the forward ref aligned with the latest stopBotInternal so
  // reconcile (declared earlier) can invoke it through the ref without
  // a circular useCallback dependency.
  useEffect(() => { stopBotInternalRef.current = stopBotInternal; }, [stopBotInternal]);

  // Manual stop wrapper for the UI button.
  const stopBot = useCallback(() => { void stopBotInternal(); }, [stopBotInternal]);

  // ── Start handler. Validates inputs, kicks the first reconcile
  //    immediately, then schedules the polling loop. */
  const startBot = useCallback(async () => {
    if (mm.status === 'RUNNING') return;
    if (!isDemoMode && !privateKey) {
      toast.error('Set wallet private key in Settings first');
      return;
    }
    if (budget <= 0) { toast.error('Budget must be > 0'); return; }
    if (orderSize <= 0) { toast.error('Order size must be > 0'); return; }
    if (overBudget) {
      toast.error(`Total commitment $${totalCommitment.toFixed(2)} exceeds budget $${budget.toFixed(2)}`);
      return;
    }

    sessionIdRef.current = Math.random().toString(36).slice(2, 8);
    seqRef.current = 0;
    managedRef.current.clear();

    setField('status', 'RUNNING');
    setField('sessionStartedAt', nowMs());
    isRunningRef.current = true;

    pushLog('info', `▶ Started ${mm.symbol} • ${layers}×$${orderSize} ladder • spread ${mm.spreadBps}bps • requote ${mm.requoteBps}bps`);
    // Dispatch reconcile through the ref so each tick uses the latest
    // closure (with up-to-date mm.inventoryBase, etc.) rather than the
    // one captured at start time.
    void reconcileRef.current();
    pollTimerRef.current = setInterval(() => { void reconcileRef.current(); }, RECONCILE_INTERVAL_MS);
  }, [mm.status, mm.symbol, mm.spreadBps, mm.requoteBps, isDemoMode, privateKey,
      budget, orderSize, overBudget, totalCommitment, layers,
      setField, pushLog]);

  // Auto-cleanup if the page unmounts while the bot is running.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // We deliberately do NOT cancel open orders on unmount — the
      // user might just be navigating away briefly, and cancelling
      // their resting orders silently would be surprising. The
      // explicit Stop button handles cancellation.
      isRunningRef.current = false;
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  const isRunning = mm.status === 'RUNNING';
  const sessionDuration = mm.sessionStartedAt
    ? Math.max(0, Math.floor((nowMs() - mm.sessionStartedAt) / 1000))
    : 0;

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 md:gap-5 h-[calc(100vh-52px)] overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500/20 via-cyan-500/15 to-blue-500/20 border border-emerald-400/40 shadow-[0_0_12px_rgba(16,185,129,0.25)] flex items-center justify-center">
            <Layers size={20} className="text-emerald-300" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary">Market Maker Bot</h1>
            <p className="text-[11px] text-text-muted mt-0.5">
              Post-only ladder • maker-fee farming • SoDEX spot
            </p>
          </div>
        </div>
        <StatusBadge
          status={isRunning ? 'RUNNING' : mm.status === 'ERROR' ? 'ERROR' : 'STOPPED'}
        />
      </div>

      {/* Key explainer banner — sets expectation for first-time users */}
      <div className="shrink-0 flex items-start gap-3 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-[12px] text-emerald-200/90">
        <Zap size={14} className="shrink-0 mt-0.5 text-emerald-400" />
        <div>
          <strong className="text-emerald-300">How it works:</strong>{' '}
          The bot posts <strong>post-only (GTX)</strong> limit orders just
          inside the BBO — every fill is a guaranteed <strong>maker fill</strong>.
          Operates in <strong>inventory-aware sequential mode</strong>: BUYs are
          placed first to seed inventory, then SELLs are opened only up to the
          base asset actually accumulated from filled BUYs. This avoids
          self-match / wash-trade flags and works on spot with zero starting
          base balance. Goal: <em>maximum real volume, minimum fee</em>.
          Auto-stops on budget / volume / fee caps.
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
        <StatCard
          label="Volume"
          value={<NumberDisplay value={mm.volumeUsdt} prefix="$" />}
          icon={<TrendingUp size={16} />}
          trend={mm.volumeUsdt > 0 ? 'up' : 'neutral'}
        />
        <StatCard
          label="Fees Paid (est)"
          value={<NumberDisplay value={mm.feesUsdt} prefix="$" decimals={4} />}
          icon={<Wallet size={16} />}
        />
        <StatCard
          label="Filled / Placed"
          value={<span className="font-mono">{mm.ordersFilled} / {mm.ordersPlaced}</span>}
          icon={<CheckCircle2 size={16} />}
        />
        <StatCard
          label="Fee / Volume"
          value={
            <span className="font-mono">
              {mm.volumeUsdt > 0 ? `${((mm.feesUsdt / mm.volumeUsdt) * 100).toFixed(4)}%` : '—'}
            </span>
          }
          icon={<Target size={16} />}
        />
      </div>

      <div className="grid lg:grid-cols-[400px_1fr] gap-5 flex-1 min-h-0">
        {/* ── Left: configuration panel ─────────────────────────── */}
        <div className="flex flex-col gap-4 overflow-y-auto pr-1">
          {/* AI Auto-Configure — derives layers / spread / re-quote / order
              size from the current order book + 24h ATR. Hidden while the
              bot is running so a click can't accidentally desync live state
              from configured state. */}
          <AutoConfigureButton
            symbol={mm.symbol}
            market="spot"
            recommender={(ctx) => recommendMarketMakerBot(ctx, parseFloat(mm.budgetUsdt) || 100)}
            hidden={isRunning}
            onApply={(preset) => {
              if (preset.layers)        setField('layers',        String(preset.layers));
              if (preset.spreadBps)     setField('spreadBps',     String(preset.spreadBps));
              if (preset.requoteBps)    setField('requoteBps',    String(preset.requoteBps));
              if (preset.orderSizeUsdt) setField('orderSizeUsdt', String(preset.orderSizeUsdt));
              if (preset.makerFeeRate)  setField('makerFeeRate',  String(preset.makerFeeRate));
            }}
          />
          <Card className="p-4 space-y-3">
            <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
              Pair &amp; Sizing
            </div>
            <SymbolSelector
              market="spot"
              value={mm.symbol}
              onChange={(val) => setField('symbol', val)}
              disabled={isRunning}
            />
            <Input
              label="Budget (USDT)"
              type="number"
              min="1"
              step="1"
              value={mm.budgetUsdt}
              onChange={(e) => setField('budgetUsdt', e.target.value)}
              disabled={isRunning}
            />
            <Input
              label="Order Size (USDT)"
              type="number"
              min="1"
              step="1"
              value={mm.orderSizeUsdt}
              onChange={(e) => setField('orderSizeUsdt', e.target.value)}
              disabled={isRunning}
            />
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-text-muted uppercase tracking-wider font-semibold">Ladder Layers</span>
                <span className="text-xs font-mono font-bold text-emerald-300">{layers} × side</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={layers}
                onChange={(e) => setField('layers', e.target.value)}
                disabled={isRunning}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-[9px] text-text-muted font-mono mt-0.5">
                <span>1 (ping-pong)</span>
                <span>5 (deep ladder)</span>
              </div>
            </div>

            {/* Commitment summary — updates live as user tweaks inputs */}
            <div className={cn(
              'rounded-xl p-3 text-[11px] space-y-1 border',
              overBudget
                ? 'bg-danger/10 border-danger/30 text-danger'
                : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-200',
            )}>
              <div className="flex justify-between">
                <span>Active commitment:</span>
                <strong className="font-mono">
                  ${(orderSize * layers).toFixed(2)} × 2 sides = ${totalCommitment.toFixed(2)}
                </strong>
              </div>
              <div className="flex justify-between">
                <span>Budget headroom:</span>
                <strong className="font-mono">
                  ${(budget - totalCommitment).toFixed(2)}
                </strong>
              </div>
              {overBudget && (
                <div className="flex items-start gap-1.5 mt-1 text-[10px]">
                  <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                  Total commitment exceeds budget — reduce order size or layers.
                </div>
              )}
            </div>
          </Card>

          <Card className="p-4 space-y-3">
            <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted">
              Pricing &amp; Re-quote
            </div>
            <Input
              label="Spread Offset (bps)"
              type="number"
              min="0"
              step="0.5"
              value={mm.spreadBps}
              onChange={(e) => setField('spreadBps', e.target.value)}
              disabled={isRunning}
              hint="0 = join the BBO (fastest fills). Higher = less adverse selection but slower fills."
            />
            <Input
              label="Re-quote Threshold (bps)"
              type="number"
              min="1"
              step="0.5"
              value={mm.requoteBps}
              onChange={(e) => setField('requoteBps', e.target.value)}
              disabled={isRunning}
              hint="When the BBO moves this many bps from a posted order, cancel and re-quote at the fresh price."
            />
            <Input
              label="Maker Fee Rate"
              type="number"
              min="0"
              step="0.00001"
              value={mm.makerFeeRate}
              onChange={(e) => setField('makerFeeRate', e.target.value)}
              disabled={isRunning}
              hint="0.0001 = 1bp. Lower this if you have a SOSO stake fee discount."
            />
          </Card>

          <Card className="p-4 space-y-3">
            <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-2">
              Stop Conditions <span className="text-text-muted/60 normal-case font-normal">(optional)</span>
            </div>
            <Input
              label="Volume Target (USDT)"
              type="number"
              min="0"
              step="100"
              value={mm.volumeTargetUsdt}
              onChange={(e) => setField('volumeTargetUsdt', e.target.value)}
              disabled={isRunning}
              placeholder="Empty = no cap"
            />
            <Input
              label="Fee Budget (USDT)"
              type="number"
              min="0"
              step="0.5"
              value={mm.feeBudgetUsdt}
              onChange={(e) => setField('feeBudgetUsdt', e.target.value)}
              disabled={isRunning}
              placeholder="Empty = no cap"
            />
            {(volTarget > 0 || feeBudget > 0) && (
              <div className="space-y-2 pt-1">
                {volTarget > 0 && (
                  <div>
                    <div className="flex justify-between text-[10px] text-text-muted">
                      <span>Volume progress</span>
                      <span className="font-mono">{volProgress.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-surface mt-0.5 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all"
                        style={{ width: `${volProgress}%` }}
                      />
                    </div>
                  </div>
                )}
                {feeBudget > 0 && (
                  <div>
                    <div className="flex justify-between text-[10px] text-text-muted">
                      <span>Fee budget</span>
                      <span className="font-mono">{feeProgress.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-surface mt-0.5 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-amber-500 to-orange-400 transition-all"
                        style={{ width: `${feeProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Estimated impact preview — answers "what will this DO?" */}
          <Card className="p-4 space-y-2 bg-emerald-500/5 border-emerald-500/20">
            <div className="text-[10px] uppercase tracking-widest font-bold text-emerald-300">
              Estimated Impact
            </div>
            <div className="text-[11px] text-text-secondary space-y-1">
              <div className="flex justify-between">
                <span>Volume per hour (rough):</span>
                <strong className="font-mono text-text-primary">~${estVolumePerHour.toFixed(0)}</strong>
              </div>
              <div className="flex justify-between">
                <span>Fee per hour (est):</span>
                <strong className="font-mono text-text-primary">~${(estVolumePerHour * feeRate).toFixed(2)}</strong>
              </div>
              <div className="flex justify-between">
                <span>Fee rate:</span>
                <strong className="font-mono text-text-primary">{feeRatioPct.toFixed(3)}%</strong>
              </div>
            </div>
            <p className="text-[10px] text-text-muted italic mt-2">
              Estimates assume average market conditions. Volatile markets fill faster, quiet markets slower.
            </p>
          </Card>

          {/* Start / Stop control */}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant={isRunning ? 'danger' : 'primary'}
              icon={isRunning ? <Square size={14} /> : <Play size={14} />}
              onClick={isRunning ? stopBot : () => void startBot()}
              disabled={busy && !isRunning}
            >
              {isRunning ? 'Stop' : 'Start Farming'}
            </Button>
            <Button
              variant="outline"
              icon={<RefreshCw size={14} />}
              onClick={resetStats}
              disabled={isRunning}
              title="Reset stats counters"
            >
              Reset
            </Button>
          </div>
        </div>

        {/* ── Right: live status + log ──────────────────────────── */}
        <div className="flex flex-col gap-4 min-h-0">
          {/* Live BBO + session info */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BookOpen size={14} className="text-emerald-400" />
                <span className="text-xs font-bold uppercase tracking-wider">{mm.symbol}</span>
                {isRunning && (
                  <span className="text-[10px] font-mono text-emerald-400 ml-2 flex items-center gap-1">
                    <Activity size={10} className="animate-pulse" />
                    {Math.floor(sessionDuration / 60)}m {sessionDuration % 60}s
                  </span>
                )}
              </div>
              {busy && <RefreshCw size={12} className="animate-spin text-text-muted" />}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-[9px] uppercase text-text-muted">Best Bid</div>
                <div className="text-lg font-bold font-mono text-success mt-0.5">
                  {bestBid > 0 ? bestBid.toFixed(pricePrec) : '—'}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase text-text-muted">Mid</div>
                <div className="text-lg font-bold font-mono text-text-primary mt-0.5">
                  {mid > 0 ? mid.toFixed(pricePrec) : '—'}
                </div>
                <div className="text-[9px] font-mono text-text-muted">
                  {spreadBps > 0 ? `${spreadBps.toFixed(2)} bps` : ''}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[9px] uppercase text-text-muted">Best Ask</div>
                <div className="text-lg font-bold font-mono text-danger mt-0.5">
                  {bestAsk > 0 ? bestAsk.toFixed(pricePrec) : '—'}
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-[9px] uppercase text-text-muted">Active Orders</div>
                <div className="text-sm font-bold font-mono text-text-primary">{managedRef.current.size}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-text-muted">Cancelled</div>
                <div className="text-sm font-bold font-mono text-text-secondary">{mm.ordersCancelled}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-text-muted">Inventory</div>
                <div className={cn(
                  'text-sm font-bold font-mono',
                  Math.abs(mm.inventoryBase) < stepSize ? 'text-text-secondary' :
                  mm.inventoryBase > 0 ? 'text-success' : 'text-danger',
                )}>
                  {mm.inventoryBase > 0 ? '+' : ''}{mm.inventoryBase.toFixed(qtyPrec)}
                </div>
              </div>
            </div>
            {!isRunning && (
              <div className="mt-3 flex items-start gap-2 text-[11px] text-text-muted bg-surface rounded-lg p-2">
                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                Bot is stopped. Press Start to begin a new farming session.
              </div>
            )}
          </Card>

          {/* Activity log */}
          <Card className="p-4 flex-1 min-h-[300px] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="text-[10px] uppercase tracking-widest font-bold text-text-muted flex items-center gap-2">
                <Activity size={11} /> Activity Log
              </div>
              <span className="text-[10px] font-mono text-text-muted">{logs.length} entries</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[11px]">
              {logs.length === 0 ? (
                <div className="text-text-muted italic text-center py-6">
                  No activity yet. Press Start and orders will begin filling.
                </div>
              ) : (
                logs.map((l, i) => {
                  const time = new Date(l.ts).toLocaleTimeString();
                  const colour =
                    l.type === 'fill'   ? 'text-success' :
                    l.type === 'order'  ? 'text-cyan-400' :
                    l.type === 'cancel' ? 'text-amber-400' :
                    l.type === 'error'  ? 'text-danger' :
                                          'text-text-muted';
                  return (
                    <div key={i} className={cn('flex gap-2 leading-tight py-0.5', colour)}>
                      <span className="text-text-muted shrink-0 w-[64px]">{time}</span>
                      <span className="break-words">{l.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
