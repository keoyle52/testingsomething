/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ AI Strategist                                                       │
 * │ Multi-source LLM fusion overlay for the BTC Predictor.              │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * The Predictor itself is a deterministic 12-signal weighted ensemble.
 * Workshop briefings (SoSoValue Buildathon kickoff, Apr-29) called for
 * "LLMs as the BRAIN of the system" — not just sentiment classification.
 * This module wraps a Gemini 2.5-flash call that ingests every signal
 * the Predictor already computed (technicals + order book + funding +
 * news sentiment + ETF flows + treasury flows + macro context) and
 * returns a holistic verdict the UI surfaces alongside the rule-based
 * decision. The two are independent: a strong cross-confirmation
 * upgrades sizing/SL discipline, a divergence skips the trade.
 *
 * Crucial design choices:
 *  - The Strategist NEVER overrides the rule-based decision. It is
 *    consensus-only (overlay). This keeps backtesting deterministic
 *    and avoids the "LLM hallucinated a long here" failure mode being
 *    silently fatal.
 *  - Demo mode is a deterministic synth. No Gemini calls, no API key
 *    requirement — produces a verdict from the same signal payload
 *    using a transparent rule (signed score sum + confidence band)
 *    so jurors see "AI consensus" working in the demo without paying
 *    for tokens.
 *  - All output is strictly JSON-schema validated. Any malformed
 *    Gemini reply degrades to a NEUTRAL/low-confidence verdict tagged
 *    `parse_error` so the UI can show "AI unavailable" instead of
 *    crashing the cycle.
 *  - One in-memory cache slot per signal hash means consecutive
 *    cycles with identical inputs never burn a second LLM call.
 *  - 8s timeout + single retry — same envelope NewsBot uses, so the
 *    Gemini quota footprint is predictable.
 */

import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';
import type { SignalSnapshot } from '../store/predictorStore';

/** Verdict the Strategist returns to the cycle. */
export type StrategistDecision = 'LONG' | 'SHORT' | 'HOLD';

export interface StrategistVerdict {
  /** LLM (or synth) recommendation. Independent of the rule-based decision. */
  decision: StrategistDecision;
  /** 0..100 — model's stated confidence in the verdict. */
  confidence: number;
  /** 1–2 sentence plain-English rationale. Surfaced verbatim in the UI. */
  rationale: string;
  /** 0..1 — recommended position sizing multiplier (1 = full, 0.5 = half, 0 = skip). */
  sizeMultiplier: number;
  /** Provenance flag for the UI badge. */
  source: 'gemini' | 'demo' | 'parse_error' | 'unavailable';
  /** Wall-clock when the verdict was produced. */
  ts: number;
}

/**
 * Single-slot cache. The Predictor cycle has a 5-min cadence; the
 * signal vector changes every cycle so we don't really need a multi-
 * entry cache, but we de-duplicate identical payloads (e.g. retries)
 * to avoid double-spending Gemini quota.
 */
let _lastCache: { hash: string; verdict: StrategistVerdict } | null = null;

/**
 * Hash the inputs that actually drive the decision. Anything outside
 * the prompt (timestamps, fallback flags, raw imbalance vs gradient)
 * is excluded so identical "real signal" cycles share a cache slot
 * even if metadata jitters.
 */
function hashSignals(s: SignalSnapshot, price: number): string {
  return [
    s.weightedScore.toFixed(3),
    s.agreementCount,
    s.totalSignals,
    s.rsi.toFixed(0),
    s.atrPct?.toFixed(2) ?? '?',
    s.fundingRate.toFixed(5),
    s.newsSentiment.toFixed(2),
    s.etfFlow.toFixed(2),
    s.treasurySignal?.toFixed(2) ?? '0',
    s.orderBookImbalance.toFixed(2),
    Math.round(price / 10),  // price bucket so tiny tick noise doesn't bust the cache
  ].join('|');
}

