# SoDEX Terminal — A One-Person On-Chain Finance Business

> **Built for the SoSoValue × AKINDO Buildathon** — _"Build Your One-Person On-Chain Finance Business with SoSoValue"_.
>
> A fully browser-based, agentic finance terminal that turns one operator into a research desk **and** a trading floor: SoSoValue intelligence → AI-driven signals → SoDEX execution. No backend. No private servers. No CEX accounts.

---

## Why this fits the brief

The buildathon is looking for **agentic challengers to traditional finance businesses** — applications that "function as a financial news agency, an index publisher, or a fund manager" and become available on-chain to users worldwide.

This terminal does all three from a single browser tab:

| Brief direction | Implementation |
|---|---|
| **Signal-to-Execution Agent** | `BTC Predictor` blends 12 SoSoValue + on-chain signals into a 5-min directional call, then optionally fires a leveraged perp on SoDEX. |
| **Opportunity Discovery Engine** | `Sector Spotlight` heat-map, `Fundraising Intelligence`, `BTC Treasury Tracker`, `SSI Indices`, `Macro Calendar`. |
| **Strategy Assistant Bot** | `Grid Bot`, `TWAP Bot`, `DCA Bot`, `News Bot`, all with live PnL tracking and pre-launch risk summaries. |
| **Smart Research Dashboard** | Unified Dashboard + 6 SoSoValue-powered analytical pages, every figure tagged with its source. |
| **Copy-Trading Support Tool** | `Copy Trader` mirrors a target wallet's SoDEX activity into the user's account in real time. |

---

## Mapping to judging criteria

| Criterion (weight) | Where it shows up |
|---|---|
| **User Value & Practical Impact (30 %)** | Real research-to-execution flow: e.g. browse `Macro Calendar` → check `Sector Spotlight` → confirm with `BTC Predictor` reasoning panel → fire a `Grid Bot` after a `Risk Summary` confirmation. End-to-end actionable. |
| **Functionality & Working Demo (25 %)** | A built-in **Demo Mode** simulates SoDEX + SoSoValue without API keys. Jury can run every bot, see every page, and inspect the predictor without onboarding. |
| **Logic, Workflow & Product Design (20 %)** | The `BTC Predictor` exposes its reasoning (signal-by-signal bar chart, weights, conviction filter, warmup gate, accuracy circuit-breaker). Bots include risk-summary modals before any capital is committed. |
| **Data / API Integration (15 %)** | **9 distinct SoSoValue endpoints** wired up (news, ETF inflow, ETF metrics, indices, sector spotlight, fundraising, BTC treasuries, crypto stocks, macro events) plus the full SoDEX REST + WS surface. See _SoSoValue API depth_ below. |
| **UX & Clarity (10 %)** | Glassmorphism dark theme, lazy-loaded routes, consistent component library (`Card`, `Button`, `Input`, `RiskSummaryModal`, `BotPnlStrip`), live mini-PnL widgets on every bot page. |
| **Bonus — Risk control & confirmation** | Every bot opens a parametrised `RiskSummaryModal` showing the explicit capital at risk, requires an "I have reviewed" tick before launch. |
| **Bonus — AI-enhanced functionality** | Gemini sentiment for headlines (with a deterministic demo-mode fallback so judges see AI working without keys). |
| **Bonus — More complete flow from insight to action** | Predictor → optional auto-trade → live PnL strip → resolution → accuracy tracker — closed loop. |

---

## Demo Mode (for judges — no API keys needed)

1. Open the deployed link and head to **Settings**.
2. Toggle **Demo Mode** on.
3. Every page now runs against a deterministic synthetic data engine:
   - Tickers tick at ~1.2 s intervals around realistic anchors.
   - Order book, funding, and klines are simulated.
   - SoSoValue endpoints (news, ETF, sector, treasuries, fundraising, indices, macro events, crypto stocks) return seeded synthetic data — **zero outbound API calls**.
   - Gemini sentiment is replaced by a deterministic synthesiser that reads keyword cues (`approved`, `hack`, `ETF`, `SEC`, …) and emits Bullish/Bearish/Neutral with a 60–80 % confidence band, so the AI feature is fully exercised even without a key.
4. Every bot, predictor cycle, and analytics page works end-to-end with no signing required.

