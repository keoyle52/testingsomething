import React, { useEffect, useState } from 'react';
import { Select } from './Input';
import { fetchSymbols } from '../../api/services';

/**
 * Trading-pair dropdown that pulls the **live symbol list** straight
 * from SoDEX so the user can never type an invalid symbol.
 *
 * Why this exists:
 *   - SoDEX testnet uses test-token aliases (e.g. `vBTC-vUSDC`,
 *     `vETH-vUSDC`) that don't match canonical mainnet names, so a
 *     hard-coded `BTC_USDC` default fails on testnet. By fetching the
 *     authoritative list, the dropdown always reflects what the
 *     exchange actually exposes.
 *   - Free-text symbol inputs in the original bot pages put the
 *     burden on the user to know exact venue spelling. Replacing them
 *     with this component makes onboarding zero-friction.
 *
 * Behaviour:
 *   - Pulls symbols on mount + whenever `market` flips.
 *   - When the current `value` is not in the freshly-loaded list (e.g.
 *     user just switched spot↔perps) the component auto-selects the
 *     first available pair and notifies the parent via `onChange`.
 *     This keeps the bot config in a valid state at all times.
 *   - Falls back to a small canned list if the API call fails so the
 *     UI is never empty.
 */
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
  /** Limit the dropdown to N most-prominent pairs. Defaults to 100 —
   *  enough to cover the long tail without blowing up the panel. */
  maxOptions?: number;
}

/** Hard-coded fallback if the API call fails. Conservative — only
 *  pairs that exist on every venue we know of. The component reaches
 *  this branch only if `fetchSymbols` throws or returns nothing. */
const FALLBACK = {
  spot:  ['BTC_USDC', 'ETH_USDC', 'SOL_USDC'],
  perps: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
};

export const SymbolSelector: React.FC<SymbolSelectorProps> = ({
  value,
  onChange,
  market,
  label = 'Symbol',
  disabled,
  maxOptions = 100,
}) => {
  const [pairs, setPairs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Refresh whenever the market changes — spot and perps have entirely
  // different symbol universes and an in-flight stale list would mix them.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await fetchSymbols(market);
        if (cancelled) return;
        const names = (list as Array<Record<string, unknown>>)
          .map((s) => String(s.symbol ?? ''))
          .filter(Boolean);
        const finalList = names.length > 0 ? names.slice(0, maxOptions) : FALLBACK[market];
        setPairs(finalList);

        // If the parent's selected value isn't in this market's list —
        // e.g. user just toggled from perps "BTC-USD" to spot — pull
        // it back to the first valid option so the UI never sits on a
        // value the venue would reject.
        if (!finalList.includes(value)) {
          onChange(finalList[0]);
        }
      } catch {
        // Network down or auth missing → use canned list. Better a
        // working default than a frozen UI.
        const finalList = FALLBACK[market];
        setPairs(finalList);
        if (!finalList.includes(value)) onChange(finalList[0]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // We deliberately exclude `value` and `onChange` from the deps —
    // the effect's job is to refresh on market change, not on every
    // user pick. The auto-correction inside the effect runs once per
    // refresh which is exactly what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, maxOptions]);

  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      options={
        loading
          ? [{ value: value || '__loading__', label: 'Loading pairs…' }]
          : pairs.map((s) => ({ value: s, label: s }))
      }
    />
  );
};
