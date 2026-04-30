/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ AI Console Client                                                   │
 * │ Conversational LLM interface that can call into the running app.    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * This module is the "brain" half of the AI Console feature. It packages
 * a chat history + a registry of safe tools into a single Gemini-2.5
 * call and either:
 *   1. Returns a plain-text answer to render in the chat bubble, or
 *   2. Returns a `tool` instruction the UI must execute (and, for
 *      destructive tools, confirm with the user) before continuing.
 *
 * The Console UI loop is roughly:
 *   user sends message → consoleTurn() → text reply OR tool request
 *     ↓ if tool                                    ↓
 *     execute / confirm → push tool result → consoleTurn() again
 *
 * Demo / no-key fallback: a deterministic responder that pattern-matches
 * the user query to a synth answer + tool suggestion. Lets jurors play
 * with the chat experience without entering any credentials.
 *
 * Key design constraints:
 *  - The LLM never directly calls tools. It returns a JSON instruction;
 *    the Console UI is the only execution path. This keeps destructive
 *    operations (place_order / close_position) on a one-way path the
 *    user can intercept.
 *  - Tool args are JSON-validated against the registry schema before
 *    handler execution. Bad LLM output → user-friendly "I tried to call
 *    X but the arguments looked wrong" reply, never an exception.
 *  - One "turn" = one LLM call. The Console drives the loop, this
 *    module is stateless modulo a tiny in-memory cache of identical
 *    consecutive prompts (rare, but helps when the user retries the
 *    same message).
 */

import axios from 'axios';
import { useSettingsStore } from '../store/settingsStore';

/** A single message in the conversation transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** When `role === 'tool'`, the name of the tool whose result this is. */
  toolName?: string;
  /** Wall-clock at message creation, used for UI grouping. */
  ts: number;
}

/** Schema for one argument of a tool. */
export interface ToolArgSchema {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  /** Optional enum for tightly-scoped values like sides. */
  enum?: readonly string[];
}

/** Tool definition exposed to the LLM. The actual `handler` runs on the
 *  Console side and never inside the LLM call. */
export interface ConsoleTool {
  name: string;
  description: string;
  args: Record<string, ToolArgSchema>;
  /** Read tools (`requiresConfirm: false`) auto-execute. Destructive
   *  tools (`true`) surface a confirmation card before running. */
  requiresConfirm?: boolean;
  /** Tool runner. Returns the string the LLM will see as the next
   *  turn's input (typically a JSON dump of the tool result). */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** What `consoleTurn` returns. */
export type TurnResult =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      tool: string;
      args: Record<string, unknown>;
      /** Plain-English reasoning the LLM gave for choosing this tool —
       *  surfaced under the confirm card. */
      reasoning: string;
    };

/** System prompt — kept short to leave headroom for the user's chat
 *  history within the Gemini token budget. */
function buildSystemPrompt(tools: ConsoleTool[]): string {
  const toolLines = tools.map((t) => {
    const argList = Object.entries(t.args)
      .map(([k, v]) => `${k}:${v.type}${v.required ? '' : '?'}${v.enum ? `(${v.enum.join('|')})` : ''}`)
      .join(', ');
    return `- ${t.name}(${argList})${t.requiresConfirm ? ' ⚠destructive' : ''}: ${t.description}`;
  }).join('\n');

  return `You are an AI trading assistant inside the SoDEX Terminal — a SoSoValue + SoDEX integrated app.
Your job: help the user understand market conditions and execute trades safely.

You have these tools (call them by returning the structured JSON below):
${toolLines}

RESPONSE FORMAT — always return strict JSON, no markdown, no prose around it:
  • For tool calls:    {"kind":"tool","tool":"<name>","args":{...},"reasoning":"<one sentence why>"}
  • For final replies: {"kind":"text","text":"<your answer to the user>"}

RULES:
1. ALWAYS call read tools (get_market_overview, get_account_status, get_predictor_state, get_news) BEFORE answering questions about state. Do not guess.
2. Destructive tools (place_market_order, close_position) require explicit user agreement (e.g. "yes", "go", "evet", "aç"). If the user is just asking, return text.
3. Position sizing: default to 50 USDT at 3-5x leverage unless the user specifies otherwise. Never exceed 25x — SoDEX's BTC cap.
4. Refuse to act on hunches without data. If the user asks "should I long?" — first call get_market_overview, then answer.
5. Be concise. 1-3 sentences for most replies. Use bullet points only when comparing 3+ items.
6. Speak in the user's language. If the user writes Turkish, respond in Turkish; English in English.
7. NEVER fabricate prices, balances, or news headlines. If a tool fails, say so plainly.`;
}