---

## Feature surface

### 🤖 AI Tools
| Page | What it does |
|---|---|
| **BTC Predictor** | 12-signal weighted ensemble for a 5-minute BTC direction call. Self-correcting: ATR-adaptive threshold, 10-cycle warmup gate, conviction filter (≥3 agreeing signals), accuracy-collapse circuit breaker. Exposes a **"Why this prediction?"** transparent-reasoning bar chart. Optional auto-trade on SoDEX perps. |
| **News Bot** | Polls SoSoValue news every 5 min, classifies via Gemini (or demo-mode synth), opens leveraged perps on keyword/AI triggers, manages TP/SL/hold-time exits per position. |

### 📊 SoSoValue Intel Suite
| Page | SoSoValue endpoint(s) |
|---|---|
| **Macro Calendar** | `/macro/events` — calendar grid + 14-day list, every event tagged with **High/Medium/Low BTC impact**. |
| **SSI Indices** | `/indices`, `/indices/{ticker}/constituents`, `/indices/{ticker}/klines` — basket explorer with constituent weight bars and 90-day price chart. |
| **BTC Treasury Tracker** | `/btc-treasuries`, `/btc-treasuries/{ticker}/purchase-history` — corporate BTC buys, 30-day aggregate, per-company purchase history. Same data feeds the predictor's 9th signal. |
| **Sector Spotlight** | `/currencies/sector-spotlight` — heat map (tile size ∝ market-cap dominance, colour ∝ 24 h change) + spotlight narratives. |
| **Fundraising Intelligence** | `/fundraising/projects` — recent VC rounds, weekly stats, "hottest sector" capital flow. |
| **Crypto Stocks** | `/crypto-stocks`, `/crypto-stocks/{ticker}/market-snapshot` — MSTR / COIN / MARA / RIOT / TSLA / Metaplanet card grid with price, market cap, P/E, P/B. |

### 🛠 Trading Bots (all on SoDEX)
| Bot | Strategy | Highlights |
|---|---|---|
| **Grid Bot** | Grid trading | Risk summary modal pre-launch (range, levels, capital at risk). Live PnL strip at the top. |
| **TWAP Bot** | Time-weighted slicing | Risk summary modal with full duration + slice schedule. |
| **DCA Bot** | Dollar-cost averaging | Risk summary modal flags unbounded runs with a warning tone. |
| **News Bot** | News-triggered scalping | Compact PnL strip in the sidebar; AI or keyword mode. |
| **Copy Trader** | Wallet mirroring | Mirrors target SoDEX activity with per-trade ratio + max-size guards. |

### 📈 Market Tools
| Page | What it does |
|---|---|
| **Dashboard** | Live tickers, candlestick chart, balance, open positions, total unrealised PnL. |
| **Positions** | Live positions with mark price, margin ratio, one-click reduce-only close. |
| **Funding Tracker** | Funding rates + personal funding P&L estimate. |
| **ETF Tracker** | BTC/ETH spot ETF historical inflows + per-issuer current metrics (SoSoValue). |
| **Price Alerts** | Browser notifications when a tracked symbol crosses a threshold. |
| **Backtesting** | Simple historical replay against the kline series. |
| **Schedule Cancel** | Dead-man's-switch that cancels every open order if the user goes offline. |

### 🛡 Cross-cutting concerns
- **Risk Summary Modal** (`@/src/components/common/RiskSummaryModal.tsx`) — generic English-language confirmation surface with structured rows, risk tier banner (Low/Medium/High), and an "I have reviewed" acknowledgement before any capital moves.
- **Bot PnL Tracker** (`@/src/components/common/BotPnlStrip.tsx` + `@/src/store/botPnlStore.ts`) — persistent, per-bot live performance widget showing **Today / Total / Win-rate / Trades** plus a 12-bar mini chart.
- **Demo Engine** (`@/src/api/demoEngine.ts`) — fully synthetic in-memory simulation of SoDEX so the entire app is explorable without keys.

---

## SoSoValue API depth

The terminal makes use of the real `openapi.sosovalue.com` surface:

