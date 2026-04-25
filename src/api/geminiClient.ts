import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';

export type Sentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

// In-memory sentiment cache. The classification of a fixed headline does
// not drift — a 60-minute TTL is generous and lets the same article
// surface across NewsBot polls + the BtcPredictor news scoring without
// double-billing Gemini. The size cap prevents the map from growing
// unbounded across long sessions; oldest entry is evicted when full.
const _sentimentCache = new Map<string, { sentiment: Sentiment; ts: number }>();
const SENTIMENT_CACHE_TTL  = 60 * 60_000;
const SENTIMENT_CACHE_MAX  = 500;

function cacheKey(title: string): string {
  return title.trim().toLowerCase();
}

function evictOldestIfFull(): void {
  if (_sentimentCache.size < SENTIMENT_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of _sentimentCache) {
    if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey) _sentimentCache.delete(oldestKey);
}

/** Manually flush the sentiment cache (e.g. on Settings → API key change). */
export function clearSentimentCache(): void {
  _sentimentCache.clear();
}

export async function analyzeSentiment(title: string): Promise<Sentiment> {
  // Cache check first — avoid hitting Gemini for a headline we've already
  // classified within the TTL window.
  const key = cacheKey(title);
  const cached = _sentimentCache.get(key);
  if (cached && Date.now() - cached.ts < SENTIMENT_CACHE_TTL) {
    return cached.sentiment;
  }

  const { geminiApiKey } = useSettingsStore.getState();
  
  if (!geminiApiKey) {
    throw new Error('Gemini API key is not set in Settings.');
  }

  // gemini-1.5-flash was retired by Google in late 2025 (returns 404). The
  // 2.5 family is the current low-cost / low-latency tier and is well
  // suited to single-word sentiment classification. Keep this in sync with
  // https://ai.google.dev/gemini-api/docs/models — when 2.5 is itself
  // retired, bump to the latest -flash alias.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;

  const prompt = `Analyze the potential crypto market sentiment for this news headline. 
Return ONLY one of these three words: BULLISH, BEARISH, or NEUTRAL. 
Do not provide any explanation or other text.

Headline: "${title}"`;

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.1,
      topK: 1,
      topP: 1,
      maxOutputTokens: 10,
    }
  };

  try {
    const res = await axios.post(url, payload);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()?.toUpperCase();

    const sentiment: Sentiment =
      text?.includes('BULLISH') ? 'BULLISH' :
      text?.includes('BEARISH') ? 'BEARISH' :
      'NEUTRAL';

    // Persist the classification so callers within the TTL skip Gemini.
    evictOldestIfFull();
    _sentimentCache.set(key, { sentiment, ts: Date.now() });
    return sentiment;
  } catch (err: unknown) {
    console.error('Gemini API Error:', err);
    throw new Error('Failed to analyze sentiment with Gemini AI.');
  }
}
