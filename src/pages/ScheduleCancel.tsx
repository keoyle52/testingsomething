import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { cancelAllOrders, fetchOpenOrders } from '../api/services';
import { useSettingsStore } from '../store/settingsStore';
import { ConfirmModal } from '../components/common/ConfirmModal';

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
        totalCancelled += Array.isArray(perpsResults) ? perpsResults.filter((r: any) => !r.error).length : 0;
      }
      if (scope === 'all' || scope === 'spot') {
        const spotResults = await cancelAllOrders(undefined, 'spot');
        totalCancelled += Array.isArray(spotResults) ? spotResults.filter((r: any) => !r.error).length : 0;
      }

      const resultMsg = `${totalCancelled} emir iptal edildi`;
      toast.success(`✅ ${resultMsg} (${SCOPE_LABELS[scope]})`);
      addHistory({
        timestamp: new Date().toLocaleString('tr-TR'),
        scope,
        result: resultMsg,
        status: 'success',
      });
    } catch (err: any) {
      const errMsg = err?.message || 'Bilinmeyen hata';
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

  return (
    <div className="p-6 h-[calc(100vh-48px)] flex flex-col items-center justify-center relative">
      <ConfirmModal
        isOpen={showConfirm}
        title="Dead Man's Switch Etkinleştir"
        message={`Süre dolduğunda "${SCOPE_LABELS[cancelScope]}" kapsamındaki tüm açık emirler otomatik iptal edilecek.\n\nSüre: ${parseInt(timeoutPeriod) >= 60 ? `${Math.floor(parseInt(timeoutPeriod) / 60)} dakika` : `${timeoutPeriod} saniye`}\n\nDevam etmek istiyor musunuz?`}
        onConfirm={activate}
        onCancel={() => setShowConfirm(false)}
      />

      <div className="absolute top-6 left-6 max-w-sm">
        <h2 className="text-xl font-semibold mb-2">Dead Man's Switch</h2>
        <p className="text-sm text-text-secondary">
          Bu süre içinde işlem yapmazsanız tüm emirleriniz otomatik olarak iptal edilir.
          Her işlem sonrası bu süre otomatik akıllı sözleşme limitleri veya backend tarafından yenilenir.
        </p>
      </div>

      <div className="flex flex-col items-center gap-12 w-full max-w-lg">
        {/* Big Countdown */}
        <div className={`text-8xl font-mono tabular-nums font-bold transition-colors ${isActive ? (timeLeft < 60 ? 'text-danger' : 'text-primary') : 'text-text-secondary'}`}>
          {formatTime(timeLeft)}
        </div>

        {/* Controls */}
        <div className="w-full space-y-6">
          {/* Cancel Scope */}
          <div>
            <label className="block text-sm text-text-secondary mb-2 text-center">İptal Kapsamı</label>
            <div className="flex gap-2 justify-center">
              {(['all', 'perps', 'spot'] as CancelScope[]).map((scope) => (
                <button
                  key={scope}
                  onClick={() => { setCancelScope(scope); setPreviewCount(null); }}
                  disabled={isActive}
                  className={`px-4 py-2 rounded text-sm transition-colors border ${
                    cancelScope === scope
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-text-secondary disabled:opacity-50'
                  }`}
                >
                  {SCOPE_LABELS[scope]}
                </button>
              ))}
            </div>
          </div>

          {/* Timeout Period */}
          <div>
            <label className="block text-sm text-text-secondary mb-2 text-center">Timeout Süresi</label>
            <div className="flex gap-2 justify-center">
              {[
                { label: '30sn', value: '30' },
                { label: '1dk', value: '60' },
                { label: '5dk', value: '300' },
                { label: '15dk', value: '900' },
                { label: '30dk', value: '1800' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimeoutPeriod(opt.value)}
                  disabled={isActive}
                  className={`px-4 py-2 rounded text-sm transition-colors border ${
                    timeoutPeriod === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-text-secondary disabled:opacity-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          {!isActive && (
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={fetchPreview}
                disabled={loadingPreview}
                className="text-xs text-text-secondary hover:text-primary underline transition-colors disabled:opacity-50"
              >
                {loadingPreview ? 'Kontrol ediliyor...' : 'Açık emir sayısını kontrol et'}
              </button>
              {previewCount !== null && (
                <span className="text-xs text-text-secondary">
                  → <span className="text-primary font-medium">{previewCount}</span> açık emir
                </span>
              )}
            </div>
          )}

          {/* Toggle Button */}
          <button
            onClick={handleToggle}
            className={`w-full py-4 rounded-xl text-xl font-semibold border-2 transition-all ${
              isActive
                ? 'bg-danger/20 text-danger border-danger hover:bg-danger/30'
                : 'bg-primary/20 text-primary border-primary hover:bg-primary/30'
            }`}
          >
            {isActive ? 'DEVRE DIŞI BIRAK' : 'ETKİNLEŞTİR'}
          </button>
        </div>
      </div>

      {/* Trigger History */}
      <div className="absolute bottom-6 w-full max-w-4xl mx-auto px-6">
        <div className="border-t border-border pt-4">
          <div className="text-sm text-text-secondary mb-2 font-medium">
            Son Tetiklenme Geçmişi ({history.length}/10 Günlük Limit)
          </div>
          {history.length === 0 ? (
            <div className="bg-surface border border-border rounded p-4 text-center text-xs text-text-secondary">
              Henüz kaydedilmiş bir tetiklenme veya iptal işlemi yok.
            </div>
          ) : (
            <div className="bg-surface border border-border rounded divide-y divide-border max-h-48 overflow-y-auto">
              {history.map((entry, idx) => (
                <div key={idx} className="flex items-center justify-between px-4 py-2 text-xs">
                  <span className="text-text-secondary">{entry.timestamp}</span>
                  <span className="text-text-secondary">{SCOPE_LABELS[entry.scope]}</span>
                  <span className="text-text-secondary">{entry.result}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                      entry.status === 'success'
                        ? 'bg-success/20 text-success'
                        : 'bg-danger/20 text-danger'
                    }`}
                  >
                    {entry.status === 'success' ? 'BAŞARILI' : 'HATA'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