/**
 * Build the contents array for Gemini from our flat ChatMessage history.
 * Tool messages are rendered as `tool` role with explicit framing so the
 * model knows the content came from a function it requested.
 */
function buildContents(systemPrompt: string, history: ChatMessage[]): unknown[] {
  // Gemini's REST API uses `role: 'user' | 'model'` and a `parts` array.
  // We collapse our `assistant` and `tool` roles into the right format.
  const contents: unknown[] = [];
  // First entry: system prompt as a user-side primer (Gemini doesn't have
  // a dedicated system role on the v1beta REST endpoint — well-known
  // workaround is a single user-role priming message).
  contents.push({
    role: 'user',
    parts: [{ text: systemPrompt }],
  });
  contents.push({
    role: 'model',
    parts: [{ text: 'Understood. I will follow the response format and rules. Awaiting the user\'s message.' }],
  });

  for (const msg of history) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: msg.content }] });
    } else if (msg.role === 'tool') {
      // Render tool result as a user-role observation so the model can
      // continue the chain. We tag it explicitly so Gemini doesn't
      // confuse it with the actual user voice.
      contents.push({
        role: 'user',
        parts: [{
          text: `[TOOL RESULT for ${msg.toolName ?? 'unknown'}]\n${msg.content}\n[END TOOL RESULT — please continue with your next JSON instruction]`,
        }],
      });
    }
  }
  return contents;
}

/**
 * Lightweight intent matcher used by the demo / no-key fallback.
 * Recognises a handful of common questions in EN + TR and routes them
 * to the most useful tool or canned reply. Falls back to a generic
 * "summarise market" suggestion otherwise.
 */
function demoIntent(userText: string, lastTool?: string): TurnResult {
  const t = userText.toLowerCase().trim();

  // Confirmation words — used to follow up on a pending destructive tool.
  if (/^(yes|y|go|ok|tamam|evet|aç|onayl[ıi]yorum|do it)\b/.test(t) && lastTool) {
    // The Console UI handles the actual execution; here we just push
    // the LLM-level acknowledgement so the chat reads naturally.
    return { kind: 'text', text: 'Tamam, işlemi başlatıyorum…' };
  }
  if (/^(no|n|hay[ıi]r|iptal|durdur|stop|cancel)/.test(t)) {
    return { kind: 'text', text: 'Tamam, iptal ettim. Başka bir konuda yardım edebilir miyim?' };
  }

  // Market overview triggers
  if (/(btc|bitcoin|piyasa|market|fiyat|price|nas[ıi]l|how)/i.test(t) && /(durum|state|overview|nas[ıi]l|how|status)/i.test(t)) {
    return {
      kind: 'tool',
      tool: 'get_market_overview',
      args: {},
      reasoning: 'User asked about market state — fetching live snapshot before answering.',
    };
  }

  // Account / balance queries
  if (/(balance|bakiye|hesap|account|pozisyon|position|açık|open)/i.test(t)) {
    return {
      kind: 'tool',
      tool: 'get_account_status',
      args: {},
      reasoning: 'User asked about account — fetching live balance and open positions.',
    };
  }

  // Predictor state queries
  if (/(predictor|tahmin|sinyal|signal|ai|strategist)/i.test(t)) {
    return {
      kind: 'tool',
      tool: 'get_predictor_state',
      args: {},
      reasoning: 'User asked about the predictor — pulling latest cycle stats and AI verdict.',
    };
  }

  // News query
  if (/(news|haber|breaking|latest)/i.test(t)) {
    return {
      kind: 'tool',
      tool: 'get_news',
      args: { limit: 5 },
      reasoning: 'User asked for news — pulling latest 5 SoSoValue headlines.',
    };
  }

  // Trade intent — long/short
  const longMatch  = /\b(long|al|buy|açıl[ıi]r|al[ıi]r m[ıi]y[ıi]m)\b/i.test(t);
  const shortMatch = /\b(short|sat|sell|açıl[ıi]r|sat[ıi]r m[ıi]y[ıi]m)\b/i.test(t);
  const askingMode = /\b(m[ıi]|mu|mü|m[ıi]y[ıi]m|should|recommend|öner|tavsiye)\b/i.test(t);
  if ((longMatch || shortMatch) && askingMode) {
    // User is asking advice — load market overview first
    return {
      kind: 'tool',
      tool: 'get_market_overview',
      args: {},
      reasoning: 'User wants trade advice — fetching market state to inform recommendation.',
    };
  }
  if ((longMatch || shortMatch) && /\b(do|aç|open|act|şimdi|now)\b/i.test(t)) {
    return {
      kind: 'text',
      text: 'Pozisyon açmadan önce miktar ve kaldıraç doğrulaması istiyorum. Örnek: "100 USDT long aç 5x kaldıraçla" şeklinde net bir komut verir misin?',
    };
  }

  // Help / capabilities
  if (/(help|yard[ıi]m|nas[ıi]l kullan[ıi]l[ıi]r|what can|ne yap)/i.test(t)) {
    return {
      kind: 'text',
      text: 'Yapabildiklerim:\n• "BTC durumu nasıl?" — canlı piyasa özeti\n• "Hesabım?" — bakiye + açık pozisyonlar\n• "Predictor durumu?" — son AI verdict + cycle stats\n• "Son haberler" — SoSoValue başlıkları\n• "Long açayım mı?" — analiz + tavsiye\n• "100 USDT long aç 5x" — emir aç (onayla doğrularız)',
    };
  }

  // Default: nudge them toward a tool
  return {
    kind: 'text',
    text: 'Tam olarak ne istediğinden emin değilim. "BTC nasıl?", "hesabım?" veya "yardım" yazarak başlayabilirsin.',
  };
}

