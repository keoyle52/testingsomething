# 🚀 Sodex PowerOps: AI-Driven Agentic Trading Terminal

[![SoSoValue Buildathon](https://img.shields.io/badge/SoSoValue-Buildathon-blueviolet?style=for-the-badge)](https://sosovalue.com/)
[![SoDEX Protocol](https://img.shields.io/badge/SoDEX-Protocol-emerald?style=for-the-badge)](https://sodex.com/join/KEOLE)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-orange?style=for-the-badge)](https://deepmind.google/technologies/gemini/)

> **The ultimate "One-Person On-Chain Hedge Fund" terminal.** Sodex PowerOps leverages high-frequency SoSoValue data, institutional flow analysis, and Google Gemini AI to orchestrate autonomous trading agents on the SoDEX ValueChain.

---

## 🌟 Overview

Sodex PowerOps is not just a trading dashboard; it's an **Agentic Finance Ecosystem**. Developed for the **SoSoValue x Akindo Buildathon (May 2026)**, it solves the "Information Overload" problem for individual traders by using AI Orchestrators to detect market regimes and deploy specialized autonomous bots.

### 🧠 The Core Philosophy: "Insight to Action"
Traditional terminals stop at showing data. Sodex PowerOps completes the loop:
1.  **Ingest:** Real-time data from SoSoValue (News, ETF Flows, Institutional Treasuries).
2.  **Analyze:** Market regime classification and sentiment extraction via Gemini AI.
3.  **Execute:** Seamless order execution on SoDEX Perps and Spot markets with sub-second latency via [SoDEX](https://sodex.com/join/KEOLE).

---

## 🛠 Features

### 1. 🤖 AI Strategy Orchestrator
The "Brain" of the terminal. It analyzes market volatility (ATR), trend strength (EMA/MACD), and news intensity to classify the current market regime.
-   **Low Volatility?** Recommends **Grid Bot** for range harvesting.
-   **Strong Trend?** Recommends **DCA Bot** or **BTC Predictor**.
-   **News Spike?** Triggers the **AI News Scalper**.

### 2. 🔮 BTC Predictor (Ensemble Intelligence)
A sophisticated forecasting engine that combines **12 unique signals** into a weighted consensus model:
-   **Technical Cluster:** RSI, EMA Cross, MACD Histogram, ROC.
-   **Microstructure:** Orderbook Imbalance Z-Score, Funding Rate Momentum.
-   **Macro/Flow:** Spot BTC ETF Net Inflows, Institutional Treasury Aggregation.
-   **AI Validation:** Every high-conviction signal is cross-validated by the **AI Strategist** (Gemini) before execution.

### 3. 📰 AI News Bot
A real-time scalper that listens to the SoSoValue News API.
-   Uses Gemini AI to extract sentiment and ticker names from headlines.
-   Automatically opens leveraged Perps positions on SoDEX.
-   Features auto-exit logic (TP/SL/Time-based) to protect capital during news volatility.

### 4. ⚡ Professional Execution Algos
-   **Grid Bot:** Geometric/Arithmetic market making on SoDEX.
-   **TWAP Bot:** Volatility-guarded large order slicing.
-   **Signal Bot:** Follows complex technical indicators with automated risk management.

---

## 🏗 Tech Stack

-   **Frontend:** React 18, TypeScript, Vite.
-   **Styling:** Vanilla CSS & Tailwind (Glassmorphism UI).
-   **AI:** Google Gemini Pro (Sentiment & Strategy Validation).
-   **Data:** SoSoValue API (Market Data, News, ETF, Treasuries).
-   **Execution:** SoDEX API (EIP-712 Signing, Perps/Spot Trading).
-   **State Management:** Zustand (High-performance store).

---

## 🚀 Getting Started

### Prerequisites
-   A SoSoValue API Key
-   A Google Gemini API Key
-   A Wallet Private Key (for SoDEX trading)

### Installation
1.  Clone the repository:
    ```bash
    git clone https://github.com/your-username/sodex-powerops.git
    cd sodex-powerops
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the development server:
    ```bash
    npm run dev
    ```

### Configuration
Go to the **Settings** page in the terminal and input your API keys. You can toggle **Demo Mode** to test the AI Orchestrator and Predictor with simulated data before going live.

---

## 📊 Judging Criteria Alignment

-   **User Value (30%):** Empowers a single person to run a complex, data-driven trading operation.
-   **Functionality (25%):** Fully working integration with SoDEX Perps and SoSoValue.
-   **Product Design (20%):** Professional-grade "Terminal" UX with dark-mode glassmorphism.
-   **Data/API Integration (15%):** Deep usage of 5+ different SoSoValue endpoints and Gemini AI.
-   **UX & Clarity (10%):** AI-guided "Recommended Bot" system simplifies complex decision-making.

---

## 🛡 Disclaimer
*This software is for educational and hackathon purposes. Trading cryptocurrencies involves significant risk. The authors are not responsible for any financial losses.*

---

## 🤝 Acknowledgements
-   [SoSoValue](https://sosovalue.xyz/) for the comprehensive data infra.
-   [SoDEX](https://sodex.com/join/KEOLE) for the high-performance ValueChain.
-   [Akindo](https://akindo.io/) for hosting the Buildathon.

---
*Last Updated: May 6, 2026*
