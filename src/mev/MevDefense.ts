import { VersionedTransaction, Transaction } from "@solana/web3.js";

export interface MevCheckResult {
  safe: boolean;
  riskScore: number;       // 0–1, higher = riskier
  flags: string[];
  recommendation: "proceed" | "reorder" | "abort";
}

export interface OrderContext {
  inputMint: string;
  outputMint: string;
  amountIn: number;
  expectedAmountOut: number;
  slippageBps: number;
  priorityFeeLamports: number;
}

export class MevDefense {
  private readonly MAX_SLIPPAGE_BPS = 800;         // tuned for meme coins
  private readonly MIN_PRIORITY_FEE = 50_000;      // lamports
  private readonly SANDWICH_RISK_THRESHOLD = 0.65;

  /**
   * Inline check — must be called on every order BEFORE broadcast.
   */
  inspect(order: OrderContext): MevCheckResult {
    const flags: string[] = [];
    let riskScore = 0;

    if (order.slippageBps > this.MAX_SLIPPAGE_BPS) {
      flags.push(`HIGH_SLIPPAGE:${order.slippageBps}bps`);
      riskScore += 0.35;
    }

    if (order.priorityFeeLamports < this.MIN_PRIORITY_FEE) {
      flags.push("LOW_PRIORITY_FEE");
      riskScore += 0.2;
    }

    const usdEstimate = order.amountIn;
    if (usdEstimate > 200) {
      flags.push("LARGE_ORDER");
      riskScore += 0.3;
    }

    const safe = riskScore < this.SANDWICH_RISK_THRESHOLD;
    const recommendation = riskScore >= 0.8 ? "abort" : riskScore >= 0.5 ? "reorder" : "proceed";

    return { safe, riskScore, flags, recommendation };
  }

  /**
   * Wraps a transaction in a Jito bundle for atomic MEV protection.
   * Stub — replace with real Jito bundle client.
   */
  async bundleForJito(tx: VersionedTransaction | Transaction): Promise<{ bundleId: string }> {
    // TODO: POST to https://mainnet.block-engine.jito.wtf/api/v1/bundles
    return { bundleId: `jito_stub_${Date.now()}` };
  }
}
