# SoDEX Terminal — Project Rules & Architecture Guide

## Project Identity
- **Name**: SoDEX Terminal (`sodex-terminal`)
- **Purpose**: Full-featured crypto trading terminal for the SoDEX DEX (decentralised exchange). Covers trade bots, AI agents, market data/intelligence, and account management.
- **Location**: `c:\Users\Berat\Desktop\Terminal\testingsomething\`

---

## Tech Stack (exact versions)
| Layer | Library | Version |
|---|---|---|
| Framework | React | ^19.2.4 |
| Language | TypeScript | ~6.0.2 |
| Build | Vite | ^8.0.4 |
| Styling | TailwindCSS v4 | ^4.2.2 |
| Routing | React Router v6 | ^6.28.0 |
| State | Zustand | ^5.0.12 |
| HTTP | Axios | ^1.15.0 |
| Charts | lightweight-charts | ^5.1.0 |
| Blockchain | ethers.js | ^6.16.0 |
| Icons | lucide-react | ^1.8.0 |
| Toasts | react-hot-toast | ^2.6.0 |
| Utilities | clsx + tailwind-merge | latest |

---

## Directory Structure
```
src/
  api/           # All API clients, services, AI logic
  components/    # Shared UI components
    common/      # Button, Card, Input, StatusBadge, SymbolSelector, etc.
  pages/         # 23 route-level page components (lazy-loaded)
  store/         # Zustand stores (settings, bot, predictor, botPnl)
  lib/           # Utility functions (cn, getErrorMessage)
  assets/        # Static assets
  App.tsx        # Root: routing, Sidebar, Topbar, demo engine lifecycle
  index.css      # TailwindCSS v4 @theme tokens + global styles
  main.tsx       # ReactDOM.createRoot entry point
```

---

## Key Files — Quick Reference
| File | Role |
|---|---|
| `src/api/services.ts` | Central service layer — all SoDEX REST calls go through here |
| `src/api/perpsClient.ts` | Axios instance for Perps (Bolt) engine, auto-signs writes |
| `src/api/spotClient.ts` | Axios instance for Spot engine, auto-signs writes |
| `src/api/signer.ts` | EIP-712 signing, nonce management, address derivation |
| `src/api/demoEngine.ts` | Full mock engine — simulates all API responses in demo mode |
| `src/api/aiAutoConfig.ts` | Rule-based AI auto-configure for bot parameters |
| `src/api/aiConsoleClient.ts` | Gemini AI chat client for AI Console page |
| `src/api/aiOrchestrator.ts` | Market context builder + AI trade suggestions |
| `src/api/signalEngine.ts` | Technical indicator signal evaluation (EMA, RSI, MACD, etc.) |
| `src/store/settingsStore.ts` | Persisted credentials, network toggle, theme, demo mode |
| `src/store/botStore.ts` | In-memory state for GridBot, MarketMakerBot, SignalBot |
| `src/store/predictorStore.ts` | BTC predictor model state |
| `src/store/botPnlStore.ts` | Cross-bot PnL tracking strip |

---

## API Architecture

### Networks
- **Mainnet**: `https://mainnet-gw.sodex.dev/api/v1/perps` / `.../spot`  
  Chain ID: `286623`
- **Testnet**: `https://testnet-gw.sodex.dev/api/v1/perps` / `.../spot`  
  Chain ID: `138565`

### Authentication — EIP-712 Signing
Every **write** (POST/DELETE) is signed server-side via EIP-712. The pipeline:
1. Wrap body as `{ type: actionType, params: payload }` → `JSON.stringify` (key order matters — must match Go struct field order)
2. `payloadHash = keccak256(JSON string)`
3. Sign `ExchangeAction { payloadHash, nonce }` with engine domain
4. Prepend `0x01` prefix byte → `X-API-Sign` header
5. Also send `X-API-Key` and `X-API-Nonce`

**Key rule**: `signPayload()` in `signer.ts` is the only correct way to sign. Never inline signing logic.

### Credential Model (v2 — dual-network)
```
Mainnet: mainnetApiKeyName + mainnetPrivateKey + mainnetEvmAddress
Testnet: testnetPrivateKey + testnetEvmAddress + testnetApiKeyName (optional)
Active passthrough: apiKeyName / privateKey / evmAddress  ← read these in API clients
```
- **Private keys are NEVER persisted to localStorage** (partialize excludes them)
- Use `resolveApiKey()` from `signer.ts` to get the effective `X-API-Key`
- `setMainnetPrivateKey` / `setTestnetPrivateKey` — use per-network setters, not legacy `setPrivateKey`

