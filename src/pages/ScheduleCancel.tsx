import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Shield, Search } from 'lucide-react';
import { cancelAllOrders, fetchOpenOrders } from '../api/services';
import { useSettingsStore } from '../store/settingsStore';
import { ConfirmModal } from '../components/common/ConfirmModal';
import { Button } from '../components/common/Button';

type CancelScope = 'all' | 'perps' | 'spot';

interface TriggerRecord {
  timestamp: string;
  scope: CancelScope;
  result: string;
  status: 'success' | 'error';
}

const SCOPE_LABELS: Record<CancelScope, string> = {
  all: 'Tümü',
  perps: 'Sadece Perps',
  spot: 'Sadece Spot',
};

const CIRCLE_SIZE = 200;
const STROKE_WIDTH = 6;
const RADIUS = (CIRCLE_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const ScheduleCancel: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [timeoutPeriod, setTimeoutPeriod] = useState('300');
  const [timeLeft, setTimeLeft] = useState(0);
  const [cancelScope, setCancelScope] = useState<CancelScope>('all');
  const [history, setHistory] = useState<TriggerRecord[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const isCancelling = useRef(false);

  const { confirmOrders } = useSettingsStore();

  const addHistory = useCallback((record: TriggerRecord) => {
    setHistory((prev) => [record, ...prev].slice(0, 10));
  }, []);

  const executeCancellation = useCallback(async () => {
    if (isCancelling.current) return;
    isCancelling.current = true;

    const scope = cancelScope;
    let totalCancelled = 0;

    try {
      if (scope === 'all' || scope === 'perps') {
        const perpsResults = await cancelAllOrders(undefined, 'perps');
        totalCancelled += Array.isArray(perpsResults) ? perpsResults.filter((r) => !(r as Record<string, unknown>).error).length : 0;
      }
      if (scope === 'all' || scope === 'spot') {
        const spotResults = await cancelAllOrders(undefined, 'spot');
        totalCancelled += Array.isArray(spotResults) ? spotResults.filter((r) => !(r as Record<string, unknown>).error).length : 0;
      }

      const resultMsg = `${totalCancelled} emir iptal edildi`;
      toast.success(`✅ ${resultMsg} (${SCOPE_LABELS[scope]})`);
      addHistory({
        timestamp: new Date().toLocaleString('tr-TR'),
        scope,
        result: resultMsg,
        status: 'success',
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Bilinmeyen hata';
      toast.error(`❌ İptal başarısız: ${errMsg}`);
      addHistory({
        timestamp: new Date().toLocaleString('tr-TR'),
        scope,
        result: errMsg,
        status: 'error',
      });
    } finally {
      isCancelling.current = false;
      setIsActive(false);
      setTimeLeft(0);
    }
  }, [cancelScope, addHistory]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (isActive && timeLeft > 0) {
      timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    } else if (isActive && timeLeft === 0) {
      executeCancellation();
    }
    return () => clearTimeout(timer);
  }, [isActive, timeLeft, executeCancellation]);

  const fetchPreview = async () => {
    setLoadingPreview(true);
    try {
      let count = 0;
      if (cancelScope === 'all' || cancelScope === 'perps') {
        const perps = await fetchOpenOrders('perps');
        count += Array.isArray(perps) ? perps.length : 0;
      }
      if (cancelScope === 'all' || cancelScope === 'spot') {
        const spot = await fetchOpenOrders('spot');
        count += Array.isArray(spot) ? spot.length : 0;
      }
      setPreviewCount(count);
    } catch {
      setPreviewCount(null);
      toast.error('Açık emir sayısı alınamadı');
    } finally {
      setLoadingPreview(false);
    }
  };

  const activate = () => {
    setPreviewCount(null);
    setIsActive(true);
    setTimeLeft(parseInt(timeoutPeriod));
  };

  const handleToggle = () => {
    if (isActive) {
      setIsActive(false);
      setTimeLeft(0);
      return;
    }
    if (confirmOrders) {
      setShowConfirm(true);
    } else {
      activate();
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const totalDuration = parseInt(timeoutPeriod) || 1;
  const progress = isActive ? timeLeft / totalDuration : 0;
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const isUrgent = isActive && timeLeft < 60;

  return (
    <div className="p-6 h-[calc(100vh-52px)] flex overflow-hidden">
      <ConfirmModal
        isOpen={showConfirm}
        title="Dead Man's Switch Etkinleştir"
        message={`Süre dolduğunda "${SCOPE_LABELS[cancelScope]}" kapsamındaki tüm açık emirler otomatik iptal edilecek.\n\nSüre: ${parseInt(timeoutPeriod) >= 60 ? `${Math.floor(parseInt(timeoutPeriod) / 60)} dakika` : `${timeoutPeriod} saniye`}\n\nDevam etmek istiyor musunuz?`}
        onConfirm={activate}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Left Panel - Info & Controls */}
      <div className="w-80 pr-6 flex flex-col gap-6 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield size={20} className="text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{"Dead Man's Switch"}</h2>
              <p className="text-[11px] text-text-muted">Otomatik emir iptal koruma sistemi</p>
            </div>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Bu süre içinde işlem yapmazsanız tüm emirleriniz otomatik olarak iptal edilir.
          </p>
        </div>

        {/* Scope Selection */}
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">İptal Kapsamı</label>
          <div className="flex flex-col gap-1.5">
            {(['all', 'perps', 'spot'] as CancelScope[]).map((scope) => (
              <button
                key={scope}
                onClick={() => { setCancelScope(scope); setPreviewCount(null); }}
                disabled={isActive}
                className={`px-4 py-2.5 rounded-lg text-xs text-left transition-all duration-200 border ${
                  cancelScope === scope
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background/40 text-text-muted hover:border-border-hover disabled:opacity-50'
                }`}
              >
                {SCOPE_LABELS[scope]}
              </button>
            ))}
          </div>
        </div>

        {/* Timeout */}
        <div className="space-y-2">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">Timeout Süresi</label>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: '30s', value: '30' },
              { label: '1m', value: '60' },
              { label: '5m', value: '300' },
              { label: '15m', value: '900' },
              { label: '30m', value: '1800' },
              { label: '60m', value: '3600' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setTimeoutPeriod(opt.value)}
                disabled={isActive}
                className={`py-2 rounded-lg text-xs transition-all duration-200 border ${
                  timeoutPeriod === opt.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background/40 text-text-muted hover:border-border-hover disabled:opacity-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {!isActive && (
          <Button variant="ghost" size="sm" icon={<Search size={14} />} onClick={fetchPreview} loading={loadingPreview}>
            {previewCount !== null ? `${previewCount} açık emir` : 'Açık emirleri kontrol et'}
          </Button>
        )}

        {/* History */}
        <div className="flex-1 min-h-0">
          <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-2">Geçmiş</label>
          {history.length === 0 ? (
            <div className="glass-card p-3 text-center text-[11px] text-text-muted">
              Henüz geçmiş yok.
            </div>
          ) : (
            <div className="glass-card p-0 max-h-48 overflow-y-auto divide-y divide-border/50">
              {history.map((entry, idx) => (
                <div key={idx} className="flex items-center justify-between px-3 py-2 text-[11px]">
                  <span className="text-text-muted tabular-nums">{entry.timestamp}</span>
                  <span className={`badge ${entry.status === 'success' ? 'badge-success' : 'badge-danger'}`}>
                    {entry.status === 'success' ? 'OK' : 'HATA'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Center - Circular Timer */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="relative">
          {/* SVG Circular Progress */}
          <svg width={CIRCLE_SIZE} height={CIRCLE_SIZE} className="circular-progress">
            {/* Background circle */}
            <circle
              cx={CIRCLE_SIZE / 2}
              cy={CIRCLE_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="rgba(27,34,48,0.5)"
              strokeWidth={STROKE_WIDTH}
            />
            {/* Progress circle */}
            <circle
              cx={CIRCLE_SIZE / 2}
              cy={CIRCLE_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={isUrgent ? 'var(--color-danger)' : 'var(--color-primary)'}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              className="transition-all duration-1000 ease-linear"
              style={{
                filter: isActive ? `drop-shadow(0 0 6px ${isUrgent ? 'rgba(248,81,73,0.4)' : 'rgba(255,107,0,0.4)'})` : 'none',
              }}
            />
          </svg>
          {/* Timer Text */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-4xl font-mono tabular-nums font-bold transition-colors duration-300 ${
              isActive ? (isUrgent ? 'text-danger' : 'text-primary') : 'text-text-muted'
            }`}>
              {formatTime(timeLeft)}
            </span>
            {isActive && (
              <span className="text-[10px] text-text-muted mt-1 uppercase tracking-wider">
                {isUrgent ? 'Kritik!' : 'Aktif'}
              </span>
            )}
          </div>
        </div>

        {/* Toggle Button */}
        <div className="mt-10 w-full max-w-xs">
          <button
            onClick={handleToggle}
            className={`w-full py-4 rounded-2xl text-lg font-bold border-2 transition-all duration-300 ${
              isActive
                ? 'bg-danger/15 text-danger border-danger/50 hover:bg-danger/25 glow-danger'
                : 'bg-primary/15 text-primary border-primary/50 hover:bg-primary/25 glow-primary'
            }`}
          >
            {isActive ? 'DEVRE DIŞI BIRAK' : 'ETKİNLEŞTİR'}
          </button>
        </div>
      </div>
    </div>
  );
};
