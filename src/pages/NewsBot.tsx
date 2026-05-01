import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, Zap, RefreshCw, Settings2, TrendingUp, TrendingDown, AlertCircle, X as XIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  fetchSosoNews,
  fetchSosoNewsByCurrency,
  fetchSosoCoins,
  NEWS_CATEGORIES,
  getNewsTitle,
  extractCoinFromNews,
} from '../api/sosoServices';
import type { SosoCoin, SosoNewsItem } from '../api/sosoServices';
import { placeOrder, fetchTickers, getPerpsSymbolMeta, updatePerpsLeverage, type PerpsSymbolMeta } from '../api/services';
import { useSettingsStore } from '../store/settingsStore';
import { useBotPnlStore } from '../store/botPnlStore';
import { Card } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { cn, getErrorMessage } from '../lib/utils';
import { analyzeSentiment } from '../api/geminiClient';

interface LogEntry {
  time: string;
  type: 'info' | 'trade' | 'error';
  message: string;
}

interface TriggerRule {
  keyword: string;
  side: 'BUY' | 'SELL';
  category: number; // 0 = any
}

const DEFAULT_RULES: TriggerRule[] = [
  { keyword: 'ETF approved', side: 'BUY', category: 0 },
  { keyword: 'SEC reject', side: 'SELL', category: 0 },
  { keyword: 'halving', side: 'BUY', category: 0 },
  { keyword: 'hack', side: 'SELL', category: 0 },
];

// 5-minute poll cadence — tight enough to react to breaking news within
// the same news cycle, slack enough to stay well under SoSoValue's free
// tier limits (worst case: 12 fetches/hour vs the 20+ we saw on 3-min).
const POLL_MS = 5 * 60_000;
const TRIGGER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_IDS = 2000;
const AI_TIMEOUT_MS = 8000;
const AI_RETRIES = 2;
// Throttle for the manual "Poll" button so spamming it can't burn through
// the SoSoValue / Gemini budget on a whim.
const MANUAL_POLL_MIN_INTERVAL_MS = 30_000;
// Hard cap on Gemini sentiment classifications per polling cycle. The
// first poll after a fresh start often sees 5–10 brand-new headlines;
// without this cap we'd burn 10 Gemini calls in one tick.
const SENTIMENT_PER_POLL_LIMIT = 5;

// ── Trade-management defaults ──────────────────────────────────────────────
// Sane starting values for a news-spike scalp on a perp. The user can
// override every one of these in the UI; only the leverage cap is hard.
//
// Margin is the collateral the user actually puts up out of their
// wallet. Effective exposure = margin × leverage. So a 10 USDT margin
// at 10× opens a 100 USDT position — which means 10× the airdrop
// volume per trade vs treating the same number as raw notional.
const DEFAULT_MARGIN_USDT    = '10';
const DEFAULT_LEVERAGE       = 5;
const DEFAULT_HOLD_MINUTES   = 3;
const DEFAULT_TP_PCT         = 1.5;
const DEFAULT_SL_PCT         = 0.8;
const DEFAULT_FALLBACK_COIN  = 'BTC';
// Position monitor cadence. Hits the cached fetchTickers() so cost is
// effectively one network round-trip per 30s regardless of how many
// open positions exist.
const POSITION_TRACK_MS      = 15_000;
// Lower bound on the leverage slider. The upper bound is dynamic —
// derived from getPerpsSymbolMeta(fallbackCoin) so it always reflects
// the exchange's actual per-symbol cap (BTC may allow 25× while alts
// cap at 10×, etc.). Until the first metadata fetch resolves we use
// a conservative initial cap so the slider isn't accidentally usable
// at a value SoDEX would reject.
const LEVERAGE_MIN = 1;
const LEVERAGE_INITIAL_CAP = 10;

interface NewsBotPosition {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  leverage: number;
  openedAt: number;
  tpPrice: number;
  slPrice: number;
  expiresAt: number;
  triggerHeadline: string;
  triggerKeyword: string;
  lastPrice: number;     // updated each tracker tick for live PnL display
}

async function analyzeSentimentWithTimeout(title: string, timeoutMs = AI_TIMEOUT_MS): Promise<'BULLISH' | 'BEARISH' | 'NEUTRAL'> {
  return Promise.race([
    analyzeSentiment(title),
    new Promise<'BULLISH' | 'BEARISH' | 'NEUTRAL'>((_, reject) =>
      setTimeout(() => reject(new Error('AI sentiment timeout')), timeoutMs),
    ),
  ]);
}

