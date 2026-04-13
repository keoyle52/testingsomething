import React from 'react';
import { cn } from '../../lib/utils';

type ButtonVariant = 'primary' | 'danger' | 'ghost' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-black font-semibold hover:bg-primary-soft shadow-sm shadow-primary/20 hover:shadow-primary/30',
  danger: 'bg-danger/10 text-danger border border-danger/30 font-medium hover:bg-danger/20',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
  outline: 'border border-border text-text-secondary hover:text-text-primary hover:border-border-hover hover:bg-surface-hover',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-md gap-1.5',
  md: 'px-4 py-2.5 text-sm rounded-lg gap-2',
  lg: 'px-6 py-3.5 text-base rounded-xl gap-2.5',
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  icon,
  loading,
  fullWidth,
  children,
  className,
  disabled,
  ...props
}) => {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center font-medium transition-all duration-200 active:scale-[0.98]',
        variantStyles[variant],
        sizeStyles[size],
        fullWidth && 'w-full',
        (disabled || loading) && 'opacity-50 cursor-not-allowed pointer-events-none',
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : icon}
      {children}
    </button>
  );
};