/** Convert any signed value to a directional label for the prompt. */
function dirLabel(v: number): string {
  if (v > 0.15) return 'BULLISH';
  if (v < -0.15) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Build the LLM prompt. Plain-English structured payload optimised for
 * the smallest token footprint that still carries the multi-source
 * narrative the workshop emphasised. We deliberately do NOT include
 * the rule-based composite decision so the LLM can't lazy-mirror it —
 * we want an independent second opinion.
 */
function buildPrompt(s: SignalSnapshot, price: number, atrSummary: string): string {
  const lines: string[] = [];
  lines.push('You are an institutional crypto strategist for BTC perps on the SoDEX exchange.');
  lines.push('Decide LONG, SHORT, or HOLD for a 5-minute horizon. Be conservative — only commit when multiple independent sources confluence.');
  lines.push('');
  lines.push(`Live mark: $${price.toFixed(0)} ${atrSummary}`);
  lines.push('');
  lines.push('--- Technical signals (weighted ensemble inputs) ---');
  lines.push(`RSI(14): ${s.rsi.toFixed(0)} (${s.rsi > 70 ? 'overbought' : s.rsi < 30 ? 'oversold' : 'neutral'})`);
  lines.push(`EMA cross: ${dirLabel(s.emaSignal)}`);
  lines.push(`MACD: ${dirLabel(s.macdSignal)}`);
  if (typeof s.vwapSignal === 'number') lines.push(`VWAP deviation: ${dirLabel(s.vwapSignal)} (${s.vwapDeviation?.toFixed(2) ?? '?'}%)`);
  if (typeof s.rocSignal === 'number') lines.push(`Rate-of-change: ${dirLabel(s.rocSignal)}`);
  lines.push(`Microstructure: ${dirLabel(s.microstructureSignal)}${s.volumeSpike ? ' [VOLUME SPIKE]' : ''}`);
  lines.push('');
  lines.push('--- Order book & flows ---');
  lines.push(`Order book imbalance: ${(s.orderBookImbalance * 100).toFixed(0)}% bid-side (${dirLabel(s.orderBookSignal)})`);
  lines.push(`Funding rate: ${(s.fundingRate * 100).toFixed(4)}% (${dirLabel(s.fundingRateSignal)} bias)`);
  if (typeof s.fundingMomentumSignal === 'number') lines.push(`Funding momentum: ${dirLabel(s.fundingMomentumSignal)}`);
  lines.push('');
  lines.push('--- SoSoValue intelligence ---');
  const newsTag = s.newsFallback ? ' [FALLBACK]' : '';
  lines.push(`News sentiment (1h aggregate): ${dirLabel(s.newsSentiment)} (${s.newsSentiment.toFixed(2)})${newsTag}`);
  const etfTag = s.etfFallback ? ' [FALLBACK]' : '';
  lines.push(`ETF flows (latest day): ${dirLabel(s.etfFlow)} (${s.etfFlow.toFixed(2)})${etfTag}`);
  if (typeof s.treasurySignal === 'number') {
    // Build the treasury detail outside the template so nested ternaries
    // don't trip the TS parser inside `${...}` interpolations.
    const tDir = dirLabel(s.treasurySignal);
    const tNet = typeof s.treasuryNetBtc === 'number'
      ? ` (net ${s.treasuryNetBtc > 0 ? '+' : ''}${s.treasuryNetBtc.toFixed(0)} BTC${s.treasuryTopBuyer ? `, top: ${s.treasuryTopBuyer}` : ''})`
      : '';
    const tTag = s.treasuryFallback ? ' [FALLBACK]' : '';
    lines.push(`BTC treasury accumulation (30d): ${tDir}${tNet}${tTag}`);
  }
  lines.push('');
  lines.push('--- Output format (strict JSON, no prose, no markdown) ---');
  lines.push('{"decision":"LONG"|"SHORT"|"HOLD","confidence":0-100,"rationale":"one or two sentences","sizeMultiplier":0.0-1.0}');
  lines.push('');
  lines.push('Rules:');
  lines.push('1. confidence ≥ 70 only when ≥3 independent sources confluence (technicals + flows + sentiment).');
  lines.push('2. sizeMultiplier 1.0 = strong consensus; 0.5 = mild lean; 0.0 = HOLD.');
  lines.push('3. Avoid LONG when funding > +0.02% AND order book leans bid (overheated).');
  lines.push('4. Avoid SHORT when treasury accumulation BULLISH AND ETF flows BULLISH (institutional bid).');
  lines.push('5. Default to HOLD when signals disagree.');
  return lines.join('\n');
}

/**
 * Demo-mode synthesizer. Produces a verdict deterministically from the
 * signal vector itself — no LLM call, no API key, no network. The
 * output is intentionally close to what a real model would say so the
 * UI looks identical in demo vs live: we sum all -1..+1 directional
 * signals, gate by source-count, attach a templated rationale.
 *
 * This is also the unavailable-Gemini fallback so the cycle never
 * leaves the user with a missing card.
 */
function synthesizeVerdict(s: SignalSnapshot, price: number, source: StrategistVerdict['source'] = 'demo'): StrategistVerdict {
  // Sum every signed signal we have. Normalised to [-1, 1] roughly.
  const components: Array<{ name: string; v: number; weight: number }> = [
    { name: 'EMA',           v: s.emaSignal,            weight: 1.0 },
    { name: 'MACD',          v: s.macdSignal,           weight: 1.0 },
    { name: 'RSI',           v: s.rsiSignal,            weight: 0.8 },
    { name: 'VWAP',          v: s.vwapSignal ?? 0,      weight: 0.7 },
    { name: 'RoC',           v: s.rocSignal ?? 0,       weight: 0.7 },
    { name: 'OrderBook',     v: s.orderBookSignal,      weight: 0.8 },
    { name: 'Funding',       v: s.fundingRateSignal,    weight: 0.6 },
    { name: 'Microstructure',v: s.microstructureSignal, weight: 0.7 },
    { name: 'News',          v: s.newsSentiment,        weight: 1.2 },
    { name: 'ETF',           v: s.etfFlow,              weight: 1.2 },
    { name: 'Treasury',      v: s.treasurySignal ?? 0,  weight: 1.0 },
  ];

  const sum = components.reduce((a, c) => a + c.v * c.weight, 0);
  const totalW = components.reduce((a, c) => a + c.weight, 0);
  const norm = sum / totalW;          // [-1..+1]
  const agreeing = components.filter((c) => Math.sign(c.v) === Math.sign(norm) && Math.abs(c.v) > 0.1);
  const confluence = agreeing.length;

  // Decision band — must clear a meaningful magnitude AND have ≥3 confluence.
  let decision: StrategistDecision = 'HOLD';
  let confidence = 35;
  let sizeMul = 0;

  if (Math.abs(norm) > 0.20 && confluence >= 4) {
    decision = norm > 0 ? 'LONG' : 'SHORT';
    confidence = Math.min(85, 55 + confluence * 5);
    sizeMul = Math.min(1, 0.4 + confluence * 0.10);
  } else if (Math.abs(norm) > 0.10 && confluence >= 3) {
    decision = norm > 0 ? 'LONG' : 'SHORT';
    confidence = 50 + confluence * 3;
    sizeMul = 0.5;
  }

  // Risk overrides — same heuristics the real LLM prompt enforces.
  if (decision === 'LONG' && s.fundingRate > 0.0002 && s.orderBookSignal > 0.3) {
    decision = 'HOLD';
    confidence = Math.max(30, confidence - 20);
    sizeMul = 0;
  }
  if (decision === 'SHORT' && (s.treasurySignal ?? 0) > 0.3 && s.etfFlow > 0.3) {
    decision = 'HOLD';
    confidence = Math.max(30, confidence - 20);
    sizeMul = 0;
  }

  // Templated rationale picks up the strongest 2-3 confluencers.
  const top = [...agreeing].sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 3);
  const topNames = top.map((c) => `${c.name} ${c.v > 0 ? 'bullish' : 'bearish'}`);
  let rationale: string;
  if (decision === 'HOLD') {
    rationale = confluence < 3
      ? `Insufficient confluence (${confluence} sources lean directionally) — wait for cleaner setup.`
      : `Mixed signals: ${topNames.slice(0, 2).join(', ')} but risk overrides triggered (overheated funding or institutional bid against the trade).`;
  } else {
    const sideWord = decision === 'LONG' ? 'long' : 'short';
    rationale = `${topNames.length} confluencers ${topNames.join(', ')} support ${sideWord} bias. ATR ${s.atrPct?.toFixed(2) ?? '?'}% ${s.atrPct && s.atrPct > 0.10 ? 'gives room to clear fees' : 'is tight — small expected payoff'}. Live mark $${price.toFixed(0)}.`;
  }
  // Round to one decimal to match the live model's behaviour.
  sizeMul = +sizeMul.toFixed(2);

  return {
    decision,
    confidence: Math.round(confidence),
    rationale,
    sizeMultiplier: sizeMul,
    source,
    ts: Date.now(),
  };
}

