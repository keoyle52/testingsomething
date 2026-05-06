import React, { useState, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Users, TrendingUp, CheckCircle2, Eye } from 'lucide-react';
import { ethers } from 'ethers';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { useSettingsStore } from '../store/settingsStore';
import {
  fetchTargetAccountFills,
  fetchPositions,
  placeOrder,
  type PlaceOrderParams,
} from '../api/services';

interface CopyLog {
  timestamp: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  amount: string;
  status: 'SUCCESS' | 'FAILED';
  market: string;
  error?: string;
}

interface TargetOrder {
  orderID?: number;
  orderId?: string;
  id?: string;
  symbol: string;
  side: number;
  type: number;
  quantity: string;
  price?: string;
  timeInForce?: number;
  time?: number;
  [key: string]: unknown;
}

function getOrderId(order: TargetOrder): string {
  return String(order.orderID ?? order.orderId ?? order.id ?? '');
}

const POLL_INTERVAL = 5000;
// After this many consecutive polling failures the Copy Trader auto-stops
// into ERROR state. Covers ~25s of hard failures at the 5s poll cadence,
// long enough to absorb brief network blips but short enough that the
// user notices promptly if the target-account endpoint goes down or auth
// fails.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

export const CopyTrader: React.FC = () => {
  const { confirmOrders } = useSettingsStore();

  const [targetAddress, setTargetAddress] = useState('');
  const [copyRatio, setCopyRatio] = useState('100');
  const [maxSize, setMaxSize] = useState('5000');
  const [marketType, setMarketType] = useState<'BOTH' | 'SPOT' | 'PERPS'>('BOTH');
  const [delay, setDelay] = useState('0');
  const [status, setStatus] = useState<'STOPPED' | 'RUNNING' | 'ERROR'>('STOPPED');

  const [targetOrders, setTargetOrders] = useState<TargetOrder[]>([]);
  const [lastDetected, setLastDetected] = useState<TargetOrder | null>(null);
  const [copyLogs, setCopyLogs] = useState<CopyLog[]>([]);
  const [successCount, setSuccessCount] = useState(0);
  const [totalAttempts, setTotalAttempts] = useState(0);
  const [pnl, setPnl] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);

  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);
  // Consecutive per-market polling failures, summed across markets in
  // a single tick. Reset on any successful poll. Hits
  // MAX_CONSECUTIVE_POLL_ERRORS → auto-stop into ERROR.
  const consecutivePollErrorsRef = useRef(0);

  const addLog = useCallback((log: CopyLog) => {
    setCopyLogs((prev) => [log, ...prev].slice(0, 200));
  }, []);

  const copyOrder = useCallback(
    async (order: TargetOrder, market: 'spot' | 'perps') => {
      const ratio = parseFloat(copyRatio) / 100;
      const max = parseFloat(maxSize);
      let qty = parseFloat(order.quantity) * ratio;
      if (qty > max) qty = max;
      if (qty <= 0) return;

      const delayMs = parseInt(delay, 10) || 0;
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      if (!isRunningRef.current) return;

      const params: PlaceOrderParams = {
        symbol: order.symbol,
        side: order.side as 1 | 2,
        type: 2, // Always place copied orders as Market Orders for guaranteed fill
        quantity: qty.toString(),
      };

      const sideLabel = order.side === 1 ? 'BUY' : 'SELL';
      setTotalAttempts((p) => p + 1);

      try {
        await placeOrder(params, market);
        setSuccessCount((p) => p + 1);
        addLog({
          timestamp: new Date().toLocaleTimeString(),
          symbol: order.symbol,
          side: sideLabel,
          amount: qty.toFixed(4),
          status: 'SUCCESS',
          market,
        });
        toast.success(`Copied: ${sideLabel} ${order.symbol} x${qty.toFixed(4)}`);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        addLog({
          timestamp: new Date().toLocaleTimeString(),
          symbol: order.symbol,
          side: sideLabel,
          amount: qty.toFixed(4),
          status: 'FAILED',
          market,
          error: errorMsg,
        });
        toast.error(`Copy failed: ${order.symbol} - ${errorMsg}`);
      }
    },
    [copyRatio, maxSize, delay, addLog],
  );

  // Forward ref so pollOrders can call the latest stopBot without a
  // circular useCallback dependency chain.
  const stopBotRef = useRef<(() => void) | null>(null);

  const pollOrders = useCallback(
    async (market: 'spot' | 'perps') => {
      try {
        const orders: TargetOrder[] = await fetchTargetAccountFills(market, targetAddress) as TargetOrder[];
        const ordersArray = Array.isArray(orders) ? orders : [];

        setTargetOrders((prev) => {
          const existingIds = new Set(prev.map(getOrderId));
          const merged = [...prev];
          for (const o of ordersArray) {
            if (!existingIds.has(getOrderId(o))) {
              merged.push(o);
            }
          }
          return merged.slice(-200);
        });

        const newOrders: TargetOrder[] = [];
        for (const order of ordersArray) {
          const oid = getOrderId(order);
          if (oid && !knownOrderIdsRef.current.has(oid)) {
            knownOrderIdsRef.current.add(oid);
            newOrders.push(order);
          }
        }

        if (newOrders.length > 0) {
          setLastDetected(newOrders[newOrders.length - 1]);
          for (const order of newOrders) {
            await copyOrder(order, market);
          }
        }

        // Successful poll — clear the failure streak. If ANY market
        // succeeds this tick the streak resets, which is the right
        // policy for BOTH mode (one transient perps failure shouldn't
        // auto-stop when spot is still giving us fresh signals).
        consecutivePollErrorsRef.current = 0;
      } catch (err: unknown) {
        consecutivePollErrorsRef.current += 1;
        const errorMsg = err instanceof Error ? err.message : 'Polling error';
        toast.error(
          `Target tracking error (${market}) [${consecutivePollErrorsRef.current}/${MAX_CONSECUTIVE_POLL_ERRORS}]: ${errorMsg}`,
        );
        if (consecutivePollErrorsRef.current >= MAX_CONSECUTIVE_POLL_ERRORS) {
          toast.error(`Copy Trader auto-stopped after ${MAX_CONSECUTIVE_POLL_ERRORS} consecutive failures`);
          setStatus('ERROR');
          isRunningRef.current = false;
          if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
          // Defer the rest of the teardown through the ref so we don't
          // double-fire it from here if multiple markets report errors
          // on the same tick.
          stopBotRef.current?.();
        }
      }
    },
    [targetAddress, copyOrder],
  );

  const pollPositions = useCallback(async () => {
    try {
      const positions = await fetchPositions();
      const posArray = Array.isArray(positions) ? positions : [];
      const totalPnl = posArray.reduce((sum: number, p: Record<string, unknown>) => {
        const unrealized = parseFloat(String(p.unrealizedPnl ?? p.pnl ?? 0));
        return sum + (isNaN(unrealized) ? 0 : unrealized);
      }, 0);
      setPnl(totalPnl);
    } catch {
      // Silently handle
    }
  }, []);

  const startBot = useCallback(() => {
    if (!targetAddress.trim()) {
      toast.error('Enter a target wallet address.');
      return;
    }
    if (!ethers.isAddress(targetAddress.trim())) {
      toast.error('Invalid Ethereum address format.');
      return;
    }

    knownOrderIdsRef.current = new Set();
    setTargetOrders([]);
    setLastDetected(null);
    setCopyLogs([]);
    setSuccessCount(0);
    setTotalAttempts(0);
    // Clear failure streak inherited from a previous ERROR-stopped
    // session so the very first poll is not unfairly penalised.
    consecutivePollErrorsRef.current = 0;
    isRunningRef.current = true;
    setStatus('RUNNING');
    toast.success('Copy Trader started.');

    const markets: ('spot' | 'perps')[] =
      marketType === 'BOTH'
        ? ['spot', 'perps']
        : marketType === 'SPOT'
          ? ['spot']
          : ['perps'];

    const seedKnownOrders = async () => {
      for (const m of markets) {
        try {
          const orders: TargetOrder[] = await fetchTargetAccountFills(m, targetAddress) as TargetOrder[];
          const ordersArray = Array.isArray(orders) ? orders : [];
          for (const order of ordersArray) {
            const oid = getOrderId(order);
            if (oid) knownOrderIdsRef.current.add(oid);
          }
          setTargetOrders(ordersArray.slice(-200));
        } catch {
          // Will be caught by subsequent polls
        }
      }
    };

    seedKnownOrders().then(() => {
      intervalRef.current = setInterval(() => {
        if (!isRunningRef.current) return;
        for (const m of markets) {
          pollOrders(m);
        }
        pollPositions();
      }, POLL_INTERVAL);
    });
  }, [targetAddress, marketType, pollOrders, pollPositions]);

  const stopBot = useCallback(() => {
    isRunningRef.current = false;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    consecutivePollErrorsRef.current = 0;
    // If we're already in ERROR (auto-stopped from pollOrders), keep
    // the badge red so the user notices intervention is required.
    setStatus((prev) => (prev === 'ERROR' ? 'ERROR' : 'STOPPED'));
    toast('Copy Trader stopped.', { icon: '⏹️' });
  }, []);

  // Wire the ref so pollOrders can call the latest stopBot.
  useEffect(() => { stopBotRef.current = stopBot; }, [stopBot]);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const handleStart = () => {
    if (confirmOrders) {
      setShowConfirm(true);
    } else {
      startBot();
    }
  };

  const successRate =
    totalAttempts > 0 ? (successCount / totalAttempts) * 100 : 100;
  const pnlTrend: 'up' | 'down' | 'neutral' =
    pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'neutral';
  const isRunning = status === 'RUNNING';

  return (
    <div className="flex h-full">
      <ConfirmModal
        isOpen={showConfirm}
        title="Start Copy Trader"
        message={`Target: ${targetAddress}\nRatio: ${copyRatio}% | Max: ${maxSize} USDC\nMarket: ${marketType} | Delay: ${delay}ms\n\nAre you sure you want to start?`}
        onConfirm={startBot}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Settings</h2>
          <StatusBadge status={status} />
        </div>

        <Input
          label="Target Wallet"
          type="text"
          value={targetAddress}
          onChange={(e) => setTargetAddress(e.target.value)}
          placeholder="0x..."
          disabled={isRunning}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Copy Ratio (%)"
            type="number"
            value={copyRatio}
            onChange={(e) => setCopyRatio(e.target.value)}
            disabled={isRunning}
          />
          <Input
            label="Max Size (USDC)"
            type="number"
            value={maxSize}
            onChange={(e) => setMaxSize(e.target.value)}
            disabled={isRunning}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Market"
            value={marketType}
            onChange={(e) => setMarketType(e.target.value as 'BOTH' | 'SPOT' | 'PERPS')}
            disabled={isRunning}
            options={[
              { value: 'BOTH', label: 'Both' },
              { value: 'SPOT', label: 'Spot Only' },
              { value: 'PERPS', label: 'Perps Only' },
            ]}
          />
          <Input
            label="Delay (ms)"
            type="number"
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            disabled={isRunning}
          />
        </div>

        <div className="mt-auto pt-4 border-t border-border">
          {!isRunning ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={handleStart}>
              Start
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={stopBot}>
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* Split Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left - Target Wallet */}
        <div className="w-1/2 border-r border-border p-6 flex flex-col gap-4 overflow-hidden">
          <div className="flex items-center gap-2">
            <Eye size={16} className="text-primary" />
            <h3 className="text-sm font-semibold">Target Wallet Analysis</h3>
          </div>

          {targetAddress ? (
            <>
              <div className="grid grid-cols-2 gap-3 shrink-0">
                <div className="stat-card !p-3">
                  <div className="text-[10px] text-text-muted uppercase mb-1">Detected</div>
                  <NumberDisplay value={targetOrders.length} decimals={0} className="text-lg font-semibold" />
                </div>
                <div className="stat-card !p-3">
                  <div className="text-[10px] text-text-muted uppercase mb-1">Last Detected</div>
                  {lastDetected ? (
                    <span className="text-xs font-mono">
                      <span className={lastDetected.side === 1 ? 'text-success' : 'text-danger'}>
                        {lastDetected.side === 1 ? 'BUY' : 'SELL'}
                      </span>{' '}
                      {lastDetected.symbol}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </div>
              </div>

              <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
                <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Recent Trades</span>
                  <span className="badge badge-neutral">{targetOrders.length}</span>
                </div>
                {targetOrders.length > 0 ? (
                  <div className="flex-1 overflow-y-auto divide-y divide-border/30">
                    {[...targetOrders].reverse().slice(0, 50).map((order, i) => (
                      <div key={getOrderId(order) || i} className="px-4 py-2 text-xs flex justify-between items-center hover:bg-surface-hover/30 transition-colors">
                        <span className="font-mono flex items-center gap-2">
                          <span className={`badge ${order.side === 1 ? 'badge-success' : 'badge-danger'}`}>
                            {order.side === 1 ? 'BUY' : 'SELL'}
                          </span>
                          {order.symbol}
                        </span>
                        <span className="text-text-muted tabular-nums font-mono">
                          {parseFloat(order.quantity).toFixed(4)}
                          {order.price ? ` @ ${order.price}` : ' MKT'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
                    {isRunning ? 'Monitoring orders...' : 'Waiting for API data...'}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
              <div className="text-center">
                <Users size={32} className="mx-auto mb-3 opacity-30" />
                <p>Enter a target wallet address to monitor.</p>
              </div>
            </div>
          )}
        </div>

        {/* Right - My Copies */}
        <div className="w-1/2 p-6 flex flex-col gap-4 overflow-hidden">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-primary" />
            <h3 className="text-sm font-semibold">Copied Trades</h3>
          </div>

          <div className="grid grid-cols-2 gap-3 shrink-0">
            <StatCard
              label="PnL"
              value={
                <NumberDisplay
                  value={Math.abs(pnl)}
                  prefix={pnl >= 0 ? '+$' : '-$'}
                  trend={pnlTrend}
                />
              }
              icon={<TrendingUp size={14} />}
              trend={pnlTrend}
            />
            <StatCard
              label="Success Rate"
              value={<NumberDisplay value={successRate} suffix="%" />}
              icon={<CheckCircle2 size={14} />}
            />
          </div>

          <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Activity Log</span>
              {copyLogs.length > 0 && (
                <span className="text-[10px] text-text-muted">
                  {successCount}/{totalAttempts} successful
                </span>
              )}
            </div>
            {copyLogs.length > 0 ? (
              <div className="flex-1 overflow-y-auto">
                {copyLogs.map((log, i) => (
                  <div key={`${log.timestamp}-${i}`} className="px-4 py-2 text-xs flex items-center gap-3 hover:bg-surface-hover/30 transition-colors animate-fade-in border-b border-border/20">
                    <span className="text-text-muted shrink-0 tabular-nums font-mono w-14">{log.timestamp}</span>
                    <span className={`badge ${log.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>
                      {log.side}
                    </span>
                    <span className="font-mono font-medium truncate">{log.symbol}</span>
                    <span className="tabular-nums text-text-secondary font-mono">{log.amount}</span>
                    <span className="ml-auto">
                      {log.status === 'SUCCESS' ? (
                        <span className="badge badge-success">✓</span>
                      ) : (
                        <span className="badge badge-danger" title={log.error}>✗</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-muted text-xs">
                No trades copied yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
