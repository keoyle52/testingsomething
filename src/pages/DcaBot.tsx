import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Repeat, Hash, DollarSign, TrendingUp, Activity } from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchBookTickers, normalizeSymbol } from '../api/services';
import { getErrorMessage } from '../lib/utils';

interface DcaLog {
  time: string;
  side?: string;
  message?: string;
  price?: number;
  amount?: number;
}

export const DcaBot: React.FC = () => {
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const [symbol, setSymbol] = useState('BTC-USDC');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [amountPerOrder, setAmountPerOrder] = useState('0.01');
  const [intervalSec, setIntervalSec] = useState('3600');
  const [maxOrders, setMaxOrders] = useState('0');
  const [isSpot, setIsSpot] = useState(true);
  const [status, setStatus] = useState<'STOPPED' | 'RUNNING' | 'ERROR'>('STOPPED');
  const [showConfirm, setShowConfirm] = useState(false);

  const [executedOrders, setExecutedOrders] = useState(0);
  const [totalInvested, setTotalInvested] = useState(0);
  const [avgPrice, setAvgPrice] = useState(0);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [logs, setLogs] = useState<DcaLog[]>([]);

  const addLog = useCallback((log: DcaLog) => {
    setLogs((prev) => [log, ...prev].slice(0, 50));
  }, []);

  const executeDcaOrder = useCallback(async () => {
    if (!runningRef.current) return;

    const market: 'spot' | 'perps' = isSpot ? 'spot' : 'perps';
    const sideNum = side === 'BUY' ? 1 : 2;
    const amount = parseFloat(amountPerOrder);

    if (isNaN(amount) || amount <= 0) return;

    try {
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const normalizedSym = normalizeSymbol(symbol, market);
      const ticker = arr.find((t) => (t as Record<string, unknown>).symbol === normalizedSym) as Record<string, unknown> | undefined;

      const bidPrice = parseFloat(String(ticker?.bidPrice ?? ticker?.bid ?? '0'));
      const askPrice = parseFloat(String(ticker?.askPrice ?? ticker?.ask ?? '0'));
      const fillPrice = side === 'BUY' ? askPrice : bidPrice;

      if (fillPrice <= 0) {
        addLog({ time: new Date().toLocaleTimeString(), message: 'Fiyat verisi alinamadi. Siparis atlanıyor.' });
        return;
      }

      setCurrentPrice(fillPrice);

      await placeOrder(
        { symbol, side: sideNum as 1 | 2, type: 2, quantity: amount.toFixed(8) },
        market,
      );

      const vol = amount * fillPrice;

      setExecutedOrders((prev) => {
        const newCount = prev + 1;
        setAvgPrice((prevAvg) => prevAvg + (fillPrice - prevAvg) / newCount);

        // Check max orders inside the same state update to avoid race condition
        const maxOrd = parseInt(maxOrders);
        if (maxOrd > 0 && newCount >= maxOrd) {
          runningRef.current = false;
          setStatus('STOPPED');
          addLog({ time: new Date().toLocaleTimeString(), message: `Maksimum siparis sayisina (${maxOrd}) ulasildi. Bot durdu.` });
        }

        return newCount;
      });
      setTotalInvested((p) => p + vol);

      addLog({
        time: new Date().toLocaleTimeString(),
        side,
        amount,
        price: fillPrice,
        message: `DCA emri tamamlandi`,
      });
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      addLog({ time: new Date().toLocaleTimeString(), message: `HATA: ${msg}` });
      toast.error(`DCA: ${msg}`);
    }
  }, [symbol, side, isSpot, amountPerOrder, maxOrders, addLog]);

  const scheduleNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    scheduleNextRef.current = () => {
      if (!runningRef.current) return;
      const interval = Math.max(1, parseInt(intervalSec) || 3600) * 1000;
      timerRef.current = setTimeout(async () => {
        await executeDcaOrder();
        scheduleNextRef.current();
      }, interval);
    };
  }, [executeDcaOrder, intervalSec]);

  const doStart = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    setStatus('RUNNING');
    setExecutedOrders(0);
    setTotalInvested(0);
    setAvgPrice(0);
    setCurrentPrice(0);
    setLogs([]);

    addLog({ time: new Date().toLocaleTimeString(), message: 'DCA Bot baslatildi' });

    (async () => {
      await executeDcaOrder();
      scheduleNextRef.current();
    })();
  }, [executeDcaOrder, addLog]);

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
    setStatus('STOPPED');
    addLog({ time: new Date().toLocaleTimeString(), message: 'Bot durduruldu' });
  }, [addLog]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const isRunning = status === 'RUNNING';
  const pnlPercent = avgPrice > 0 && currentPrice > 0
    ? ((currentPrice - avgPrice) / avgPrice) * 100 * (side === 'BUY' ? 1 : -1)
    : 0;

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="DCA Bot Baslat"
        message={`${symbol} icin DCA ${side} emri baslatilacak.\nMiktar/Emir: ${amountPerOrder}\nAralik: ${intervalSec}s\nMax Emir: ${maxOrders === '0' ? 'Limitsiz' : maxOrders}\nPiyasa: ${isSpot ? 'Spot' : 'Perps'}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">DCA Ayarlari</h2>
          <StatusBadge status={status} />
        </div>

        <Input
          label="Sembol"
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="BTC-USDC"
          disabled={isRunning}
        />

        <Select
          label="Yon"
          value={side}
          onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
          disabled={isRunning}
          options={[
            { value: 'BUY', label: 'Alis (BUY)' },
            { value: 'SELL', label: 'Satis (SELL)' },
          ]}
        />

        <Input
          label="Miktar/Emir"
          type="number"
          value={amountPerOrder}
          onChange={(e) => setAmountPerOrder(e.target.value)}
          disabled={isRunning}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Aralik (sn)"
            type="number"
            value={intervalSec}
            onChange={(e) => setIntervalSec(e.target.value)}
            disabled={isRunning}
            hint="3600 = 1 saat"
          />
          <Input
            label="Max Emir"
            type="number"
            value={maxOrders}
            onChange={(e) => setMaxOrders(e.target.value)}
            disabled={isRunning}
            hint="0 = limitsiz"
          />
        </div>

        {/* Market Toggle */}
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">Piyasa</label>
          <div className="flex gap-2">
            <button
              onClick={() => !isRunning && setIsSpot(true)}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'} ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}
            >
              Spot
            </button>
            <button
              onClick={() => !isRunning && setIsSpot(false)}
              className={`flex-1 py-2 text-xs rounded-lg border transition-all duration-200 ${!isSpot ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/40 text-text-muted hover:border-border-hover'} ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}
            >
              Perps
            </button>
          </div>
        </div>

        <div className="mt-auto pt-4 border-t border-border">
          {!isRunning ? (
            <Button variant="primary" fullWidth size="lg" icon={<Play size={16} />} onClick={startBot}>
              Baslat
            </Button>
          ) : (
            <Button variant="danger" fullWidth size="lg" icon={<Square size={16} />} onClick={stopBot}>
              Durdur
            </Button>
          )}
        </div>
      </div>

      {/* Live Status Panel */}
      <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Tamamlanan Emir"
            value={<NumberDisplay value={executedOrders} decimals={0} />}
            icon={<Hash size={16} />}
          />
          <StatCard
            label="Toplam Yatirim"
            value={<NumberDisplay value={totalInvested} prefix="$" />}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Ort. Fiyat"
            value={<NumberDisplay value={avgPrice} />}
            icon={<Repeat size={16} />}
          />
          <StatCard
            label="PnL"
            value={<NumberDisplay value={Math.abs(pnlPercent)} suffix="%" prefix={pnlPercent >= 0 ? '+' : '-'} trend={pnlPercent >= 0 ? 'up' : 'down'} />}
            icon={<TrendingUp size={16} />}
            trend={pnlPercent >= 0 ? (pnlPercent > 0 ? 'up' : 'neutral') : 'down'}
          />
        </div>

        {/* DCA Summary */}
        <div className="glass-card p-4">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-[10px] text-text-muted uppercase mb-1">Guncel Fiyat</div>
              <NumberDisplay value={currentPrice} className="text-lg font-semibold" />
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase mb-1">Ort. Alis</div>
              <NumberDisplay value={avgPrice} className="text-lg font-semibold" />
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase mb-1">Fark</div>
              <NumberDisplay
                value={Math.abs(currentPrice - avgPrice)}
                prefix={currentPrice >= avgPrice ? '+' : '-'}
                trend={currentPrice >= avgPrice ? 'up' : 'down'}
                className="text-lg font-semibold"
              />
            </div>
          </div>
        </div>

        {/* Log */}
        <div className="flex-1 glass-card flex flex-col overflow-hidden p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Log Kayitlari</span>
            <span className="text-[10px] text-text-muted">{logs.length} kayit</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
            {logs.map((log, i) => (
              <div key={i} className="text-xs flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-hover/50 transition-colors font-mono animate-fade-in">
                <span className="text-text-muted w-16 shrink-0 tabular-nums">{log.time}</span>
                {log.side && (
                  <span className={`badge ${log.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{log.side}</span>
                )}
                {log.amount != null && (
                  <span className="tabular-nums text-text-secondary">
                    <NumberDisplay value={log.amount} decimals={4} />
                  </span>
                )}
                {log.price != null && (
                  <span className="tabular-nums text-text-muted">
                    @ <NumberDisplay value={log.price} />
                  </span>
                )}
                {log.message && <span className="text-text-secondary truncate">{log.message}</span>}
              </div>
            ))}
            {logs.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                <div className="text-center">
                  <Activity size={32} className="mx-auto mb-3 opacity-30" />
                  <p>DCA log kayitlari burada gorunecektir.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
