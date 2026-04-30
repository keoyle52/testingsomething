/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ AI Strategy Orchestrator                                            │
 * │ Regime-aware bot recommendation engine.                             │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Workshop note: SoSoValue Buildathon called for "agentic" UX where the
 * AI does more than parrot signals — it actively *picks* the right
 * tool for the moment. This module classifies the current BTC regime
 * (volatility, trend, news intensity, funding skew) and recommends
 * which of our four strategy bots is the best fit, with pre-filled
 * parameters.
 *
 * The orchestrator runs PURELY on already-fetched market data — no new
 * API calls — so it can be invoked freely from the Dashboard without
 * adding rate-limit pressure on SoSoValue or SoDEX.
 *
 * Decision tree (in priority order):
 *  1. Sideways + low vol  →  Grid Bot (geometric, tight spacing)
 *  2. Strong trend         →  DCA Bot (buy-the-dip in uptrend, scaled
 *                              short distribution in downtrend) OR
 *                              BTC Predictor if trend confirmed by AI
 *  3. High news activity   →  News Bot (event-driven scalping)
 *  4. Volatile choppy      →  TWAP Bot (slice large size, volatility
 *                              guard reduces market-impact risk)
 *  5. No clear regime      →  Predictor only, low-conviction reminder
 *
 * Output is a deterministic recommendation card the Dashboard renders
 * with a one-click "Deploy" link that pre-fills the chosen bot's UI.
 *
 * This module intentionally does NOT call an LLM. The reasoning is
 * fully transparent (rule-based) so the Dashboard always renders fast
 * and the recommendation is reproducible. The AI Console can layer LLM
 * narrative on top via its tool calls if the user asks "why?".
 */

export type Regime =
  | 'low_vol_range'      // calm sideways — grid harvest IV
  | 'strong_uptrend'     // clean trending up
  | 'strong_downtrend'   // clean trending down
  | 'choppy_volatile'    // wide range, high noise
  | 'news_driven'        // breaking news intensity
  | 'mixed';             // no clean regime

export type RecommendedBot = 'grid' | 'dca' | 'twap' | 'news' | 'predictor';

export interface RegimeInputs {
  /** ATR(14) on 1-min as a % of price. Bigger = more volatile. */
  atrPct: number;
  /** Last 24h change in %. Sign = direction. */
  change24hPct: number;
  /** Funding rate in raw form (e.g. 0.0001 = 1 bp). */
  fundingRate: number;
  /** EMA cross signal -1..+1 (positive = bullish trend). */
  emaSignal: number;
  /** MACD signal -1..+1. */
  macdSignal: number;
  /** News count in the last hour from SoSoValue. Optional — defaults to 0. */
  recentNewsCount?: number;
  /** Aggregate news sentiment -1..+1 (bullish). Optional. */
  newsSentiment?: number;
  /** Predictor's last AI Strategist confidence 0-100. Optional. */
  aiConfidence?: number;
}

export interface BotRecommendation {
  /** Top-pick bot for the current regime. */
  bot: RecommendedBot;
  /** Detected regime — drives the rationale. */
  regime: Regime;
  /** 0-100 — how confident the orchestrator is in this regime/bot match. */
  confidence: number;
  /** 1-2 sentence rationale, plain English. */
  rationale: string;
  /** Pre-fill suggestions the Dashboard "Deploy" button can pass through
   *  the URL query string to the bot's page. Bot-specific keys. */
  presets: Record<string, string | number>;
  /** Secondary alternative pick — useful for "or you could…" UI affordance. */
  alternative?: { bot: RecommendedBot; reason: string };
}

/**
 * Pure regime classifier. Deterministic — same inputs always yield the
 * same regime label.
 */
export function classifyRegime(inp: RegimeInputs): Regime {
  const atr = inp.atrPct;
  const ch  = inp.change24hPct;
  const trendStrength = (Math.abs(inp.emaSignal) + Math.abs(inp.macdSignal)) / 2;
  const newsCount = inp.recentNewsCount ?? 0;

  // News-driven first — even an otherwise calm market with a breaking
  // catalyst should route to NewsBot before anything else.
  if (newsCount >= 4 && Math.abs(inp.newsSentiment ?? 0) >= 0.3) {
    return 'news_driven';
  }

  // Volatile choppy: high ATR but no clean trend direction.
  if (atr >= 0.20 && trendStrength < 0.30) {
    return 'choppy_volatile';
  }

  // Strong directional trend — both technicals + 24h move agree.
  if (trendStrength >= 0.50 && Math.abs(ch) >= 1.5) {
    return ch > 0 ? 'strong_uptrend' : 'strong_downtrend';
  }

  // Calm ranging market.
  if (atr < 0.15 && Math.abs(ch) < 1.5) {
    return 'low_vol_range';
  }

  return 'mixed';
}

/**
 * Convert a regime + the raw inputs into a concrete bot recommendation
 * with pre-filled launch parameters.
 *
 * Pre-fill choices are deliberately conservative — the user can always
 * tighten them on the bot's page. This lowers the cognitive cost of
 * the "click → launch" UX while keeping risk bounded.
 */
