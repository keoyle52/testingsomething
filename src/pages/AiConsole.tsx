import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Send, RefreshCw, Bot, User as UserIcon, Wrench, AlertTriangle,
  CheckCircle2, XCircle, Trash2, Wand2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Card } from '../components/common/Card';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';
import {
  consoleTurn,
  type ChatMessage,
  type ConsoleTool,
  type ToolArgSchema,
  type TurnResult,
} from '../api/aiConsoleClient';
import {
  fetchTickers, fetchPositions, fetchBalances, fetchFundingRates,
  placeOrder, updatePerpsLeverage, getPerpsSymbolMeta,
} from '../api/services';
import { fetchSosoNews, getNewsTitle } from '../api/sosoServices';
import { usePredictorStore } from '../store/predictorStore';
import { useSettingsStore } from '../store/settingsStore';

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ AI Console                                                          │
 * │ Conversational front-end to the entire SoDEX Terminal state.        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Workshop alignment: Levi (SoSoValue) explicitly framed the buildathon
 * as wanting "LLMs as the BRAIN of the system" and "one-person hedge
 * fund" agentic UX. This page is the most direct implementation of that
 * vision — the user types what they want, the LLM reads live state via
 * tools, and proposes (or with confirmation, executes) actions on
 * SoDEX.
 *
 * The chat loop is driven from this component; the LLM call itself is
 * stateless (in `aiConsoleClient.ts`). After each `consoleTurn` we
 * either:
 *   - Render the text reply, or
 *   - For read tools: auto-run the handler, append result to history,
 *     and call `consoleTurn` again (max 4 hops to bound cost).
 *   - For destructive tools: render a confirmation card. On approve we
 *     run the handler + continue; on reject we feed a "user declined"
 *     synth into the next turn so the LLM doesn't keep retrying.
 *
 * The tool registry is built once via `useMemo` so handler closures
 * capture stable refs to the predictor store + setters. Tool results
 * are stringified JSON so the LLM sees structured data, but each tool
 * also returns a `friendly` summary the UI can show in the chat bubble
 * without dumping raw JSON to the user.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_HOPS = 4;          // hard limit on automatic tool chains per user message
const STORAGE_KEY = 'sodex-ai-console-history';
const MAX_HISTORY_PERSIST = 50;   // localStorage entries — older trims off

