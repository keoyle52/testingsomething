import React from 'react';
import { cn } from '../../lib/utils';

interface NumberDisplayProps {
  value: number | string;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}

export const NumberDisplay: React.FC<NumberDisplayProps> = ({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  trend = 'neutral',
  className,
}) => {
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  const formatted = isNaN(numValue) ? '0.00' : numValue.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const getTrendColor = () => {
    if (trend === 'up') return 'text-success';
    if (trend === 'down') return 'text-danger';
    return 'text-text-primary';
  };

  return (
    <span className={cn('tabular-nums font-mono', getTrendColor(), className)}>
      {prefix}{formatted}{suffix}
    </span>
  );
};
