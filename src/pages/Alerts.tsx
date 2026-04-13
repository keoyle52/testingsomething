import React, { useState, useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { Bell, Plus, Trash2, Volume2, ArrowUp, ArrowDown, AlertCircle } from 'lucide-react';
import { fetchBookTickers } from '../api/services';
import { Card } from '../components/common/Card';
import { Input, Select } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { cn } from '../lib/utils';

interface PriceAlert {
  id: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  targetPrice: number;
  market: 'spot' | 'perps';
  triggered: boolean;
  createdAt: string;
  triggeredAt?: string;
}

const STORAGE_KEY = 'sodex-alerts';

function loadAlerts(): PriceAlert[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: PriceAlert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch {
    // Storage might be full
  }
}

export const Alerts: React.FC = () => {
  const [alerts, setAlerts] = useState<PriceAlert[]>(loadAlerts);
  const [newSymbol, setNewSymbol] = useState('BTC-USDC');
  const [newCondition, setNewCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [newPrice, setNewPrice] = useState('');
  const [newMarket, setNewMarket] = useState<'spot' | 'perps'>('perps');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateAlerts = useCallback((updated: PriceAlert[]) => {
    setAlerts(updated);
    saveAlerts(updated);
  }, []);

  const addAlert = useCallback(() => {
    const price = parseFloat(newPrice);
    if (!newSymbol.trim() || isNaN(price) || price <= 0) {
      toast.error('Gecerli bir sembol ve fiyat girin');
      return;
    }

    const alert: PriceAlert = {
      id: crypto.randomUUID(),
      symbol: newSymbol.trim().toUpperCase(),
      condition: newCondition,
      targetPrice: price,
      market: newMarket,
      triggered: false,
      createdAt: new Date().toLocaleString('tr-TR'),
    };

    updateAlerts([alert, ...alerts]);
    setNewPrice('');
    toast.success(`Alarm eklendi: ${alert.symbol} ${alert.condition === 'ABOVE' ? '>' : '<'} ${price}`);
  }, [newSymbol, newCondition, newPrice, newMarket, alerts, updateAlerts]);

  const removeAlert = useCallback((id: string) => {
    updateAlerts(alerts.filter((a) => a.id !== id));
  }, [alerts, updateAlerts]);

  const clearTriggered = useCallback(() => {
    updateAlerts(alerts.filter((a) => !a.triggered));
  }, [alerts, updateAlerts]);

  // Poll prices and check alerts
  useEffect(() => {
    const checkAlerts = async () => {
      const activeAlerts = alerts.filter((a) => !a.triggered);
      if (activeAlerts.length === 0) return;

      const markets = new Set(activeAlerts.map((a) => a.market));
      const priceMap: Record<string, number> = {};

      for (const market of markets) {
        try {
          const tickers = await fetchBookTickers(market);
          const arr = Array.isArray(tickers) ? tickers : [];
          for (const item of arr) {
            const t = item as Record<string, unknown>;
            const bid = parseFloat(String(t.bidPrice ?? t.bid ?? '0'));
            const ask = parseFloat(String(t.askPrice ?? t.ask ?? '0'));
            if (t.symbol) {
              priceMap[`${String(t.symbol)}_${market}`] = (bid + ask) / 2;
            }
          }
        } catch {
          // Skip failed market
        }
      }

      let hasChanges = false;
      const updated = alerts.map((alert) => {
        if (alert.triggered) return alert;

        const key = `${alert.symbol}_${alert.market}`;
        const price = priceMap[key];
        if (price == null) return alert;

        const shouldTrigger =
          (alert.condition === 'ABOVE' && price >= alert.targetPrice) ||
          (alert.condition === 'BELOW' && price <= alert.targetPrice);

        if (shouldTrigger) {
          hasChanges = true;
          const direction = alert.condition === 'ABOVE' ? 'yukari' : 'asagi';
          toast(
            `${alert.symbol} ${direction} alarmi tetiklendi! Fiyat: ${price.toFixed(2)}`,
            { icon: '🔔', duration: 10_000 },
          );

          // Try browser notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`SoDEX Alert: ${alert.symbol}`, {
              body: `Fiyat ${direction} ${alert.targetPrice} seviyesini gecti. Guncel: ${price.toFixed(2)}`,
              icon: '/vite.svg',
            });
          }

          return { ...alert, triggered: true, triggeredAt: new Date().toLocaleString('tr-TR') };
        }

        return alert;
      });

      if (hasChanges) {
        updateAlerts(updated);
      }
    };

    pollRef.current = globalThis.setInterval(checkAlerts, 5000);
    checkAlerts(); // Initial check

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [alerts, updateAlerts]);

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const activeCount = alerts.filter((a) => !a.triggered).length;
  const triggeredCount = alerts.filter((a) => a.triggered).length;

  return (
    <div className="p-4 md:p-6 h-[calc(100vh-52px)] flex flex-col gap-5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Bell size={20} className="text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Fiyat Alarmlari</h2>
            <p className="text-[11px] text-text-muted">
              {activeCount} aktif, {triggeredCount} tetiklenmis
            </p>
          </div>
        </div>
        {triggeredCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clearTriggered}>
            Tetiklenenleri Temizle
          </Button>
        )}
      </div>

      {/* Add Alert Form */}
      <Card className="shrink-0">
        <div className="flex items-center gap-2 mb-4">
          <Plus size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">Yeni Alarm</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
          <Input
            label="Sembol"
            type="text"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            placeholder="BTC-USDC"
          />
          <Select
            label="Kosul"
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value as 'ABOVE' | 'BELOW')}
            options={[
              { value: 'ABOVE', label: 'Yukari Gecerse (>)' },
              { value: 'BELOW', label: 'Asagi Gecerse (<)' },
            ]}
          />
          <Input
            label="Hedef Fiyat"
            type="number"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            placeholder="50000"
          />
          <Select
            label="Piyasa"
            value={newMarket}
            onChange={(e) => setNewMarket(e.target.value as 'spot' | 'perps')}
            options={[
              { value: 'perps', label: 'Perps' },
              { value: 'spot', label: 'Spot' },
            ]}
          />
          <Button variant="primary" onClick={addAlert} icon={<Plus size={14} />}>
            Ekle
          </Button>
        </div>
      </Card>

      {/* Alerts List */}
      <div className="flex-1 min-h-0 glass-card flex flex-col overflow-hidden p-0">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Tum Alarmlar
          </span>
          <span className="badge badge-primary">{alerts.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {alerts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm py-16">
              <div className="text-center">
                <Bell size={32} className="mx-auto mb-3 opacity-30" />
                <p>Henuz alarm eklenmedi.</p>
                <p className="text-xs mt-1">Yukardaki formu kullanarak fiyat alarmi ekleyin.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={cn(
                    'flex items-center gap-4 px-5 py-3.5 transition-colors',
                    alert.triggered
                      ? 'bg-success/5 hover:bg-success/10'
                      : 'hover:bg-surface-hover/30',
                  )}
                >
                  {/* Icon */}
                  <div className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                    alert.triggered ? 'bg-success/10 text-success' : 'bg-surface-hover text-text-muted',
                  )}>
                    {alert.triggered ? (
                      <Volume2 size={16} />
                    ) : alert.condition === 'ABOVE' ? (
                      <ArrowUp size={16} />
                    ) : (
                      <ArrowDown size={16} />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{alert.symbol}</span>
                      <span className={`badge ${alert.condition === 'ABOVE' ? 'badge-success' : 'badge-danger'}`}>
                        {alert.condition === 'ABOVE' ? '> Yukari' : '< Asagi'}
                      </span>
                      <span className="badge badge-neutral">{alert.market}</span>
                    </div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {alert.triggered
                        ? `Tetiklendi: ${alert.triggeredAt}`
                        : `Olusturulma: ${alert.createdAt}`}
                    </div>
                  </div>

                  {/* Target Price */}
                  <div className="text-right">
                    <div className="font-mono tabular-nums text-sm font-semibold">
                      {alert.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </div>
                    {alert.triggered && (
                      <span className="badge badge-success text-[10px]">Tetiklendi</span>
                    )}
                  </div>

                  {/* Delete */}
                  <button
                    onClick={() => removeAlert(alert.id)}
                    className="text-text-muted hover:text-danger transition-colors p-1.5 rounded-lg hover:bg-danger/10"
                    title="Alarmi sil"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Info Banner */}
      <div className="shrink-0 flex items-start gap-2 p-3 bg-info/5 border border-info/20 rounded-lg">
        <AlertCircle size={14} className="text-info shrink-0 mt-0.5" />
        <p className="text-xs text-info leading-relaxed">
          Alarmlar tarayiciniz acik oldugu surece calisir. Sayfa kapatildiginda fiyat izleme durur.
          Bildirim izni vererek tarayici bildirimlerini aktif edebilirsiniz.
        </p>
      </div>
    </div>
  );
};