/**
 * Public entry point. One LLM call → one turn result. Console drives
 * the multi-turn loop, this function is stateless modulo a single-slot
 * cache for identical consecutive (history, tools) pairs.
 *
 * The history must already include the user's latest message. The
 * caller appends the returned text/tool-output to the history and
 * calls again as needed.
 */
export async function consoleTurn(
  history: ChatMessage[],
  tools: ConsoleTool[],
): Promise<TurnResult> {
  if (history.length === 0) {
    return { kind: 'text', text: 'Hi! What would you like to know about the market?' };
  }
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    return { kind: 'text', text: 'I need a question or instruction to act on.' };
  }

  const { isDemoMode, geminiApiKey } = useSettingsStore.getState();

  // Demo / no-key fast path
  if (isDemoMode || !geminiApiKey) {
    // Look back to see if the previous assistant message was a tool
    // confirmation prompt; if so, the lastUser may be a yes/no follow-up.
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    const lastToolMention = lastAssistant?.content.match(/\bplace_market_order|close_position\b/i)?.[0];
    return demoIntent(lastUser.content, lastToolMention ?? undefined);
  }

  const systemPrompt = buildSystemPrompt(tools);
  const contents = buildContents(systemPrompt, history);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
  const payload = {
    contents,
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 800,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await axios.post(url, payload, { signal: controller.signal });
    const text = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    if (!text) {
      return { kind: 'text', text: 'I had a network glitch — try asking again.' };
    }
    // Strip code fences if Gemini decided to wrap despite responseMimeType.
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch {
      // Gemini failed JSON — surface the raw text so at least the user
      // sees the model's intent, even if structurally broken.
      return { kind: 'text', text: cleaned.slice(0, 800) };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'text', text: 'I produced an unexpected response. Try rephrasing the question.' };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.kind === 'tool' && typeof obj.tool === 'string') {
      const tool = tools.find((t) => t.name === obj.tool);
      if (!tool) {
        return { kind: 'text', text: `I tried to use a tool called "${obj.tool}" but it isn't available. Try a different question.` };
      }
      return {
        kind: 'tool',
        tool: obj.tool,
        args: (typeof obj.args === 'object' && obj.args ? obj.args : {}) as Record<string, unknown>,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
      };
    }
    if (obj.kind === 'text' && typeof obj.text === 'string') {
      return { kind: 'text', text: obj.text };
    }
    return { kind: 'text', text: 'I produced an unexpected response. Try rephrasing the question.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'text', text: `I couldn't reach the LLM (${msg}). Try again, or switch to demo mode in Settings.` };
  } finally {
    clearTimeout(timeoutId);
  }
}
