# SoDEX Terminal

A professional-grade, browser-based trading toolset built on top of the [SoDEX](https://sodex.dev) decentralised perpetuals exchange. Crafted for the **SoDEX Buildathon** — every feature runs entirely in the browser with zero backend, using EIP-712 signing and the SoDEX REST + WebSocket APIs directly.

![Status](https://img.shields.io/badge/status-live-brightgreen)
![Build](https://img.shields.io/badge/build-passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![React](https://img.shields.io/badge/React-19-61dafb)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Overview

SoDEX Terminal replaces the exchange's default UI with a fully-featured trading workstation. It ships with automated trading bots, real-time analytics, AI-powered signals, and a demo sandbox — all without needing a dedicated server or database.

---

## Features

### 📊 Market & Portfolio

| Page | Description |
|---|---|
| **Dashboard** | Live candlestick chart, real-time ticker table for all perps markets, portfolio balance, open position count, and total unrealised PnL |
| **Positions** | View all open perpetual positions with live mark price, unrealised PnL, margin ratio, and one-click close |
| **Funding Tracker** | Real-time funding rates for every market, 8-hour APR equivalent, personal funding P&L estimate, and top-paying rate rankings |
| **ETF Tracker** | Bitcoin spot ETF institutional flow data from SoSoValue — daily net inflow, cumulative inflow, AUM per issuer (BlackRock, Fidelity, etc.) with historical chart |

### 🤖 Automated Bots

| Bot | Strategy | Description |
|---|---|---|
| **Grid Bot** | Grid trading | Places a ladder of buy + sell limit orders across a configurable price range. Profits from oscillation without predicting direction |
| **TWAP Bot** | Time-Weighted Average Price | Splits a large order into equal-size slices executed at a fixed time interval to minimise market impact |
| **DCA Bot** | Dollar-Cost Averaging | Automatically buys or sells a fixed notional amount at a recurring interval — ideal for accumulation strategies |
| **Copy Trader** | On-chain mirroring | Polls a target wallet's open orders and mirrors them on your own account with configurable size scaling |

### 🧠 AI Tools

| Tool | Description |
|---|---|
| **BTC Price Predictor** | Evidence-based 5-minute BTC direction predictor using 8 weighted signals (see below). Tracks accuracy with rolling last-10, last-20, and all-time stats. Self-corrects when accuracy drops below 45% |
| **News Bot** | Real-time crypto news feed from SoSoValue with Gemini AI sentiment scoring (BULLISH / BEARISH / NEUTRAL) per headline |

#### BTC Price Predictor — Signal Engine

The predictor combines every available data source into a single weighted score. A prediction is only made when the absolute score exceeds the neutral threshold **and** confidence is above 40%.

| Signal | Weight | Source | Notes |
|---|---|---|---|
| Order Book Imbalance | **28%** | SoDEX REST | `bid_vol / (bid_vol + ask_vol)` top-10 levels |
| Funding Rate Momentum | **18%** | SoDEX REST | Rising rate = bearish; falling rate = bullish. Extreme values (>±0.01%) = strong contrarian |
| News Sentiment | **15%** | SoSoValue + Gemini AI | Last 5 BTC headlines, scored BULLISH/BEARISH/NEUTRAL. 3-min cache. Falls back to mark-price momentum if API unavailable |
| Price Microstructure | **14%** | SoDEX klines | HH/HL candle pattern + price velocity + volume spike (>2× avg) |
| BTC ETF Net Flow | **12%** | SoSoValue | Daily net inflow normalised to ±$500M. 5-min cache. Falls back to RSI-derived momentum if API unavailable |
| EMA 9/21 Crossover | **7%** | SoDEX klines | Distance-weighted: wider spread = stronger signal |
| RSI (14) Extreme | **4%** | SoDEX klines | Fires only when RSI < 30 (oversold) or > 70 (overbought). Ignored in neutral zone |
| MACD Zero Cross | **2%** | SoDEX klines | Fires only on histogram zero-line crossover. Magnitude ignored |

Scoring rules:
- Each signal outputs **+1** (bullish), **−1** (bearish), or **0** (neutral)
- `weighted_score = Σ(signal × weight)`
- `score > +0.15` → predict **UP**
- `score < −0.15` → predict **DOWN**
- `−0.15 ≤ score ≤ +0.15` → **NEUTRAL** (skipped, not counted in accuracy)
- If last-20 accuracy falls below 45%, neutral threshold auto-widens to **±0.20**

### 🛠 Utilities

| Page | Description |
|---|---|
| **Backtesting** | In-browser strategy backtester — SMA Crossover, RSI Mean-Reversion, and Breakout on up to 500 historical 1-minute candles |
| **Price Alerts** | Browser-based price alerts with desktop notifications. Supports above/below triggers for any symbol |
| **Dead Man's Switch** | Schedule an automatic cancel-all for a future time — acts as a safety net if you lose connectivity |
| **Settings** | Configure API key name, EVM private key (EIP-712 signing), network (mainnet / testnet), Gemini AI key, and SoSoValue API key |

---

## Demo Mode

No credentials required. Enable **Demo Mode** in Settings to explore every feature with simulated price feeds, fake account balances, and synthetic order fills. The demo engine generates realistic tick data and responds to all bot commands without touching any live endpoint.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | **React 19** + **TypeScript 5** |
| Build | **Vite 8** — every page is a separate lazy-loaded chunk |
| Styling | **TailwindCSS v4** with CSS custom-property theming |
| State | **Zustand** with `persist` middleware (localStorage) |
| Signing | **ethers.js v6** — EIP-712 typed-data signing |
| Charts | **lightweight-charts v5** — TradingView-compatible candlestick component |
| Routing | **React Router v7** |
| AI | **Google Gemini API** — sentiment classification for news headlines |
| Market Data | **SoSoValue API** — institutional ETF flows and crypto news |

---

## Quick Start

```bash
git clone https://github.com/keoyle52/SoDexTerminal
cd SoDexTerminal
npm install
npm run dev        # dev server → http://localhost:5173
npm run build      # production build (zero TypeScript errors)
npm run lint       # ESLint
```

---

## Configuration

Open **Settings** in the app and fill in the relevant fields:

| Field | Required | Description |
|---|---|---|
| API Key Name | Perps bots | Key name registered in your SoDEX account dashboard |
| Private Key | Perps bots | EVM private key for EIP-712 request signing — never leaves the browser |
| Default Symbol | Optional | Trading pair shown by default on the Dashboard chart |
| Testnet | Optional | Toggles all endpoints between mainnet and testnet |
| Gemini API Key | AI features | Required for News Bot sentiment scoring and BTC Predictor news signal |
| SoSoValue API Key | AI features | Required for ETF Tracker, News Bot, and BTC Predictor ETF/news signals |

> **Security:** Private keys and API keys are stored only in `localStorage` and are never transmitted to any third-party server.

---

## API & Authentication

All account-level requests use **EIP-712** typed-data signatures:

1. **Nonce** — monotonically increasing integer; never reuses within the same millisecond.
2. **Payload hash** — `keccak256(stableStringify(payload))` with keys sorted alphabetically.
3. **Signature** — `ExchangeAction { payloadHash, nonce }` prefixed with `0x01`.

### Symbol format

| Market | Format | Example |
|---|---|---|
| Perps | `BASE-USD` (hyphen) | `BTC-USD`, `ETH-USD` |
| Spot | `BASE_USDC` (underscore) | `BTC_USDC` |

`normalizeSymbol()` in `services.ts` converts between formats automatically.

### Order placement flow

```
fetchPerpsAccountState()  →  accountID
fetchSymbolEntry()        →  symbolID
placePerpsOrder()         →  POST /trade/orders
  body: { accountID, symbolID, orders: [{ clOrdID, modifier, side, type,
          timeInForce, price?, quantity, reduceOnly, positionSide }] }
```

HTTP 200 responses with `code !== 0` are thrown as errors by the Axios interceptor.

---

## Project Structure

```
src/
├── api/
│   ├── perpsClient.ts       Axios instance — signs every authenticated request
│   ├── spotClient.ts        Axios instance for spot market
│   ├── services.ts          All REST helpers: fetchKlines, fetchOrderbook, placeOrder, …
│   ├── sosoValueClient.ts   SoSoValue API client with TTL cache + rate limiter
│   ├── sosoServices.ts      Typed wrappers: fetchSosoNews, fetchEtfCurrentMetrics, …
│   ├── geminiClient.ts      Gemini AI sentiment analysis
│   ├── signer.ts            EIP-712 signing, nonce, stableStringify
│   ├── websocket.ts         WebSocket service — miniTicker live price feed
│   ├── useLiveTicker.ts     React hook — live ticker via WS or demo engine
│   └── demoEngine.ts        In-browser demo simulation engine
├── components/
│   ├── TradingChart.tsx     lightweight-charts v5 candlestick chart
│   ├── Sidebar.tsx          Navigation sidebar with grouped routes
│   ├── Topbar.tsx           Page title + wallet/network status bar
│   └── common/              Button, Input, Card, Modal, StatusBadge, NumberDisplay
├── pages/
│   ├── Dashboard.tsx        Market overview + portfolio stats
│   ├── GridBot.tsx          Grid trading bot
│   ├── TwapBot.tsx          TWAP execution bot
│   ├── DcaBot.tsx           DCA accumulation bot
│   ├── CopyTrader.tsx       On-chain copy trading
│   ├── Positions.tsx        Open positions manager
│   ├── FundingTracker.tsx   Funding rate analytics
│   ├── EtfTracker.tsx       BTC ETF institutional flow
│   ├── NewsBot.tsx          AI-scored crypto news feed
│   ├── BtcPredictor.tsx     8-signal BTC direction predictor
│   ├── Backtesting.tsx      In-browser strategy backtester
│   ├── Alerts.tsx           Browser price alerts
│   ├── ScheduleCancel.tsx   Dead man's switch
│   └── Settings.tsx         Credentials + network config
└── store/
    ├── settingsStore.ts     API keys, network, demo mode
    ├── predictorStore.ts    BTC Predictor persisted state + accuracy tracking
    └── botStore.ts          Bot states (Grid, TWAP, DCA)
```

---

## Known Limitations

- **Copy Trader** polls the SoDEX REST API for target wallet orders — a WebSocket feed would reduce latency.
- **Backtesting** runs in-browser on up to 500 candles; not suitable for large multi-day datasets.
- **Price Alerts** stop firing when the browser tab is suspended or closed.
- **BTC Predictor** accuracy depends on signal quality; NEUTRAL predictions are intentionally skipped to protect the accuracy rate.

---

## License

MIT
