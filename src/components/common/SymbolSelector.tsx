import React, { useEffect } from 'react';
import { Select } from './Input';

interface SymbolSelectorProps {
  /** Currently-selected symbol (e.g. "BTC-USD" or "vBTC-vUSDC"). */
  value: string;
  /** Called when the user picks a different symbol OR when the list
   *  refreshes and the previously-selected symbol no longer exists. */
  onChange: (next: string) => void;
  /** Trading venue. Determines the API endpoint + the auto-default
   *  fallback list. */
  market: 'spot' | 'perps';
  /** Optional label rendered above the dropdown (defaults to "Symbol"). */
  label?: string;
  /** Disables interaction (e.g. while a bot is running). */
  disabled?: boolean;
}

const SPOT_OPTIONS = [
  { value: 'vBTC-vUSDC', label: 'BTC-USDC' },
  { value: 'vETH-vUSDC', label: 'ETH-USDC' },
  { value: 'vSOL-vUSDC', label: 'SOL-USDC' },
  { value: 'vSOSO-vUSDC', label: 'SOSO-USDC' },
];

const PERPS_OPTIONS = [
  { value: 'BTC-USD', label: 'BTC-USD' },
  { value: 'ETH-USD', label: 'ETH-USD' },
  { value: 'SOL-USD', label: 'SOL-USD' },
  { value: 'SOSO-USD', label: 'SOSO-USD' },
];

export const SymbolSelector: React.FC<SymbolSelectorProps> = ({
  value,
  onChange,
  market,
  label = 'Trading Pair',
  disabled,
}) => {
  const options = market === 'spot' ? SPOT_OPTIONS : PERPS_OPTIONS;

  // If market changes and the current value is not in the new market's options, auto-select the first valid one.
  useEffect(() => {
    const isValid = options.some(opt => opt.value === value);
    if (!isValid) {
      onChange(options[0].value);
    }
  }, [market, value, onChange, options]);

  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      options={options}
    />
  );
};
