/**
 * MevDefense.ts
 * -------------
 * Inline MEV risk scoring + Jito bundle submission.
 * Thresholds loosened for active meme-coin copy trading.
 *
 * Updated: bundleForJito() now wired to real JitoClient (no longer a stub).
 */

import { VersionedTransaction, Transaction } from "@solana/web3.js";
import { JitoClient, BundleResult } from "./JitoClient";

export interface MevCheckResult {
  safe:            boolean;
  riskScore:       number;        // 0–1, higher = riskier
  flags:           string[];
  recommendation: "proceed" | "reorder" | "abort";
}

export interface OrderContext {
  inputMint:           string;
  outputMint:          string;
  amountIn:            number;    // USD
  expectedAmountOut:   number;
  slippageBps:         number;
  priorityFeeLamports: number;
}

// Thresholds match loosened mev-defense.js values
const CONFIG = {
  MAX_SLIPPAGE_BPS:        1000,   // flag above 10%
  MIN_PRIORITY_FEE:        10_000, // lamports
  LARGE_ORDER_USD:         500,    // flag USD trade size above this
  SANDWICH_RISK_THRESHOLD: 0.85,   // reorder below this, abort above 0.90
  RAPID_REPEAT_MS:         500,    // same pair within 500ms = flag
} as const;

export class MevDefense {
  private jito:         JitoClient;
  private recentOrders: Map<string, number> = new Map();

  constructor(jitoOpts?: { endpoints?: string[]; authKey?: string }) {
    this.jito = new JitoClient(jitoOpts);
  }

  /**
   * Inline check — must be called on every order BEFORE broadcast.
   * Pure synchronous scoring (no network calls).
   */
  inspect(order: OrderContext): MevCheckResult {
    const flags: string[] = [];
    let riskScore = 0;

    if (order.slippageBps > CONFIG.MAX_SLIPPAGE_BPS) {
      flags.push(`HIGH_SLIPPAGE:${order.slippageBps}bps`);
      riskScore += 0.35;
    }

    if (order.priorityFeeLamports < CONFIG.MIN_PRIORITY_FEE) {
      flags.push(`LOW_PRIORITY_FEE:${order.priorityFeeLamports}`);
      riskScore += 0.20;
    }

    if (order.amountIn > CONFIG.LARGE_ORDER_USD) {
      flags.push(`LARGE_ORDER:$${order.amountIn.toFixed(2)}`);
      riskScore += 0.30;
    }

    // Rapid-repeat guard — same token pair within 500ms
    const now = Date.now();
    const key = `${order.inputMint}:${order.outputMint}`;
    const last = this.recentOrders.get(key);
    if (last && (now - last) < CONFIG.RAPID_REPEAT_MS) {
      flags.push("RAPID_REPEAT");
      riskScore += 0.20;
    }
    this.recentOrders.set(key, now);
    // Prune stale entries
    for (const [k, t] of this.recentOrders) {
      if (now - t > 10_000) this.recentOrders.delete(k);
    }

    const safe = riskScore < CONFIG.SANDWICH_RISK_THRESHOLD;
    // abort at 0.90+; reorder between 0.60–0.89; proceed below 0.60
    const recommendation: "proceed" | "reorder" | "abort" =
      riskScore >= 0.90 ? "abort"   :
      riskScore >= 0.60 ? "reorder" : "proceed";

    if (flags.length > 0) {
      console.log(`🛡️  [MEV] score=${riskScore.toFixed(2)} [${recommendation.toUpperCase()}]: ${flags.join(", ")}`);
    }

    return { safe, riskScore, flags, recommendation };
  }

  /**
   * Submit a signed transaction as an atomic Jito bundle.
   *
   * Bundles protect against:
   *   - Sandwich attacks (atomicity guarantee)
   *   - Front-running (bypass public mempool)
   *
   * Called by ExecutionNode when MEV risk is "reorder" and Jito is available.
   * Falls back gracefully if Jito is down — caller uses standard sendRawTransaction.
   *
   * @param tx          - Signed VersionedTransaction to protect
   * @param tipLamports - Tip to incentivise validator inclusion (default: 10k lamports)
   */
  async bundleForJito(
    tx:           VersionedTransaction | Transaction,
    tipLamports = 10_000,
  ): Promise<BundleResult> {
    if (!(tx instanceof VersionedTransaction)) {
      // Legacy Transaction — convert for JitoClient
      // Jito accepts both, but VersionedTransaction is required for v6 Jupiter txs
      console.warn("[MevDefense] Legacy Transaction passed to bundleForJito — prefer VersionedTransaction");
    }

    const versionedTx = tx instanceof VersionedTransaction
      ? tx
      : VersionedTransaction.deserialize((tx as Transaction).serialize());

    console.log(`[MevDefense] Submitting bundle (tip: ${tipLamports} lamports)`);
    const result = await this.jito.sendWithTip(versionedTx, tipLamports);

    if (result.status === "Landed" || result.status === "Processed") {
      console.log(`[MevDefense] ✅ Jito bundle confirmed in ${result.landedMs}ms`);
    } else if (result.error) {
      console.warn(`[MevDefense] ⚠️  Jito bundle ${result.status}: ${result.error}`);
    }

    return result;
  }

  /**
   * Convenience wrapper used by ExecutionNode:
   * decides whether to use Jito or standard path.
   *
   * @param tx              - Signed transaction
   * @param mevCheck        - Result from inspect()
   * @param useJito         - Whether Jito is enabled (env/config gate)
   */
  async route(
    tx:       VersionedTransaction,
    mevCheck: MevCheckResult,
    useJito   = process.env.JITO_ENABLED !== "false",
  ): Promise<{ path: "jito" | "standard"; bundleResult?: BundleResult }> {
    if (useJito && mevCheck.recommendation === "reorder") {
      const bundleResult = await this.bundleForJito(tx);
      if (bundleResult.status === "Landed" || bundleResult.status === "Processed") {
        return { path: "jito", bundleResult };
      }
      // Jito failed — fall through to standard
      console.warn("[MevDefense] Jito failed — falling back to standard send");
    }
    return { path: "standard" };
  }

  get config() { return CONFIG; }
}
