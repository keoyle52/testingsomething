import React, { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time, ColorType } from 'lightweight-charts';
import { fetchKlines } from '../api/services';
import { cn } from './common/NumberDisplay';

interface TradingChartProps {
  symbol: string;
  market?: 'spot' | 'perps';
  height?: number;
  className?: string;
}

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export const TradingChart: React.FC<TradingChartProps> = ({
  symbol,
  market = 'perps',
  height = 400,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [interval, setInterval] = useState<string>('1h');
  const [loading, setLoading] = useState(true);

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
  }, [height]);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      setLoading(true);
      try {
        const rawKlines = await fetchKlines(symbol, interval, 200, market);
        if (cancelled || !seriesRef.current) return;

        const klines = Array.isArray(rawKlines) ? rawKlines : [];
        const candlesticks: CandlestickData<Time>[] = klines.map((k: any) => ({
          time: (typeof k.time === 'number' ? k.time / 1000 : Math.floor(new Date(k.time ?? k.openTime ?? k[0]).getTime() / 1000)) as Time,
          open: parseFloat(k.open ?? k[1]),
          high: parseFloat(k.high ?? k[2]),
          low: parseFloat(k.low ?? k[3]),
          close: parseFloat(k.close ?? k[4]),
        }));

        if (candlesticks.length > 0) {
          seriesRef.current.setData(candlesticks);
          chartRef.current?.timeScale().fitContent();
        }
      } catch {
        // Chart data load failed silently
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadData();
    const timer = globalThis.setInterval(loadData, 30_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, interval, market]);

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
              onClick={() => setInterval(iv)}
              className={cn(
                'px-2 py-1 text-[10px] rounded-md transition-all duration-200',
                interval === iv
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
