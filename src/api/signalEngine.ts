/**
 * Signal Engine — client-side technical analysis calculator.
 * No external dependencies — all indicators computed from raw kline data.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type SignalType = 'RSI' | 'MACD' | 'BB' | 'EMA_CROSS' | 'STOCH_RSI' | 'VOLUME_SPIKE' | 'CUSTOM';

export interface SignalConfig {
  id: string;
  type: SignalType;
  enabled: boolean;
  label: string;
  description: string;
  params: Record<string, number>;
  /** Only for CUSTOM signals — user-provided JS expression */
  customExpression?: string;
}

export interface SignalResult {
  id: string;
  type: SignalType;
  label: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  strength: number;    // 0–100
  value: number;       // primary indicator value (RSI number, MACD histogram, etc.)
  threshold: number;   // trigger threshold used
  description: string; // human-readable explanation
}

export type CombineMode = 'ANY' | 'ALL' | 'MAJORITY';

export interface CombinedDecision {
  action: 'LONG' | 'SHORT' | 'NONE';
  signals: SignalResult[];
  reasoning: string;
}

// ── Default Presets ──────────────────────────────────────────────────

export const SIGNAL_PRESETS: Omit<SignalConfig, 'id'>[] = [
  {
    type: 'RSI',
    enabled: true,
    label: 'RSI',
    description: 'Relative Strength Index — oversold/overbought reversals',
    params: { period: 14, oversold: 30, overbought: 70 },
  },
  {
    type: 'MACD',
    enabled: true,
    label: 'MACD',
    description: 'Moving Average Convergence Divergence — trend momentum',
    params: { fast: 12, slow: 26, signal: 9 },
  },
  {
    type: 'BB',
    enabled: false,
    label: 'Bollinger Bands',
    description: 'Price deviation from moving average — mean-reversion',
    params: { period: 20, stdDev: 2 },
  },
  {
    type: 'EMA_CROSS',
    enabled: false,
    label: 'EMA Crossover',
    description: 'Fast/slow EMA crossover — trend following',
    params: { fast: 9, slow: 21 },
  },
  {
    type: 'STOCH_RSI',
    enabled: false,
    label: 'Stochastic RSI',
    description: 'RSI of RSI — high-sensitivity momentum oscillator',
    params: { period: 14, kPeriod: 3, dPeriod: 3, oversold: 20, overbought: 80 },
  },
  {
    type: 'VOLUME_SPIKE',
    enabled: false,
    label: 'Volume Spike',
    description: 'Abnormal volume with directional candle confirmation',
    params: { multiplier: 2, lookback: 20 },
  },
];

export function createDefaultSignals(): SignalConfig[] {
  return SIGNAL_PRESETS.map((p, i) => ({
    ...p,
    id: `signal-${p.type}-${i}`,
  }));
}

let _customCounter = 0;
export function createCustomSignal(): SignalConfig {
  _customCounter++;
  return {
    id: `custom-${Date.now()}-${_customCounter}`,
    type: 'CUSTOM',
    enabled: true,
    label: `Custom Signal ${_customCounter}`,
    description: 'User-defined signal expression',
    params: { threshold: 0 },
    customExpression: '// Available: rsi(14), ema(9), sma(20), close, open, high, low, volume\n// Return: 1 for LONG, -1 for SHORT, 0 for NEUTRAL\nreturn rsi(14) < 25 ? 1 : rsi(14) > 75 ? -1 : 0;',
  };
}

// ── Math Helpers ─────────────────────────────────────────────────────

function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    if (isNaN(prev)) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j];
      prev = sum / period;
    } else {
      prev = data[i] * k + prev * (1 - k);
    }
    result.push(prev);
  }
  return result;
}

function stdDev(data: number[], period: number): number[] {
  const means = sma(data, period);
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (isNaN(means[i])) { result.push(NaN); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = data[j] - means[i];
      sumSq += diff * diff;
    }
    result.push(Math.sqrt(sumSq / period));
  }
  return result;
}

// ── Indicator Calculators ────────────────────────────────────────────