### Demo Mode
- `useSettingsStore.getState().isDemoMode` → `true` means all service calls short-circuit to `demoEngine.ts`
- `startDemoEngine()` / `stopDemoEngine()` driven from `App.tsx`
- Every `services.ts` function checks `isDemo()` at the top

---

## State Management (Zustand)

### `useSettingsStore` — persisted
Key fields: `isTestnet`, `theme`, `isDemoMode`, `sosoApiKey`, `geminiApiKey`, credentials per network.  
Always use `resolveActive()` pattern when updating any credential field.

### `useBotStore` — in-memory
Holds: `gridBot`, `marketMakerBot`, `signalBot`  
Pattern: each sub-store has `setField<K>(field, value)` + `resetStats()`  
**Critical**: use `bumpField(field, delta)` for accumulating numeric increments (avoids stale closure bug).

### `useBotPnlStore` — in-memory
Cross-bot PnL strip shown at the top of every bot page.

### `usePredictorStore` — in-memory
BTC Predictor model training state.

---

## UI / Styling Rules

### TailwindCSS v4 Custom Tokens (defined in `index.css @theme`)
```
Colors:
  background    #0C0C0E (dark) / #F8FAFC (light)
  surface       #111116 / #FFFFFF
  surface-2     #18181D / #F1F5F9
  primary       #818CF8 (dark) / #6366F1 (light)
  text-primary  #F1F5F9 / #0F172A
  text-secondary #94A3B8 / #475569
  text-muted    #4B5563 / #94A3B8
  success       #34D399 / #059669
  danger        #F87171 / #DC2626
  warning       #FCD34D / #D97706

Fonts:
  sans  → Inter
  mono  → JetBrains Mono
```

### Theme Classes
- Dark (default): no extra class  
- Light: `theme-light` on `<html>`  
- Use `cn()` from `src/lib/utils.ts` for conditional classes (clsx + tailwind-merge)

### CSS Utility Classes (from `index.css`)
- `glass-card` — standard card surface
- `glass-card-hover` — hover lift effect
- `stat-card` — metric display card
- `glow-primary / glow-success / glow-danger` — glow borders
- `gradient-text` — primary gradient text
- `data-table` — styled table
- `font-mono tabular-nums` — numbers (always use for financial data)

### Component Patterns
```tsx
import { Card, StatCard } from '../components/common/Card';
import { Input } from '../components/common/Input';
import { Button } from '../components/common/Button';
import { StatusBadge } from '../components/common/StatusBadge';
import { NumberDisplay } from '../components/common/NumberDisplay';
import { SymbolSelector } from '../components/common/SymbolSelector';
import { AutoConfigureButton } from '../components/common/AutoConfigureButton';
import { BotPnlStrip } from '../components/common/BotPnlStrip';
import { cn } from '../lib/utils';
```

---

## Page Architecture

### Routing (`App.tsx`)
- All pages are **lazy-loaded** via `lazyFrom()` wrapper (Vite code splitting)
- `Settings` is loaded synchronously (outside Suspense) to avoid stall
- Fallback: top shimmer bar (`PageLoader`), not full-screen spinner
- `PageTransition` re-mounts on pathname change (resets intervals/subscriptions)
- `preloadCommonPages()` warms Positions, GridBot, FundingTracker on idle

### Page Routes
```
/dashboard        → Dashboard
/positions        → Positions
/grid-bot         → GridBot
/twap-bot         → TwapBot
/dca-bot          → DcaBot
/market-maker     → MarketMakerBot
/copy-trader      → CopyTrader
/signal-bot       → SignalBot
/schedule-cancel  → ScheduleCancel
/alerts           → Alerts
/backtesting      → Backtesting
/funding          → FundingTracker
/etf-tracker      → EtfTracker
/macro            → MacroCalendar
/btc-predictor    → BtcPredictor
/ai-console       → AiConsole
/news-bot         → NewsBot
/ssi-indices      → SsiIndices
/btc-treasuries   → BtcTreasuries
/fundraising      → Fundraising
/sector-spotlight → SectorSpotlight
/crypto-stocks    → CryptoStocks
/settings         → Settings
```