export function recommendBot(inp: RegimeInputs, price: number): BotRecommendation {
  const regime = classifyRegime(inp);

  switch (regime) {
    case 'low_vol_range': {
      // Geometric grid centred on current price. Range = ±3% (calm
      // markets stay within that with high probability over a 24h
      // window). 30 levels = ~0.2% per rung which clears fees comfortably.
      const lower = +(price * 0.97).toFixed(0);
      const upper = +(price * 1.03).toFixed(0);
      return {
        bot: 'grid',
        regime,
        confidence: 75,
        rationale:
          'Calm sideways market — a Grid Bot harvests IV inside the range. Geometric spacing keeps profit-per-grid constant across price levels.',
        presets: {
          mode: 'geometric',
          lower,
          upper,
          levels: 30,
          investUsdt: 200,
        },
        alternative: {
          bot: 'predictor',
          reason: 'The score-margin gate forces most cycles to NEUTRAL in sideways markets; the grid is more productive.',
        },
      };
    }

    case 'strong_uptrend': {
      return {
        bot: 'dca',
        regime,
        confidence: 70,
        rationale:
          'Clean uptrend — a Buy-the-Dip DCA captures pullbacks and keeps the average entry low. If the Predictor agrees, you can run it alongside.',
        presets: {
          mode: 'buy-the-dip',
          intervalMin: 30,
          amountPerOrder: 50,
          maxOrders: 20,
          dipPct: 0.8,           // only buy after 0.8% local pullback
        },
        alternative: {
          bot: 'predictor',
          reason: inp.aiConfidence && inp.aiConfidence >= 70
            ? `AI Strategist agrees at ${inp.aiConfidence}% confidence — you can let Predictor auto-trade fire on the next signal.`
            : 'Recent Predictor cycles have low conviction — DCA is the safer pick.',
        },
      };
    }

    case 'strong_downtrend': {
      return {
        bot: 'predictor',
        regime,
        confidence: 65,
        rationale:
          'Clean downtrend — the Predictor will lean SHORT and the ATR-scaled stop bounds tail risk. A short-mode DCA is an option, but the Predictor reacts faster to maintain momentum.',
        presets: {
          autoTrade: 'on',
          tradeAmountUsdt: '50',
          tradeLeverage: 3,
          stopLossEnabled: 'on',
        },
        alternative: {
          bot: 'twap',
          reason: 'If you need to slice out of an existing long, TWAP\'s volatility guard reduces market impact on exit.',
        },
      };
    }

    case 'choppy_volatile': {
      return {
        bot: 'twap',
        regime,
        confidence: 60,
        rationale:
          'Choppy volatile market — a single large order fills at a poor average. TWAP\'s time/size jitter + price-band guard captures a fair average price.',
        presets: {
          orderType: 'limit',
          slices: 12,
          intervalSec: 60,
          totalUsdt: 1000,
          priceBandPct: 0.5,   // skip slice if price > 0.5% off TWAP target
        },
        alternative: {
          bot: 'grid',
          reason: 'If the range is forecastable, a wide geometric grid (±5%) increases harvest.',
        },
      };
    }

    case 'news_driven': {
      return {
        bot: 'news',
        regime,
        confidence: 70,
        rationale:
          'Heavy news flow — the News Bot scalps headline reactions with Gemini AI sentiment. TP/SL/hold-time guards prevent over-holding.',
        presets: {
          mode: 'ai',
          marginUsdt: 20,
          leverage: 5,
          holdMinutes: 5,
          takeProfitPct: 1.5,
          stopLossPct: 0.8,
        },
        alternative: {
          bot: 'predictor',
          reason: 'Pair them: run Predictor on low leverage and let News Bot scalp aggressively on headlines.',
        },
      };
    }

    case 'mixed':
    default: {
      // Soft default — point user at the Predictor since its score-margin
      // gate naturally filters bad regimes itself, plus surface "or use
      // AI Console for advice" as the alternative.
      return {
        bot: 'predictor',
        regime: 'mixed',
        confidence: 45,
        rationale:
          'No clean regime detected — the Predictor\'s score-margin gate already turns NEUTRAL on weak setups. Ask the AI Console for a deeper read if you want detail.',
        presets: {
          autoTrade: 'on',
          tradeAmountUsdt: '50',
          tradeLeverage: 3,
        },
      };
    }
  }
}

/** Map a recommendation to the destination route + query string for the
 *  Dashboard's Deploy button. The bot pages don't currently consume
 *  these query params, but having the route keyed centrally makes it
 *  cheap to wire up later without touching the orchestrator caller. */
export function recommendationLink(rec: BotRecommendation): string {
  const route =
    rec.bot === 'grid'      ? '/grid-bot' :
    rec.bot === 'dca'       ? '/dca-bot' :
    rec.bot === 'twap'      ? '/twap-bot' :
    rec.bot === 'news'      ? '/news-bot' :
    rec.bot === 'predictor' ? '/btc-predictor' :
                              '/dashboard';
  // Encode presets as a `preset=` query param — bot pages can opt-in
  // to read it later. Keeping it base64-style avoids URL-encoding
  // long objects with curly braces.
  try {
    const json = JSON.stringify(rec.presets);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    return `${route}?preset=${encoded}`;
  } catch {
    return route;
  }
}

/** Friendly label for UI badges. */
export function regimeLabel(r: Regime): string {
  switch (r) {
    case 'low_vol_range':    return 'Calm Range';
    case 'strong_uptrend':   return 'Strong Uptrend';
    case 'strong_downtrend': return 'Strong Downtrend';
    case 'choppy_volatile':  return 'Choppy Volatile';
    case 'news_driven':      return 'News Driven';
    case 'mixed':            return 'Mixed';
  }
}

/** Friendly label for the bot pick. */
export function botLabel(b: RecommendedBot): string {
  switch (b) {
    case 'grid':      return 'Grid Bot';
    case 'dca':       return 'DCA Bot';
    case 'twap':      return 'TWAP Bot';
    case 'news':      return 'News Bot';
    case 'predictor': return 'BTC Predictor';
  }
}
