import React, { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Play, Square, Clock, Hash, DollarSign, BarChart3 } from 'lucide-react';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { StatusBadge } from '../components/common/StatusBadge';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { StatCard } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { useSettingsStore } from '../store/settingsStore';
import { placeOrder, fetchBookTickers, fetchFeeRate } from '../api/services';
import type { FeeRateInfo } from '../api/services';

interface TwapLog {
  time: string;
  side?: string;
  message?: string;
  price?: number;
  amount?: number;
}

export const TwapBot: React.FC = () => {
  const { confirmOrders } = useSettingsStore();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const feeRateRef = useRef<FeeRateInfo>({ makerFee: 0.00035, takerFee: 0.00065 });

  const [symbol, setSymbol] = useState('BTC-USDC');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [totalAmount, setTotalAmount] = useState('1');
  const [slices, setSlices] = useState('10');
  const [intervalSec, setIntervalSec] = useState('60');
  const [isSpot, setIsSpot] = useState(true);
  const [status, setStatus] = useState<'STOPPED' | 'RUNNING' | 'ERROR'>('STOPPED');
  const [showConfirm, setShowConfirm] = useState(false);

  const [executedSlices, setExecutedSlices] = useState(0);
  const [executedVolume, setExecutedVolume] = useState(0);
  const [avgPrice, setAvgPrice] = useState(0);
  const [totalFee, setTotalFee] = useState(0);
  const [logs, setLogs] = useState<TwapLog[]>([]);

  const addLog = useCallback((log: TwapLog) => {
    setLogs((prev) => [log, ...prev].slice(0, 50));
  }, []);

  const executeSlice = useCallback(async (sliceAmount: number, currentSlice: number, totalSlices: number) => {
    if (!runningRef.current) return;

    const market: 'spot' | 'perps' = isSpot ? 'spot' : 'perps';
    const sideNum = side === 'BUY' ? 1 : 2;

    try {
      const tickers = await fetchBookTickers(market);
      const arr = Array.isArray(tickers) ? tickers : [];
      const ticker = arr.find((t: any) => t.symbol === symbol);

      const bidPrice = parseFloat(ticker?.bidPrice ?? ticker?.bid ?? '0');
      const askPrice = parseFloat(ticker?.askPrice ?? ticker?.ask ?? '0');
      const fillPrice = side === 'BUY' ? askPrice : bidPrice;

      if (fillPrice <= 0) {
        addLog({ time: new Date().toLocaleTimeString(), message: `Fiyat verisi alinamadi. Slice atlanıyor.` });
        return;
      }

      await placeOrder(
        { symbol, side: sideNum as 1 | 2, type: 2, quantity: sliceAmount.toFixed(8) },
        market,
      );

      const vol = sliceAmount * fillPrice;
      const fee = vol * feeRateRef.current.takerFee; // Market order = taker fee from API

      setExecutedSlices((p) => p + 1);
      setExecutedVolume((p) => p + vol);
      setTotalFee((p) => p + fee);
      setAvgPrice((prev) => {
        const prevSlices = currentSlice;
        return prevSlices === 0 ? fillPrice : prev + (fillPrice - prev) / (prevSlices + 1);
      });

      addLog({
        time: new Date().toLocaleTimeString(),
        side,
        amount: sliceAmount,
        price: fillPrice,
        message: `Slice ${currentSlice + 1}/${totalSlices} tamamlandi`,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Bilinmeyen hata';
      addLog({ time: new Date().toLocaleTimeString(), message: `HATA: ${msg}` });
      toast.error(`TWAP: ${msg}`);
    }
  }, [symbol, side, isSpot, addLog]);

  const doStart = useCallback(() => {
    if (runningRef.current) return;

    const total = parseFloat(totalAmount);
    const numSlices = parseInt(slices);
    const interval = parseInt(intervalSec);

    if (isNaN(total) || isNaN(numSlices) || isNaN(interval) || total <= 0 || numSlices < 1 || interval < 1) {
      toast.error('Gecersiz parametreler');
      return;
    }

    runningRef.current = true;
    setStatus('RUNNING');
    setExecutedSlices(0);
    setExecutedVolume(0);
    setAvgPrice(0);
    setTotalFee(0);
    setLogs([]);

    const sliceAmount = total / numSlices;
    let currentSlice = 0;
    const market: 'spot' | 'perps' = isSpot ? 'spot' : 'perps';

    const runSlice = async () => {
      if (!runningRef.current || currentSlice >= numSlices) {
        if (currentSlice >= numSlices) {
          runningRef.current = false;
          setStatus('STOPPED');
          addLog({ time: new Date().toLocaleTimeString(), message: 'Tum slice\'lar tamamlandi. Bot durdu.' });
        }
        return;
      }

      await executeSlice(sliceAmount, currentSlice, numSlices);
      currentSlice++;

      if (runningRef.current && currentSlice < numSlices) {
        timerRef.current = setTimeout(runSlice, interval * 1000);
      } else if (currentSlice >= numSlices) {
        runningRef.current = false;
        setStatus('STOPPED');
        addLog({ time: new Date().toLocaleTimeString(), message: 'Tum slice\'lar tamamlandi. Bot durdu.' });
      }
    };

    // Fetch real fee rates from API before starting
    (async () => {
      const feeRate = await fetchFeeRate(market);
      feeRateRef.current = feeRate;
      addLog({
        time: new Date().toLocaleTimeString(),
        message: `TWAP baslatildi: ${numSlices} slice, ${interval}s aralik — Fee: maker ${(feeRate.makerFee * 100).toFixed(4)}%, taker ${(feeRate.takerFee * 100).toFixed(4)}%`,
      });
      runSlice();
    })();
  }, [totalAmount, slices, intervalSec, isSpot, executeSlice, addLog]);

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
  const totalSlicesNum = parseInt(slices) || 1;
  const progress = totalSlicesNum > 0 ? (executedSlices / totalSlicesNum) * 100 : 0;

  return (
    <div className="flex h-[calc(100vh-52px)]">
      <ConfirmModal
        isOpen={showConfirm}
        title="TWAP Bot Baslat"
        message={`${symbol} icin TWAP ${side} emri baslatilacak.\nToplam: ${totalAmount}\nSlice: ${slices}\nAralik: ${intervalSec}s\nPiyasa: ${isSpot ? 'Spot' : 'Perps'}`}
        onConfirm={doStart}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Settings Panel */}
      <div className="w-80 border-r border-border bg-surface/30 backdrop-blur-sm p-5 flex flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">TWAP Ayarlari</h2>
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
          label="Toplam Miktar"
          type="number"
          value={totalAmount}
          onChange={(e) => setTotalAmount(e.target.value)}
          disabled={isRunning}
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Slice Sayisi"
            type="number"
            value={slices}
            onChange={(e) => setSlices(e.target.value)}
            disabled={isRunning}
          />
          <Input
            label="Aralik (sn)"
            type="number"
            value={intervalSec}
            onChange={(e) => setIntervalSec(e.target.value)}
            disabled={isRunning}
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
            label="Tamamlanan Slice"
            value={<span>{executedSlices}/{totalSlicesNum}</span>}
            icon={<Hash size={16} />}
          />
          <StatCard
            label="Islem Hacmi"
            value={<NumberDisplay value={executedVolume} prefix="$" />}
            icon={<BarChart3 size={16} />}
          />
          <StatCard
            label="Ort. Fiyat"
            value={<NumberDisplay value={avgPrice} />}
            icon={<DollarSign size={16} />}
          />
          <StatCard
            label="Toplam Fee"
            value={<NumberDisplay value={totalFee} prefix="$" />}
            icon={<Clock size={16} />}
          />
        </div>

        {/* Progress */}
        <div className="glass-card p-4">
          <div className="flex justify-between text-xs mb-2">
            <span className="text-text-secondary">TWAP Ilerlemesi</span>
            <span className="text-text-primary font-mono tabular-nums">
              {progress.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-primary-soft rounded-full transition-all duration-500"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
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
                  <Clock size={32} className="mx-auto mb-3 opacity-30" />
                  <p>TWAP log kayitlari burada gorunecektir.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
