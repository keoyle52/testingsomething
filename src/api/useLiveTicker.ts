import { useEffect, useRef, useState } from 'react';
import { wsService } from './websocket';
import { useSettingsStore } from '../store/settingsStore';
import { subscribeToDemoTicks, getDemoTickers } from './demoEngine';

export interface LiveTicker {
  symbol: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
  markPrice?: number;
}

// ─── Demo mode: subscribe to the demo engine's per-tick notification ─────────
function useDemoTickers(): LiveTicker[] {
  const [tickers, setTickers] = useState<LiveTicker[]>(() => mapDemoSnapshot());

  useEffect(() => {
    // Initial snapshot + live subscription. The engine is started elsewhere
    // in the app boot sequence when `isDemoMode` flips on.
    setTickers(mapDemoSnapshot());
    const unsub = subscribeToDemoTicks(() => {
      setTickers(mapDemoSnapshot());
    });
    return unsub;
  }, []);

  return tickers;
}

function mapDemoSnapshot(): LiveTicker[] {
  const rows = getDemoTickers('perps');
  return rows.map((t) => ({
    symbol: t.symbol,
    lastPrice: t.lastPrice,
    change24h: t.priceChangePercent,
    volume24h: parseFloat(String(t.quoteVolume)),
    markPrice: t.markPrice,
  }));
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
 * - In demo mode: simulates price ticks from mock data every 2s.
 * - In live mode: subscribes to SoDEX WebSocket miniTicker channel.
 */
export function useLiveTicker(
  initialTickers: LiveTicker[],
  symbols: string[],
): LiveTicker[] {
  const { isDemoMode, isTestnet } = useSettingsStore();

  const demoTickers = useDemoTickers();
  const wsTickers   = useWsTickers(isDemoMode ? [] : symbols, isTestnet);

  if (isDemoMode) {
    // Ensure that consumers that seed from `initialTickers` still see only
    // the requested symbol set if any; otherwise return the full feed.
    if (initialTickers.length === 0) return demoTickers;
    const byKey = new Map(demoTickers.map((t) => [t.symbol, t]));
    return initialTickers.map((t) => byKey.get(t.symbol) ?? t);
  }

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

  // Demo mode: subscribe to the engine tick for the requested symbol.
  useEffect(() => {
    if (!isDemoMode || !symbol) return;
    const readFromEngine = () => {
      const rows = getDemoTickers('perps');
      const target = rows.find((t) => t.symbol === symbol);
      if (target && target.lastPrice > 0) {
        setPrice(target.lastPrice);
        baseRef.current = target.lastPrice;
      }
    };
    readFromEngine();
    const unsub = subscribeToDemoTicks(readFromEngine);
    return unsub;
  }, [isDemoMode, symbol]);

  // WS mode
  useEffect(() => {
    if (isDemoMode || !symbol) return;
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
  }, [symbol, isTestnet, isDemoMode]);

  return price;
}