async function analyzeSentimentWithRetry(title: string): Promise<'BULLISH' | 'BEARISH' | 'NEUTRAL'> {
  let lastError: unknown;
  for (let attempt = 0; attempt < AI_RETRIES; attempt++) {
    try {
      return await analyzeSentimentWithTimeout(title);
    } catch (err) {
      lastError = err;
      if (attempt === AI_RETRIES - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AI sentiment failed');
}

export const NewsBot: React.FC = () => {
  const { sosoApiKey, privateKey, geminiApiKey } = useSettingsStore();

  const [running, setRunning] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [rules, setRules] = useState<TriggerRule[]>(DEFAULT_RULES);
  const [newKeyword, setNewKeyword] = useState('');
  const [newSide, setNewSide] = useState<'BUY' | 'SELL'>('BUY');
  const [newCat, setNewCat] = useState(0);
  // ── Trade execution settings (per-trade risk knobs) ────────────────────
  // Margin = collateral pulled from wallet. Position size on the book =
  // marginUsdt × leverage. The other knobs (TP%, SL%, hold time, fallback
  // coin) work on top of that resolved position size.
  const [marginUsdt,   setMarginUsdt]   = useState(DEFAULT_MARGIN_USDT);
  const [leverage,     setLeverage]     = useState<number>(DEFAULT_LEVERAGE);
  const [holdMinutes,  setHoldMinutes]  = useState<number>(DEFAULT_HOLD_MINUTES);
  const [takeProfitPct,setTakeProfitPct]= useState<number>(DEFAULT_TP_PCT);
  const [stopLossPct,  setStopLossPct]  = useState<number>(DEFAULT_SL_PCT);
  const [fallbackCoin, setFallbackCoin] = useState<string>(DEFAULT_FALLBACK_COIN);

  const [coins, setCoins] = useState<SosoCoin[]>([]);
  const [filterCoin, setFilterCoin] = useState<string>(''); // SoSoValue currencyId
  const [openPositions, setOpenPositions] = useState<NewsBotPosition[]>([]);
  const [triggeredIds] = useState(() => new Map<string, number>());

  // Resolved metadata for the currently-selected fallback coin so the
  // slider's max + 'cap' label always reflect the real exchange limit.
  // null = lookup pending or symbol not listed.
  const [fallbackMeta, setFallbackMeta] = useState<PerpsSymbolMeta | null>(null);
  const [fallbackMetaErr, setFallbackMetaErr] = useState<string | null>(null);
  const effectiveLeverageCap = fallbackMeta?.maxLeverage ?? LEVERAGE_INITIAL_CAP;

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const useAiRef = useRef(false); // needed for closure in interval
  const pollInFlightRef = useRef(false);
  const lastManualPollRef = useRef(0);

  // Track every user-tunable trade param in a ref so executeTrade() can
  // read the latest value without being recreated each render.
  const filterCoinRef    = useRef('');
  const marginRef        = useRef(DEFAULT_MARGIN_USDT);
  const leverageRef      = useRef<number>(DEFAULT_LEVERAGE);
  const holdMinutesRef   = useRef<number>(DEFAULT_HOLD_MINUTES);
  const takeProfitPctRef = useRef<number>(DEFAULT_TP_PCT);
  const stopLossPctRef   = useRef<number>(DEFAULT_SL_PCT);
  const fallbackCoinRef  = useRef<string>(DEFAULT_FALLBACK_COIN);
  const openPositionsRef = useRef<NewsBotPosition[]>([]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs((prev) => [
      { time: new Date().toLocaleTimeString(), type, message },
      ...prev,
    ].slice(0, 100));
  }, []);

  // Load coins for filter dropdown
  useEffect(() => {
    if (sosoApiKey) {
      fetchSosoCoins().then(setCoins).catch(() => {});
    }
  }, [sosoApiKey]);

  // Keep refs synced with their state counterparts so callbacks always read
  // the freshest user input without invalidating themselves on each change.
  useEffect(() => { filterCoinRef.current    = filterCoin;    }, [filterCoin]);
  useEffect(() => { marginRef.current        = marginUsdt;    }, [marginUsdt]);
  useEffect(() => { leverageRef.current      = leverage;      }, [leverage]);
  useEffect(() => { holdMinutesRef.current   = holdMinutes;   }, [holdMinutes]);
  useEffect(() => { takeProfitPctRef.current = takeProfitPct; }, [takeProfitPct]);
  useEffect(() => { stopLossPctRef.current   = stopLossPct;   }, [stopLossPct]);
  useEffect(() => { fallbackCoinRef.current  = fallbackCoin;  }, [fallbackCoin]);
  useEffect(() => { openPositionsRef.current = openPositions; }, [openPositions]);

  // Whenever the fallback coin changes, re-resolve its SoDEX metadata so
  // the leverage slider can clamp to the exchange's actual cap. We also
  // pull the slider value down if it now exceeds the new cap.
  useEffect(() => {
    let cancelled = false;
    const ticker = fallbackCoin.trim().toUpperCase();
    if (!ticker) {
      setFallbackMeta(null);
      setFallbackMetaErr(null);
      return;
    }
    setFallbackMetaErr(null);
    void (async () => {
      const meta = await getPerpsSymbolMeta(ticker).catch(() => null);
      if (cancelled) return;
      setFallbackMeta(meta);
      if (!meta) {
        setFallbackMetaErr(`${ticker} not listed on SoDEX perps`);
        return;
      }
      // Pull slider down if user-set leverage now exceeds exchange cap.
      if (leverage > meta.maxLeverage) setLeverage(meta.maxLeverage);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackCoin]);

  const matchesRules = useCallback((item: SosoNewsItem): TriggerRule | null => {
    const title = getNewsTitle(item).toLowerCase();
    for (const rule of rules) {
      if (!rule.keyword) continue;
      if (!title.includes(rule.keyword.toLowerCase())) continue;
      if (rule.category !== 0 && item.category !== rule.category) continue;
      return rule;
    }
    return null;
  }, [rules]);

  /**
   * Resolve a ticker ("BTC") to its full SoDEX perps metadata (symbol +
   * leverage caps). Returns null when no compatible market is listed
   * — the caller logs and skips the trade. Wraps getPerpsSymbolMeta()
   * so callers don't need to import it everywhere.
   */
  const resolvePerpsMeta = useCallback(async (ticker: string): Promise<PerpsSymbolMeta | null> => {
    try { return await getPerpsSymbolMeta(ticker); }
    catch { return null; }
  }, []);

  /**
   * Look up the latest mark/last price for a perps symbol via the
   * (cached) ticker payload. Returns 0 on any failure so callers can
   * safely guard against that sentinel.
   */
  const fetchSymbolPrice = useCallback(async (symbol: string): Promise<number> => {
    try {
      const tickers = await fetchTickers('perps') as Record<string, unknown>[];
      const row = tickers.find((t) => String(t.symbol ?? '').toUpperCase() === symbol.toUpperCase());
      const price = parseFloat(String(row?.lastPrice ?? row?.markPrice ?? row?.lastPx ?? 0));
      return Number.isFinite(price) && price > 0 ? price : 0;
    } catch { return 0; }
  }, []);

  /**
   * Close a single managed position with a reduce-only market order.
   * Removes it from `openPositions` on success, surfaces the realised
   * PnL in the activity log.
   */
  const closeManagedPosition = useCallback(async (pos: NewsBotPosition, reason: string): Promise<void> => {
    try {
      await placeOrder(
        {
          symbol: pos.symbol,
          side: pos.side === 'LONG' ? 2 : 1,   // opposite
          type: 2,                              // MARKET
          quantity: pos.qty.toString(),
          reduceOnly: true,
        },
        'perps',
      );
      const exitPrice = pos.lastPrice > 0 ? pos.lastPrice : pos.entryPrice;
      const pnlPct = pos.side === 'LONG'
        ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
      const pnlLeveraged = pnlPct * pos.leverage;
      // Convert leveraged-% PnL into a USDT figure using the position's
      // notional × leverage relationship: PnL% (leveraged) is already
      // expressed against the user's margin, so we multiply by margin
      // (= qty × entryPrice ÷ leverage) to get the USD result.
      const margin = (pos.qty * pos.entryPrice) / Math.max(1, pos.leverage);
      const pnlUsdt = (pnlLeveraged / 100) * margin;
      useBotPnlStore.getState().recordTrade('news', {
        pnlUsdt,
        ts: Date.now(),
        note: `${pos.side} ${pos.symbol} closed (${reason})`,
      });
      addLog('trade', `🏁 Closed ${pos.side} ${pos.qty.toFixed(4)} ${pos.symbol} @ ${exitPrice.toFixed(4)} (${reason}) — PnL ${pnlLeveraged >= 0 ? '+' : ''}${pnlLeveraged.toFixed(2)}% (leveraged) ${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT`);
      setOpenPositions((prev) => prev.filter((p) => p.id !== pos.id));
    } catch (err) {
      addLog('error', `❌ Close failed for ${pos.symbol}: ${getErrorMessage(err)}`);
    }
  }, [addLog]);

  const executeTrade = useCallback(async (rule: TriggerRule, item: SosoNewsItem) => {
    const title = getNewsTitle(item);
    if (!privateKey) {
      addLog('error', 'No wallet configured — set Private Key in Settings');
      return;
    }

    // 1. Resolve the coin from the headline (with the user's fallback).
    const ticker = extractCoinFromNews(title, fallbackCoinRef.current);
    addLog('info', `� Trigger "${rule.keyword}" on ${ticker} — "${title.slice(0, 60)}"`);

    // 2. Map ticker → SoDEX perps metadata (symbol + leverage caps).
    const meta = await resolvePerpsMeta(ticker);
    if (!meta) {
      addLog('error', `${ticker} not listed on SoDEX perps — skipping`);
      return;
    }
    const symbol = meta.symbol;

    // 3. Fetch latest price + sanity-check user inputs.
    const price = await fetchSymbolPrice(symbol);
    if (price <= 0) {
      addLog('error', `Price unavailable for ${symbol} — skipping`);
      return;
    }
    const margin = parseFloat(marginRef.current);
    if (!Number.isFinite(margin) || margin <= 0) {
      addLog('error', `Invalid margin "${marginRef.current}" — set a positive USDT amount`);
      return;
    }
    // Clamp the user's leverage to the symbol's actual exchange cap.
    // Prevents the order from getting rejected at submission time when
    // the slider was set against a different coin's cap, or when the
    // article-derived ticker has a tighter cap than the fallback coin.
    const requested = Math.max(LEVERAGE_MIN, leverageRef.current | 0);
    const lev = Math.min(requested, meta.maxLeverage);
    if (lev < requested) {
      addLog('info', `ℹ ${symbol} caps leverage at ${meta.maxLeverage}× — using ${lev}× instead of ${requested}×`);
    }

    // Effective position size = margin × leverage. This is the notional
    // exposure the order book actually sees — the user only puts up
    // `margin` from their wallet as collateral.
    const positionUsdt = margin * lev;
    // qty rounded to 4 decimals — conservative for most SoDEX step sizes;
    // the server may re-round inside placePerpsOrder.
    const qty = Math.max(0.0001, +(positionUsdt / price).toFixed(4));
    const side = rule.side; // 'BUY' or 'SELL'

    try {
      // 4. Set leverage best-effort (server rejects when there's an open
      //    position on the same symbol; we surface and continue).
      try {
        await updatePerpsLeverage(symbol, lev, 2);
      } catch (e) {
        addLog('info', `ℹ Leverage set skipped for ${symbol}: ${getErrorMessage(e)}`);
      }

      // 5. Open the position.
      await placeOrder(
        { symbol, side: side === 'BUY' ? 1 : 2, type: 2, quantity: qty.toString() },
        'perps',
      );

      // 6. Register it for the tracker so TP/SL/time-exit fire.
      const tpMul = side === 'BUY' ? 1 + takeProfitPctRef.current / 100 : 1 - takeProfitPctRef.current / 100;
      const slMul = side === 'BUY' ? 1 - stopLossPctRef.current   / 100 : 1 + stopLossPctRef.current   / 100;
      const newPos: NewsBotPosition = {
        id: `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        side: side === 'BUY' ? 'LONG' : 'SHORT',
        qty,
        entryPrice: price,
        leverage: lev,
        openedAt: Date.now(),
        tpPrice: price * tpMul,
        slPrice: price * slMul,
        expiresAt: Date.now() + holdMinutesRef.current * 60_000,
        triggerHeadline: title,
        triggerKeyword: rule.keyword,
        lastPrice: price,
      };
      setOpenPositions((prev) => [...prev, newPos]);

      addLog(
        'trade',
        `🚀 ${newPos.side} ${qty.toFixed(4)} ${symbol} @ ${price.toFixed(4)} — ${margin.toFixed(2)} USDT margin × ${lev}× = ${positionUsdt.toFixed(2)} USDT position — TP +${takeProfitPctRef.current}% / SL −${stopLossPctRef.current}% / hold ${holdMinutesRef.current}m`,
      );
      toast.success(`${newPos.side} ${symbol} opened`);
    } catch (err) {
      const msg = getErrorMessage(err);
      addLog('error', `❌ Order failed: ${msg}`);
      toast.error(`News Bot: ${msg}`);
    }
  }, [privateKey, addLog, resolvePerpsMeta, fetchSymbolPrice]);

  const poll = useCallback(async () => {
    if (!runningRef.current) return;
    if (pollInFlightRef.current) {
      addLog('info', 'Previous poll still running, skipping this cycle');
      return;
    }
    pollInFlightRef.current = true;
    addLog('info', 'Checking latest news...');
    try {
      const now = Date.now();
      for (const [id, ts] of triggeredIds.entries()) {
        if (now - ts > TRIGGER_TTL_MS) triggeredIds.delete(id);
      }
      if (triggeredIds.size > MAX_TRACKED_IDS) {
        const sorted = [...triggeredIds.entries()].sort((a, b) => a[1] - b[1]);
        for (const [id] of sorted.slice(0, triggeredIds.size - MAX_TRACKED_IDS)) {
          triggeredIds.delete(id);
        }
      }

      const activeFilter = filterCoinRef.current;
      const result = activeFilter
        ? await fetchSosoNewsByCurrency(activeFilter, 1, 10)
        : await fetchSosoNews(1, 10);

      const items = result.list || [];
      let processes = 0;
      let sentimentCallsThisPoll = 0;

      for (const item of items) {
        if (triggeredIds.has(item.id)) continue;
        triggeredIds.set(item.id, now);
        const title = getNewsTitle(item);

        if (useAiRef.current) {
          if (sentimentCallsThisPoll >= SENTIMENT_PER_POLL_LIMIT) {
            addLog('info', `⚡ Sentiment quota reached (${SENTIMENT_PER_POLL_LIMIT}/poll) — skipping remaining headlines this cycle`);
            break;
          }
          sentimentCallsThisPoll++;
          addLog('info', `🤖 Analyzing with AI: "${title.slice(0, 40)}..."`);
          try {
            const sentiment = await analyzeSentimentWithRetry(title);
            if (sentiment === 'BULLISH') {
              await executeTrade({ keyword: 'AI_BULLISH', side: 'BUY', category: 0 }, item);
            } else if (sentiment === 'BEARISH') {
              await executeTrade({ keyword: 'AI_BEARISH', side: 'SELL', category: 0 }, item);
            } else {
              addLog('info', `◈ Sentiment: Neutral — Ignoring`);
            }
          } catch (err) {
            addLog('error', `AI Error: ${getErrorMessage(err)}`);
          }
        } else {
          const rule = matchesRules(item);
          if (rule) {
            await executeTrade(rule, item);
          }
        }
        processes++;
      }
      
      if (processes === 0) addLog('info', `No new headlines found`);
    } catch (err) {
      addLog('error', `Poll error: ${getErrorMessage(err)}`);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [matchesRules, executeTrade, addLog, triggeredIds]);

  // Keep the filterCoin ref synced with state so `poll` always sees the
  // current selection without the surrounding callback being recreated.
  useEffect(() => { filterCoinRef.current = filterCoin; }, [filterCoin]);

  // Manual "Poll" button — throttled to prevent spam from melting our
  // SoSoValue / Gemini quotas. Uses the same poll() under the hood.
  const manualPoll = useCallback(() => {
    const now = Date.now();
    const since = now - lastManualPollRef.current;
    if (since < MANUAL_POLL_MIN_INTERVAL_MS) {
      const wait = Math.ceil((MANUAL_POLL_MIN_INTERVAL_MS - since) / 1000);
      addLog('info', `⏱ Manual poll throttled — wait ${wait}s before retrying`);
      return;
    }
    lastManualPollRef.current = now;
    void poll();
  }, [poll, addLog]);

  const start = useCallback(() => {
    if (!sosoApiKey) { toast.error('Set SosoValue API key in Settings'); return; }
    if (useAi && !geminiApiKey) { toast.error('Set Gemini API key in Settings for AI mode'); return; }
    if (!useAi && rules.length === 0) { toast.error('Add at least one trigger rule'); return; }
    
    runningRef.current = true;
    useAiRef.current = useAi;
    setRunning(true);
    addLog('info', `▶ Bot started (${useAi ? 'AI Sentiment' : 'Keyword'} mode) — polling every ${Math.round(POLL_MS / 1000)}s`);

    // Silent bootstrap: snapshot whatever headlines are CURRENTLY showing
    // and stamp them as "already seen" so the bot only reacts to genuinely
    // new news from this point onward. Without this, an AI-mode start
    // could fire 5–10 Gemini classifications in a burst on the very first
    // poll just because the trackedId set was empty.
    void (async () => {
      try {
        const activeFilter = filterCoinRef.current;
        const seed = activeFilter
          ? await fetchSosoNewsByCurrency(activeFilter, 1, 10)
          : await fetchSosoNews(1, 10);
        const seedItems = seed.list ?? [];
        const now = Date.now();
        for (const it of seedItems) triggeredIds.set(it.id, now);
        addLog('info', `Bootstrapped with ${seedItems.length} existing headlines — will only react to news posted from now on`);
      } catch {
        // Quiet fail: the next scheduled poll will surface any real error.
      }
    })();

    // First real poll runs after POLL_MS — by then any new headline is
    // genuinely new relative to the bootstrap snapshot.
    pollRef.current = setInterval(poll, POLL_MS);
  }, [sosoApiKey, geminiApiKey, useAi, rules, poll, addLog, triggeredIds]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (pollRef.current) clearInterval(pollRef.current);
    const remaining = openPositionsRef.current.length;
    if (remaining > 0) {
      addLog('info', `■ Bot stopped — ${remaining} open position(s) will continue to be monitored for TP/SL/time-exit`);
    } else {
      addLog('info', '■ Bot stopped');
    }
  }, [addLog]);

  // Position tracker — polls once every POSITION_TRACK_MS while there is
  // at least one managed open position. Each tick fetches the (cached)
  // perps tickers, updates `lastPrice` for the live PnL display, and
  // closes any position whose TP / SL / hold-time exit condition has
  // fired. Runs independently of the news-poll loop so positions remain
  // watched even after the bot is stopped.
  useEffect(() => {
    if (openPositions.length === 0) {
      if (trackerRef.current) { clearInterval(trackerRef.current); trackerRef.current = null; }
      return;
    }
    const tick = async () => {
      try {
        const tickers = await fetchTickers('perps') as Record<string, unknown>[];
        const tickerBySymbol = new Map<string, Record<string, unknown>>();
        for (const t of tickers) tickerBySymbol.set(String(t.symbol ?? '').toUpperCase(), t);

        const now = Date.now();
        const updates: NewsBotPosition[] = [];
        const toClose: { pos: NewsBotPosition; reason: string }[] = [];
        for (const pos of openPositionsRef.current) {
          const row = tickerBySymbol.get(pos.symbol.toUpperCase());
          const px  = parseFloat(String(row?.lastPrice ?? row?.markPrice ?? row?.lastPx ?? 0));
          const lastPrice = Number.isFinite(px) && px > 0 ? px : pos.lastPrice;
          updates.push({ ...pos, lastPrice });

          if (pos.side === 'LONG'  && lastPrice >= pos.tpPrice) toClose.push({ pos, reason: `TP +${takeProfitPctRef.current}%` });
          else if (pos.side === 'SHORT' && lastPrice <= pos.tpPrice) toClose.push({ pos, reason: `TP +${takeProfitPctRef.current}%` });
          else if (pos.side === 'LONG'  && lastPrice <= pos.slPrice) toClose.push({ pos, reason: `SL −${stopLossPctRef.current}%` });
          else if (pos.side === 'SHORT' && lastPrice >= pos.slPrice) toClose.push({ pos, reason: `SL −${stopLossPctRef.current}%` });
          else if (now >= pos.expiresAt)                              toClose.push({ pos, reason: `${holdMinutesRef.current}m hold expired` });
        }
        // Update lastPrice for every still-open position in a single render.
        setOpenPositions(updates);
        // Sequentially fire close orders so we don't slam the exchange.
        for (const { pos, reason } of toClose) {
          await closeManagedPosition(pos, reason);
        }
      } catch (err) {
        addLog('error', `Tracker error: ${getErrorMessage(err)}`);
      }
    };
    void tick();
    trackerRef.current = setInterval(() => { void tick(); }, POSITION_TRACK_MS);
    return () => {
      if (trackerRef.current) { clearInterval(trackerRef.current); trackerRef.current = null; }
    };
  }, [openPositions.length, closeManagedPosition, addLog]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (trackerRef.current) clearInterval(trackerRef.current);
  }, []);

  const addRule = () => {
    if (!newKeyword.trim()) return;
    setRules((prev) => [...prev, { keyword: newKeyword.trim(), side: newSide, category: newCat }]);
    setNewKeyword('');
  };

  const removeRule = (idx: number) => setRules((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div className="flex h-[calc(100vh-52px)] overflow-hidden gap-4 p-5">
      {/* Config panel */}
      <div className="w-80 shrink-0 space-y-4 overflow-y-auto">
        {/* Live PnL strip — shows live aggregate of every News Bot close */}
        <BotPnlStrip botKey="news" compact />
        {/* Status */}
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Zap size={15} className={cn('text-primary', running && 'animate-pulse')} />
              <h3 className="text-sm font-semibold">News Trading Bot</h3>
            </div>
            <span className={cn(
              'text-[10px] font-semibold px-2 py-0.5 rounded-full',
              running ? 'text-success bg-success/10' : 'text-text-muted bg-surface',
            )}>
              {running ? 'LIVE' : 'IDLE'}
            </span>
          </div>

          {!sosoApiKey && (
            <div className="flex items-start gap-2 p-2 bg-danger/5 border border-danger/20 rounded-lg mb-3 text-[10px] text-danger">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              SosoValue API key required
            </div>
          )}

          {/* Mode Toggle */}
          <div className="flex items-center justify-between mb-4 p-2 bg-surface rounded-lg">
            <div className="flex items-center gap-2">
              <div className={cn(
                'w-2 h-2 rounded-full',
                useAi ? 'bg-gradient-to-tr from-blue-500 to-purple-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'bg-text-muted'
              )} />
              <span className="text-xs font-medium">{useAi ? 'Gemini AI Mode' : 'Keyword Mode'}</span>
            </div>
            <button
              disabled={running}
              onClick={() => setUseAi(!useAi)}
              className={cn(
                'w-9 h-5 rounded-full transition-colors relative flex items-center',
                useAi ? 'bg-primary' : 'bg-border',
                running && 'opacity-50 cursor-not-allowed'
              )}
            >
              <div className={cn(
                'w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform',
                useAi ? 'translate-x-4.5' : 'translate-x-1'
              )} />
            </button>
          </div>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              icon={running ? <Square size={13} /> : <Play size={13} />}
              variant={running ? 'danger' : 'primary'}
              onClick={running ? stop : start}
            >
              {running ? 'Stop' : 'Start'}
            </Button>
            <Button variant="outline" icon={<RefreshCw size={13} />} onClick={manualPoll} disabled={!running} title={`Manually poll headlines (throttled to once every ${MANUAL_POLL_MIN_INTERVAL_MS / 1000}s)`}>
              Poll
            </Button>
          </div>
        </Card>

        {/* Trade settings — risk knobs only. Symbol is auto-derived from
            the news headline; quantity is derived from notional + price. */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Settings2 size={14} className="text-primary" />
            <h3 className="text-sm font-semibold">Trade Settings</h3>
            <span className="ml-auto text-[9px] text-text-muted uppercase tracking-wider">Perps · auto-coin</span>
          </div>
          <div className="space-y-3">
            <Input
              label="Margin per trade (USDT)"
              type="number"
              min="1"
              step="1"
              value={marginUsdt}
              onChange={(e) => setMarginUsdt(e.target.value)}
              placeholder="10"
            />

            {/* Live exposure preview — makes the margin×leverage relationship
                explicit so the user knows exactly what size order will hit
                the book. The wallet only loses `margin` USDT as collateral. */}
            {(() => {
              const m  = parseFloat(marginUsdt) || 0;
              const lv = Math.min(leverage, effectiveLeverageCap);
              const pos = m * lv;
              return (
                <div className="flex items-center justify-between text-[10px] -mt-1.5 px-1">
                  <span className="text-text-muted">
                    Position size on book
                  </span>
                  <span className="font-mono font-bold text-primary">
                    {m.toFixed(2)} × {lv}× = {pos.toFixed(2)} USDT
                  </span>
                </div>
              );
            })()}

            {/* Leverage slider — hard-bounded by the fallback coin's actual
                exchange cap from getPerpsSymbolMeta(). When the bot opens a
                trade on a different coin (because the headline mentions one)
                executeTrade() re-clamps to that symbol's specific cap. */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-text-muted uppercase tracking-wider font-semibold">Leverage</span>
                <span className="text-xs font-mono font-bold text-primary">{leverage}×</span>
              </div>
              <input
                type="range"
                min={LEVERAGE_MIN}
                max={effectiveLeverageCap}
                step={1}
                value={Math.min(leverage, effectiveLeverageCap)}
                onChange={(e) => setLeverage(parseInt(e.target.value, 10))}
                className="w-full accent-primary"
              />
              <div className="flex items-center justify-between text-[9px] text-text-muted mt-0.5">
                <span>{LEVERAGE_MIN}×</span>
                <span>
                  {fallbackMeta
                    ? <>{fallbackCoin} cap: <span className="text-text-secondary font-semibold">{fallbackMeta.maxLeverage}×</span> · default {fallbackMeta.initLeverage}×</>
                    : fallbackMetaErr
                      ? <span className="text-amber-400">{fallbackMetaErr}</span>
                      : 'Resolving cap from SoDEX…'}
                </span>
                <span>{effectiveLeverageCap}×</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Input
                label="TP %"
                type="number"
                step="0.1"
                value={takeProfitPct}
                onChange={(e) => setTakeProfitPct(parseFloat(e.target.value) || 0)}
              />
              <Input
                label="SL %"
                type="number"
                step="0.1"
                value={stopLossPct}
                onChange={(e) => setStopLossPct(parseFloat(e.target.value) || 0)}
              />
              <Input
                label="Hold (m)"
                type="number"
                step="1"
                value={holdMinutes}
                onChange={(e) => setHoldMinutes(parseInt(e.target.value, 10) || 1)}
              />
            </div>

            <Select
              label="Fallback coin (when headline has no ticker)"
              value={fallbackCoin}
              onChange={(e) => setFallbackCoin(e.target.value.toUpperCase())}
              disabled={isRunning}
              options={[
                { value: 'BTC', label: 'BTC' },
                { value: 'ETH', label: 'ETH' },
                { value: 'SOL', label: 'SOL' },
                { value: 'SOSO', label: 'SOSO' },
              ]}
            />

            <Select
              label="News filter (optional)"
              value={filterCoin}
              onChange={(e) => setFilterCoin(e.target.value)}
              options={[
                { value: '', label: 'All Coins' },
                ...coins.slice(0, 30).map((c) => ({ value: c.id, label: `${c.name.toUpperCase()} — ${c.fullName}` })),
              ]}
            />

            {/* Inline quick-reference — explains how the new auto-pipeline maps
                a headline to a trade so the lack of Symbol / Quantity inputs
                doesn't feel surprising. */}
            <div className="text-[10px] text-text-muted leading-relaxed bg-white/[0.02] rounded-md p-2 border border-white/5">
              <span className="text-primary font-semibold">How it works:</span> headline → ticker (e.g. "SOL ETF approved" → SOL)
              → SoDEX perps symbol → leverage applied → MARKET open with{' '}
              <span className="text-text-secondary">{marginUsdt || 0} USDT</span> margin{' '}
              × <span className="text-text-secondary">{leverage}×</span> ={' '}
              <span className="text-text-secondary">{((parseFloat(marginUsdt) || 0) * leverage).toFixed(2)} USDT</span> position. Auto-closes on{' '}
              <span className="text-emerald-400">+{takeProfitPct}%</span> TP,{' '}
              <span className="text-red-400">−{stopLossPct}%</span> SL, or after{' '}
              <span className="text-text-secondary">{holdMinutes}m</span>.
            </div>
          </div>
        </Card>

        {/* Open Positions — visible only when something is being managed. */}
        {openPositions.length > 0 && (
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} className="text-primary animate-pulse" />
              <h3 className="text-sm font-semibold">Open Positions</h3>
              <span className="ml-auto text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded font-semibold">{openPositions.length}</span>
            </div>
            <div className="space-y-2">
              {openPositions.map((pos) => {
                const livePct = pos.side === 'LONG'
                  ? ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100
                  : ((pos.entryPrice - pos.lastPrice) / pos.entryPrice) * 100;
                const livePctLev = livePct * pos.leverage;
                const remainingMs = Math.max(0, pos.expiresAt - Date.now());
                const remainingS  = Math.ceil(remainingMs / 1000);
                const mm = Math.floor(remainingS / 60);
                const ss = remainingS % 60;
                return (
                  <div
                    key={pos.id}
                    className="p-2.5 bg-surface rounded-lg border border-white/5 space-y-1.5"
                    title={pos.triggerHeadline}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-[10px] font-bold px-1.5 py-0.5 rounded',
                        pos.side === 'LONG' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
                      )}>{pos.side}</span>
                      <span className="text-xs font-mono font-bold">{pos.symbol}</span>
                      <span className="text-[10px] text-text-muted">{pos.leverage}×</span>
                      <button
                        onClick={() => closeManagedPosition(pos, 'manual close')}
                        className="ml-auto text-text-muted hover:text-danger transition-colors p-0.5"
                        title="Close now (reduce-only market)"
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="text-text-muted">{pos.qty.toFixed(4)} @ {pos.entryPrice.toFixed(4)}</span>
                      <span className={cn('font-bold', livePctLev >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {livePctLev >= 0 ? '+' : ''}{livePctLev.toFixed(2)}% (lev)
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-text-muted">
                      <span>TP {pos.tpPrice.toFixed(4)} · SL {pos.slPrice.toFixed(4)}</span>
                      <span>{mm}:{ss.toString().padStart(2, '0')} left</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Trigger Rules */}
        <Card className={cn(useAi && 'opacity-50 pointer-events-none grayscale')}>
          <div className="flex items-center gap-2 mb-4">
            <Zap size={14} className="text-primary" />
            <h3 className="text-sm font-semibold">Trigger Rules</h3>
            {useAi && <span className="text-[10px] text-primary bg-primary/10 px-1.5 py-0.5 rounded">Paused</span>}
          </div>

          <div className="space-y-2 mb-4">
            {rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2 p-2 bg-surface rounded-lg text-xs">
                <span className={cn(
                  'font-semibold px-1.5 py-0.5 rounded text-[10px]',
                  r.side === 'BUY' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
                )}>
                  {r.side}
                </span>
                <span className="flex-1 truncate text-text-secondary">"{r.keyword}"</span>
                {r.category !== 0 && (
                  <span className="text-[9px] text-text-muted">{NEWS_CATEGORIES[r.category]?.label}</span>
                )}
                <button
                  onClick={() => removeRule(i)}
                  className="text-text-muted hover:text-danger transition-colors"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Add new rule */}
          <div className="space-y-2">
            <Input
              label="Keyword"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder='e.g. "ETF approved"'
              onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && addRule()}
            />
            <div className="grid grid-cols-2 gap-2">
              <Select
                label="Action"
                value={newSide}
                onChange={(e) => setNewSide(e.target.value as 'BUY' | 'SELL')}
                options={[{ value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }]}
              />
              <Select
                label="Category"
                value={String(newCat)}
                onChange={(e) => setNewCat(parseInt(e.target.value))}
                options={[
                  { value: '0', label: 'Any' },
                  ...Object.entries(NEWS_CATEGORIES).map(([k, v]) => ({ value: k, label: v.label })),
                ]}
              />
            </div>
            <Button variant="outline" className="w-full" onClick={addRule} disabled={!newKeyword.trim()}>
              + Add Rule
            </Button>
          </div>
        </Card>
      </div>

      {/* Activity Log */}
      <div className="flex-1 flex flex-col min-w-0">
        <Card className="flex-1 flex flex-col p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0">
            <span className="text-xs font-semibold uppercase tracking-wider">Activity Log</span>
            <button
              onClick={() => setLogs([])}
              className="text-[10px] text-text-muted hover:text-text transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-1.5 font-mono">
            {logs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-text-muted">
                <Zap size={36} className="opacity-20 mb-3" />
                <p className="text-sm">Start the bot to begin monitoring news</p>
                <p className="text-xs mt-1 opacity-60">Headlines are checked every {Math.round(POLL_MS / 1000)} seconds</p>
              </div>
            )}
            {logs.map((log, i) => (
              <div key={i} className={cn(
                'flex items-start gap-3 text-xs py-1 px-2 rounded',
                log.type === 'trade' && 'bg-primary/5',
                log.type === 'error' && 'bg-danger/5',
              )}>
                <span className="text-text-muted shrink-0">{log.time}</span>
                <span className={cn(
                  'flex-1 leading-relaxed',
                  log.type === 'trade' && 'text-primary',
                  log.type === 'error' && 'text-danger',
                  log.type === 'info' && 'text-text-secondary',
                )}>
                  {log.message}
                </span>
                {log.type === 'trade' && (
                  log.message.includes('BUY')
                    ? <TrendingUp size={12} className="text-success shrink-0 mt-0.5" />
                    : <TrendingDown size={12} className="text-danger shrink-0 mt-0.5" />
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};
