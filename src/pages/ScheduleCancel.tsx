import React, { useState, useEffect } from 'react';

export const ScheduleCancel: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [timeoutPeriod, setTimeoutPeriod] = useState('300'); // 5dk by default
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isActive && timeLeft > 0) {
      timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
    } else if (isActive && timeLeft === 0) {
      // Trigger API mock
      setIsActive(false);
    }
    return () => clearTimeout(timer);
  }, [isActive, timeLeft]);

  const handleToggle = () => {
    if (isActive) {
      setIsActive(false);
      setTimeLeft(0);
    } else {
      setIsActive(true);
      setTimeLeft(parseInt(timeoutPeriod));
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="p-6 h-[calc(100vh-48px)] flex flex-col items-center justify-center relative">
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
          <div>
             <label className="block text-xs text-text-secondary mb-2 text-center text-sm">Timeout Süresi</label>
             <div className="flex gap-2 justify-center">
                {[
                  { label: '30sn', value: '30' },
                  { label: '1dk', value: '60' },
                  { label: '5dk', value: '300' },
                  { label: '15dk', value: '900' },
                  { label: '30dk', value: '1800' }
                ].map(opt => (
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
      
      <div className="absolute bottom-6 w-full max-w-4xl mx-auto px-6">
        <div className="border-t border-border pt-4">
           <div className="text-sm text-text-secondary mb-2 font-medium">Son Tetiklenme Geçmişi (0/10 Günlük Limit)</div>
           <div className="bg-surface border border-border rounded p-4 text-center text-xs text-text-secondary">
             Henüz kaydedilmiş bir tetiklenme veya iptal işlemi yok.
           </div>
        </div>
      </div>
    </div>
  );
};
