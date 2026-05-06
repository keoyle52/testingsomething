import { useEffect, useRef, useState } from 'react';
import { wsService } from './websocket';
import { useSettingsStore } from '../store/settingsStore';

export interface LiveTicker {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
  markPrice?: number;
}

// ─── Real WebSocket mode ─────────────────────────────────────────────────────
function useWsTickers(symbols: string[], isTestnet: boolean): LiveTicker[] {
  const [tickers, setTickers] = useState<Map<string, LiveTicker>>(new Map());

  useEffect(() => {
    if (symbols.length === 0) return;

    try { wsService.connect(isTestnet); } catch { return; }

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
 * Subscribes to SoDEX WebSocket miniTicker channel.
 */
export function useLiveTicker(
  initialTickers: LiveTicker[],
  symbols: string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _market: 'spot' | 'perps' = 'perps',
): LiveTicker[] {
  const { isTestnet } = useSettingsStore();

  const wsTickers = useWsTickers(symbols, isTestnet);

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
export function useLivePrice(
  symbol: string,
  fallback = 0,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _market: 'spot' | 'perps' = 'perps',
): number {
  const { isTestnet } = useSettingsStore();
  const [price, setPrice] = useState(fallback);
  const baseRef = useRef(fallback);

  useEffect(() => {
    baseRef.current = fallback > 0 ? fallback : baseRef.current;
  }, [fallback]);

  // WS mode
  useEffect(() => {
    if (!symbol) return;
    try { wsService.connect(isTestnet); } catch { return; }
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
  }, [symbol, isTestnet]);

  return price;
}
