import React from 'react';
import { cn } from '../../lib/utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  icon?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({
  label,
  hint,
  icon,
  className,
  ...props
}) => {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
            {icon}
          </div>
        )}
        <input
          className={cn(
            'w-full bg-background/60 border border-border rounded-lg px-3 py-2.5 text-sm text-text-primary',
            'placeholder:text-text-muted transition-all duration-200',
            'hover:border-border-hover',
            icon && 'pl-9',
            className,
          )}
          {...props}
        />
      </div>
      {hint && (
        <p className="text-[10px] text-text-muted">{hint}</p>
      )}
    </div>
  );
};

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

export const Select: React.FC<SelectProps> = ({
  label,
  options,
  className,
  ...props
}) => {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wider">
          {label}
        </label>
      )}
      <select
        className={cn(
          'w-full bg-background/60 border border-border rounded-lg px-3 py-2.5 text-sm text-text-primary',
          'transition-all duration-200 hover:border-border-hover appearance-none cursor-pointer',
          className,
        )}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export const Toggle: React.FC<ToggleProps> = ({ label, description, checked, onChange }) => {
  return (
    <div
      className="flex items-center justify-between p-3.5 bg-background/40 border border-border rounded-lg hover:border-border-hover transition-colors cursor-pointer"
      onClick={() => onChange(!checked)}
    >
      <div>
        <span className="text-sm text-text-primary">{label}</span>
        {description && <p className="text-[10px] text-text-muted mt-0.5">{description}</p>}
      </div>
      <div className={cn(
        'w-11 h-6 rounded-full relative transition-all duration-300 shrink-0',
        checked ? 'bg-primary' : 'bg-border',
      )}>
        <div className={cn(
          'w-4 h-4 rounded-full bg-white absolute top-1 transition-all duration-300 shadow-sm',
          checked ? 'left-6' : 'left-1',
        )} />
      </div>
    </div>
  );
};