function calcRSI(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function calcMACD(closes: number[], fast: number, slow: number, signalP: number) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) { macdLine.push(NaN); continue; }
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalLine = ema(validMacd, signalP);
  // Re-align signal line
  const offset = macdLine.length - validMacd.length;
  const fullSignal: number[] = new Array(offset).fill(NaN).concat(signalLine);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(macdLine[i]) || isNaN(fullSignal[i])) { histogram.push(NaN); continue; }
    histogram.push(macdLine[i] - fullSignal[i]);
  }
  return { macdLine, signalLine: fullSignal, histogram };
}

function calcBB(closes: number[], period: number, mult: number) {
  const middle = sma(closes, period);
  const sd = stdDev(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i])) { upper.push(NaN); lower.push(NaN); continue; }
    upper.push(middle[i] + sd[i] * mult);
    lower.push(middle[i] - sd[i] * mult);
  }
  return { upper, middle, lower };
}

function calcStochRSI(closes: number[], rsiPeriod: number, kPeriod: number, dPeriod: number) {
  const rsiArr = calcRSI(closes, rsiPeriod);
  const stochK: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(rsiArr[i]) || i < rsiPeriod + kPeriod - 1) continue;
    let minRSI = Infinity, maxRSI = -Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (isNaN(rsiArr[j])) { minRSI = NaN; break; }
      minRSI = Math.min(minRSI, rsiArr[j]);
      maxRSI = Math.max(maxRSI, rsiArr[j]);
    }
    if (isNaN(minRSI) || maxRSI === minRSI) continue;
    stochK[i] = ((rsiArr[i] - minRSI) / (maxRSI - minRSI)) * 100;
  }
  const validK = stochK.filter(v => !isNaN(v));
  const dLine = sma(validK, dPeriod);
  const offset = stochK.length - validK.length;
  const fullD: number[] = new Array(offset).fill(NaN).concat(dLine);
  return { k: stochK, d: fullD };
}

// ── Signal Evaluators ────────────────────────────────────────────────

function evalRSI(klines: CandleData[], params: Record<string, number>): SignalResult {
  const closes = klines.map(k => k.close);
  const period = params.period ?? 14;
  const oversold = params.oversold ?? 30;
  const overbought = params.overbought ?? 70;
  const rsi = calcRSI(closes, period);
  const curr = rsi[rsi.length - 1] ?? 50;
  const prev = rsi[rsi.length - 2] ?? 50;
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let desc = `RSI(${period}) = ${curr.toFixed(1)}`;
  let threshold = 50;
  if (prev <= oversold && curr > oversold) {
    direction = 'LONG'; threshold = oversold;
    desc = `RSI crossed above ${oversold} (oversold exit) → LONG`;
  } else if (prev >= overbought && curr < overbought) {
    direction = 'SHORT'; threshold = overbought;
    desc = `RSI crossed below ${overbought} (overbought exit) → SHORT`;
  } else if (curr < oversold) {
    desc += ` — in oversold zone (waiting for exit)`;
  } else if (curr > overbought) {
    desc += ` — in overbought zone (waiting for exit)`;
  }
  const strength = direction !== 'NEUTRAL'
    ? Math.min(100, Math.abs(curr - 50) * 2)
    : 0;
  return { id: '', type: 'RSI', label: 'RSI', direction, strength, value: curr, threshold, description: desc };
}

function evalMACD(klines: CandleData[], params: Record<string, number>): SignalResult {
  const closes = klines.map(k => k.close);
  const { macdLine, signalLine, histogram } = calcMACD(closes, params.fast ?? 12, params.slow ?? 26, params.signal ?? 9);
  const currHist = histogram[histogram.length - 1] ?? 0;
  const prevHist = histogram[histogram.length - 2] ?? 0;
  const currMacd = macdLine[macdLine.length - 1] ?? 0;
  const currSignal = signalLine[signalLine.length - 1] ?? 0;
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let desc = `MACD: ${currMacd.toFixed(4)}, Signal: ${currSignal.toFixed(4)}`;
  if (prevHist <= 0 && currHist > 0) {
    direction = 'LONG';
    desc = `MACD crossed above signal line → LONG`;
  } else if (prevHist >= 0 && currHist < 0) {
    direction = 'SHORT';
    desc = `MACD crossed below signal line → SHORT`;
  }
  return { id: '', type: 'MACD', label: 'MACD', direction, strength: direction !== 'NEUTRAL' ? Math.min(100, Math.abs(currHist) * 10000) : 0, value: currHist, threshold: 0, description: desc };
}

