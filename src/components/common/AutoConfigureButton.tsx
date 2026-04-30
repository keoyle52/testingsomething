import React, { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { Sparkles } from 'lucide-react';
import { cn, getErrorMessage } from '../../lib/utils';
import { buildContext, type RecommendationResult } from '../../api/aiAutoConfig';

/**
 * Reusable "AI Auto-Configure" button for every bot page.
 *
 * Wires three things together:
 *   1. `buildContext(symbol, market)` — fetches a market snapshot
 *      (24× 1h klines + L1 book) so the recommender has the data it
 *      needs without each bot page duplicating fetch boilerplate.
 *   2. A bot-specific `recommender(ctx)` — returns a `Preset` plus a
 *      plain-English `rationale` describing *why* those values were
 *      chosen.
 *   3. `onApply(preset)` — owner-supplied callback that pushes the
 *      preset values into the bot's store. The button doesn't know
 *      anything about the underlying field names, which is what
 *      keeps it reusable.
 *
 * The toast carries the rationale (7-second hold) so the user gets
 * an educational moment ("ah, the high ATR is why it picked
 * geometric spacing") instead of feeling like values appeared by
 * magic.
 *
 * The button auto-disables while a bot is running — changing
 * parameters mid-run would diverge live state from configured state
 * in confusing ways. The owner passes `disabled` to enforce this.
 */
interface AutoConfigureButtonProps {
  /** Trading pair, e.g. "BTC_USDC". */
  symbol: string;
  /** Spot vs perps — recommender may behave differently for each. */
  market: 'spot' | 'perps';
  /** Bot-specific preset recommender. Pure function — no side effects. */
  recommender: (ctx: Awaited<ReturnType<typeof buildContext>>) => RecommendationResult;
  /** Owner-supplied applier — called with the preset on success. */
  onApply: (preset: Record<string, string | number>) => void;
  /** When true (e.g. while the bot is running), the button is hidden
   *  entirely. Hiding rather than disabling avoids the visual noise
   *  of a permanently-greyed button on a running-bot screen. */
  hidden?: boolean;
}

export const AutoConfigureButton: React.FC<AutoConfigureButtonProps> = ({
  symbol, market, recommender, onApply, hidden,
}) => {
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const ctx = await buildContext(symbol, market);
      const result = recommender(ctx);
      onApply(result.preset);
      toast.success(result.rationale, { duration: 7_000 });
    } catch (err) {
      toast.error(`Auto-configure failed: ${getErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }, [symbol, market, recommender, onApply]);

  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className={cn(
        'group relative flex items-center justify-between gap-3 px-4 py-3 rounded-xl w-full',
        'bg-gradient-to-r from-fuchsia-500/15 via-violet-500/12 to-cyan-500/15',
        'border border-fuchsia-400/30 hover:border-fuchsia-400/50',
        'shadow-[0_0_12px_rgba(217,70,239,0.15)] hover:shadow-[0_0_18px_rgba(217,70,239,0.3)]',
        'transition-all duration-200',
        busy && 'opacity-60 cursor-wait',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-fuchsia-500/30 to-cyan-400/30 border border-fuchsia-400/40 flex items-center justify-center">
          <Sparkles size={13} className="text-fuchsia-200" />
        </div>
        <div className="text-left">
          <div className="text-[11px] font-bold uppercase tracking-wider bg-gradient-to-r from-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            AI Auto-Configure
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            Smart defaults from current market
          </div>
        </div>
      </div>
      {busy ? (
        <div className="w-3 h-3 border-2 border-fuchsia-400/60 border-t-transparent rounded-full animate-spin" />
      ) : (
        <span className="text-[10px] text-fuchsia-300 font-mono group-hover:translate-x-0.5 transition-transform">→</span>
      )}
    </button>
  );
};
