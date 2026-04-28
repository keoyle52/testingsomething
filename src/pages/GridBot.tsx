import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Play, Square, Layers, DollarSign, CheckCircle2, TrendingUp, Grid2X2,
  ChevronDown, ChevronUp, AlertTriangle, Zap, Info, Target, ShieldAlert,
} from 'lucide-react';
import { useBotStore } from '../store/botStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  placeOrder,
  cancelAllOrders,
  fetchBookTickers,
  fetchOpenOrders,
  normalizeSymbol,
  updatePerpsLeverage,
  getPerpsSymbolMeta,
  type PerpsSymbolMeta,
} from '../api/services';
import { cn, getErrorMessage } from '../lib/utils';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { RiskSummaryModal, type RiskSummaryRow } from '../components/common/RiskSummaryModal';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { useBotPnlStore } from '../store/botPnlStore';

interface GridLevel {
  price: number;
  orderId?: string;
  side?: 'BUY' | 'SELL';
  status: 'EMPTY' | 'ACTIVE' | 'FILLED';
}

interface LogEntry {
  time: string;
  side?: 'BUY' | 'SELL';
  message?: string;
}

const POLL_INTERVAL = 10_000;
const ROUND_TRIP_FEE_PCT = 0.08; // approximate combined taker fee — used for the profit-per-grid sanity hint

/**
 * Compute grid level prices for either arithmetic (constant absolute step)
 * or geometric (constant percent step) spacing.
 *
 * Geometric grids are preferred in volatile or wide-range markets because
 * they keep profit-per-grid (in %) constant across the entire range —
 * lower-priced rungs get tighter absolute spacing, upper rungs get wider.
 * Major exchanges expose this as a primary mode for that reason.
 */
function buildGridLevels(
  lower: number,
  upper: number,
  count: number,
  spacing: 'ARITHMETIC' | 'GEOMETRIC',
): number[] {
  if (lower <= 0 || upper <= 0 || count < 2 || lower >= upper) return [];
  const levels: number[] = [];
  if (spacing === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    for (let i = 0; i <= count; i++) levels.push(lower * Math.pow(ratio, i));
  } else {
    const step = (upper - lower) / count;
    for (let i = 0; i <= count; i++) levels.push(lower + step * i);
  }
  return levels;
}

/**
 * Estimated profit per filled grid round-trip, expressed as a percentage
 * of the lower-rung price. Mirrors the live preview shown by Binance /
 * Bybit / OKX: useful for sanity-checking that the chosen grid count is
 * dense enough to clear the round-trip taker fee (~0.08% combined).
 */
function profitPerGridPct(
  lower: number,
  upper: number,
  count: number,
  spacing: 'ARITHMETIC' | 'GEOMETRIC',
): number {
  if (lower <= 0 || upper <= 0 || count < 2 || lower >= upper) return 0;
  if (spacing === 'GEOMETRIC') {
    const ratio = Math.pow(upper / lower, 1 / count);
    return (ratio - 1) * 100;
  }
  const step = (upper - lower) / count;
  return (step / lower) * 100;
}

