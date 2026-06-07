/**
 * mev-defense.js
 * --------------
 * Inline MEV defense for Sol-trade-bit.
 * Tuned for meme coin copy trading (high slippage tolerance, small positions).
 *
 * Add to executeJupiterSwap() BEFORE the Jupiter POST:
 *
 *   const mevCheck = mevDefense.inspect({
 *     inputMint, outputMint,
 *     amountIn: solAmountUsd,
 *     slippageBps: SLIPPAGE_BPS,
 *     priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
 *   });
 *   if (mevCheck.recommendation === 'abort') { return null; }
 *   const effectiveFee = mevCheck.recommendation === 'reorder'
 *     ? Math.max(PRIORITY_FEE_LAMPORTS, 400_000)
 *     : PRIORITY_FEE_LAMPORTS;
 */

const CONFIG = {
  MAX_SLIPPAGE_BPS:        800,    // flag above 8% as high-risk
  MIN_PRIORITY_FEE:        50_000, // lamports
  LARGE_ORDER_USD:         200,    // flag USD trade size above this
  SANDWICH_RISK_THRESHOLD: 0.65,
};

const _recentOrders = new Map();

export const mevDefense = {
  inspect(order) {
    const flags = [];
    let riskScore = 0;

    if (order.slippageBps > CONFIG.MAX_SLIPPAGE_BPS) {
      flags.push(`HIGH_SLIPPAGE:${order.slippageBps}bps`);
      riskScore += 0.35;
    }

    if (order.priorityFeeLamports < CONFIG.MIN_PRIORITY_FEE) {
      flags.push(`LOW_PRIORITY_FEE:${order.priorityFeeLamports}`);
      riskScore += 0.2;
    }

    if (order.amountIn > CONFIG.LARGE_ORDER_USD) {
      flags.push(`LARGE_ORDER:$${order.amountIn.toFixed(2)}`);
      riskScore += 0.3;
    }

    // Rapid-repeat guard — same token pair within 2s
    const now = Date.now();
    const key = `${order.inputMint}:${order.outputMint}`;
    const last = _recentOrders.get(key);
    if (last && (now - last) < 2000) {
      flags.push('RAPID_REPEAT');
      riskScore += 0.2;
    }
    _recentOrders.set(key, now);
    for (const [k, t] of _recentOrders) {
      if (now - t > 10_000) _recentOrders.delete(k);
    }

    const safe = riskScore < CONFIG.SANDWICH_RISK_THRESHOLD;
    const recommendation = riskScore >= 0.8 ? 'abort' : riskScore >= 0.5 ? 'reorder' : 'proceed';

    if (flags.length > 0) {
      console.log(`\ud83d\udee1\ufe0f  [MEV] score=${riskScore.toFixed(2)} [${recommendation.toUpperCase()}]: ${flags.join(', ')}`);
    }

    return { safe, riskScore, flags, recommendation };
  },
  config: CONFIG,
};
