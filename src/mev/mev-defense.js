/**
 * mev-defense.js
 * --------------
 * Inline MEV defense for Sol-trade-bit.
 * Loosened for active meme-coin trading — only abort on extreme risk.
 *
 * Risk thresholds (loosened):
 *   SANDWICH_RISK_THRESHOLD 0.65 → 0.85 (only abort when truly dangerous)
 *   abort cutoff             0.80 → 0.90 (reorder on moderate risk, abort only on extreme)
 *   LARGE_ORDER_USD          200  → 500  (small meme positions rarely attract bots)
 *   rapid-repeat cooldown    2s   → 500ms (allow faster consecutive fills)
 */

const CONFIG = {
  MAX_SLIPPAGE_BPS:        1000,   // flag above 10% (meme coins regularly need 5-8%)
  MIN_PRIORITY_FEE:        10_000, // lamports — bot uses 200k, this gate won't trigger
  LARGE_ORDER_USD:         500,    // only flag large orders that attract real bots
  SANDWICH_RISK_THRESHOLD: 0.85,   // abort threshold raised — let more trades through
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

    // Rapid-repeat guard — same token pair within 500ms (loosened from 2s)
    const now = Date.now();
    const key = `${order.inputMint}:${order.outputMint}`;
    const last = _recentOrders.get(key);
    if (last && (now - last) < 500) {
      flags.push('RAPID_REPEAT');
      riskScore += 0.2;
    }
    _recentOrders.set(key, now);
    for (const [k, t] of _recentOrders) {
      if (now - t > 10_000) _recentOrders.delete(k);
    }

    const safe = riskScore < CONFIG.SANDWICH_RISK_THRESHOLD;
    // abort only at 0.9+; reorder between 0.6–0.9
    const recommendation = riskScore >= 0.9 ? 'abort' : riskScore >= 0.6 ? 'reorder' : 'proceed';

    if (flags.length > 0) {
      console.log(`\u{1F6E1}\uFE0F  [MEV] score=${riskScore.toFixed(2)} [${recommendation.toUpperCase()}]: ${flags.join(', ')}`);
    }

    return { safe, riskScore, flags, recommendation };
  },
  config: CONFIG,
};
