import React, { useState, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { useSettingsStore } from '../store/settingsStore';
import {
  fetchAccountOrders,
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
  return order.orderId ?? order.id ?? '';
}

const POLL_INTERVAL = 5000;

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

      // If bot was stopped while waiting on delay, abort
      if (!isRunningRef.current) return;

      const params: PlaceOrderParams = {
        symbol: order.symbol,
        side: order.side as 1 | 2,
        type: order.type as 1 | 2,
        quantity: qty.toString(),
      };
      if (order.type === 1 && order.price) {
        params.price = order.price;
      }
      if (order.timeInForce && order.timeInForce !== 2) {
        params.timeInForce = order.timeInForce as 1 | 3 | 4;
      }

      const sideLabel = order.side === 1 ? 'BUY' : 'SELL';
      setTotalAttempts((p) => p + 1);

      try {
        await placeOrder(params, market);
        setSuccessCount((p) => p + 1);
        addLog({
          timestamp: new Date().toLocaleTimeString('tr-TR'),
          symbol: order.symbol,
          side: sideLabel,
          amount: qty.toFixed(4),
          status: 'SUCCESS',
          market,
        });
        toast.success(`Kopyalandı: ${sideLabel} ${order.symbol} x${qty.toFixed(4)}`);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        addLog({
          timestamp: new Date().toLocaleTimeString('tr-TR'),
          symbol: order.symbol,
          side: sideLabel,
          amount: qty.toFixed(4),
          status: 'FAILED',
          market,
          error: errorMsg,
        });
        toast.error(`Kopya başarısız: ${order.symbol} - ${errorMsg}`);
      }
    },
    [copyRatio, maxSize, delay, addLog],
  );

  const pollOrders = useCallback(
    async (market: 'spot' | 'perps') => {
      try {
        const orders: TargetOrder[] = await fetchAccountOrders(market, targetAddress);
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
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Polling error';
        toast.error(`Hedef izleme hatası (${market}): ${errorMsg}`);
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
      // Silently handle - positions are supplementary info
    }
  }, []);

  const startBot = useCallback(() => {
    if (!targetAddress.trim()) {
      toast.error('Hedef cüzdan adresi giriniz.');
      return;
    }

    // Snapshot known orders on first poll to avoid copying old orders
    knownOrderIdsRef.current = new Set();
    setTargetOrders([]);
    setLastDetected(null);
    setCopyLogs([]);
    setSuccessCount(0);
    setTotalAttempts(0);
    isRunningRef.current = true;
    setStatus('RUNNING');
    toast.success('Copy Trader başlatıldı.');

    const markets: ('spot' | 'perps')[] =
      marketType === 'BOTH'
        ? ['spot', 'perps']
        : marketType === 'SPOT'
          ? ['spot']
          : ['perps'];

    // Do an initial poll to seed known order IDs (don't copy existing orders)
    const seedKnownOrders = async () => {
      for (const m of markets) {
        try {
          const orders: TargetOrder[] = await fetchAccountOrders(m, targetAddress);
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
    setStatus('STOPPED');
    toast('Copy Trader durduruldu.', { icon: '⏹️' });
  }, []);

  // Cleanup on unmount
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

  return (
    <div className="flex h-[calc(100vh-48px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="Copy Trader Başlat"
        message={`Hedef: ${targetAddress}\nOran: %${copyRatio} | Max: ${maxSize} USDC\nMarket: ${marketType} | Gecikme: ${delay}ms\n\nBaşlatmak istediğinize emin misiniz?`}
        onConfirm={startBot}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface p-4 flex flex-col gap-4 overflow-y-auto">
        <h2 className="font-semibold mb-2">Copy Trader Ayarları</h2>

        <div>
          <label className="block text-xs text-text-secondary mb-1">Hedef Cüzdan (Adres)</label>
          <input
            type="text"
            value={targetAddress}
            onChange={(e) => setTargetAddress(e.target.value)}
            placeholder="0x..."
            disabled={status === 'RUNNING'}
            className="w-full bg-surface border border-border rounded px-3 py-2 text-sm disabled:opacity-50"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Kopya Oranı (%)</label>
            <input
              type="number"
              value={copyRatio}
              onChange={(e) => setCopyRatio(e.target.value)}
              disabled={status === 'RUNNING'}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Max Boyut (USDC)</label>
            <input
              type="number"
              value={maxSize}
              onChange={(e) => setMaxSize(e.target.value)}
              disabled={status === 'RUNNING'}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums disabled:opacity-50"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Market</label>
            <select
              value={marketType}
              onChange={(e) => setMarketType(e.target.value as 'BOTH' | 'SPOT' | 'PERPS')}
              disabled={status === 'RUNNING'}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm outline-none disabled:opacity-50"
            >
              <option value="BOTH">Her İkisi</option>
              <option value="SPOT">Sadece Spot</option>
              <option value="PERPS">Sadece Perps</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Gecikme (ms)</label>
            <input
              type="number"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              disabled={status === 'RUNNING'}
              className="w-full bg-surface border border-border rounded px-3 py-2 text-sm tabular-nums disabled:opacity-50"
            />
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-2">
          {status !== 'RUNNING' ? (
            <button
              onClick={handleStart}
              className="w-full py-2 bg-primary text-black font-medium rounded hover:bg-primary/90 transition-colors"
            >
              Başlat
            </button>
          ) : (
            <button
              onClick={stopBot}
              className="w-full py-2 bg-danger/10 text-danger border border-danger/30 font-medium rounded hover:bg-danger/20 transition-colors"
            >
              Durdur
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Hedef Cüzdan Panel */}
        <div className="w-1/2 border-r border-border p-6 overflow-y-auto">
          <h3 className="font-medium text-text-secondary mb-4">Hedef Cüzdan Analizi</h3>
          {targetAddress ? (
            <div className="space-y-4">
              <div className="p-4 bg-surface border border-border rounded flex gap-4">
                <div className="flex-1">
                  <span className="text-xs text-text-secondary block">Tespit Edilen Emirler</span>
                  <NumberDisplay value={targetOrders.length} decimals={0} className="text-xl" />
                </div>
                <div className="flex-1">
                  <span className="text-xs text-text-secondary block">Son Tespit</span>
                  {lastDetected ? (
                    <span className="text-sm font-mono">
                      {lastDetected.side === 1 ? '🟢 BUY' : '🔴 SELL'}{' '}
                      {lastDetected.symbol} x{parseFloat(lastDetected.quantity).toFixed(4)}
                    </span>
                  ) : (
                    <span className="text-sm text-text-secondary">—</span>
                  )}
                </div>
              </div>
              <div className="border border-border rounded bg-surface">
                <div className="px-4 py-2 border-b border-border text-sm font-medium">
                  Son İşlemleri ({targetOrders.length})
                </div>
                {targetOrders.length > 0 ? (
                  <div className="max-h-80 overflow-y-auto divide-y divide-border">
                    {[...targetOrders].reverse().slice(0, 50).map((order, i) => (
                      <div key={getOrderId(order) || i} className="px-4 py-2 text-xs flex justify-between items-center">
                        <span className="font-mono">
                          <span className={order.side === 1 ? 'text-success' : 'text-danger'}>
                            {order.side === 1 ? 'BUY' : 'SELL'}
                          </span>{' '}
                          {order.symbol}
                        </span>
                        <span className="text-text-secondary tabular-nums">
                          {parseFloat(order.quantity).toFixed(4)}
                          {order.price ? ` @ ${order.price}` : ' MKT'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 text-xs text-text-secondary text-center">
                    {status === 'RUNNING' ? 'Emirler izleniyor...' : 'API verisi bekleniyor...'}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center text-text-secondary text-sm pt-10">
              İzlemek için bir hedef cüzdan adresi giriniz.
            </div>
          )}
        </div>

        {/* Kendi İşlemlerim Panel */}
        <div className="w-1/2 p-6 overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-text-secondary">Kopyalanan İşlemler</h3>
            <StatusBadge status={status} />
          </div>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="p-4 bg-surface border border-border rounded">
              <div className="text-xs text-text-secondary mb-1">Kendi PnL&apos;im</div>
              <NumberDisplay
                value={pnl}
                prefix={pnl >= 0 ? '+$' : '$'}
                trend={pnlTrend}
                className="text-xl"
              />
            </div>
            <div className="p-4 bg-surface border border-border rounded">
              <div className="text-xs text-text-secondary mb-1">Başarı Oranı</div>
              <NumberDisplay value={successRate} suffix="%" className="text-xl" />
            </div>
          </div>
          <div className="flex-1 border border-border rounded bg-surface flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-border text-sm font-medium flex justify-between">
              <span>Log Kayıtları</span>
              {copyLogs.length > 0 && (
                <span className="text-xs text-text-secondary">
                  {successCount}/{totalAttempts} başarılı
                </span>
              )}
            </div>
            {copyLogs.length > 0 ? (
              <div className="flex-1 overflow-y-auto divide-y divide-border">
                {copyLogs.map((log, i) => (
                  <div key={`${log.timestamp}-${i}`} className="px-4 py-2 text-xs flex items-center gap-3">
                    <span className="text-text-secondary shrink-0 tabular-nums">{log.timestamp}</span>
                    <span className={log.side === 'BUY' ? 'text-success' : 'text-danger'}>
                      {log.side}
                    </span>
                    <span className="font-mono">{log.symbol}</span>
                    <span className="tabular-nums text-text-secondary">{log.amount}</span>
                    <span className="text-text-secondary">{log.market}</span>
                    <span className="ml-auto">
                      {log.status === 'SUCCESS' ? (
                        <span className="text-success">✓</span>
                      ) : (
                        <span className="text-danger" title={log.error}>✗</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 text-xs text-text-secondary text-center">
                Henüz bir işlem kopyalanmadı.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
