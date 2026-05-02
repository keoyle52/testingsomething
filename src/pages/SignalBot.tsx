import React, { useEffect, useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Radio, Settings2, Target, Zap, Activity } from 'lucide-react';
import { useBotStore, type SignalPosition } from '../store/botStore';
import { useBotPnlStore } from '../store/botPnlStore';
import { useSettingsStore } from '../store/settingsStore';
import { fetchKlines, placeOrder, updatePerpsLeverage, fetchBookTickers, normalizeSymbol } from '../api/services';
import { evaluateSignals, resolveSignals, PARAM_LABELS, type CandleData, type SignalResult } from '../api/signalEngine';
import { cn, getErrorMessage } from '../lib/utils';
import { TradingChart } from '../components/TradingChart';
import { SymbolSelector } from '../components/common/SymbolSelector';
import { StatusBadge } from '../components/common/StatusBadge';
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
    state.setField('status', 'STOPPED');
    addLog(`Bot stopped${reason ? `: ${reason}` : ''}`, 'warn');
  }, [addLog, state]);

  // Execute a trade based on signal decision
  const executeTrade = useCallback(async (decision: 'LONG' | 'SHORT', currentPrice: number, signals: SignalResult[]) => {
    const market = state.isSpot ? 'spot' : 'perps';
    const amountUsdt = parseFloat(state.amountUsdt);
    if (isNaN(amountUsdt) || amountUsdt <= 0) {
      addLog('Invalid Amount USDT, cannot trade', 'error');
      return;
    }

    try {
      // 1. Check max open positions
      if (state.activePositions.length >= parseInt(state.maxOpenPositions || '1')) {
        addLog('Max open positions reached, skipping signal', 'warn');
        return;
      }

      // 2. Set leverage if perps
      let lev = parseInt(state.leverage);
      if (!state.isSpot) {
        if (!Number.isFinite(lev) || lev < 1) lev = 1;
        if (!isDemoMode) {
          await updatePerpsLeverage(state.symbol, lev, 2).catch((e) => {
            addLog(`Leverage update skipped: ${getErrorMessage(e)}`, 'warn');
          });
        }
      }

      // 3. Calculate quantity
      const qty = (amountUsdt * lev) / currentPrice;

      // 4. Place market order
      const side = decision === 'LONG' ? 1 : 2; // BUY = 1, SELL = 2
      let orderId = `demo-${Date.now()}`;
      
      if (!isDemoMode) {
        const res = await placeOrder({
          symbol: state.symbol,
          side,
          type: 2, // MARKET
          quantity: String(qty),
          timeInForce: 1, // GTC
        }, market);
        const r = res as Record<string, unknown>;
        orderId = String(r?.orderID ?? r?.orderId ?? r?.id ?? orderId);
      }
      
      addLog(`${isDemoMode ? '[DEMO] ' : ''}Opened ${decision} position @ ~${currentPrice.toFixed(2)} (${orderId})`, 'success');

      // 5. Place TP/SL limit orders (Simulated here via client-side tracking, as SoDEX testnet TP/SL is spotty)
      // We will track TP/SL purely client-side to ensure reliability across spot/perps
      const tpPct = parseFloat(state.takeProfitPct);
      const slPct = parseFloat(state.stopLossPct);
      let tpPrice = null;
      let slPrice = null;

      if (!isNaN(tpPct) && tpPct > 0) {
        tpPrice = decision === 'LONG' ? currentPrice * (1 + tpPct / 100) : currentPrice * (1 - tpPct / 100);
      }
      if (!isNaN(slPct) && slPct > 0) {
        slPrice = decision === 'LONG' ? currentPrice * (1 - slPct / 100) : currentPrice * (1 + slPct / 100);
      }

      // 6. Record position
      const newPos: SignalPosition = {
        id: `pos-${Date.now()}`,
        symbol: state.symbol,
        side: decision,
        entryPrice: currentPrice,
        quantity: qty,
        leverage: lev,
        tpPrice,
        slPrice,
        openTime: Date.now(),
        triggeredBy: signals.map(s => s.label),
        orderId,
        unrealizedPnl: 0,
        status: 'OPEN',
      };

      state.setField('activePositions', [...state.activePositions, newPos]);
      state.setField('lastSignalTime', Date.now());
      state.setField('lastSignalDirection', decision);
      
    } catch (err) {
      addLog(`Failed to execute ${decision}: ${getErrorMessage(err)}`, 'error');
    }
  }, [addLog, state]);

  // Main evaluation loop
  const evaluationLoop = useCallback(async () => {
    if (!runningRef.current) return;
    const market = state.isSpot ? 'spot' : 'perps';
    
    try {
      // 1. Fetch latest tickers to update PnL and check TP/SL
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const normSym = normalizeSymbol(state.symbol, market);
      const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normSym) as Record<string, unknown> | undefined;
      
      let currentPrice = 0;
      if (ticker) {
        const bid = parseFloat(String(ticker.bidPrice ?? ticker.bid ?? '0'));
        const ask = parseFloat(String(ticker.askPrice ?? ticker.ask ?? '0'));
        currentPrice = (bid + ask) / 2;
      }

      if (currentPrice > 0) {
        // Evaluate active positions for TP/SL
        const activePos = [...state.activePositions];
        let changed = false;

        for (let i = 0; i < activePos.length; i++) {
          const p = activePos[i];
          if (p.status !== 'OPEN') continue;

          // Update Unrealized PnL
          const pnlRatio = p.side === 'LONG' 
            ? (currentPrice - p.entryPrice) / p.entryPrice 
            : (p.entryPrice - currentPrice) / p.entryPrice;
          p.unrealizedPnl = (p.quantity * p.entryPrice / p.leverage) * pnlRatio * p.leverage;

          // Check TP
          if (p.tpPrice) {
            if ((p.side === 'LONG' && currentPrice >= p.tpPrice) || (p.side === 'SHORT' && currentPrice <= p.tpPrice)) {
              p.status = 'TP_HIT';
              changed = true;
              addLog(`Take Profit hit for ${p.side} @ ${currentPrice.toFixed(2)}`, 'success');
              
              // Place closing market order
              if (!isDemoMode) {
                await placeOrder({ symbol: state.symbol, side: p.side === 'LONG' ? 2 : 1, type: 2, quantity: String(p.quantity), timeInForce: 1 }, market).catch(() => {});
              }
              
              // Record PnL
              state.setField('realizedPnl', state.realizedPnl + p.unrealizedPnl);
              state.setField('totalTrades', state.totalTrades + 1);
              state.setField('winTrades', state.winTrades + 1);
              useBotPnlStore.getState().recordTrade('signal', { pnlUsdt: p.unrealizedPnl, ts: Date.now(), note: `${p.side} TP Hit` });
            }
          }

          // Check SL
          if (p.status === 'OPEN' && p.slPrice) {
            if ((p.side === 'LONG' && currentPrice <= p.slPrice) || (p.side === 'SHORT' && currentPrice >= p.slPrice)) {
              p.status = 'SL_HIT';
              changed = true;
              addLog(`Stop Loss hit for ${p.side} @ ${currentPrice.toFixed(2)}`, 'warn');
              
              // Place closing market order
              if (!isDemoMode) {
                await placeOrder({ symbol: state.symbol, side: p.side === 'LONG' ? 2 : 1, type: 2, quantity: String(p.quantity), timeInForce: 1 }, market).catch(() => {});
              }
              
              // Record PnL
              state.setField('realizedPnl', state.realizedPnl + p.unrealizedPnl);
              state.setField('totalTrades', state.totalTrades + 1);
              useBotPnlStore.getState().recordTrade('signal', { pnlUsdt: p.unrealizedPnl, ts: Date.now(), note: `${p.side} SL Hit` });
            }
          }
        }

        if (changed) {
          // Remove closed positions from active list (or keep them but mark closed)
          state.setField('activePositions', activePos.filter(p => p.status === 'OPEN'));
        } else {
          state.setField('activePositions', activePos); // just to update PnL
        }
      }

      // 2. Fetch Klines and run Signal Engine
      const checkIntervalMs = parseInt(state.checkInterval) * 1000 || 60000;
      const now = Date.now();
      
      // Only run expensive signal evaluation if interval has passed
      if (now - lastProcessTimeRef.current >= checkIntervalMs) {
        lastProcessTimeRef.current = now;

        const rawKlines = await fetchKlines(state.symbol, state.klineInterval, 100, market);
        const klines: CandleData[] = (Array.isArray(rawKlines) ? rawKlines : []).map(raw => {
          const k = raw as Record<string, any>;
          return {
            time: typeof k.t === 'number' ? k.t : parseFloat(k.t || 0),
            open: parseFloat(k.o || 0),
            high: parseFloat(k.h || 0),
            low: parseFloat(k.l || 0),
            close: parseFloat(k.c || 0),
            volume: parseFloat(k.v || 0)
          };
        }).filter(k => k.time > 0);

        if (klines.length < 30) return;

        const currentPriceEval = klines[klines.length - 1].close;

        // Run signals
        const results = evaluateSignals(klines, state.signals);
        setActiveSignals(results);

        // Add markers to chart
        const newMarkers: SeriesMarker<Time>[] = [];
        results.forEach(r => {
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
          setChartMarkers(prev => [...prev, ...newMarkers].slice(-50)); // keep last 50
        }

        // Combine decisions
        const decision = resolveSignals(results, state.combineMode);

        if (decision.action !== 'NONE') {
          // Check cooldown
          const cooldownMs = parseInt(state.cooldownSeconds) * 1000 || 120000;
          if (state.lastSignalTime && (now - state.lastSignalTime < cooldownMs)) {
            // In cooldown
            return;
          }

          // Check conflict resolution
          const activePos = state.activePositions[0]; // just check the first one for simplicity
          if (activePos && activePos.side !== decision.action) {
            addLog(`Conflicting signal: ${decision.action} while holding ${activePos.side}`, 'warn');
            
            if (state.onConflictingSignal === 'IGNORE') {
              return;
            }
            
            if (state.onConflictingSignal === 'CLOSE_ONLY' || state.onConflictingSignal === 'CLOSE_AND_REVERSE') {
              // Close position
              if (!isDemoMode) {
                await placeOrder({ symbol: state.symbol, side: activePos.side === 'LONG' ? 2 : 1, type: 2, quantity: String(activePos.quantity), timeInForce: 1 }, market).catch(() => {});
              }
              
              // Record PnL
              state.setField('realizedPnl', state.realizedPnl + activePos.unrealizedPnl);
              state.setField('totalTrades', state.totalTrades + 1);
              if (activePos.unrealizedPnl > 0) state.setField('winTrades', state.winTrades + 1);
              useBotPnlStore.getState().recordTrade('signal', { pnlUsdt: activePos.unrealizedPnl, ts: Date.now(), note: `Closed by Signal` });
              
              state.setField('activePositions', state.activePositions.filter(p => p.id !== activePos.id));
              addLog(`Position closed due to conflict`, 'info');

              if (state.onConflictingSignal === 'CLOSE_ONLY') {
                return;
              }
            }
          } else if (activePos && activePos.side === decision.action) {
            // Already holding same direction
            return;
          }

          // Execute new trade
          addLog(`Signal Engine triggered: ${decision.action}. Reasoning: ${decision.reasoning}`, 'info');
          await executeTrade(decision.action, currentPriceEval, decision.signals);
        }
      }

    } catch (err) {
      addLog(`Loop error: ${getErrorMessage(err)}`, 'error');
    }
  }, [addLog, executeTrade, state]);

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
    return () => {
      runningRef.current = false;
      if (loopRef.current) clearInterval(loopRef.current);
    };
  }, []);

  const isLocked = state.status === 'RUNNING';

  const closePosition = async (posId: string) => {
    const pos = state.activePositions.find(p => p.id === posId);
    if (!pos) return;
    
    const market = state.isSpot ? 'spot' : 'perps';
    try {
      if (!isDemoMode) {
        await placeOrder({ symbol: state.symbol, side: pos.side === 'LONG' ? 2 : 1, type: 2, quantity: String(pos.quantity), timeInForce: 1 }, market);
      }
      state.setField('realizedPnl', state.realizedPnl + pos.unrealizedPnl);
      state.setField('totalTrades', state.totalTrades + 1);
      if (pos.unrealizedPnl > 0) state.setField('winTrades', state.winTrades + 1);
      useBotPnlStore.getState().recordTrade('signal', { pnlUsdt: pos.unrealizedPnl, ts: Date.now(), note: 'Manual Close' });
      state.setField('activePositions', state.activePositions.filter(p => p.id !== posId));
      addLog(`Position manually closed`, 'success');
      toast.success('Position closed');
    } catch (e) {
      toast.error(`Close failed: ${getErrorMessage(e)}`);
    }
  };

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
    <div className="flex h-[calc(100vh-52px)]">
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
                onChange={(e) => state.setField('combineMode', e.target.value as any)}
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
                  onChange={(e) => state.setField('onConflictingSignal', e.target.value as any)}
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