// Suggested prompt chips shown above the input on first load. Designed
// to onboard the user to what the assistant can do without making them
// read documentation.
const SUGGESTED_PROMPTS: string[] = [
  'How is BTC?',
  'Show my account',
  'What did the Predictor say?',
  'Latest news',
  'Should I go long?',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowMs(): number { return Date.now(); }

/** Tiny stable id helper — sufficient for keying chat bubbles. */
function makeMsgId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Format a USDT-ish number with up to 2 decimals + grouping. */
function fmtUsdt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

// ─── The page ─────────────────────────────────────────────────────────────────

export const AiConsole: React.FC = () => {
  const { isDemoMode, geminiApiKey, privateKey } = useSettingsStore();
  const predictorStore = usePredictorStore();

  // Persist chat history across reloads (in localStorage). We deliberately
  // keep this lightweight — no Zustand store, just JSON.parse on mount.
  const [messages, setMessages] = useState<Array<ChatMessage & { id: string }>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(-MAX_HISTORY_PERSIST);
    } catch { /* swallow — corrupt history is non-fatal */ }
    return [];
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Pending destructive tool awaiting user confirm. While set, the input
  // bar is disabled — user must click Confirm or Cancel first.
  const [pendingTool, setPendingTool] = useState<{
    tool: string;
    args: Record<string, unknown>;
    reasoning: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll to the bottom on every new message. We do this on a
  // microtask so the DOM has flushed the new bubble first.
  useEffect(() => {
    queueMicrotask(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [messages, busy, pendingTool]);

  // Persist messages to localStorage on every change. We keep only the
  // tail to bound storage; full transcript stays in memory while the
  // page is open.
  useEffect(() => {
    try {
      const tail = messages.slice(-MAX_HISTORY_PERSIST);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tail));
    } catch { /* quota or private mode — ignore */ }
  }, [messages]);

  // ── Tool registry ─────────────────────────────────────────────────
  // Built once per render (memoised on the deps that affect handler
  // behaviour). Handlers must return a string the LLM can ingest; we
  // package useful structured data as JSON.

  const tools = useMemo<ConsoleTool[]>(() => [
    {
      name: 'get_market_overview',
      description: 'Live BTC market snapshot: mark price, 24h change, funding rate, predictor verdict.',
      args: {} as Record<string, ToolArgSchema>,
      handler: async () => {
        const tickers = await fetchTickers('perps') as Record<string, unknown>[];
        const btc = tickers.find((t) => /BTC[-_]/.test(String(t.symbol ?? '')));
        const price = parseFloat(String(btc?.lastPrice ?? btc?.markPrice ?? 0));
        const ch24  = parseFloat(String(btc?.priceChangePercent ?? 0));
        let funding = 0;
        try {
          const fr = await fetchFundingRates() as Array<Record<string, unknown>>;
          const btcFr = fr?.find?.((r) => /BTC[-_]/.test(String(r.symbol ?? '')));
          funding = parseFloat(String(btcFr?.fundingRate ?? btcFr?.lastFundingRate ?? 0));
        } catch { /* funding optional */ }

        const predictor = usePredictorStore.getState();
        const aiV = predictor.aiVerdict;

        return JSON.stringify({
          symbol: String(btc?.symbol ?? 'BTC-USD'),
          markPrice: price,
          changePct24h: ch24,
          fundingRate: funding,
          fundingPct: funding * 100,
          predictor: {
            current: predictor.currentPrediction,
            confidence: predictor.currentConfidence,
            atrPct: predictor.currentSignals?.atrPct ?? null,
            score: predictor.currentSignals?.weightedScore ?? null,
          },
          aiStrategist: aiV ? {
            decision: aiV.decision,
            confidence: aiV.confidence,
            sizeMultiplier: aiV.sizeMultiplier,
            rationale: aiV.rationale,
            source: aiV.source,
          } : null,
        }, null, 2);
      },
    },
    {
      name: 'get_account_status',
      description: 'Wallet balances + open positions (counts and notional).',
      args: {} as Record<string, ToolArgSchema>,
      handler: async () => {
        const [balances, positions] = await Promise.all([
          fetchBalances('perps').catch(() => []),
          fetchPositions().catch(() => []),
        ]);
        const balanceList = (balances as Array<Record<string, unknown>>).map((b) => ({
          asset: String(b.asset ?? b.coin ?? '?'),
          balance: parseFloat(String(b.balance ?? b.available ?? 0)),
        })).filter((b) => Number.isFinite(b.balance) && Math.abs(b.balance) > 0);

        const positionList = (positions as Array<Record<string, unknown>>).map((p) => ({
          symbol: String(p.symbol ?? ''),
          side: String(p.side ?? p.positionSide ?? ''),
          qty: parseFloat(String(p.positionAmt ?? p.quantity ?? p.size ?? 0)),
          entry: parseFloat(String(p.entryPrice ?? p.avgPrice ?? 0)),
          unrealisedPnl: parseFloat(String(p.unrealizedProfit ?? p.unrealisedPnl ?? p.pnl ?? 0)),
        })).filter((p) => Math.abs(p.qty) > 0);

        return JSON.stringify({
          balances: balanceList,
          openPositions: positionList,
          openPositionCount: positionList.length,
        }, null, 2);
      },
    },
    {
      name: 'get_predictor_state',
      description: 'BTC Predictor stats (last verdict, accuracy, AI Strategist verdict, history sample).',
      args: {} as Record<string, ToolArgSchema>,
      handler: async () => {
        const s = usePredictorStore.getState();
        const totalDecided = s.correct + s.wrong;
        const winRate = totalDecided > 0 ? s.correct / totalDecided : 0;
        const recent = s.history.slice(0, 5).map((h) => ({
          dir: h.direction,
          result: h.result,
          netPct: h.netPricePct ?? null,
          ts: new Date(h.timestamp).toISOString(),
        }));
        return JSON.stringify({
          current: {
            direction: s.currentPrediction,
            confidence: s.currentConfidence,
            neutralReason: s.currentSignals?.neutralReason ?? null,
            score: s.currentSignals?.weightedScore ?? null,
          },
          stats: {
            correct: s.correct,
            wrong: s.wrong,
            skipped: s.skipped,
            winRate,
          },
          aiStrategist: s.aiVerdict,
          openPosition: s.openPosition,
          recentTrades: recent,
        }, null, 2);
      },
    },
    {
      name: 'get_news',
      description: 'Latest SoSoValue news headlines.',
      args: {
        limit: { type: 'number', description: 'How many headlines (1-10)', required: false },
      } as Record<string, ToolArgSchema>,
      handler: async (args) => {
        const lim = Math.max(1, Math.min(10, Number(args.limit ?? 5)));
        const result = await fetchSosoNews(1, lim);
        const items = (result?.list ?? []).slice(0, lim).map((it) => ({
          title: getNewsTitle(it),
          ts: it.releaseTime ?? null,
        }));
        return JSON.stringify({ count: items.length, items }, null, 2);
      },
    },
    {
      name: 'place_market_order',
      description: 'Open a new position with a market order. ALWAYS confirm with the user before invoking. NEVER exceed leverage 25.',
      requiresConfirm: true,
      args: {
        symbol:   { type: 'string', description: 'BTC, ETH, etc. — bare ticker', required: true },
        side:     { type: 'string', description: 'LONG or SHORT', required: true, enum: ['LONG', 'SHORT'] },
        usdt:     { type: 'number', description: 'Margin in USDT (collateral, not notional)', required: true },
        leverage: { type: 'number', description: 'Leverage 1-25', required: false },
      } as Record<string, ToolArgSchema>,
      handler: async (args) => {
        const ticker = String(args.symbol ?? '').toUpperCase().replace(/[-_]USD[CT]?$/i, '').trim() || 'BTC';
        const side = String(args.side ?? '').toUpperCase();
        if (side !== 'LONG' && side !== 'SHORT') return JSON.stringify({ error: 'side must be LONG or SHORT' });
        const usdt = Number(args.usdt);
        if (!Number.isFinite(usdt) || usdt <= 0) return JSON.stringify({ error: 'usdt must be a positive number' });
        const lev = Math.max(1, Math.min(25, Number(args.leverage ?? 5)));

        const meta = await getPerpsSymbolMeta(ticker);
        if (!meta) return JSON.stringify({ error: `${ticker} is not listed on SoDEX perps` });
        const symbol = meta.symbol;
        const cap = Math.min(lev, meta.maxLeverage ?? 25);

        const tickers = await fetchTickers('perps') as Record<string, unknown>[];
        const row = tickers.find((t) => String(t.symbol ?? '').toUpperCase() === symbol.toUpperCase());
        const price = parseFloat(String(row?.lastPrice ?? row?.markPrice ?? 0));
        if (price <= 0) return JSON.stringify({ error: `Live price unavailable for ${symbol}` });

        const positionUsdt = usdt * cap;
        const qty = Math.max(0.0001, +(positionUsdt / price).toFixed(4));

        try { await updatePerpsLeverage(symbol, cap, 2); } catch { /* server may reject — order will still attempt */ }

        await placeOrder({
          symbol,
          side: side === 'LONG' ? 1 : 2,
          type: 2, // MARKET
          quantity: qty.toString(),
        }, 'perps');

        return JSON.stringify({
          ok: true,
          opened: { symbol, side, qty, entryEst: price, leverage: cap, marginUsdt: usdt, positionUsdt },
        }, null, 2);
      },
    },
    {
      name: 'close_position',
      description: 'Close an open position with a reduce-only market order. ALWAYS confirm with the user.',
      requiresConfirm: true,
      args: {
        symbol: { type: 'string', description: 'Symbol or bare ticker — defaults to BTC', required: false },
      } as Record<string, ToolArgSchema>,
      handler: async (args) => {
        const ticker = String(args.symbol ?? 'BTC').toUpperCase().replace(/[-_]USD[CT]?$/i, '').trim();
        const positions = await fetchPositions() as Array<Record<string, unknown>>;
        const pos = positions.find((p) => String(p.symbol ?? '').toUpperCase().includes(ticker));
        if (!pos) return JSON.stringify({ error: `No open position found for ${ticker}` });
        const symbol = String(pos.symbol);
        const qty = Math.abs(parseFloat(String(pos.positionAmt ?? pos.quantity ?? pos.size ?? 0)));
        if (!Number.isFinite(qty) || qty <= 0) return JSON.stringify({ error: 'Position quantity not parseable' });
        const sideStr = String(pos.side ?? pos.positionSide ?? '').toUpperCase();
        const isLong = sideStr.includes('LONG') || sideStr === 'BUY';
        await placeOrder({
          symbol,
          side: isLong ? 2 : 1, // opposite
          type: 2,
          quantity: qty.toString(),
          reduceOnly: true,
        }, 'perps');
        return JSON.stringify({ ok: true, closed: { symbol, qty } }, null, 2);
      },
    },
  ], []);

  // ── Chat loop ──────────────────────────────────────────────────────
  // The chat experience uses a single async path:
  //   sendUserMessage → driveTurns(loop until text or pending-tool)
  // We rely on a small allow-list pattern to bound automatic tool
  // invocations: read tools auto-run, destructive tools pause for
  // confirmation. The hop counter prevents loops where the LLM keeps
  // requesting tools indefinitely.

  const appendMessage = useCallback((m: ChatMessage): { id: string } => {
    const id = makeMsgId();
    setMessages((prev) => [...prev, { ...m, id }]);
    return { id };
  }, []);

  const driveTurns = useCallback(async (history: ChatMessage[], hops = 0): Promise<void> => {
    if (hops >= MAX_TOOL_HOPS) {
      appendMessage({
        role: 'assistant',
        content: 'I tried too many tool calls in a row — stopping to avoid a loop. Please rephrase your question.',
        ts: nowMs(),
      });
      return;
    }
    setBusy(true);
    let result: TurnResult;
    try {
      result = await consoleTurn(history, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendMessage({ role: 'assistant', content: `Error talking to the model: ${msg}`, ts: nowMs() });
      setBusy(false);
      return;
    }

    if (result.kind === 'text') {
      appendMessage({ role: 'assistant', content: result.text, ts: nowMs() });
      setBusy(false);
      return;
    }

    // Tool path — find the spec and decide auto-run vs confirm.
    const spec = tools.find((t) => t.name === result.tool);
    if (!spec) {
      appendMessage({ role: 'assistant', content: `Unknown tool requested: "${result.tool}".`, ts: nowMs() });
      setBusy(false);
      return;
    }

    if (spec.requiresConfirm) {
      // Render a confirm card. The user clicks Confirm/Cancel which
      // drives the next turn from `confirmPendingTool` below. No auto-run.
      setPendingTool({ tool: result.tool, args: result.args, reasoning: result.reasoning });
      // Surface the LLM's reasoning + tool args so the user knows what
      // they're approving.
      appendMessage({
        role: 'assistant',
        content: `Proposed: \`${result.tool}\`\n\n${result.reasoning || '(no rationale provided)'}\n\nArgs: \`\`\`json\n${JSON.stringify(result.args, null, 2)}\n\`\`\``,
        ts: nowMs(),
      });
      setBusy(false);
      return;
    }

    // Read tool — auto-run, append result, recurse.
    appendMessage({
      role: 'assistant',
      content: `_${result.reasoning || `Calling ${result.tool}…`}_`,
      ts: nowMs(),
    });
    let toolOutput: string;
    try {
      toolOutput = await spec.handler(result.args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toolOutput = JSON.stringify({ error: msg });
    }
    const newHistory: ChatMessage[] = [
      ...history,
      { role: 'tool', content: toolOutput, toolName: result.tool, ts: nowMs() },
    ];
    // Keep the tool result visible to the user as a collapsible system
    // bubble. This is essential for trust — they see exactly what the
    // model fed itself before answering.
    appendMessage({
      role: 'tool',
      content: toolOutput,
      toolName: result.tool,
      ts: nowMs(),
    });
    await driveTurns(newHistory, hops + 1);
  }, [tools, appendMessage]);

  const sendUserMessage = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || pendingTool) return;
    appendMessage({ role: 'user', content: text, ts: nowMs() });
    // Build the history the LLM sees from the latest snapshot. We
    // exclude assistant "thinking" italic bubbles that contain the
    // reasoning preview only — those are UI affordances, not part of
    // the conversation Gemini should reason over.
    const cleanHistory: ChatMessage[] = [
      ...messages
        .filter((m) => !(m.role === 'assistant' && m.content.startsWith('_')))
        .map(({ role, content, toolName, ts }) => ({ role, content, toolName, ts })),
      { role: 'user', content: text, ts: nowMs() },
    ];
    await driveTurns(cleanHistory, 0);
  }, [busy, pendingTool, appendMessage, messages, driveTurns]);

  const confirmPendingTool = useCallback(async (approve: boolean) => {
    const pending = pendingTool;
    if (!pending) return;
    setPendingTool(null);

    if (!approve) {
      appendMessage({ role: 'assistant', content: 'Tamam, iptal ettim.', ts: nowMs() });
      // Synthesize a "user declined" tool result so the LLM's next
      // turn (if any) doesn't keep proposing the same destructive op.
      const cleanHistory: ChatMessage[] = [
        ...messages
          .filter((m) => !(m.role === 'assistant' && m.content.startsWith('_')))
          .map(({ role, content, toolName, ts }) => ({ role, content, toolName, ts })),
        { role: 'tool', content: JSON.stringify({ cancelled: true }), toolName: pending.tool, ts: nowMs() },
      ];
      await driveTurns(cleanHistory, 0);
      return;
    }

    setBusy(true);
    const spec = tools.find((t) => t.name === pending.tool);
    if (!spec) {
      appendMessage({ role: 'assistant', content: 'Tool no longer available — cancelling.', ts: nowMs() });
      setBusy(false);
      return;
    }

    let toolOutput: string;
    try {
      toolOutput = await spec.handler(pending.args);
      // Surface a positive toast for destructive tools so the user has
      // an out-of-chat ack on success.
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(toolOutput); } catch { /* non-JSON */ }
      if (!parsed.error) toast.success(`${pending.tool} OK`);
      else toast.error(`${pending.tool}: ${String(parsed.error).slice(0, 80)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toolOutput = JSON.stringify({ error: msg });
      toast.error(`${pending.tool} failed: ${msg.slice(0, 80)}`);
    }
    appendMessage({ role: 'tool', content: toolOutput, toolName: pending.tool, ts: nowMs() });
    const cleanHistory: ChatMessage[] = [
      ...messages
        .filter((m) => !(m.role === 'assistant' && m.content.startsWith('_')))
        .map(({ role, content, toolName, ts }) => ({ role, content, toolName, ts })),
      { role: 'tool', content: toolOutput, toolName: pending.tool, ts: nowMs() },
    ];
    await driveTurns(cleanHistory, 0);
  }, [pendingTool, tools, appendMessage, messages, driveTurns]);

  const clearChat = useCallback(() => {
    setMessages([]);
    setPendingTool(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  }, []);

  // Display gating — predictor scope is always available even with no key
  // because the demo synth path returns deterministic responses.
  const liveLlm = !!geminiApiKey;
  const tradeReady = !!privateKey || isDemoMode;

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-52px)] overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-5 py-3 border-b border-border flex items-center gap-3 flex-wrap">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-fuchsia-500/30 via-violet-500/25 to-cyan-400/30 border border-fuchsia-400/40 shadow-[0_0_12px_rgba(217,70,239,0.35)] flex items-center justify-center">
          <Sparkles size={18} className="text-fuchsia-200" />
        </div>
        <div className="flex-1 min-w-[200px]">
          <h2 className="text-sm font-bold bg-gradient-to-r from-fuchsia-300 via-violet-300 to-cyan-300 bg-clip-text text-transparent">
            AI Console
          </h2>
          <p className="text-[11px] text-text-muted">
            Conversational interface to your portfolio. The LLM reads live SoSoValue + SoDEX state via tools and proposes actions.
          </p>
        </div>
        {/* Status badges */}
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span className={cn(
            'px-2 py-0.5 rounded border',
            liveLlm
              ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
              : 'border-cyan-500/40 text-cyan-400 bg-cyan-500/10',
          )}>
            {liveLlm ? '◉ GEMINI 2.5' : '◯ DEMO SYNTH'}
          </span>
          <span className={cn(
            'px-2 py-0.5 rounded border',
            tradeReady
              ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
              : 'border-amber-500/40 text-amber-400 bg-amber-500/10',
          )}>
            {tradeReady ? '◉ TRADE READY' : '⚠ READ-ONLY'}
          </span>
          <Button
            variant="outline"
            size="sm"
            icon={<Trash2 size={12} />}
            onClick={clearChat}
            disabled={messages.length === 0}
            title="Clear chat"
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.length === 0 && !busy && !pendingTool && (
          <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-fuchsia-500/20 via-violet-500/15 to-cyan-400/20 border border-fuchsia-400/30 flex items-center justify-center">
              <Wand2 size={28} className="text-fuchsia-300" />
            </div>
            <div>
              <h3 className="text-base font-bold text-text-primary mb-1">Hi — I&apos;m your trading assistant</h3>
              <p className="text-xs text-text-muted max-w-md">
                I can read your live SoSoValue news + SoDEX positions and
                {' '}<strong>open or close trades for you</strong> when you ask.
                {!liveLlm && ' Currently in demo mode — connect a Gemini key in Settings for full LLM reasoning.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-lg">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => sendUserMessage(p)}
                  className="px-3 py-1.5 text-xs rounded-full bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-300 hover:bg-fuchsia-500/20 hover:border-fuchsia-500/50 transition"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}

        {/* Confirmation card for destructive tool */}
        {pendingTool && (
          <ConfirmCard
            tool={pendingTool.tool}
            args={pendingTool.args}
            reasoning={pendingTool.reasoning}
            onConfirm={() => void confirmPendingTool(true)}
            onCancel={() => void confirmPendingTool(false)}
          />
        )}

        {/* Thinking indicator */}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-text-muted px-3 py-2">
            <RefreshCw size={12} className="animate-spin" />
            <span>Thinking…</span>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-border p-3">
        <form
          onSubmit={(e) => { e.preventDefault(); void sendUserMessage(input); setInput(''); }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={pendingTool
              ? 'Confirm or cancel the action above first…'
              : busy
                ? 'Thinking…'
                : 'Ask anything: "How is BTC?", "open 100 USDT long at 5x", "my account?"'}
            disabled={busy || !!pendingTool}
            className={cn(
              'flex-1 px-4 py-2.5 rounded-xl bg-surface border border-border text-sm',
              'placeholder:text-text-muted focus:border-fuchsia-500/50 focus:ring-1 focus:ring-fuchsia-500/30 focus:outline-none',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !!pendingTool || !input.trim()}
            icon={<Send size={14} />}
          >
            Send
          </Button>
        </form>
        {!liveLlm && (
          <div className="mt-2 flex items-start gap-2 text-[11px] text-cyan-400/80">
            <Sparkles size={11} className="shrink-0 mt-0.5" />
            <span>Demo synth mode — pattern-matched replies. Add a Gemini key in Settings for full reasoning.</span>
          </div>
        )}
        {!tradeReady && (
          <div className="mt-1 flex items-start gap-2 text-[11px] text-amber-400/80">
            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
            <span>No wallet configured — trade tools will fail. Read-only Q&amp;A still works.</span>
          </div>
        )}
      </div>
      {/* Avoid the unused import warning until predictorStore.X is accessed
          in the JSX directly. We intentionally use the store via tool
          handlers + this getState() pattern, but the variable shadow
          ensures TS sees the top-level reference. */}
      {predictorStore && null}
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const MessageBubble: React.FC<{ msg: ChatMessage & { id: string } }> = ({ msg }) => {
  const isUser = msg.role === 'user';
  const isTool = msg.role === 'tool';
  const isThinking = msg.role === 'assistant' && msg.content.startsWith('_');

  if (isTool) {
    // Render tool results as a collapsed JSON dump that the user can
    // expand. Keeps the chat readable but transparent.
    return (
      <details className="group ml-9 max-w-[90%]">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-text-muted hover:text-text-secondary flex items-center gap-1.5 select-none">
          <Wrench size={10} />
          Tool result: <code className="font-mono text-fuchsia-400">{msg.toolName}</code>
          <span className="text-text-muted/50 group-open:hidden">[click to expand]</span>
        </summary>
        <pre className="mt-1 p-2 text-[10px] font-mono bg-black/30 border border-fuchsia-500/15 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {msg.content}
        </pre>
      </details>
    );
  }

  return (
    <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      <div className={cn(
        'w-7 h-7 rounded-full shrink-0 flex items-center justify-center',
        isUser
          ? 'bg-cyan-500/15 border border-cyan-500/30'
          : 'bg-gradient-to-br from-fuchsia-500/30 via-violet-500/25 to-cyan-400/30 border border-fuchsia-400/40',
      )}>
        {isUser ? <UserIcon size={14} className="text-cyan-300" /> : <Bot size={14} className="text-fuchsia-200" />}
      </div>
      <div className={cn(
        'max-w-[80%] px-3 py-2 rounded-2xl text-sm',
        isUser
          ? 'bg-cyan-500/10 border border-cyan-500/20 text-text-primary rounded-tr-md'
          : isThinking
            ? 'bg-fuchsia-500/5 border border-fuchsia-500/15 text-fuchsia-300/80 italic rounded-tl-md text-xs'
            : 'bg-surface border border-border text-text-primary rounded-tl-md',
      )}>
        {/* Format newlines + simple inline code (`thing`) without pulling
            in a full markdown renderer — the LLM is told to keep replies
            short so this is sufficient. */}
        <FormattedMessage text={msg.content} />
      </div>
    </div>
  );
};

/**
 * Tiny formatter that handles:
 *  - paragraph breaks (\n\n)
 *  - line breaks (\n)
 *  - inline `code` segments (single-backtick)
 *  - fenced code blocks (triple-backtick)
 * Anything else stays plain text.
 */
const FormattedMessage: React.FC<{ text: string }> = ({ text }) => {
  // Split out fenced code blocks first so their content isn't mangled.
  const parts: React.ReactNode[] = [];
  const fenceRe = /```(?:\w+)?\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push(<InlineSegment key={`t${key++}`} text={text.slice(lastIdx, m.index)} />);
    }
    parts.push(
      <pre key={`p${key++}`} className="my-1 p-2 text-[11px] font-mono bg-black/30 border border-border rounded-lg overflow-x-auto whitespace-pre-wrap">
        {m[1].trim()}
      </pre>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<InlineSegment key={`t${key++}`} text={text.slice(lastIdx)} />);
  }
  return <>{parts}</>;
};

const InlineSegment: React.FC<{ text: string }> = ({ text }) => {
  // Split on single-backtick segments. This is intentionally simple —
  // no markdown link/bold/italic — to keep the bubble visually quiet.
  const tokens = text.split(/(`[^`\n]+`)/g);
  return (
    <span className="whitespace-pre-wrap">
      {tokens.map((t, i) => {
        if (t.startsWith('`') && t.endsWith('`') && t.length > 2) {
          return (
            <code key={i} className="px-1 py-0.5 rounded bg-black/40 border border-border text-[12px] font-mono text-fuchsia-300">
              {t.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{t}</span>;
      })}
    </span>
  );
};

const ConfirmCard: React.FC<{
  tool: string;
  args: Record<string, unknown>;
  reasoning: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ tool, args, reasoning, onConfirm, onCancel }) => {
  const isOrder = tool === 'place_market_order';
  const isClose = tool === 'close_position';

  // Derive a human summary of the args for the headline above the JSON.
  let summary = '';
  if (isOrder) {
    const side = String(args.side ?? '?');
    const symbol = String(args.symbol ?? '?');
    const usdt = Number(args.usdt ?? 0);
    const lev  = Number(args.leverage ?? 5);
    summary = `${side} ${symbol} — ${fmtUsdt(usdt)} USDT margin × ${lev}× = ${fmtUsdt(usdt * lev)} USDT position`;
  } else if (isClose) {
    summary = `Close ${String(args.symbol ?? 'BTC')} position`;
  } else {
    summary = tool;
  }

  return (
    <Card className="ml-9 max-w-[80%] p-4 border-2 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-xs uppercase tracking-widest font-bold text-amber-400 mb-1">
            Confirmation required
          </div>
          <div className="text-sm font-bold text-text-primary mb-1">{summary}</div>
          {reasoning && (
            <p className="text-[12px] text-text-secondary italic mb-2">
              &quot;{reasoning}&quot;
            </p>
          )}
          <details className="text-[11px] text-text-muted">
            <summary className="cursor-pointer hover:text-text-secondary">Tool args</summary>
            <pre className="mt-1 p-2 font-mono bg-black/30 rounded-lg overflow-x-auto">
              {JSON.stringify(args, null, 2)}
            </pre>
          </details>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" icon={<CheckCircle2 size={14} />} onClick={onConfirm}>
              Confirm &amp; Execute
            </Button>
            <Button variant="outline" size="sm" icon={<XCircle size={14} />} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};