export const GridBot: React.FC = () => {
  const { gridBot: state } = useBotStore();
  const { confirmOrders } = useSettingsStore();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const armWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const armedRef = useRef(false);
  const gridLevelsRef = useRef<GridLevel[]>([]);
  const [gridLevels, setGridLevels] = useState<GridLevel[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [stopConditionsOpen, setStopConditionsOpen] = useState(false);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const prevPriceForCrossRef = useRef<number | null>(null);

  // Dynamically resolved leverage cap for the current perps symbol so the
  // input can never exceed the value SoDEX would reject. BTC sits at 25×
  // for example, alts often top out at 10× or 20× — relying on the live
  // metadata avoids any hard-coded assumption.
  const [perpsMeta, setPerpsMeta] = useState<PerpsSymbolMeta | null>(null);
  const [perpsMetaErr, setPerpsMetaErr] = useState<string | null>(null);
  const leverageCap = perpsMeta?.maxLeverage ?? 25;
  useEffect(() => {
    if (state.isSpot) { setPerpsMeta(null); setPerpsMetaErr(null); return; }
    let cancelled = false;
    setPerpsMetaErr(null);
    // Take only the base ticker (e.g. "BTC" from "BTC-USD") so the helper
    // can scan all USD/USDC/USDT-quoted candidates.
    const ticker = state.symbol.split(/[-_/]/)[0];
    void (async () => {
      const meta = await getPerpsSymbolMeta(ticker).catch(() => null);
      if (cancelled) return;
      setPerpsMeta(meta);
      if (!meta) {
        setPerpsMetaErr(`No live cap for ${ticker} — using 25× default`);
        return;
      }
      // Pull the user-set leverage down if it now exceeds the resolved cap.
      const userLev = parseInt(state.leverage) || 1;
      if (userLev > meta.maxLeverage) state.setField('leverage', String(meta.maxLeverage));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.symbol, state.isSpot]);

  const addLog = useCallback((entry: Omit<LogEntry, 'time'>) => {
    setLogs((prev) =>
      [{ time: new Date().toLocaleTimeString(), ...entry }, ...prev].slice(0, 50),
    );
  }, []);

  const placeGridOrder = useCallback(
    async (price: number, side: 'BUY' | 'SELL'): Promise<string | null> => {
      const { gridBot: s } = useBotStore.getState();
      const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

      try {
        const rawQty = parseFloat(s.amountPerGrid);
        if (isNaN(rawQty) || rawQty <= 0) throw new Error('Invalid quantity — check Amount/Grid');

        const result = await placeOrder(
          {
            symbol: s.symbol,
            side: side === 'BUY' ? 1 : 2,
            type: 1,          // LIMIT
            quantity: String(rawQty),
            price: String(price),
            timeInForce: 1,   // GTC
          },
          market,
        );

        const res = result as Record<string, unknown> | undefined;
        const orderId: string | null = String(res?.orderID ?? res?.orderId ?? res?.id ?? '') || null;
        if (orderId) {
          addLog({ message: `${side} LIMIT @ ${price.toFixed(2)} placed (${orderId})`, side });
        }
        return orderId;
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        addLog({ message: `ERROR placing ${side} @ ${price.toFixed(2)}: ${msg}` });
        toast.error(`Grid Bot: ${msg}`);
        return null;
      }
    },
    [addLog],
  );

  const fetchLastPrice = useCallback(async (): Promise<number | null> => {
    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';
    try {
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const normalizedSym = normalizeSymbol(s.symbol, market);
      const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normalizedSym) as Record<string, unknown> | undefined;
      if (!ticker) return null;
      const bid = parseFloat(String(ticker.bidPrice ?? ticker.bid ?? '0'));
      const ask = parseFloat(String(ticker.askPrice ?? ticker.ask ?? '0'));
      const mid = (bid + ask) / 2;
      lastPriceRef.current = mid;
      setLastPrice(mid);
      return mid;
    } catch (err: unknown) {
      addLog({ message: `ERROR fetching price: ${getErrorMessage(err)}` });
      return null;
    }
  }, [addLog]);

  // Forward declaration — pollOrders calls into stopBot, stopBot needs to
  // tear down the pollRef interval before the latest pollOrders fires.
  const stopBotRef = useRef<((reason?: string) => Promise<void>) | null>(null);

  const pollOrders = useCallback(async () => {
    if (!runningRef.current) return;
    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    try {
      // 1. Refresh last price for stop-condition checks (cheap — already
      //    cached server-side and TTL'd in our axios layer).
      const mid = await fetchLastPrice();

      // 2. Auto-stop conditions — these short-circuit before the order
      //    reconciliation so we don't keep replacing rungs while exiting.
      const sl = parseFloat(s.stopLossPrice);
      const tp = parseFloat(s.takeProfitPrice);
      const trail = parseFloat(s.trailingProfitUsd);
      const fresh = useBotStore.getState().gridBot;
      if (mid !== null) {
        if (Number.isFinite(sl) && sl > 0 && mid <= sl) {
          addLog({ message: `Stop-loss hit (${mid.toFixed(2)} ≤ ${sl}). Stopping bot.` });
          await stopBotRef.current?.(`SL @ ${sl}`);
          return;
        }
        if (Number.isFinite(tp) && tp > 0 && mid >= tp) {
          addLog({ message: `Take-profit hit (${mid.toFixed(2)} ≥ ${tp}). Stopping bot.` });
          await stopBotRef.current?.(`TP @ ${tp}`);
          return;
        }
      }
      if (Number.isFinite(trail) && trail > 0 && fresh.realizedPnl >= trail) {
        addLog({ message: `Profit target hit ($${fresh.realizedPnl.toFixed(2)} ≥ $${trail}). Stopping bot.` });
        await stopBotRef.current?.(`Profit @ $${trail}`);
        return;
      }

      // 3. Reconcile open orders.
      const openOrders = await fetchOpenOrders(market);
      const openOrderIds = new Set(
        (Array.isArray(openOrders) ? openOrders : []).map(
          (o) => { const r = o as Record<string, unknown>; return String(r.orderID ?? r.orderId ?? r.id ?? ''); },
        ),
      );

      const levels = gridLevelsRef.current;
      // Pre-compute neighbour gaps for arbitrary spacing (geometric grids
      // have non-uniform absolute steps so a single `gridStep` is wrong).

      for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        if (
          level.status === 'ACTIVE' &&
          level.orderId &&
          !openOrderIds.has(level.orderId)
        ) {
          const filledSide = level.side!;
          level.status = 'FILLED';
          level.orderId = undefined;

          addLog({
            message: `${filledSide} LIMIT @ ${level.price.toFixed(2)} FILLED ✓`,
            side: filledSide,
          });

          // Profit per fill = absolute distance to the neighbour rung × qty.
          // Works for both arithmetic and geometric spacing.
          const neighbourPrice =
            filledSide === 'BUY'  && i + 1 < levels.length ? levels[i + 1].price :
            filledSide === 'SELL' && i - 1 >= 0           ? levels[i - 1].price :
            level.price;
          const pnlPerGrid = Math.abs(neighbourPrice - level.price) * parseFloat(s.amountPerGrid);
          const freshState = useBotStore.getState().gridBot;
          freshState.setField('completedGrids', freshState.completedGrids + 1);
          freshState.setField('realizedPnl', freshState.realizedPnl + pnlPerGrid);
          useBotPnlStore.getState().recordTrade('grid', {
            pnlUsdt: pnlPerGrid,
            ts: Date.now(),
            note: `${filledSide} grid filled @ ${level.price.toFixed(2)}`,
          });

          if (filledSide === 'BUY' && i + 1 < levels.length) {
            const orderId = await placeGridOrder(levels[i + 1].price, 'SELL');
            if (orderId) {
              levels[i + 1] = { ...levels[i + 1], orderId, side: 'SELL', status: 'ACTIVE' };
            }
          } else if (filledSide === 'SELL' && i - 1 >= 0) {
            const orderId = await placeGridOrder(levels[i - 1].price, 'BUY');
            if (orderId) {
              levels[i - 1] = { ...levels[i - 1], orderId, side: 'BUY', status: 'ACTIVE' };
            }
          }
        }
      }

      const activeCount = levels.filter((l) => l.status === 'ACTIVE').length;
      useBotStore.getState().gridBot.setField('activeOrders', activeCount);

      gridLevelsRef.current = [...levels];
      setGridLevels([...levels]);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      addLog({ message: `ERROR polling orders: ${msg}` });
    }
  }, [addLog, placeGridOrder, fetchLastPrice]);

  /**
   * Place initial orders + start the poll loop. Assumes parameters have
   * already been validated and any preconditions (e.g. trigger price)
   * have been met. Triggered both by an immediate Start and by the
   * trigger-watcher's ARMED → RUNNING transition.
   */
  const launchGrid = useCallback(async () => {
    const { gridBot: s } = useBotStore.getState();
    const lower = parseFloat(s.lowerPrice);
    const upper = parseFloat(s.upperPrice);
    const count = parseInt(s.gridCount);
    const amount = parseFloat(s.amountPerGrid);

    runningRef.current = true;
    armedRef.current = false;
    s.setField('status', 'RUNNING');

    const currentPrice = lastPriceRef.current ?? (await fetchLastPrice());
    if (!currentPrice) {
      runningRef.current = false;
      s.setField('status', 'ERROR');
      addLog({ message: 'Failed to fetch current price. Bot stopped.' });
      return;
    }

    // For perps, push the chosen leverage to the exchange before placing
    // the ladder. Mirrors what the user would do manually in the SoDEX UI.
    // Resolve the live cap one last time and clamp against it — defends
    // against the user editing the box and pressing Start before the meta
    // useEffect has had a chance to clamp.
    if (!s.isSpot) {
      let lev = parseInt(s.leverage);
      if (!Number.isFinite(lev) || lev < 1) lev = 1;
      const liveMeta = perpsMeta ?? await getPerpsSymbolMeta(s.symbol.split(/[-_/]/)[0]).catch(() => null);
      const cap = liveMeta?.maxLeverage ?? 25;
      if (lev > cap) {
        addLog({ message: `Requested ${lev}× exceeds ${s.symbol} cap ${cap}× — clamping.` });
        lev = cap;
        s.setField('leverage', String(cap));
      }
      if (lev > 0) {
        try { await updatePerpsLeverage(s.symbol, lev, 2); }
        catch (err: unknown) { addLog({ message: `Leverage update skipped: ${getErrorMessage(err)}` }); }
      }
    }

    addLog({ message: `Live mid: ${currentPrice.toFixed(2)} — building ${s.spacing.toLowerCase()} grid` });

    const priceLevels = buildGridLevels(lower, upper, count, s.spacing);
    const levels: GridLevel[] = priceLevels.map((price) => ({ price, status: 'EMPTY' as const }));

    let totalInvested = 0;
    let activeCount = 0;
    for (let i = 0; i < levels.length; i++) {
      if (!runningRef.current) break;
      let side: 'BUY' | 'SELL' | null = null;
      if (s.mode === 'NEUTRAL') {
        if (levels[i].price < currentPrice) side = 'BUY';
        else if (levels[i].price > currentPrice) side = 'SELL';
      } else if (s.mode === 'LONG') {
        if (levels[i].price < currentPrice) side = 'BUY';
      } else if (s.mode === 'SHORT') {
        if (levels[i].price > currentPrice) side = 'SELL';
      }

      if (side) {
        const orderId = await placeGridOrder(levels[i].price, side);
        if (orderId) {
          levels[i] = { ...levels[i], orderId, side, status: 'ACTIVE' };
          activeCount++;
          if (side === 'BUY') totalInvested += levels[i].price * amount;
        }
      }
    }

    gridLevelsRef.current = levels;
    setGridLevels([...levels]);

    s.setField('activeOrders', activeCount);
    s.setField('totalInvestment', totalInvested);
    addLog({ message: `Placed ${activeCount} initial orders across ${count} grid levels` });

    pollRef.current = setInterval(pollOrders, POLL_INTERVAL);
  }, [addLog, fetchLastPrice, placeGridOrder, pollOrders, perpsMeta]);

  /**
   * Watch for the trigger price to be crossed in the configured direction.
   * Lightweight loop — same 10-s cadence as the main poll, no extra
   * outbound traffic because `fetchLastPrice` shares the cached ticker.
   */
  const startArmWatcher = useCallback(() => {
    armedRef.current = true;
    const { gridBot: s } = useBotStore.getState();
    s.setField('status', 'ARMED');
    addLog({
      message: `Armed — waiting for price to ${s.triggerDirection === 'CROSS_UP' ? 'rise above' : 'fall below'} ${s.triggerPrice}`,
    });

    const tick = async () => {
      if (!armedRef.current) return;
      const fresh = useBotStore.getState().gridBot;
      const trigger = parseFloat(fresh.triggerPrice);
      if (!Number.isFinite(trigger) || trigger <= 0) return;
      const mid = await fetchLastPrice();
      if (mid === null) return;
      const prev = prevPriceForCrossRef.current;
      prevPriceForCrossRef.current = mid;
      // Need a previous sample to detect a crossing — first poll just
      // seeds the state.
      if (prev === null) return;
      const crossedUp   = prev <  trigger && mid >= trigger;
      const crossedDown = prev >  trigger && mid <= trigger;
      const fired = (fresh.triggerDirection === 'CROSS_UP' && crossedUp) || (fresh.triggerDirection === 'CROSS_DOWN' && crossedDown);
      if (fired) {
        if (armWatcherRef.current) clearInterval(armWatcherRef.current);
        armWatcherRef.current = null;
        addLog({ message: `Trigger fired (${prev.toFixed(2)} → ${mid.toFixed(2)}). Launching grid…` });
        await launchGrid();
      }
    };
    void tick();
    armWatcherRef.current = setInterval(() => { void tick(); }, POLL_INTERVAL);
  }, [addLog, fetchLastPrice, launchGrid]);

  const doStart = useCallback(async () => {
    if (runningRef.current || armedRef.current) return;
    const { gridBot: s } = useBotStore.getState();
    const lower = parseFloat(s.lowerPrice);
    const upper = parseFloat(s.upperPrice);
    const count = parseInt(s.gridCount);
    const amount = parseFloat(s.amountPerGrid);

    if (
      isNaN(lower) || isNaN(upper) || isNaN(count) || isNaN(amount) ||
      lower >= upper || count < 2 || amount <= 0
    ) {
      toast.error('Invalid grid parameters');
      return;
    }

    s.resetStats();
    setLogs([]);
    addLog({ message: 'Grid Bot starting…' });
    prevPriceForCrossRef.current = null;

    const trigger = parseFloat(s.triggerPrice);
    if (Number.isFinite(trigger) && trigger > 0) {
      startArmWatcher();
    } else {
      await launchGrid();
    }
  }, [addLog, launchGrid, startArmWatcher]);

  const startBot = useCallback(() => {
    if (confirmOrders) setShowConfirm(true);
    else void doStart();
  }, [confirmOrders, doStart]);

  const stopBot = useCallback(async (reason?: string) => {
    runningRef.current = false;
    armedRef.current = false;
    if (pollRef.current)       { clearInterval(pollRef.current); pollRef.current = null; }
    if (armWatcherRef.current) { clearInterval(armWatcherRef.current); armWatcherRef.current = null; }

    const { gridBot: s } = useBotStore.getState();
    const market: 'spot' | 'perps' = s.isSpot ? 'spot' : 'perps';

    addLog({ message: reason ? `Stopping bot — ${reason}` : 'Cancelling all grid orders…' });

    try {
      await cancelAllOrders(s.symbol, market);
      addLog({ message: 'All orders cancelled successfully' });
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      addLog({ message: `ERROR cancelling orders: ${msg}` });
      toast.error(`Grid Bot: ${msg}`);
    }

    s.setField('status', 'STOPPED');
    s.setField('activeOrders', 0);

    gridLevelsRef.current = gridLevelsRef.current.map((l) => ({
      ...l, status: 'EMPTY' as const, orderId: undefined, side: undefined,
    }));
    setGridLevels([...gridLevelsRef.current]);
    addLog({ message: 'Grid Bot stopped' });
  }, [addLog]);

  // Wire the ref so pollOrders / armWatcher can call the latest stopBot.
  useEffect(() => { stopBotRef.current = stopBot; }, [stopBot]);

  useEffect(() => () => {
    runningRef.current = false;
    armedRef.current = false;
    if (pollRef.current)       clearInterval(pollRef.current);
    if (armWatcherRef.current) clearInterval(armWatcherRef.current);
  }, []);

  const isRunning = state.status === 'RUNNING';
  const isArmed = state.status === 'ARMED';
  const isLocked = isRunning || isArmed;

  // ── Live computed previews — drive the right-hand "Estimated metrics"
  //    panel without re-running on every keystroke (memoised on inputs). ──
  const lower = parseFloat(state.lowerPrice) || 0;
  const upper = parseFloat(state.upperPrice) || 0;
  const count = parseInt(state.gridCount) || 0;
  const amount = parseFloat(state.amountPerGrid) || 0;
  const profitPct = useMemo(
    () => profitPerGridPct(lower, upper, count, state.spacing),
    [lower, upper, count, state.spacing],
  );
  const previewLevels = useMemo(
    () => buildGridLevels(lower, upper, count, state.spacing),
    [lower, upper, count, state.spacing],
  );
  const buyLevelCount = state.mode === 'SHORT'
    ? 0
    : Math.max(1, Math.floor(count / 2));
  const investmentEstimate = lower > 0 && upper > 0 && amount > 0
    ? buyLevelCount * amount * ((lower + upper) / 2)
    : 0;
  const profitClearsFee = profitPct >= ROUND_TRIP_FEE_PCT * 1.5;
  const rangePct = lower > 0 && upper > 0 ? ((upper - lower) / ((lower + upper) / 2)) * 100 : 0;

  const buildRiskRows = (): { rows: RiskSummaryRow[]; totalRisk: string; risk: 'Low' | 'Medium' | 'High' } => {
    const tooWide = rangePct > 30;
    const tooNarrow = rangePct < 4 && rangePct > 0;
    const rows: RiskSummaryRow[] = [
      { label: 'Pair', value: state.symbol, hint: state.isSpot ? 'Spot market' : 'Perpetual futures' },
      { label: 'Direction', value: state.mode, tone: state.mode === 'NEUTRAL' ? 'default' : 'warning' },
      { label: 'Spacing', value: state.spacing === 'GEOMETRIC' ? 'Geometric (constant %)' : 'Arithmetic (constant Δ)' },
      ...(!state.isSpot && parseInt(state.leverage) > 1
        ? [{ label: 'Leverage', value: `${state.leverage}×`, tone: parseInt(state.leverage) > 5 ? 'warning' as const : 'default' as const }]
        : []),
      {
        label: 'Price range',
        value: `${lower.toLocaleString()} – ${upper.toLocaleString()}`,
        hint: rangePct > 0 ? `${rangePct.toFixed(1)}% wide` : undefined,
        tone: tooWide || tooNarrow ? 'warning' : 'default',
      },
      {
        label: 'Grid levels',
        value: `${count} levels`,
        hint: profitPct > 0 ? `Profit/grid ≈ ${profitPct.toFixed(3)}%` : undefined,
      },
      {
        label: 'Profit/grid vs fee',
        value: `${profitPct.toFixed(3)}% vs ~${ROUND_TRIP_FEE_PCT.toFixed(2)}% fee`,
        tone: profitClearsFee ? 'positive' as const : 'warning' as const,
        hint: profitClearsFee
          ? 'Each fill clears round-trip fees with margin to spare.'
          : 'Each fill barely clears the fee — increase range or reduce grid count.',
      },
      { label: 'Amount per grid', value: `${amount} ${state.symbol.split(/[_-]/)[0]}` },
      { label: 'Approx. orders placed', value: `${Math.max(0, count - 1)} initial limit orders` },
    ];
    if (state.triggerPrice && parseFloat(state.triggerPrice) > 0) {
      rows.push({
        label: 'Trigger price',
        value: `${state.triggerPrice} (${state.triggerDirection === 'CROSS_UP' ? 'on rise' : 'on drop'})`,
        hint: 'Bot will stay ARMED until price crosses this level.',
      });
    }
    if (state.stopLossPrice && parseFloat(state.stopLossPrice) > 0) {
      rows.push({ label: 'Stop-loss', value: state.stopLossPrice, tone: 'warning' });
    }
    if (state.takeProfitPrice && parseFloat(state.takeProfitPrice) > 0) {
      rows.push({ label: 'Take-profit', value: state.takeProfitPrice, tone: 'positive' });
    }
    if (state.trailingProfitUsd && parseFloat(state.trailingProfitUsd) > 0) {
      rows.push({ label: 'Profit target', value: `$${state.trailingProfitUsd}`, tone: 'positive' });
    }
    if (tooWide) rows.push({ label: 'Heads-up', value: 'Range > 30%', tone: 'warning', hint: 'Wide ranges trade less often.' });
    if (tooNarrow) rows.push({ label: 'Heads-up', value: 'Range < 4%', tone: 'warning', hint: 'Narrow ranges break out frequently.' });

    const lev = parseInt(state.leverage) || 1;
    // High when leverage exceeds half the live cap (e.g. > 12× when BTC's
    // cap is 25). Falls back to "> 5×" when the cap hasn't loaded yet.
    const highLevThreshold = perpsMeta ? Math.max(2, Math.floor(perpsMeta.maxLeverage / 2)) : 5;
    const risk: 'Low' | 'Medium' | 'High' =
      (!state.isSpot && lev > highLevThreshold) || (state.mode !== 'NEUTRAL' && (tooWide || tooNarrow)) ? 'High'
      : (state.mode !== 'NEUTRAL' || tooWide || tooNarrow || lev > 1) ? 'Medium'
      : 'Low';
    const totalRisk = investmentEstimate > 0
      ? `~$${investmentEstimate.toLocaleString(undefined, { maximumFractionDigits: 0 })} max long exposure${lev > 1 ? ` × ${lev} leverage` : ''}`
      : '— (configure parameters)';
    return { rows, totalRisk, risk };
  };
  const riskSummary = buildRiskRows();

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <RiskSummaryModal
        isOpen={showConfirm}
        title="Grid Bot Summary"
        subtitle="Review the run before launch — these parameters cannot be changed while the bot is active."
        rows={riskSummary.rows}
        risk={riskSummary.risk}
        totalRisk={riskSummary.totalRisk}
        disclaimer="The bot will place limit orders at every grid level on start (or after the trigger fires) and re-balance them as fills occur. Stopping the bot cancels all open grid orders."
        confirmLabel="Confirm & Start Bot"
        onConfirm={() => { setShowConfirm(false); void doStart(); }}
        onCancel={() => setShowConfirm(false)}
      />

      {/* ─────────────── Settings Panel ─────────────── */}
      <div className="w-96 border-r border-border bg-surface/30 backdrop-blur-sm flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm">Grid Bot</h2>
          <StatusBadge status={state.status} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* ── Market ── */}
          <Section icon={<Layers size={12} />} label="Market">
            <Input
              label="Symbol"
              type="text"
              value={state.symbol}
              onChange={(e) => state.setField('symbol', e.target.value)}
              disabled={isLocked}
            />
            <div>
              <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1.5">Market type</label>
              <div className="flex gap-2">
                <button
                  onClick={() => { if (!isLocked) { state.setField('isSpot', true); state.setField('symbol', normalizeSymbol(state.symbol, 'spot')); } }}
                  className={cn(
                    'flex-1 py-2 text-xs rounded-lg border transition-all',
                    state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover',
                    isLocked && 'opacity-50 pointer-events-none',
                  )}
                >Spot</button>
                <button
                  onClick={() => { if (!isLocked) { state.setField('isSpot', false); state.setField('symbol', normalizeSymbol(state.symbol, 'perps')); } }}
                  className={cn(
                    'flex-1 py-2 text-xs rounded-lg border transition-all',
                    !state.isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover',
                    isLocked && 'opacity-50 pointer-events-none',
                  )}
                >Perps</button>
              </div>
            </div>
          </Section>

          {/* ── Range & spacing ── */}
          <Section icon={<Grid2X2 size={12} />} label="Range & spacing">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Lower price"
                type="number"
                value={state.lowerPrice}
                onChange={(e) => state.setField('lowerPrice', e.target.value)}
                disabled={isLocked}
              />
              <Input
                label="Upper price"
                type="number"
                value={state.upperPrice}
                onChange={(e) => state.setField('upperPrice', e.target.value)}
                disabled={isLocked}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Grid count"
                type="number"
                value={state.gridCount}
                onChange={(e) => state.setField('gridCount', e.target.value)}
                disabled={isLocked}
                hint="2 – 200 levels"
              />
              <Input
                label="Amount/grid"
                type="number"
                value={state.amountPerGrid}
                onChange={(e) => state.setField('amountPerGrid', e.target.value)}
                disabled={isLocked}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-1.5">Spacing</label>
              <div className="flex gap-2">
                {(['ARITHMETIC','GEOMETRIC'] as const).map((sp) => (
                  <button
                    key={sp}
                    onClick={() => { if (!isLocked) state.setField('spacing', sp); }}
                    className={cn(
                      'flex-1 py-2 text-[11px] rounded-lg border transition-all flex flex-col items-center gap-0.5',
                      state.spacing === sp ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover',
                      isLocked && 'opacity-50 pointer-events-none',
                    )}
                  >
                    <span className="font-semibold uppercase tracking-wider">{sp === 'ARITHMETIC' ? 'Arithmetic' : 'Geometric'}</span>
                    <span className="text-[9px] text-text-muted">{sp === 'ARITHMETIC' ? 'constant Δ' : 'constant %'}</span>
                  </button>
                ))}
              </div>
            </div>
            <Select
              label="Direction (mode)"
              value={state.mode}
              onChange={(e) => state.setField('mode', e.target.value as 'NEUTRAL' | 'LONG' | 'SHORT')}
              disabled={isLocked}
              options={[
                { value: 'NEUTRAL', label: 'Neutral — buys & sells around price' },
                { value: 'LONG', label: 'Long — buys only' },
                { value: 'SHORT', label: 'Short — sells only' },
              ]}
            />
          </Section>

          {/* ── Advanced (leverage + trigger) ── */}
          <Collapsible
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((p) => !p)}
            icon={<Zap size={12} />}
            label="Advanced settings"
            badge={
              (parseInt(state.leverage) > 1 || (state.triggerPrice && parseFloat(state.triggerPrice) > 0))
                ? `${parseInt(state.leverage) > 1 ? `${state.leverage}× lev` : ''}${state.triggerPrice ? `${parseInt(state.leverage) > 1 ? ' · ' : ''}trigger` : ''}`
                : undefined
            }
          >
            {!state.isSpot && (
              <Input
                label="Leverage"
                type="number"
                value={state.leverage}
                onChange={(e) => state.setField('leverage', e.target.value)}
                onBlur={(e) => {
                  // Hard-clamp on blur so we never push a leverage SoDEX
                  // would reject, even if the user typed past the cap.
                  const v = parseInt(e.target.value);
                  if (!Number.isFinite(v) || v < 1) state.setField('leverage', '1');
                  else if (v > leverageCap) state.setField('leverage', String(leverageCap));
                }}
                disabled={isLocked}
                hint={
                  perpsMeta
                    ? `1 – ${leverageCap}× (live cap from SoDEX)`
                    : perpsMetaErr ?? `1 – ${leverageCap}× (resolving cap…)`
                }
              />
            )}
            <Input
              label="Trigger price (optional)"
              type="number"
              value={state.triggerPrice}
              onChange={(e) => state.setField('triggerPrice', e.target.value)}
              disabled={isLocked}
              hint="Bot waits until price crosses this level"
            />
            {state.triggerPrice && parseFloat(state.triggerPrice) > 0 && (
              <Select
                label="Trigger direction"
                value={state.triggerDirection}
                onChange={(e) => state.setField('triggerDirection', e.target.value as 'CROSS_UP' | 'CROSS_DOWN')}
                disabled={isLocked}
                options={[
                  { value: 'CROSS_UP', label: 'Activate on rise above trigger' },
                  { value: 'CROSS_DOWN', label: 'Activate on drop below trigger' },
                ]}
              />
            )}
          </Collapsible>

          {/* ── Stop conditions ── */}
          <Collapsible
            open={stopConditionsOpen}
            onToggle={() => setStopConditionsOpen((p) => !p)}
            icon={<ShieldAlert size={12} />}
            label="Stop conditions"
            badge={
              [
                state.stopLossPrice && parseFloat(state.stopLossPrice) > 0 && 'SL',
                state.takeProfitPrice && parseFloat(state.takeProfitPrice) > 0 && 'TP',
                state.trailingProfitUsd && parseFloat(state.trailingProfitUsd) > 0 && '$ tgt',
              ].filter(Boolean).join(' · ') || undefined
            }
          >
            <Input
              label="Stop-loss price"
              type="number"
              value={state.stopLossPrice}
              onChange={(e) => state.setField('stopLossPrice', e.target.value)}
              disabled={isLocked}
              hint="Cancels & exits if price falls here"
            />
            <Input
              label="Take-profit price"
              type="number"
              value={state.takeProfitPrice}
              onChange={(e) => state.setField('takeProfitPrice', e.target.value)}
              disabled={isLocked}
              hint="Cancels & exits if price rises here"
            />
            <Input
              label="Profit target ($)"
              type="number"
              value={state.trailingProfitUsd}
              onChange={(e) => state.setField('trailingProfitUsd', e.target.value)}
              disabled={isLocked}
              hint="Stops once realised PnL reaches this"
            />
          </Collapsible>

          {/* ── Live preview card ── */}
          <div className="rounded-xl border border-border bg-background/40 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              <Target size={10} /> Live preview
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <PreviewRow label="Profit/grid"   value={`${profitPct.toFixed(3)}%`} tone={profitClearsFee ? 'good' : 'warn'} />
              <PreviewRow label="Range"         value={`${rangePct.toFixed(1)}%`} tone={rangePct === 0 ? 'mute' : (rangePct > 30 || rangePct < 4) ? 'warn' : 'good'} />
              <PreviewRow label="Levels"        value={`${count}`} tone="mute" />
              <PreviewRow label="Est. capital"  value={investmentEstimate > 0 ? `$${Math.round(investmentEstimate).toLocaleString()}` : '—'} tone="mute" />
              <PreviewRow label="Last price"    value={lastPrice ? lastPrice.toFixed(2) : '—'} tone="mute" />
              <PreviewRow label="Spacing"       value={state.spacing === 'GEOMETRIC' ? 'Geo' : 'Arith'} tone="mute" />
            </div>
            {!profitClearsFee && profitPct > 0 && (
              <div className="flex items-start gap-1.5 mt-1 text-[10px] text-amber-300">
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                <span>Profit/grid is below 1.5× the round-trip fee — fills may be unprofitable. Widen the range or reduce grid count.</span>
              </div>
            )}
            {previewLevels.length > 0 && previewLevels.length <= 30 && (
              <div className="flex flex-wrap gap-0.5 mt-1">
                {previewLevels.map((p, i) => (
                  <span
                    key={i}
                    className="text-[9px] tabular-nums px-1 py-0.5 rounded bg-white/5 text-text-muted"
                    title={`Level ${i + 1}: ${p.toFixed(2)}`}
                  >{p.toFixed(0)}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border bg-background/40">
          {!isLocked ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={startBot}>
              Start Bot
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={() => stopBot()}>
              {isArmed ? 'Cancel (waiting)' : 'Stop'}
            </Button>
          )}
        </div>
      </div>

      {/* ─────────────── Live status ─────────────── */}
      <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
        <BotPnlStrip botKey="grid" />

        {/* Status banners */}
        {isArmed && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-200 text-xs">
            <Info size={14} />
            <span>
              Armed — waiting for last price to {state.triggerDirection === 'CROSS_UP' ? 'rise above' : 'drop below'} <strong>{state.triggerPrice}</strong>.
              Live mid: {lastPrice ? lastPrice.toFixed(2) : '…'}
            </span>
          </div>
        )}

        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Active orders"   value={<NumberDisplay value={state.activeOrders} decimals={0} />} icon={<Layers size={16} />} />
          <StatCard label="Total invested"  value={<NumberDisplay value={state.totalInvestment} prefix="$" />} icon={<DollarSign size={16} />} />
          <StatCard label="Completed grids" value={<NumberDisplay value={state.completedGrids} decimals={0} />} icon={<CheckCircle2 size={16} />} />
          <StatCard
            label="Realized PnL"
            value={<NumberDisplay value={state.realizedPnl} prefix="$" trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'} />}
            icon={<TrendingUp size={16} />}
            trend={state.realizedPnl >= 0 ? (state.realizedPnl > 0 ? 'up' : 'neutral') : 'down'}
          />
        </div>

        {/* Grid Levels */}
        <div className="glass-card flex flex-col overflow-hidden p-0" style={{ maxHeight: '260px' }}>
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Grid Levels</span>
            <span className="badge badge-primary">
              <Grid2X2 size={10} />
              {gridLevels.filter((l) => l.status === 'ACTIVE').length} active
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {gridLevels.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {[...gridLevels].reverse().map((level, i) => {
                  const pct = gridLevels.length > 1
                    ? ((level.price - gridLevels[0].price) / (gridLevels[gridLevels.length - 1].price - gridLevels[0].price)) * 100
                    : 50;
                  return (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono rounded-lg hover:bg-surface-hover/50 transition-colors group">
                      <span className="w-24 tabular-nums text-text-primary">{level.price.toFixed(2)}</span>
                      {level.side ? (
                        <span className={`badge ${level.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{level.side}</span>
                      ) : (
                        <span className="w-12 text-text-muted">—</span>
                      )}
                      <div className="flex-1 h-1.5 bg-background rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            level.status === 'ACTIVE' ? 'bg-primary/60' :
                            level.status === 'FILLED' ? 'bg-success/60' :
                            'bg-border'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={`text-[10px] font-sans ${
                        level.status === 'ACTIVE' ? 'text-primary' :
                        level.status === 'FILLED' ? 'text-success' :
                        'text-text-muted'
                      }`}>
                        {level.status === 'ACTIVE' ? '● Active' :
                         level.status === 'FILLED' ? '✓ Filled' :
                         '○ Empty'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center text-text-muted pt-6 text-sm">
                Grid levels will appear here once the bot starts.
              </div>
            )}
          </div>
        </div>

        {/* Logs */}
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
                {log.message && <span className="text-text-secondary truncate">{log.message}</span>}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                Bot activity logs will appear here.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Local presentational helpers
// ──────────────────────────────────────────────────────────────────────

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}
const Section: React.FC<SectionProps> = ({ icon, label, children }) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
      {icon}<span>{label}</span>
    </div>
    {children}
  </div>
);

interface CollapsibleProps {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  children: React.ReactNode;
}
const Collapsible: React.FC<CollapsibleProps> = ({ open, onToggle, icon, label, badge, children }) => (
  <div className="rounded-xl border border-border bg-background/30">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
    >
      <span className="flex items-center gap-1.5">{icon}{label}</span>
      <span className="flex items-center gap-2">
        {badge && <span className="text-[10px] font-mono normal-case tracking-normal text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-full px-2 py-0.5">{badge}</span>}
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </span>
    </button>
    {open && <div className="border-t border-border p-3 flex flex-col gap-3">{children}</div>}
  </div>
);

const PreviewRow: React.FC<{ label: string; value: string; tone: 'good' | 'warn' | 'mute' }> = ({ label, value, tone }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-text-muted">{label}</span>
    <span className={cn(
      'font-mono font-semibold',
      tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : 'text-text-primary',
    )}>
      {value}
    </span>
  </div>
);
