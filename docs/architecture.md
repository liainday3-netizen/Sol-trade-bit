# Sol-trade-bit — Multi-Plane Architecture

> **Version**: 2.0 — enhanced with WalletManager, MEV Defense, AI Signal Bridge, and full Jupiter v6 execution

---

## System Overview

```
                         ┌──────────────────────────────────┐
                         │      Global Control Plane (GCP)  │
                         │  bootstrap() · broadcast() ·      │
                         │  routeAIScores() · shutdown()     │
                         └────────────────┬─────────────────┘
                                          │ fan-out
              ┌───────────────────────────┼────────────────────────┐
              ▼                           ▼                        ▼
   ┌──────────────────┐      ┌─────────────────────┐    ┌─────────────────┐
   │  Execution Plane  │      │    AI / Learn Plane  │    │   Data Plane    │
   │  ExecutionNode    │◄────►│  AIPlane             │    │  MarketBus      │
   │  WalletManager    │      │  AISignalBridge       │    │  (Pyth feed)    │
   │  MevDefense       │      │  Strategies:          │    └─────────────────┘
   │  Jupiter v6 REST  │      │   Momentum            │
   └──────────────────┘      │   VolumeSpike          │    ┌─────────────────┐
                              │   CopyTrade            │    │ Security Plane  │
                              └─────────────────────┘     │ AuthGuard       │
                                                           └─────────────────┘
```

---

## Planes

### Global Control Plane (`src/control/GlobalControlPlane.ts`)

Owns system wiring. Nothing trades without going through here.

| Method | Purpose |
|--------|---------|
| `bootstrap(walletConfig, bridgeConfig)` | Wire all planes together at startup |
| `broadcast(event)` | Fan-out events to registered planes; route `EXECUTE_SIGNAL` directly to ExecutionNode |
| `routeAIScores(scores)` | Feed AI strategy scores into AISignalBridge for filtering |
| `emergencyShutdown()` | Disconnect wallet, broadcast GLOBAL_SHUTDOWN, halt all planes |

---

### Execution Plane (`src/execution/ExecutionNode.ts`)

Responsible for **every real swap**. Accepts an `Order` from GCP and handles the full lifecycle.

**Swap lifecycle:**
```
Order received
  → MEV gate (MevDefense.inspect())
      abort → return early + notify bridge
      reorder → bump priority fee to 400k lamports
      proceed → continue
  → Jupiter v6 quote (getJupiterQuote)
  → Jupiter v6 swap tx (buildSwapTx)
  → getLatestBlockhash (blockhash-anchored confirmation)
  → WalletManager.signTransaction()
  → sendRawTransaction (skipPreflight: false)
  → confirmTransaction({ signature, blockhash, lastValidBlockHeight })
  → AISignalBridge.onOrderSettled() (RL feedback)
```

**Key config:**

| Parameter | Value | Reason |
|-----------|-------|--------|
| `slippageBps` | 500 (5%) | Fast fills on hot meme coins |
| `priorityFeeLamports` | 200,000 | Total lamports (NOT per-CU) |
| `skipPreflight` | false | Simulate before sending |
| `maxRetries` | 2 | Controlled retry loop |
| `maxAccounts` | 64 | Prevents multi-hop route errors |

---

### AI / Learn Plane (`src/ai/`)

Three live strategies, evaluated in parallel every 15 seconds.

#### Strategy: Momentum (`AIPlane.ts`)
- **Signal**: BUY when 1h price change > +8% AND 24h < +150%
- **Confidence**: scales linearly with momentum velocity, capped at 0.95
- **Guard**: skips tokens with < $50k 24h volume (illiquidity risk)

#### Strategy: Volume Spike (`AIPlane.ts`)
- **Signal**: BUY when `volume_24h / market_cap > 2.0`
- **Rationale**: high vol/mcap ratio = unusual accumulation
- **Guard**: skips if 1h change < -5% (falling knife detection)

#### Strategy: Copy Trade (`AIPlane.ts`)
- **Signal**: BUY when any tracked KOL wallet bought the same token in the last 2 minutes
- **Data source**: BirdEye wallet tx history API
- **Confidence**: 0.78 fixed (KOL signal quality)

#### Signal Bridge (`src/ai/AISignalBridge.ts`)
- Filters: only signals with `score >= minConfidenceThreshold` (default: 0.72)
- Guards: `maxConcurrentSignals` (default: 3) prevents strategy pile-on
- `dryRun: true` in paper mode — logs but does not broadcast

---

### Wallet Layer (`src/wallet/WalletManager.ts`)

Replaces the bare global `keypair` pattern in `index.js`.

```typescript
const wallet = new WalletManager(walletConfig);
await wallet.connect();           // loads keypair from env
wallet.signTransaction(tx);       // explicit signing — no direct keypair access
wallet.disconnect();              // zeroes keypair from memory on shutdown
```

Drop-in JS version: `src/wallet/wallet-manager.js`

---

### MEV Defense (`src/mev/MevDefense.ts` / `mev-defense.js`)

Inline risk scoring before every swap broadcast.

**Risk factors (loosened for active meme-coin trading):**

| Flag | Threshold | Score |
|------|-----------|-------|
| HIGH_SLIPPAGE | > 1000 bps | +0.35 |
| LOW_PRIORITY_FEE | < 10,000 lamports | +0.20 |
| LARGE_ORDER | > $500 USD | +0.30 |
| RAPID_REPEAT | same pair within 500ms | +0.20 |

**Outcome:**

| Score | Recommendation |
|-------|---------------|
| < 0.60 | proceed |
| 0.60–0.89 | reorder (bump fee to 400k) |
| ≥ 0.90 | abort |

---

## Entry Points

### TypeScript (multi-plane)
```bash
npx ts-node src/bootstrap.ts
```
Runs the full 6-plane system with AI strategies and live Jupiter execution.

### JavaScript (existing bot, patched)
```bash
node index.js
```
Original copy-trading bot with Jupiter v6 fixes applied:
- `priorityFeeLamports` (was: `computeUnitPriceMicroLamports`)
- `skipPreflight: false`
- Blockhash-anchored confirmation
- `maxAccounts: 64` on quote params

---

## Infrastructure (VPS layout)

```
Sydney (primary)      — ExecutionNode + GlobalControlPlane
Singapore (replica)   — ExecutionNode standby
Tokyo (data)          — MarketBus + Pyth feed
Frankfurt (research)  — ResearchPlane + backtesting
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `WALLET_PRIVATE_KEY` | For live trading | Base58 encoded private key |
| `HELIUS_API_KEY` | Yes | Helius mainnet RPC |
| `BIRDEYE_API_KEY` | Yes | Token market data (strategies) |
| `ALCHEMY_API_KEY` | Optional | Fallback RPC |
| `RPC_ENDPOINT` | Optional | Override RPC (defaults to Helius) |

---

## Pending / Roadmap

| Item | Priority | Notes |
|------|----------|-------|
| Jito bundle client | High | Real atomic MEV protection — stub in `MevDefense.bundleForJito()` |
| Pyth price feed | Medium | Replace BirdEye polling with WS subscription |
| RL feedback loop | Medium | `AIPlane.evolve()` hook ready — needs P&L tracking |
| KMS private key loading | High | Never store key in env for production |
| Observability plane | Low | Metrics emit stubs present |
| ResearchPlane backtest | Low | `backtest()` returns zeros — needs historical data |