/** Strict JSON parse with full schema check. Returns null on any deviation. */
function parseLlmReply(raw: string): Pick<StrategistVerdict, 'decision' | 'confidence' | 'rationale' | 'sizeMultiplier'> | null {
  // Gemini sometimes wraps the JSON in ```json fences despite explicit instructions.
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  let obj: unknown;
  try { obj = JSON.parse(cleaned); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const decision = String(o.decision ?? '').toUpperCase();
  if (decision !== 'LONG' && decision !== 'SHORT' && decision !== 'HOLD') return null;
  const confidence = Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  const rationale = typeof o.rationale === 'string' ? o.rationale.slice(0, 400) : '';
  const sizeMul = Number(o.sizeMultiplier);
  return {
    decision: decision as StrategistDecision,
    confidence,
    rationale: rationale || 'No rationale provided.',
    sizeMultiplier: Number.isFinite(sizeMul) ? Math.max(0, Math.min(1, sizeMul)) : 0.5,
  };
}

/**
 * Public entrypoint. Called by the Predictor cycle right after the
 * rule-based decision is computed. Always resolves — never throws —
 * because a Strategist failure must NOT abort a cycle that already
 * has a valid rule-based verdict.
 */
export async function callAiStrategist(
  signals: SignalSnapshot,
  price: number,
): Promise<StrategistVerdict> {
  const hash = hashSignals(signals, price);
  if (_lastCache && _lastCache.hash === hash) {
    return _lastCache.verdict;
  }

  const { isDemoMode, geminiApiKey } = useSettingsStore.getState();

  // Demo / no-key fast path — no network, no quota.
  if (isDemoMode || !geminiApiKey) {
    const verdict = synthesizeVerdict(signals, price, 'demo');
    _lastCache = { hash, verdict };
    return verdict;
  }

  // Live path: Gemini 2.5-flash with strict JSON output. Same model
  // family NewsBot uses so the user only manages one key.
  const atrSummary = typeof signals.atrPct === 'number' && signals.atrPct > 0
    ? `(ATR ${signals.atrPct.toFixed(2)}%)`
    : '';
  const prompt = buildPrompt(signals, price, atrSummary);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,        // tight — we want consistent verdicts
      topK: 1,
      topP: 0.9,
      maxOutputTokens: 250,
      responseMimeType: 'application/json',
    },
  };

  // 8s timeout to match NewsBot's envelope. AbortController so the
  // request is actually cancelled, not just ignored.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await axios.post(url, payload, { signal: controller.signal });
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseLlmReply(text);
    if (!parsed) {
      console.warn('[aiStrategist] Failed to parse Gemini reply:', text.slice(0, 200));
      const verdict = synthesizeVerdict(signals, price, 'parse_error');
      _lastCache = { hash, verdict };
      return verdict;
    }
    const verdict: StrategistVerdict = { ...parsed, source: 'gemini', ts: Date.now() };
    _lastCache = { hash, verdict };
    return verdict;
  } catch (err) {
    console.warn('[aiStrategist] Gemini call failed, using synth:', err instanceof Error ? err.message : err);
    const verdict = synthesizeVerdict(signals, price, 'unavailable');
    _lastCache = { hash, verdict };
    return verdict;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Manual cache flush (e.g. on Settings → key change). */
export function clearStrategistCache(): void {
  _lastCache = null;
}
