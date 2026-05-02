import React, { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time, ColorType, type SeriesMarker } from 'lightweight-charts';
import { fetchKlines } from '../api/services';
import { cn } from '../lib/utils';

interface TradingChartProps {
  symbol: string;
  market?: 'spot' | 'perps';
  height?: number;
  className?: string;
  markers?: SeriesMarker<Time>[];
}

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export const TradingChart: React.FC<TradingChartProps> = ({
  symbol,
  market = 'perps',
  height = 400,
  className,
  markers = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<string>('1h');
  const [loading, setLoading] = useState(true);

  // Initialize chart + series together in one effect to avoid race condition
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#7d8590',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(27,34,48,0.4)' },
        horzLines: { color: 'rgba(27,34,48,0.4)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255,107,0,0.3)', labelBackgroundColor: '#FF6B00' },
        horzLine: { color: 'rgba(255,107,0,0.3)', labelBackgroundColor: '#FF6B00' },
      },
      rightPriceScale: {
        borderColor: 'rgba(27,34,48,0.6)',
      },
      timeScale: {
        borderColor: 'rgba(27,34,48,0.6)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#3fb950',
      downColor: '#f85149',
      borderUpColor: '#3fb950',
      borderDownColor: '#f85149',
      wickUpColor: '#3fb950',
      wickDownColor: '#f85149',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    if (seriesRef.current) {
      (seriesRef.current as any).setMarkers(markers);
    }
  }, [markers]);

  // Load/refresh data whenever symbol, interval, or market changes
  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      setLoading(true);
      try {
        const rawKlines = await fetchKlines(symbol, selectedInterval, 200, market);
        if (cancelled || !seriesRef.current) return;


        const klines = Array.isArray(rawKlines) ? rawKlines : [];

        /** Convert any timestamp value (ms-number, s-number, or string of either) → Unix seconds */
        const toUnixSeconds = (v: unknown): number => {
          const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
          if (!isFinite(n) || n <= 0) return 0;
          // If > 1e12 it is in milliseconds, otherwise already in seconds
          return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
        };

        const candlesticks: CandlestickData<Time>[] = klines
          .map((k: Record<string, unknown>) => {
            const ts = toUnixSeconds(k.time ?? k.openTime ?? k.t);
            const o = parseFloat(String(k.open ?? k.o ?? k.close ?? k.c ?? 0));
            const h = parseFloat(String(k.high ?? k.h ?? k.open ?? k.o ?? 0));
            const l = parseFloat(String(k.low  ?? k.l ?? k.open ?? k.o ?? 0));
            const c = parseFloat(String(k.close ?? k.c ?? k.open ?? k.o ?? 0));
            return { ts, o, h, l, c };
          })
          .filter((x) => x.ts > 0 && x.o > 0 && x.c > 0)
          .sort((a, b) => a.ts - b.ts)
          .map((x) => ({ time: x.ts as Time, open: x.o, high: x.h, low: x.l, close: x.c }));

        if (candlesticks.length > 0 && seriesRef.current) {
          seriesRef.current.setData(candlesticks);
          chartRef.current?.timeScale().fitContent();
        }

      } catch {
        // Chart data load failed silently
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Small delay to ensure chart/series are mounted before first fetch
    const init = setTimeout(loadData, 50);
    const timer = globalThis.setInterval(loadData, 30_000);

    return () => {
      cancelled = true;
      clearTimeout(init);
      clearInterval(timer);
    };
  }, [symbol, selectedInterval, market]);

  return (
    <div className={cn('glass-card p-0 overflow-hidden', className)}>
      {/* Interval Selector */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">{symbol}</span>
          <span className="text-[10px] text-text-muted uppercase">{market}</span>
        </div>
        <div className="flex gap-1">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setSelectedInterval(iv)}
              className={cn(
                'px-2 py-1 text-[10px] rounded-md transition-all duration-200',
                selectedInterval === iv
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover',
              )}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Container */}
      <div className="relative" style={{ height }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-background/50 backdrop-blur-sm">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <div ref={containerRef} className="w-full" style={{ height }} />
      </div>
    </div>
  );
};
