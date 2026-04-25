import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, Zap, RefreshCw, Settings2, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  fetchSosoNews,
  fetchSosoNewsByCurrency,
  fetchSosoCoins,
  NEWS_CATEGORIES,
  getNewsTitle,
} from '../api/sosoServices';
import type { SosoCoin, SosoNewsItem } from '../api/sosoServices';
import { placeOrder } from '../api/services';
import { useSettingsStore } from '../store/settingsStore';
import { Card } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
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
  const [symbol, setSymbol] = useState('BTC-USD');
  const [market, setMarket] = useState<'perps' | 'spot'>('perps');
  const [quantity, setQuantity] = useState('0.001');
  const [coins, setCoins] = useState<SosoCoin[]>([]);
  const [filterCoin, setFilterCoin] = useState<string>(''); // currencyId
  const [triggeredIds] = useState(() => new Map<string, number>());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const useAiRef = useRef(false); // needed for closure in interval
  const pollInFlightRef = useRef(false);
  const lastManualPollRef = useRef(0);
  // Track filterCoin in a ref so the bootstrap fetch (run inside `start`)
  // and the interval-driven poll always see the latest selection without
  // forcing `start` to recompute every time the user changes the filter.
  const filterCoinRef = useRef('');

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

  const executeTrade = useCallback(async (rule: TriggerRule, item: SosoNewsItem) => {
    const title = getNewsTitle(item);
    addLog('trade', `🔔 Trigger: "${rule.keyword}" → ${rule.side} ${quantity} ${symbol}`);
    try {
      if (!privateKey) {
        addLog('error', 'No wallet configured — set Private Key in Settings');
        return;
      }
      await placeOrder(
        { symbol, side: rule.side === 'BUY' ? 1 : 2, type: 2, quantity },
        market,
      );
      addLog('trade', `✅ ${rule.side} MARKET ${quantity} ${symbol} placed — "${title.slice(0, 60)}"`);
      toast.success(`News Bot: ${rule.side} order placed!`);
    } catch (err) {
      const msg = getErrorMessage(err);
      addLog('error', `❌ Order failed: ${msg}`);
      toast.error(`News Bot: ${msg}`);
    }
  }, [symbol, quantity, market, privateKey, addLog]);

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
    addLog('info', '■ Bot stopped');
  }, [addLog]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

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

        {/* Trade settings */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Settings2 size={14} className="text-primary" />
            <h3 className="text-sm font-semibold">Trade Settings</h3>
          </div>
          <div className="space-y-3">
            <Input
              label="Symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="BTC-USD"
            />
            <Input
              label="Quantity"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <Select
              label="Market"
              value={market}
              onChange={(e) => setMarket(e.target.value as 'perps' | 'spot')}
              options={[
                { value: 'perps', label: 'Perps' },
                { value: 'spot', label: 'Spot' },
              ]}
            />
            <Select
              label="Filter by Coin (optional)"
              value={filterCoin}
              onChange={(e) => setFilterCoin(e.target.value)}
              options={[
                { value: '', label: 'All Coins' },
                ...coins.slice(0, 30).map((c) => ({ value: c.id, label: `${c.name.toUpperCase()} — ${c.fullName}` })),
              ]}
            />
          </div>
        </Card>

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
