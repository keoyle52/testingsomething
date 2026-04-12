import React from 'react';
import { cn } from './NumberDisplay';

interface StatusBadgeProps {
  status: 'STOPPED' | 'RUNNING' | 'ERROR';
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className }) => {
  const getStyles = () => {
    switch (status) {
      case 'RUNNING':
        return 'bg-success/20 text-success border-success/30';
      case 'ERROR':
        return 'bg-danger/20 text-danger border-danger/30';
      case 'STOPPED':
      default:
        return 'bg-surface text-text-secondary border-border';
    }
  };

  return (
    <div className={cn('px-2 py-1 text-xs uppercase font-medium border rounded-md', getStyles(), className)}>
      {status}
    </div>
  );
};
