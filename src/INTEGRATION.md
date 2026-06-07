# Integration Guide — WalletManager + MEV Defense into index.js

## Step 1 — Replace global keypair with WalletManager

**Add import at top of index.js** (after existing imports):
```js
import { WalletManager } from './src/wallet/wallet-manager.js';
```

**Replace** this block (~line 518):
```js
// === WALLET KEYPAIR (for live trading) ===
let keypair = null;
if (PRIVATE_KEY) {
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    console.log('🔑 Wallet keypair loaded for LIVE trading');
  } catch (e) {
    console.error('❌ Invalid private key! Falling back to paper mode');
  }
}
```

**With:**
```js
// === WALLET MANAGER ===
const wallet = new WalletManager(PRIVATE_KEY);
wallet.connect();
const keypair = wallet.keypair; // keeps all legacy keypair references working
```

---

## Step 2 — Wire MEV Defense into executeJupiterSwap

**Add import at top of index.js**:
```js
import { mevDefense } from './src/mev/mev-defense.js';
```

**In `executeJupiterSwap(connection, quote)` — add BEFORE the Jupiter POST:**
```js
async function executeJupiterSwap(connection, quote) {
  if (!keypair) {
    console.log('   ❌ No keypair — cannot execute live swap');
    return null;
  }

  // ── MEV DEFENSE (inline, mandatory) ────────────────────────
  const mevCheck = mevDefense.inspect({
    inputMint:           quote.inputMint,
    outputMint:          quote.outputMint,
    amountIn:            (parseInt(quote.inAmount) / 1e9) * 150, // approx SOL→USD
    slippageBps:         SLIPPAGE_BPS,
    priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
  });
  if (mevCheck.recommendation === 'abort') {
    console.log(`   🛡️  MEV abort — risk ${mevCheck.riskScore.toFixed(2)}: ${mevCheck.flags.join(', ')}`);
    return null;
  }
  const effectivePriorityFee = mevCheck.recommendation === 'reorder'
    ? Math.max(PRIORITY_FEE_LAMPORTS, 400_000)
    : PRIORITY_FEE_LAMPORTS;
  // ────────────────────────────────────────────────────────────

  const swapResponse = await safeFetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse:                 quote,
      userPublicKey:                 keypair.publicKey.toString(),
      wrapAndUnwrapSol:              true,
      computeUnitPriceMicroLamports: effectivePriorityFee,  // ← dynamic fee
      dynamicComputeUnitLimit:       true,
    }),
  });
  // ... rest unchanged
```

---

## Step 3 — Fix skipPreflight

Change `skipPreflight: true` → `skipPreflight: false` in `sendRawTransaction`.
Preflight catches simulation failures before burning fees.

---

## What this gives you

| Before | After |
|--------|-------|
| Bare global `keypair` | `WalletManager` with connect/disconnect lifecycle |
| No MEV check | Inline risk score on every swap |
| Fixed priority fee | Dynamic fee bump on `reorder` |
| `skipPreflight: true` | Preflight enabled |
| No rapid-repeat guard | 2s cooldown per token pair |
