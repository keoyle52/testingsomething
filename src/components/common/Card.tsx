import React from 'react';
import { cn } from './NumberDisplay';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  glow?: 'primary' | 'success' | 'danger';
  padding?: boolean;
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  hover = false,
  glow,
  padding = true,
}) => {
  return (
    <div
      className={cn(
        'glass-card',
        hover && 'glass-card-hover transition-all duration-300',
        glow === 'primary' && 'glow-primary',
        glow === 'success' && 'glow-success',
        glow === 'danger' && 'glow-danger',
        padding && 'p-4',
        className,
      )}
    >
      {children}
    </div>
  );
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  icon,
  trend,
  className,
}) => {
  return (
    <div className={cn('stat-card group', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-text-secondary uppercase tracking-wider mb-2">{label}</div>
          <div className={cn(
            'text-xl font-semibold font-mono tabular-nums truncate',
            trend === 'up' && 'text-success',
            trend === 'down' && 'text-danger',
          )}>
            {value}
          </div>
        </div>
        {icon && (
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0 group-hover:bg-primary/15 transition-colors">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
};