function evalBB(klines: CandleData[], params: Record<string, number>): SignalResult {
  const closes = klines.map(k => k.close);
  const period = params.period ?? 20;
  const mult = params.stdDev ?? 2;
  const { upper, lower } = calcBB(closes, period, mult);
  const curr = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const currLower = lower[lower.length - 1];
  const currUpper = upper[upper.length - 1];
  const prevLower = lower[lower.length - 2];
  const prevUpper = upper[upper.length - 2];
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let desc = `Price: ${curr.toFixed(2)}, BB: [${(currLower ?? 0).toFixed(2)} – ${(currUpper ?? 0).toFixed(2)}]`;
  if (!isNaN(currLower) && !isNaN(prevLower) && prev <= prevLower && curr > currLower) {
    direction = 'LONG';
    desc = `Price bounced off lower Bollinger Band → LONG`;
  } else if (!isNaN(currUpper) && !isNaN(prevUpper) && prev >= prevUpper && curr < currUpper) {
    direction = 'SHORT';
    desc = `Price rejected from upper Bollinger Band → SHORT`;
  }
  const bandWidth = (currUpper ?? 0) - (currLower ?? 0);
  const pctB = bandWidth > 0 ? ((curr - (currLower ?? 0)) / bandWidth) * 100 : 50;
  return { id: '', type: 'BB', label: 'Bollinger Bands', direction, strength: direction !== 'NEUTRAL' ? 70 : 0, value: pctB, threshold: 50, description: desc };
}

function evalEMACross(klines: CandleData[], params: Record<string, number>): SignalResult {
  const closes = klines.map(k => k.close);
  const fast = ema(closes, params.fast ?? 9);
  const slow = ema(closes, params.slow ?? 21);
  const currFast = fast[fast.length - 1];
  const currSlow = slow[slow.length - 1];
  const prevFast = fast[fast.length - 2];
  const prevSlow = slow[slow.length - 2];
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let desc = `EMA(${params.fast ?? 9}): ${(currFast ?? 0).toFixed(2)}, EMA(${params.slow ?? 21}): ${(currSlow ?? 0).toFixed(2)}`;
  if (!isNaN(currFast) && !isNaN(currSlow) && !isNaN(prevFast) && !isNaN(prevSlow)) {
    if (prevFast <= prevSlow && currFast > currSlow) {
      direction = 'LONG';
      desc = `EMA(${params.fast ?? 9}) crossed above EMA(${params.slow ?? 21}) → LONG`;
    } else if (prevFast >= prevSlow && currFast < currSlow) {
      direction = 'SHORT';
      desc = `EMA(${params.fast ?? 9}) crossed below EMA(${params.slow ?? 21}) → SHORT`;
    }
  }
  const diff = (currFast ?? 0) - (currSlow ?? 0);
  return { id: '', type: 'EMA_CROSS', label: 'EMA Cross', direction, strength: direction !== 'NEUTRAL' ? Math.min(100, Math.abs(diff) * 100) : 0, value: diff, threshold: 0, description: desc };
}