### Sidebar Sections
1. **AI Agents**: BTC Predictor, News Bot, AI Console
2. **Overview**: Dashboard, Positions
3. **Trade Bots**: Signal Bot, Grid Bot, TWAP Bot, DCA Bot, Market Maker, Scheduler
4. **Intelligence**: SSI Indices, BTC Treasuries, Sector Spotlight, Fundraising, Crypto Stocks
5. **Market Data**: Funding Rates, ETF Tracker, Macro Calendar
6. **Pro Tools**: Copy Trader, Price Alerts, Backtesting

---

## Bot Architecture Patterns

All trade bots (Grid, TWAP, DCA, Market Maker, Signal, Copy Trader) follow the same structure:
1. **Config panel** (left): form inputs + AutoConfigureButton
2. **Stats panel** (right): StatCards with live metrics
3. **Bot loop**: `useRef(intervalRef)` + `useCallback` for the tick function
4. **State**: config fields in `useBotStore`, live stats via `bumpField`/`setField`
5. **Error handling**: `toast.error(getErrorMessage(err))`, status → `'ERROR'`
6. **Stop/cleanup**: always cancel open orders on stop, clear the interval ref

### Market Maker Bot specifics
- `timeInForce: 'GTX'` (post-only) — guarantees maker fills
- Tracks `ordersPlaced`, `ordersFilled`, `ordersCancelled`, `volumeUsdt`, `feesUsdt`, `inventoryBase`
- `bumpField` is mandatory for accumulating stats across fills (stale closure)

---

## AI Integrations

### Gemini AI (Google)
- Client: `src/api/geminiClient.ts`
- Key stored in `settingsStore.geminiApiKey`
- Used by: AI Console (`aiConsoleClient.ts`), AI Strategist (`aiStrategist.ts`)

### SoSoValue API
- Client: `src/api/sosoValueClient.ts` + `src/api/sosoExtraServices.ts`
- Key stored in `settingsStore.sosoApiKey`
- Used by: ETF Tracker, SSI Indices, BTC Treasuries, Sector Spotlight, Fundraising, Crypto Stocks

### AI Auto-Configure
- File: `src/api/aiAutoConfig.ts`
- **Pure rule-based** (no LLM) — instant, transparent, no network round-trip
- Conservative bias: never recommend dangerous defaults (no high leverage, oversized positions)
- Functions: `recommendGridBot`, `recommendTwapBot`, `recommendDcaBot`, `recommendMarketMakerBot`

---

## Error Handling Conventions
- Use `getErrorMessage(err)` from `src/lib/utils.ts` for all catch blocks
- `assertNoBodyError(data)` in `services.ts` catches SoDEX body-level errors (HTTP 200 but `code !== 0`)
- Show errors via `toast.error(...)`, not `alert()`
- Set bot status to `'ERROR'` on fatal errors

---

## Security Rules (CRITICAL)
- **Never persist private keys** — `settingsStore.partialize` explicitly excludes all `*PrivateKey` fields
- **Never log private keys** — `console.log` in clients only shows `X-API-Key` (public address), never the key
- API keys are public EVM addresses — safe to log/display
- `sosoApiKey` and `geminiApiKey` are persisted (acceptable — they're API service keys, not wallet keys)

---

## Development Commands
```powershell
# Dev server
npm run dev

# Production build
npm run build

# Lint
npm run lint

# Preview build
npm run preview
```

---

## Common Pitfalls to Avoid
1. **Stale closure on bumpField**: Always use `useBotStore.getState().marketMakerBot.bumpField(...)` or the store's own `bumpField` action — never `store.field + delta` from a closed-over value
2. **Key order in signed payloads**: JSON keys in write request bodies MUST match Go struct field order — verify against `sodexdocument/` API docs before adding new endpoints
3. **Nonce collisions**: Never call `Date.now()` as nonce — use `getMonotonicNonce(apiKey)` from `signer.ts`
4. **Demo mode check**: Every new service function in `services.ts` must check `isDemo()` first
5. **TailwindCSS v4**: No `tailwind.config.js` — all tokens are in `index.css @theme`. Do not create a config file
6. **React 19**: Avoid patterns deprecated in React 19 (e.g. `defaultProps` on function components)
7. **Route naming**: Kebab-case (`/grid-bot`, not `/gridBot`)
8. **Symbol format**: Perps use `BTC-USD`, Spot use `BTC_USDC` (underscore, not hyphen)
