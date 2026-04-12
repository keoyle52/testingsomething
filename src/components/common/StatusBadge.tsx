import React from 'react';
import { cn } from './NumberDisplay';

interface StatusBadgeProps {
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className }) => {
  const config = {
    RUNNING: {
      dotColor: 'bg-success',
      text: 'RUNNING',
      badgeClass: 'badge-success',
    },
    ERROR: {
      dotColor: 'bg-danger',
      text: 'ERROR',
      badgeClass: 'badge-danger',
    },
    STOPPED: {
      dotColor: 'bg-text-muted',
      text: 'STOPPED',
      badgeClass: 'badge-neutral',
    },
  }[status];

  return (
    <div className={cn('badge', config.badgeClass, className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', config.dotColor, status === 'RUNNING' && 'animate-pulse-dot')} />
      {config.text}
    </div>
  );
};
