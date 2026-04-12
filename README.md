# SoDEX VolumeBot — Developer Guide

This project is a React + TypeScript + Vite trading-automation UI that targets the [SoDEX](https://sodex.dev) exchange.

---

## Quick Start

```bash
npm install
npm run dev        # starts Vite dev server at http://localhost:5173
npm run build      # production build
npm run lint       # ESLint check
```

---

## Configuration (Settings page)

| Field | Description |
|---|---|
| **API Key Name** | The key name from your SoDEX account dashboard |
| **Private Key** | EVM private key used for EIP-712 request signing |
| **Testnet** | Toggle between mainnet (`mainnet-gw.sodex.dev`) and testnet (`testnet-gw.sodex.dev`) |

---

## VolumeBot

The VolumeBot places buy/sell pairs (budget mode) or single market orders (classic mode) and tracks **confirmed fills only**.

### How volume counting works

1. An order is placed via the exchange API.
2. The bot waits `FILL_VERIFICATION_DELAY_MS` (800 ms) for the order to settle.
3. It checks for fill data: first from the inline order response, then via a REST query to `GET /accounts/{addr}/orders/{orderId}`.
4. **Only if `filledQty > 0 && avgFillPrice > 0` does the bot increment volume stats.**
5. If `MAX_CONSECUTIVE_UNVERIFIED` (5) cycles produce no verifiable fills, the bot stops automatically.

### Perps order payload (fixed)

Previously the bot sent `{ symbol, side, type, quantity }` to the perps endpoint, which returned `code:-1 / invalid request body`.  
The corrected flow:

1. **`fetchPerpsAccountState()`** — calls `GET /accounts/{evmAddress}` and extracts `accountID`.
2. **`fetchPerpsSymbolID(symbol)`** — calls `GET /markets/symbols`, finds the matching entry, and extracts `symbolID`.
3. **`placePerpsOrder()`** — posts `{ accountID, symbolID, orders: [{ clOrdID, side, type, quantity, ... }] }`.
4. Body-level errors (`code !== 0`) are thrown as `Error` even when HTTP status is 200.

### Testing locally (with DevTools)

1. Open the app and navigate to **VolumeBot**.
2. Fill in API Key Name + Private Key and click **Ayarlar** (Settings).
3. Set **Piyasa** to `Perps`, symbol to e.g. `BTC-USD`.
4. Open browser DevTools → **Network** tab → filter by `trade/orders`.
5. Click **Başlat** (Start).
6. Inspect the request payload in the Network panel:
   - **Request payload** should be `{ "accountID": ..., "symbolID": ..., "orders": [...] }`.
   - **Response** should have `code: 0` (or no `code` field).
7. The **Log** panel in the UI shows fill verification results. Volume increments only on confirmed fills.

### Signature / nonce details

- Nonce: monotonically increasing (never repeats even within the same millisecond).
- Payload hash: `keccak256(stableStringify(payload))` where `stableStringify` sorts object keys alphabetically for deterministic output.
- Signature scheme: EIP-712 `ExchangeAction { payloadHash, nonce }` prefixed with `0x01`.

---

## Project structure

```
src/
  api/
    perpsClient.ts   – axios instance for perps endpoint (signs every request)
    spotClient.ts    – axios instance for spot endpoint
    services.ts      – high-level API helpers (placeOrder, fetchPerpsAccountState, …)
    signer.ts        – EIP-712 signing + monotonic nonce + stableStringify
    websocket.ts     – WebSocket helper for account order updates
  pages/
    VolumeBot.tsx    – main bot UI & trade loop
    DcaBot.tsx
    GridBot.tsx
  store/             – Zustand state stores
```