```
News            POST  /openapi/v1/data/default/coin/list      coin universe
                GET   /api/v1/news/featured                    homepage news feed
                GET   /api/v1/news/featured/currency           per-coin news feed
ETF             POST  /openapi/v2/etf/historicalInflowChart   daily inflow series
                POST  /openapi/v2/etf/currentEtfDataMetrics   per-issuer snapshot
Indices         GET   /openapi/v1/indices                      basket list
                GET   /openapi/v1/indices/{t}/constituents    weights
                GET   /openapi/v1/indices/{t}/klines          historical price
Treasuries      GET   /openapi/v1/btc-treasuries              corporate holders
                GET   /openapi/v1/btc-treasuries/{t}/purchase-history
Crypto Stocks   GET   /openapi/v1/crypto-stocks               company list
                GET   /openapi/v1/crypto-stocks/{t}/market-snapshot
Sector          GET   /openapi/v1/currencies/sector-spotlight heat map
Fundraising     GET   /openapi/v1/fundraising/projects        VC round list
Macro           GET   /openapi/v1/macro/events                economic calendar
```

**Quota discipline:**
- Token-bucket rate limiter at the axios layer (`@/src/api/sosoValueClient.ts`) — 10-token burst, refill ~1.1 / 3.5 s, sustained ≈19 req/min (under SoSoValue's 20 / min cap).
- Per-endpoint TTL cache (4–10 min for news / ETF / coin list; 30 min for treasury aggregation).
- localStorage stale-fallback so a 429 never blanks the UI.
- In-flight request deduplication so parallel page mounts share a single round-trip.
- **Demo mode bypasses every API call** — synthesised deterministically so judges put no load on production endpoints.

---

## SoDEX integration depth

- **EIP-712 typed-data signing** in-browser via `ethers v6` (`@/src/api/signer.ts`).
- **Spot + Perps REST** (`@/src/api/perpsClient.ts`, `@/src/api/spotClient.ts`).
- **Tick-size & lot-size aware order rounding** (`@/src/api/services.ts:roundToTick`).
- **Account-state caching** with 30 s TTL keyed by network + market + address.
- **Live WebSocket tickers** for sub-second price updates.
- **Network-aware credential storage** — mainnet and testnet keys are kept in separate slots so toggling networks never overwrites the other.
- **Zero backend / zero proxy** — the browser signs and dispatches directly to SoDEX endpoints.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser (Vite + React 19)               │
│                                                                  │
│  Pages              Stores              API clients              │
│  ────────           ────────            ────────                 │
│  Dashboard          settingsStore       sosoValueClient ─────┐   │
│  BtcPredictor ────► predictorStore                          │   │
│  NewsBot      ────► botPnlStore         sosoServices ──────►├─► SoSoValue
│  GridBot/TWAP/DCA   botStore            sosoExtraServices ─►│   │
│  SSI Indices                                                │   │
│  BTC Treasuries                         geminiClient ──────►├─► Gemini
│  Sector Spotlight                                           │   │
│  Fundraising                            services.ts (SoDEX) │   │
│  Crypto Stocks                          ├─ perpsClient ─────►├─► SoDEX REST/WS
│  Macro Calendar                         └─ spotClient  ─────►│   │
│  ETF Tracker                                                │   │
│  Positions / Alerts / Backtesting       demoEngine ◄────────┘   │
│                                         (intercepts all calls   │
│                                          when isDemoMode = true)│
└──────────────────────────────────────────────────────────────────┘
```

- **No backend.** Every byte of the runtime lives in `dist/`.
- **Lazy routes.** Each page is its own chunk so the first paint stays small.
- **Persistent state.** Zustand `persist` middleware for settings, predictor history, and bot PnL — surviving reloads.
- **Adaptive predictor.** ATR-aware threshold, accuracy circuit breaker, 10-cycle warmup gate, ≥3-signal conviction filter.

---

## Setup

### Requirements
- Node.js 18 +
- npm

### Local install
```bash
git clone https://github.com/keoyle52/SoDexTerminal
cd SoDexTerminal
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
npm run lint     # eslint
```

### Environment
The terminal stores **all** configuration in localStorage, set from the Settings page:

| Setting | Required for | Notes |
|---|---|---|
| Network toggle (testnet / mainnet) | Live trading | Each network has its own credential slot. |
| **Private Key** | Live trading | **Stays in memory only.** Never written to disk. |
| EVM Address (mainnet only) | Live trading | The master wallet in `/accounts/{addr}/...` paths. |
| API Key Name (mainnet only) | Live trading | Sent as `X-API-Key`. |
| **SoSoValue API Key** | Live SoSoValue endpoints | Demo Mode bypasses this. |
| **Gemini API Key** | Live AI sentiment | Demo Mode falls back to a deterministic synth. |
| Default Symbol | Dashboard chart | e.g. `BTC-USD`. |
| Demo Mode | Off-chain exploration | Toggle this for the jury walkthrough. |

> **Security:** all keys live in browser-local storage; private keys are kept in memory only. Nothing is sent to a third-party backend — only to SoDEX, SoSoValue, and Gemini.

---

## Tech stack

- **React 19 + Vite 8** for the runtime
- **Zustand** with `persist` middleware for state
- **Tailwind CSS 4** with a custom glassmorphism design system
- **lightweight-charts 5** for kline visualisations
- **ethers v6** for EIP-712 signing
- **lucide-react** icon set
- **react-hot-toast** notifications
- **TypeScript 6** with strict-friendly tooling

---

## Project structure

```
src/
├── App.tsx                      Router + theme + demo-engine lifecycle
├── api/
│   ├── demoEngine.ts            In-memory simulation (no API calls)
│   ├── demoData.ts              Anchors for the simulation
│   ├── services.ts              SoDEX REST + signed writes
│   ├── perpsClient.ts           Perp HTTP client
│   ├── spotClient.ts            Spot HTTP client
│   ├── signer.ts                EIP-712 implementation
│   ├── sosoValueClient.ts       SoSoValue axios client + rate limiter
│   ├── sosoServices.ts          News / ETF / coin endpoints
│   ├── sosoExtraServices.ts     Indices / treasuries / fundraising / sectors / stocks / macro
│   ├── geminiClient.ts          Sentiment (with demo-mode synth)
│   ├── useLiveTicker.ts         WS-aware ticker hook
│   └── websocket.ts             SoDEX WS gateway
├── components/
│   ├── Sidebar.tsx              5 nav groups (AI, Overview, Bots, Market, Intel, Tools)
│   ├── Topbar.tsx               Network + Demo toggle
│   ├── TradingChart.tsx         lightweight-charts wrapper
│   └── common/
│       ├── Button / Card / Input / NumberDisplay / StatusBadge
│       ├── ConfirmModal.tsx     Generic confirm
│       ├── RiskSummaryModal.tsx **Pre-launch risk summary (English, structured)**
│       └── BotPnlStrip.tsx      **Live per-bot PnL widget**
├── pages/
│   ├── Dashboard.tsx
│   ├── BtcPredictor.tsx         **12-signal ensemble + reasoning panel**
│   ├── NewsBot.tsx
│   ├── GridBot.tsx · TwapBot.tsx · DcaBot.tsx · CopyTrader.tsx · ScheduleCancel.tsx
│   ├── Positions.tsx · Alerts.tsx · Backtesting.tsx
│   ├── FundingTracker.tsx · EtfTracker.tsx
│   ├── MacroCalendar.tsx        **/macro/events**
│   ├── SsiIndices.tsx           **/indices + constituents + klines**
│   ├── BtcTreasuries.tsx        **/btc-treasuries + purchase history**
│   ├── Fundraising.tsx          **/fundraising/projects**
│   ├── SectorSpotlight.tsx      **/currencies/sector-spotlight**
│   └── CryptoStocks.tsx         **/crypto-stocks**
├── store/
│   ├── settingsStore.ts         Per-network credentials + theme + demo flag
│   ├── botStore.ts              Grid bot state
│   ├── botPnlStore.ts           **Per-bot real-time PnL**
│   └── predictorStore.ts        BTC predictor history + auto-trade settings
└── lib/
    └── utils.ts                 cn helper + getErrorMessage
```

---

## Submission materials

- **GitHub repo:** [https://github.com/keoyle52/SoDexTerminal](https://github.com/keoyle52/SoDexTerminal)
- **Live deployment:** _(linked from the AKINDO submission)_
- **Demo video:** _(linked from the AKINDO submission)_

---

## License

MIT