function evalStochRSI(klines: CandleData[], params: Record<string, number>): SignalResult {
  const closes = klines.map(k => k.close);
  const { k: kLine, d: dLine } = calcStochRSI(closes, params.period ?? 14, params.kPeriod ?? 3, params.dPeriod ?? 3);
  const oversold = params.oversold ?? 20;
  const overbought = params.overbought ?? 80;
  const currK = kLine[kLine.length - 1] ?? 50;
  const prevK = kLine[kLine.length - 2] ?? 50;
  const currD = dLine[dLine.length - 1] ?? 50;
  const prevD = dLine[dLine.length - 2] ?? 50;
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let desc = `StochRSI K: ${currK.toFixed(1)}, D: ${currD.toFixed(1)}`;
  if (!isNaN(currK) && !isNaN(currD) && !isNaN(prevK) && !isNaN(prevD)) {
    if (currK < oversold && prevK <= prevD && currK > currD) {
      direction = 'LONG';
      desc = `StochRSI K crossed above D in oversold zone → LONG`;
    } else if (currK > overbought && prevK >= prevD && currK < currD) {
      direction = 'SHORT';
      desc = `StochRSI K crossed below D in overbought zone → SHORT`;
    }
  }
  return { id: '', type: 'STOCH_RSI', label: 'Stoch RSI', direction, strength: direction !== 'NEUTRAL' ? 65 : 0, value: currK, threshold: 50, description: desc };
}

function evalVolumeSpike(klines: CandleData[], params: Record<string, number>): SignalResult {
  const multiplier = params.multiplier ?? 2;
  const lookback = params.lookback ?? 20;
  const volumes = klines.map(k => k.volume ?? 0);
  const last = klines[klines.length - 1];
  const currVol = volumes[volumes.length - 1] ?? 0;
  const recentVols = volumes.slice(Math.max(0, volumes.length - 1 - lookback), volumes.length - 1);
  const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  const ratio = avgVol > 0 ? currVol / avgVol : 0;
  let desc = `Volume: ${currVol.toFixed(0)}, Avg: ${avgVol.toFixed(0)} (${ratio.toFixed(1)}×)`;
  if (ratio >= multiplier && last) {
    if (last.close > last.open) {
      direction = 'LONG';
      desc = `Volume spike ${ratio.toFixed(1)}× avg + bullish candle → LONG`;
    } else if (last.close < last.open) {
      direction = 'SHORT';
      desc = `Volume spike ${ratio.toFixed(1)}× avg + bearish candle → SHORT`;
    }
  }
  return { id: '', type: 'VOLUME_SPIKE', label: 'Volume Spike', direction, strength: direction !== 'NEUTRAL' ? Math.min(100, ratio * 30) : 0, value: ratio, threshold: multiplier, description: desc };
}

