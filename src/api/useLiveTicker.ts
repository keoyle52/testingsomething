import { useEffect, useRef, useState } from 'react';
import { wsService } from './websocket';
import { useSettingsStore } from '../store/settingsStore';
import { getDemoLivePrice } from './demoData';

export interface LiveTicker {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
  markPrice?: number;
}

// ─── Demo mode: simulates live price ticks every 2s ─────────────────────────
function useDemoTickers(initialTickers: LiveTicker[]): LiveTicker[] {
  const [tickers, setTickers] = useState<LiveTicker[]>(initialTickers);
  const baseRef = useRef(initialTickers);

  useEffect(() => {
    baseRef.current = initialTickers;
    setTickers(initialTickers);
  }, [initialTickers]);

  useEffect(() => {
    if (baseRef.current.length === 0) return;
    const interval = setInterval(() => {
      setTickers((prev) =>
        prev.map((t) => ({
          ...t,
          lastPrice: getDemoLivePrice(t.lastPrice),
          markPrice: getDemoLivePrice(t.lastPrice),
        }))
      );
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return tickers;
}

// ─── Real WebSocket mode ─────────────────────────────────────────────────────
function useWsTickers(symbols: string[], isTestnet: boolean): LiveTicker[] {
  const [tickers, setTickers] = useState<Map<string, LiveTicker>>(new Map());

  useEffect(() => {
    if (symbols.length === 0) return;

    wsService.connect(isTestnet);

    // Subscribe to mini-ticker for all symbols
    const unsubs = symbols.map((sym) => {
      const channelParam = JSON.stringify({ channel: 'miniTicker', symbols: [sym] });
      return wsService.subscribe(channelParam, (raw) => {
        const data = raw as Record<string, unknown>;
        const payload = (data.data ?? data) as Record<string, unknown>;
        const symbol = String(payload.s ?? payload.symbol ?? sym);
        const lastPrice = parseFloat(String(payload.c ?? payload.lastPrice ?? payload.close ?? 0));
        const change24h = parseFloat(String(payload.P ?? payload.priceChangePercent ?? payload.change ?? 0));
        const volume24h = parseFloat(String(payload.q ?? payload.quoteVolume ?? payload.volume ?? 0));
        const markPrice = parseFloat(String(payload.mp ?? payload.markPrice ?? lastPrice));

        if (lastPrice > 0) {
          setTickers((prev) => {
            const next = new Map(prev);
            next.set(symbol, { symbol, lastPrice, change24h, volume24h, markPrice });
            return next;
          });
        }
      });
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [symbols.join(','), isTestnet]);

  return Array.from(tickers.values());
}

// ─── Public Hook ─────────────────────────────────────────────────────────────
/**
 * Returns live ticker data.
 * - In demo mode: simulates price ticks from mock data every 2s.
 * - In live mode: subscribes to SoDEX WebSocket miniTicker channel.
 */
export function useLiveTicker(
  initialTickers: LiveTicker[],
  symbols: string[],
): LiveTicker[] {
  const { isDemoMode, isTestnet } = useSettingsStore();

  const demoTickers = useDemoTickers(isDemoMode ? initialTickers : []);
  const wsTickers   = useWsTickers(isDemoMode ? [] : symbols, isTestnet);

  if (isDemoMode) return demoTickers;

  // Merge: ws data overrides initial where available, fall back to initial
  if (wsTickers.length > 0) {
    const wsMap = new Map(wsTickers.map((t) => [t.symbol, t]));
    return initialTickers.map((t) => wsMap.get(t.symbol) ?? t);
  }

  return initialTickers;
}

// ─── Single symbol price hook ────────────────────────────────────────────────
/**
 * Tracks a single symbol's live price.
 * Returns null until a price arrives.
 */
export function useLivePrice(symbol: string, fallback = 0): number {
  const { isDemoMode, isTestnet } = useSettingsStore();
  const [price, setPrice] = useState(fallback);
  const baseRef = useRef(fallback);

  useEffect(() => {
    baseRef.current = fallback > 0 ? fallback : baseRef.current;
  }, [fallback]);

  // Demo mode: tick every 1.5s
  useEffect(() => {
    if (!isDemoMode || baseRef.current === 0) return;
    const interval = setInterval(() => {
      setPrice(getDemoLivePrice(baseRef.current));
    }, 1500);
    return () => clearInterval(interval);
  }, [isDemoMode]);

  // WS mode
  useEffect(() => {
    if (isDemoMode || !symbol) return;
    wsService.connect(isTestnet);
    const channelParam = JSON.stringify({ channel: 'miniTicker', symbols: [symbol] });
    const unsub = wsService.subscribe(channelParam, (raw) => {
      const data = raw as Record<string, unknown>;
      const payload = (data.data ?? data) as Record<string, unknown>;
      const lp = parseFloat(String(payload.c ?? payload.lastPrice ?? payload.close ?? 0));
      if (lp > 0) {
        setPrice(lp);
        baseRef.current = lp;
      }
    });
    return () => unsub();
  }, [symbol, isTestnet, isDemoMode]);

  return price;
}