function evalCustom(klines: CandleData[], config: SignalConfig): SignalResult {
  const expr = config.customExpression ?? 'return 0;';
  const closes = klines.map(k => k.close);
  const result: SignalResult = { id: '', type: 'CUSTOM', label: config.label, direction: 'NEUTRAL', strength: 0, value: 0, threshold: config.params.threshold ?? 0, description: 'Custom signal' };
  try {
    const rsiVal = (p: number) => { const r = calcRSI(closes, p); return r[r.length - 1] ?? 50; };
    const emaVal = (p: number) => { const e = ema(closes, p); return e[e.length - 1] ?? 0; };
    const smaVal = (p: number) => { const s = sma(closes, p); return s[s.length - 1] ?? 0; };
    const last = klines[klines.length - 1];
    // eslint-disable-next-line no-new-func
    const fn = new Function('rsi', 'ema', 'sma', 'close', 'open', 'high', 'low', 'volume', 'klines', expr);
    const val = fn(rsiVal, emaVal, smaVal, last?.close ?? 0, last?.open ?? 0, last?.high ?? 0, last?.low ?? 0, last?.volume ?? 0, klines);
    const numVal = Number(val);
    if (numVal > 0) { result.direction = 'LONG'; result.strength = Math.min(100, numVal * 50); result.description = `Custom: returned ${numVal} → LONG`; }
    else if (numVal < 0) { result.direction = 'SHORT'; result.strength = Math.min(100, Math.abs(numVal) * 50); result.description = `Custom: returned ${numVal} → SHORT`; }
    else { result.description = `Custom: returned ${numVal} → NEUTRAL`; }
    result.value = numVal;
  } catch (err) {
    result.description = `Custom signal error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

// ── Public API ───────────────────────────────────────────────────────

const EVALUATORS: Record<SignalType, (klines: CandleData[], params: Record<string, number>, config?: SignalConfig) => SignalResult> = {
  RSI: evalRSI,
  MACD: evalMACD,
  BB: evalBB,
  EMA_CROSS: evalEMACross,
  STOCH_RSI: evalStochRSI,
  VOLUME_SPIKE: evalVolumeSpike,
  CUSTOM: (klines, _params, config) => evalCustom(klines, config!),
};

/** Evaluate all enabled signals against the latest kline data. */
export function evaluateSignals(klines: CandleData[], configs: SignalConfig[]): SignalResult[] {
  if (klines.length < 30) return []; // not enough data
  return configs
    .filter(c => c.enabled)
    .map(c => {
      const evaluator = EVALUATORS[c.type];
      if (!evaluator) return null;
      const result = evaluator(klines, c.params, c);
      return { ...result, id: c.id };
    })
    .filter((r): r is SignalResult => r !== null);
}

/** Combine individual signal results into a single trading decision. */
export function resolveSignals(results: SignalResult[], mode: CombineMode): CombinedDecision {
  const active = results.filter(r => r.direction !== 'NEUTRAL');
  if (active.length === 0) return { action: 'NONE', signals: results, reasoning: 'No active signals' };

  const longs = active.filter(r => r.direction === 'LONG');
  const shorts = active.filter(r => r.direction === 'SHORT');

  if (mode === 'ANY') {
    // Priority: most recent signal wins — but if both present, stronger wins
    if (longs.length > 0 && shorts.length === 0) return { action: 'LONG', signals: results, reasoning: `ANY mode: ${longs.map(l => l.label).join(', ')} signalling LONG` };
    if (shorts.length > 0 && longs.length === 0) return { action: 'SHORT', signals: results, reasoning: `ANY mode: ${shorts.map(s => s.label).join(', ')} signalling SHORT` };
    // Conflicting — use strength
    const longStr = longs.reduce((s, r) => s + r.strength, 0);
    const shortStr = shorts.reduce((s, r) => s + r.strength, 0);
    if (longStr > shortStr) return { action: 'LONG', signals: results, reasoning: `ANY mode: LONG wins by strength (${longStr.toFixed(0)} vs ${shortStr.toFixed(0)})` };
    if (shortStr > longStr) return { action: 'SHORT', signals: results, reasoning: `ANY mode: SHORT wins by strength (${shortStr.toFixed(0)} vs ${longStr.toFixed(0)})` };
    return { action: 'NONE', signals: results, reasoning: 'Conflicting signals with equal strength' };
  }

  if (mode === 'ALL') {
    if (longs.length === active.length) return { action: 'LONG', signals: results, reasoning: `ALL mode: all ${longs.length} signals agree on LONG` };
    if (shorts.length === active.length) return { action: 'SHORT', signals: results, reasoning: `ALL mode: all ${shorts.length} signals agree on SHORT` };
    return { action: 'NONE', signals: results, reasoning: `ALL mode: signals disagree (${longs.length} LONG, ${shorts.length} SHORT)` };
  }

  // MAJORITY
  const total = active.length;
  const majority = Math.ceil(total / 2);
  if (longs.length >= majority && longs.length > shorts.length) return { action: 'LONG', signals: results, reasoning: `MAJORITY: ${longs.length}/${total} signals say LONG` };
  if (shorts.length >= majority && shorts.length > longs.length) return { action: 'SHORT', signals: results, reasoning: `MAJORITY: ${shorts.length}/${total} signals say SHORT` };
  return { action: 'NONE', signals: results, reasoning: `MAJORITY: no clear majority (${longs.length} LONG, ${shorts.length} SHORT)` };
}

/** Human-readable param labels for UI rendering. */
export const PARAM_LABELS: Record<string, string> = {
  period: 'Period',
  oversold: 'Oversold',
  overbought: 'Overbought',
  fast: 'Fast Period',
  slow: 'Slow Period',
  signal: 'Signal Period',
  stdDev: 'Std Deviation',
  kPeriod: 'K Period',
  dPeriod: 'D Period',
  multiplier: 'Volume Multiplier',
  lookback: 'Lookback',
  threshold: 'Threshold',
};
